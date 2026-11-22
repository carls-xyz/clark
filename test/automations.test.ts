import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { waitFor } from "./_wait.ts";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { TEAM_LABEL } from "../src/core/team.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { Automations, dueSlot, nextRunText, scheduleText, validateAutomation, type Automation } from "../src/scheduler/automations.ts";
import { runDueAutomations } from "../src/scheduler/cron.ts";
import { launchAutomation } from "../src/scheduler/automation-run.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = {
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: 0,
  model: "claude-opus-5-5",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
};

/** Heure de Paris (hiver : UTC+1). 2026-11-19 est un jeudi. */
const paris = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`);

const auto = (over: Partial<Automation>): Automation => ({
  id: 1,
  name: "Point",
  prompt: "Fais le point",
  frequency: "weekdays",
  time: "09:00",
  weekday: null,
  team: 0,
  enabled: 1,
  last_slot: null,
  last_task_id: null,
  last_run_at: null,
  kind: "chat",
  project_id: null,
  engine: null,
  model: null,
  effort: null,
  precheck: null,
  thread: "main",
  created_at: "",
  ...over,
});

test("horaires : à l'heure, en retard de moins de 2 h, pas avant, pas trop tard", () => {
  const a = auto({});
  assert.equal(dueSlot(a, paris("2026-11-19", "08:59")), null, "pas avant");
  assert.equal(dueSlot(a, paris("2026-11-19", "09:00")), "2026-11-19T09:00");
  assert.equal(dueSlot(a, paris("2026-11-19", "10:59")), "2026-11-19T09:00", "Clark éteint à 9 h, rallumé à 10 h 59 : rattrapée");
  assert.equal(dueSlot(a, paris("2026-11-19", "11:00")), null, "trop tard : on attend la prochaine");
  assert.equal(dueSlot({ ...a, last_slot: "2026-11-19T09:00" }, paris("2026-11-19", "09:30")), null, "déjà lancée");
  assert.equal(dueSlot({ ...a, enabled: 0 }, paris("2026-11-19", "09:00")), null, "coupée");
});

test("horaires : en semaine, chaque semaine, chaque heure", () => {
  assert.equal(dueSlot(auto({}), paris("2026-11-21", "09:00")), null, "samedi : pas en semaine");
  assert.equal(dueSlot(auto({ frequency: "daily" }), paris("2026-11-21", "09:00")), "2026-11-21T09:00");
  const mardi = auto({ frequency: "weekly", weekday: 2 });
  assert.equal(dueSlot(mardi, paris("2026-11-24", "09:05")), "2026-11-24T09:00");
  assert.equal(dueSlot(mardi, paris("2026-11-19", "09:05")), null);
  const hourly = auto({ frequency: "hourly", time: "00:15" });
  assert.equal(dueSlot(hourly, paris("2026-11-19", "14:20")), "2026-11-19T14:15");
  assert.equal(dueSlot(hourly, paris("2026-11-19", "14:50")), null, "retard max de 30 min pour « chaque heure »");
});

test("prochaine occurrence et libellés, en clair", () => {
  assert.equal(nextRunText(auto({}), paris("2026-11-19", "08:00")), "aujourd'hui à 09:00");
  assert.equal(nextRunText(auto({}), paris("2026-11-19", "09:30")), "maintenant");
  assert.equal(nextRunText(auto({ last_slot: "2026-11-19T09:00" }), paris("2026-11-19", "09:30")), "demain à 09:00");
  assert.equal(nextRunText(auto({ last_slot: "2026-11-21T09:00" }), paris("2026-11-21", "12:00")), "lundi à 09:00", "samedi midi → lundi");
  assert.equal(nextRunText(auto({ enabled: 0 }), paris("2026-11-19", "08:00")), "coupée");
  assert.equal(scheduleText({ frequency: "weekly", time: "08:30", weekday: 2 }), "Chaque mardi à 08:30");
  assert.equal(scheduleText({ frequency: "hourly", time: "00:05", weekday: null }), "Chaque heure, à la minute 05");
});

test("saisie : nom, consigne, heure et jour vérifiés", () => {
  const ok = { name: "Point", prompt: "Fais le point", frequency: "daily" as const, time: "09:00" };
  assert.equal(validateAutomation(ok), null);
  assert.match(validateAutomation({ ...ok, name: " " })!, /nom/);
  assert.match(validateAutomation({ ...ok, prompt: "x" })!, /consigne/);
  assert.match(validateAutomation({ ...ok, time: "25:00" })!, /Heure/);
  assert.match(validateAutomation({ ...ok, frequency: "weekly" })!, /jour/);
});

function setup() {
  const calls: { label: string; prompt: string }[] = [];
  const execute: typeof executeTask = async (deps, taskId, run) => {
    if (deps.journal.get(taskId)!.label === "plan") {
      // Clark choisit l'équipe habituelle pour un écrit.
      deps.journal.finish(taskId, "done", '{"standard": true}', 0);
      return { text: '{"standard": true}', costUsd: 0, status: "done" };
    }
    const t = deps.journal.get(taskId)!;
    calls.push({ label: t.label, prompt: run.prompt });
    const text = t.label.startsWith("relecteur") ? "VERDICT : OK" : "Fait.";
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  };
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config, store, journal, conversation }, { execute });
  return { store, journal, conversation, hub, calls };
}

test("planificateur : une occurrence part une seule fois, même si l'horloge retombe dessus", async () => {
  const { store, hub, calls, conversation } = setup();
  const id = store.automations.create({ name: "Point candidatures", prompt: "Fais le point sur mes candidatures", frequency: "weekdays", time: "09:00" }, paris("2026-11-19", "08:00"));

  assert.equal(runDueAutomations(store.automations, (a, slot) => launchAutomation(hub, a, { slot }), paris("2026-11-19", "08:59")), 0);
  assert.equal(runDueAutomations(store.automations, (a, slot) => launchAutomation(hub, a, { slot }), paris("2026-11-19", "09:00")), 1);
  assert.equal(runDueAutomations(store.automations, (a, slot) => launchAutomation(hub, a, { slot }), paris("2026-11-19", "09:01")), 0, "minute suivante : rien");
  // Clark redémarre : un nouvel objet relit la même base, l'occurrence est déjà réservée.
  assert.equal(runDueAutomations(new Automations(store.db), (a, slot) => launchAutomation(hub, a, { slot }), paris("2026-11-19", "09:02")), 0);
  await waitFor(() => calls.length >= 1);

  assert.deepEqual(calls.map((c) => c.prompt), ["Fais le point sur mes candidatures"]);
  const a = store.automations.get(id)!;
  assert.equal(a.last_slot, "2026-11-19T09:00");
  assert.ok(a.last_task_id, "la tâche lancée est notée");
  assert.ok(
    conversation.recent(OWNER_CHAT).some((m) => m.role === "system" && /^Automatisation « Point candidatures » :/.test(m.text)),
    "le fil dit que c'est une automatisation, pas toi",
  );
  assert.ok(!conversation.recent(OWNER_CHAT).some((m) => m.role === "user"));
});

test("planificateur : créer ou réactiver une automatisation ne la lance pas d'un coup", () => {
  const { store, hub } = setup();
  const id = store.automations.create({ name: "Point", prompt: "Fais le point", frequency: "daily", time: "09:00" }, paris("2026-11-19", "09:30"));
  assert.equal(runDueAutomations(store.automations, (a, slot) => launchAutomation(hub, a, { slot }), paris("2026-11-19", "09:31")), 0, "créée à 9 h 30 : l'occurrence de 9 h ne part pas");
  store.automations.setEnabled(id, false);
  store.automations.setEnabled(id, true, paris("2026-11-20", "09:10"));
  assert.equal(runDueAutomations(store.automations, (a, slot) => launchAutomation(hub, a, { slot }), paris("2026-11-20", "09:11")), 0, "réactivée à 9 h 10 : pas de rattrapage");
  assert.equal(runDueAutomations(store.automations, (a, slot) => launchAutomation(hub, a, { slot }), paris("2026-11-21", "09:00")), 1, "le lendemain, normalement");
});

test("planificateur : une automatisation d'équipe passe par l'équipe (et donc par le contrôle du quota)", async () => {
  const { store, hub, calls } = setup();
  store.automations.create({ name: "Relances", prompt: "Prépare les relances", frequency: "daily", time: "09:00", team: true }, paris("2026-11-19", "08:00"));
  runDueAutomations(store.automations, (a, slot) => launchAutomation(hub, a, { slot }), paris("2026-11-19", "09:00"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((c) => c.label), ["chercheur", "redacteur:1", "relecteur:1"]);
  assert.equal(store.db.prepare("SELECT label FROM tasks WHERE parent_id IS NULL").get()!.label, TEAM_LABEL);
});

test("interface : créer, couper, lancer maintenant, supprimer", async () => {
  const { store, hub, calls } = setup();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const web = await startWeb(hub, { port });
  const post = (path: string, body: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method: "POST", headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Content-Type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || "{}") }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  try {
    const bad = await post("/api/automations", { name: "X", prompt: "", frequency: "daily", time: "09:00" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /nom|consigne/);

    const made = await post("/api/automations", { name: "Point", prompt: "Fais le point", frequency: "weekly", time: "08:30", weekday: 2 });
    assert.equal(made.status, 201);
    const id = made.body.id;
    assert.equal(store.automations.get(id)!.weekday, 2);

    assert.equal((await post(`/api/automations/${id}`, { action: "disable" })).status, 200);
    assert.equal(store.automations.get(id)!.enabled, 0);

    assert.equal((await post(`/api/automations/${id}`, { action: "run" })).status, 200);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(calls.map((c) => c.prompt), ["Fais le point"], "lancer maintenant marche même coupée");

    assert.equal((await post(`/api/automations/${id}`, { action: "delete" })).status, 200);
    assert.equal(store.automations.list().length, 0);
    assert.equal((await post(`/api/automations/${id}`, { action: "run" })).status, 404);
  } finally {
    await web.close();
  }
});
