import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { calendarMonth } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { launchAutomation } from "../src/scheduler/automation-run.ts";
import { automationChat, parisParts, validateAutomation } from "../src/scheduler/automations.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = (): Config => ({
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: 0,
  model: "m",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
});

const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "condition jamais atteinte");
};

/** Faux agent : répond le compte rendu donné, ou échoue si la consigne contient « plante ». */
function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const chats: number[] = [];
  const fake = (async (deps: any, taskId: number, opts: RunOptions) => {
    chats.push(deps.journal.get(taskId).chat_id);
    if (/plante/.test(opts.prompt)) {
      deps.journal.finish(taskId, "failed", "Le site ne répond pas.", 0);
      return { text: "Le site ne répond pas.", costUsd: 0, status: "failed" };
    }
    deps.journal.finish(taskId, "done", "## Veille\n- Un article utile", 0);
    return { text: "## Veille\n- Un article utile", costUsd: 0, status: "done" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config: config(), store, journal, conversation }, { execute: fake, executors: { claude: fake, codex: fake } });
  return { store, journal, conversation, hub, chats };
}

test("calendrier : le fil « calendar » est accepté, une tâche dev ne peut pas y aller", () => {
  const base = { name: "Veille", prompt: "Fais la veille", frequency: "daily" as const, time: "21:00" };
  assert.equal(validateAutomation({ ...base, thread: "calendar" }), null);
  assert.equal(validateAutomation({ ...base, thread: "ailleurs" as any }), "Fil inconnu");
  const { store } = setup();
  const id = store.automations.create(base);
  assert.equal(store.automations.get(id)!.thread, "main");
  assert.ok(store.automations.setThread(id, "calendar"));
  assert.equal(store.automations.get(id)!.thread, "calendar");
  assert.throws(() => store.automations.setThread(id, "nulle-part" as any), /Fil inconnu/);
  const devId = store.db.prepare("INSERT INTO automations (name, prompt, frequency, time, kind) VALUES ('d', 'x', 'daily', '09:00', 'dev')").run().lastInsertRowid;
  assert.throws(() => store.automations.setThread(Number(devId), "calendar"), /tâche dev/);
});

test("calendrier : le compte rendu reste hors de ta conversation et se lit au jour où il a tourné", async () => {
  const { store, journal, conversation, hub, chats } = setup();
  const id = store.automations.create({ name: "Veille du soir", prompt: "Fais la veille", frequency: "daily", time: "21:00", thread: "calendar" });
  const before = conversation.recent(OWNER_CHAT).length;
  await launchAutomation(hub, store.automations.get(id)!, { manual: true });
  const [run] = store.automations.runs(id, 1);
  await until(() => run.task_id !== null && journal.get(run.task_id!)?.status === "done");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chats.at(-1), automationChat(id), "tourne dans son propre fil");
  assert.equal(conversation.recent(OWNER_CHAT).length, before, "rien dans ta conversation");

  const at = store.automations.runs(id, 1)[0].created_at;
  const month = at.slice(0, 7);
  const cal = calendarMonth(hub, month);
  assert.equal(cal.runs.length, 1);
  assert.equal(cal.runs[0].name, "Veille du soir");
  assert.equal(cal.runs[0].task, "done");
  assert.match(cal.runs[0].report!, /Un article utile/);
  assert.deepEqual(store.automations.recentCalendarRuns().map((id) => `a${id}`), [cal.runs[0].key]);

  // Remise dans la conversation : elle sort du calendrier (et son historique avec).
  store.automations.setThread(id, "main");
  assert.equal(calendarMonth(hub, month).runs.length, 0);
});

test("calendrier : une veille qui échoue est signalée en une ligne, le détail reste dans le calendrier", async () => {
  const { store, journal, conversation, hub } = setup();
  const id = store.automations.create({ name: "Veille cassée", prompt: "plante ici", frequency: "daily", time: "21:00", thread: "calendar" });
  await launchAutomation(hub, store.automations.get(id)!, { manual: true });
  const [run] = store.automations.runs(id, 1);
  await until(() => run.task_id !== null && journal.get(run.task_id!)?.status === "failed");
  await until(() => conversation.recent(OWNER_CHAT).some((m) => /Veille cassée/.test(m.text)));
  const line = conversation.recent(OWNER_CHAT).find((m) => /Veille cassée/.test(m.text))!;
  assert.match(line.text, /calendrier/);
  assert.doesNotMatch(line.text, /Le site ne répond pas/, "pas le compte rendu entier");
  const cal = calendarMonth(hub, run.created_at.slice(0, 7));
  assert.equal(cal.runs[0].task, "failed");
});

test("calendrier : le mois se lit avec une marge d'un jour (UTC → heure de Paris)", () => {
  const { store, hub } = setup();
  const id = store.automations.create({ name: "Veille", prompt: "Fais la veille", frequency: "daily", time: "21:00", thread: "calendar" });
  const add = (at: string) => store.db.prepare("INSERT INTO automation_runs (automation_id, status, note, created_at) VALUES (?, 'skipped', 'Rien de neuf.', ?)").run(id, at);
  add("2026-10-31 23:30:00"); // 1er novembre à Paris
  add("2026-11-15 20:00:00");
  add("2026-12-01 22:00:00"); // marge, l'interface le range en décembre
  add("2026-12-05 20:00:00"); // hors marge
  const cal = calendarMonth(hub, "2026-11");
  assert.deepEqual(
    cal.runs.map((r) => r.at),
    ["2026-10-31 23:30:00", "2026-11-15 20:00:00", "2026-12-01 22:00:00"],
  );
  assert.equal(cal.runs[1].status, "skipped");
  assert.equal(cal.runs[1].report, null);
});

test("brief du matin : dans sa conversation à part, sans reprendre de session, et lu dans le calendrier", async () => {
  const { BRIEF_CHAT, BRIEF_LABEL, startScheduler } = await import("../src/scheduler/cron.ts");
  // L'horloge lance le brief dans sa conversation, pas dans la tienne.
  const hour = parisParts(new Date()).hour;
  const sched = setup();
  const sent: [number, string][] = [];
  const stop = startScheduler({ config: { ...config(), briefHour: hour }, store: sched.store, enqueue: async (chat, _p, label) => void sent.push([chat, label]) });
  stop();
  assert.deepEqual(sent, [[BRIEF_CHAT, BRIEF_LABEL]]);

  const { store, journal, conversation, hub } = setup();
  store.setSession(BRIEF_CHAT, "vieille-session");
  const before = conversation.recent(OWNER_CHAT).length;
  const done = hub.enqueue(BRIEF_CHAT, "Fais le brief", BRIEF_LABEL);
  await done;
  const t = journal.lastCreated(BRIEF_LABEL)!;
  assert.ok(t);
  assert.equal(conversation.recent(OWNER_CHAT).length, before, "rien dans ta conversation");
  const entry = calendarMonth(hub, t.slice(0, 7)).runs.find((r) => r.kind === "brief")!;
  assert.equal(entry.name, "Brief du matin");
  assert.match(entry.report!, /Un article utile/);
});
