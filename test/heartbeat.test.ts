import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { MAX_PENDING } from "../src/core/initiatives.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { HEARTBEAT_CHAT, HEARTBEAT_LABEL, heartbeatDecision, heartbeatPrompt, runHeartbeat } from "../src/scheduler/heartbeat.ts";
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

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition jamais atteinte");
};

const idea = (title: string) => ({ title, why: "Parce que c'est le moment", action: `Fais : ${title}`, source: "souvenir #1" });

function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const calls: { taskId: number; opts: RunOptions }[] = [];
  const execute = (async (deps: any, taskId: number, opts: RunOptions) => {
    calls.push({ taskId, opts });
    deps.journal.finish(taskId, "done", "ok", 0);
    return { text: "ok", costUsd: 0, status: "done" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute });
  return { store, journal, conversation, hub, calls };
}

// 12 h à Paris, un mercredi de novembre (UTC+1).
const NOON = new Date("2026-11-18T11:00:00Z");
const base = { minutes: 120, engineReady: true, busy: false, pending: 0, quotaPercent: null, lastRun: null };

test("propositions : pas de doublon, refus retenu, plafond d'attente", () => {
  const s = new Store(":memory:");
  const a = s.initiatives.propose(idea("Relancer Studio Pixel"));
  assert.equal(a.outcome, "proposed");
  assert.equal(s.initiatives.propose(idea("relancer  studio pixel !")).outcome, "duplicate", "même titre, à la casse et ponctuation près");

  assert.ok(s.initiatives.decide((a as { id: number }).id, "declined", "déjà fait"));
  assert.equal(s.initiatives.propose(idea("Relancer Studio Pixel")).outcome, "declined_before", "refusée il y a moins de 30 jours");
  assert.equal(s.initiatives.recentDecisions()[0].decline_reason, "déjà fait");

  for (let i = 0; i < MAX_PENDING; i++) assert.equal(s.initiatives.propose(idea(`Action numéro ${i}`)).outcome, "proposed");
  assert.equal(s.initiatives.propose(idea("Une de trop")).outcome, "full");
  assert.ok(!s.initiatives.decide(999, "accepted"));
});

test("outil propose_initiative : lecture seule, refusé sans tâche", () => {
  const s = new Store(":memory:");
  const none = memoryTools(s, { taskId: () => undefined, writeRefusal: () => null });
  assert.match(none.propose_initiative.run(idea("Relancer la banque")), /^Refusé/);
  const ro = memoryTools(s, { taskId: () => 7, writeRefusal: () => "lecture seule" });
  assert.match(ro.propose_initiative.run(idea("Relancer la banque")), /^Proposition #1 envoyée/, "proposer n'est pas agir : permis en lecture seule");
  assert.equal(s.initiatives.get(1)!.task_id, 7);
});

test("heartbeat : quand il tourne et pourquoi il attend", () => {
  assert.deepEqual(heartbeatDecision(base, NOON), { run: true, why: "maintenant", next: NOON.getTime() });
  assert.match(heartbeatDecision({ ...base, minutes: 0 }, NOON).why, /^coupé/);
  assert.match(heartbeatDecision({ ...base, engineReady: null }, NOON).why, /aucun moteur/);
  assert.match(heartbeatDecision(base, new Date("2026-11-18T22:30:00Z")).why, /nuit/, "23 h 30 à Paris");
  assert.match(heartbeatDecision({ ...base, pending: MAX_PENDING }, NOON).why, /tranche d'abord/);
  assert.match(heartbeatDecision({ ...base, quotaPercent: 95 }, NOON).why, /quota/);
  assert.match(heartbeatDecision({ ...base, busy: true }, NOON).why, /fin des tâches/);
  const recent = heartbeatDecision({ ...base, lastRun: NOON.getTime() - 30 * 60_000 }, NOON);
  assert.equal(recent.run, false);
  assert.equal(recent.next, NOON.getTime() + 90 * 60_000);
  assert.ok(heartbeatDecision({ ...base, lastRun: NOON.getTime() - 121 * 60_000 }, NOON).run);
});

test("heartbeat : la consigne liste l'attente et les refus", () => {
  const s = new Store(":memory:");
  s.initiatives.propose(idea("Relancer la banque"));
  const r = s.initiatives.propose(idea("Préparer l'entretien")) as { id: number };
  s.initiatives.decide(r.id, "declined", "pas utile");
  const p = heartbeatPrompt(s.initiatives.pending(), s.initiatives.recentDecisions(), NOON);
  assert.ok(p.startsWith("[Tour de veille de Clark]"));
  assert.match(p, /mercredi 18 novembre 2026/);
  assert.match(p, /- Relancer la banque/);
  assert.match(p, /- Préparer l'entretien : refusé \(pas utile\)/);
});

test("heartbeat : tour en lecture seule, hors de ta conversation, sans reprendre ta session", async () => {
  const { hub, journal, conversation, store, calls } = setup();
  store.setSession(OWNER_CHAT, "session-de-charles");
  await runHeartbeat(hub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.access, "read");
  assert.equal(calls[0].opts.resume, undefined);
  const task = journal.get(calls[0].taskId)!;
  assert.equal(task.label, HEARTBEAT_LABEL);
  assert.equal(task.chat_id, HEARTBEAT_CHAT);
  assert.equal(conversation.recent(OWNER_CHAT).length, 0, "rien dans ton fil");
  assert.equal(conversation.recent(HEARTBEAT_CHAT).filter((m) => m.role === "user").length, 0);
});

test("proposition acceptée : elle devient une tâche dans ta conversation", async () => {
  const { hub, store, conversation, calls, journal } = setup();
  const { id } = store.initiatives.propose(idea("Relancer la banque")) as { id: number };
  assert.equal(hub.decideInitiative(id, "accept"), "done");
  assert.equal(hub.decideInitiative(id, "decline"), "already", "une seule décision");
  await until(() => calls.length === 1);
  assert.equal(calls[0].opts.prompt, "Fais : Relancer la banque");
  assert.equal(calls[0].opts.access, undefined, "accès normal : les écritures passent par ton accord");
  assert.equal(journal.get(calls[0].taskId)!.chat_id, OWNER_CHAT);
  assert.ok(conversation.recent(OWNER_CHAT).some((m) => m.role === "system" && m.text.startsWith("Proposition acceptée « Relancer la banque »")));
  assert.equal(store.initiatives.get(id)!.status, "accepted");
});

test("proposition refusée : rien ne part, la raison est gardée", async () => {
  const { hub, store, conversation, calls } = setup();
  const { id } = store.initiatives.propose(idea("Relancer la banque")) as { id: number };
  assert.equal(hub.decideInitiative(id, "decline", "c'est fait"), "done");
  await until(() => conversation.recent(OWNER_CHAT).some((m) => /Proposition refusée/.test(m.text)));
  assert.equal(calls.length, 0);
  assert.equal(store.initiatives.get(id)!.decline_reason, "c'est fait");
});

test("redémarrage : un tour de veille coupé est abandonné, pas repris", async () => {
  const { hub, journal, calls } = setup();
  const id = journal.create(HEARTBEAT_CHAT, HEARTBEAT_LABEL, "[Tour de veille de Clark] …");
  journal.setStatus(id, "running");
  await hub.recover();
  assert.equal(journal.get(id)!.status, "abandoned");
  assert.equal(calls.length, 0);
});
