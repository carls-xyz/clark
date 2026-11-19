import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { goalChat, sameProgress } from "../src/core/goals.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { controlGoal, createGoal, decideAfterTurn } from "../src/scheduler/goals.ts";
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

const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition jamais atteinte");
};

type Report = { status: "progress" | "done" | "blocked"; summary: string; next_step?: string } | null;

/** Un faux agent qui, à chaque tour, fait le compte rendu que le scénario lui dicte. */
function setup(script: (turn: number, prompt: string) => Report) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const prompts: string[] = [];
  const execute = (async (deps: any, taskId: number, opts: RunOptions) => {
    prompts.push(opts.prompt);
    const turn = Number(opts.prompt.match(/tour (\d+) sur/)?.[1]);
    const report = script(turn, opts.prompt);
    if (report) memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null }).report_goal.run(report);
    deps.journal.finish(taskId, "done", `tour ${turn} fini`, 0);
    return { text: `tour ${turn} fini`, costUsd: 0, status: "done" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute });
  hub.setEngine({ name: "claude", model: "x", ready: true, account: "test", problem: null });
  return { store, journal, conversation, hub, prompts };
}

test("décision après un tour", () => {
  const ev = (kind: any, text: string) => ({ id: 1, goal_id: 1, turn: 1, kind, text, next_step: null, task_id: 1, created_at: "" });
  const base = { taskStatus: "done", previous: undefined, silentTurns: 0, turns: 1, maxTurns: 10 };
  assert.deepEqual(decideAfterTurn({ ...base, report: ev("progress", "Deux relances écrites") }), { action: "continue" });
  assert.deepEqual(decideAfterTurn({ ...base, report: ev("done", "Fini") }), { action: "done", summary: "Fini" });
  assert.match((decideAfterTurn({ ...base, report: ev("blocked", "Le 25 ou le 26 ?") }) as any).reason, /besoin de toi : Le 25 ou le 26/);
  assert.match((decideAfterTurn({ ...base, report: undefined, silentTurns: 2 }) as any).reason, /sans compte rendu/);
  assert.equal(decideAfterTurn({ ...base, report: undefined, silentTurns: 1 }).action, "continue", "un oubli passe");
  assert.match((decideAfterTurn({ ...base, report: ev("progress", "Relances écrites pour Studio Pixel"), previous: ev("progress", "relances ÉCRITES pour studio pixel !") }) as any).reason, /en rond/);
  assert.match((decideAfterTurn({ ...base, report: ev("progress", "x y z"), turns: 10 }) as any).reason, /limite de 10 tours/);
  assert.match((decideAfterTurn({ ...base, taskStatus: "needs_check", report: undefined }) as any).reason, /coupé en pleine écriture/);
  assert.match((decideAfterTurn({ ...base, taskStatus: "failed", taskResult: "Codex arrêté", report: undefined }) as any).reason, /a échoué : Codex arrêté/);
  assert.ok(sameProgress("Brouillon des trois relances terminé", "brouillon des trois relances termine"));
  assert.ok(!sameProgress("Brouillon des relances terminé", "Page Notion créée avec les dates"));
});

test("objectif : Clark enchaîne les tours jusqu'à l'atteindre, dans son propre fil", async () => {
  const { hub, store, conversation, prompts } = setup((turn) =>
    turn === 1 ? { status: "progress", summary: "Deux relances écrites", next_step: "La Banque du Nord" } : { status: "done", summary: "Les trois relances sont prêtes." },
  );
  const id = createGoal(hub, "Préparer les relances de mes trois candidatures", 5);
  await until(() => store.goals.get(id)!.status === "done");
  const g = store.goals.get(id)!;
  assert.equal(g.turns, 2);
  assert.equal(g.summary, "Les trois relances sont prêtes.");
  assert.match(prompts[1], /- Tour 1 : Deux relances écrites \(prochaine étape : La Banque du Nord\)/, "le tour suivant voit le précédent");
  const mine = conversation.recent(OWNER_CHAT).map((m) => m.text);
  assert.ok(mine.some((t) => t.startsWith(`Nouvel objectif #${id}`)));
  assert.ok(mine.some((t) => t.startsWith(`Objectif atteint (#${id})`)));
  assert.ok(!mine.some((t) => /tour 1 fini/.test(t)), "les tours restent dans le fil de l'objectif");
  assert.ok(conversation.recent(goalChat(id)).some((m) => m.text === "tour 1 fini"));
});

test("objectif bloqué : Clark attend, la réponse de Charles part avec le tour suivant", async () => {
  const { hub, store, prompts } = setup((turn, prompt) =>
    prompt.includes("- Charles : Le 26") ? { status: "done", summary: "Fini avec le 26." } : { status: "blocked", summary: "Le 25 ou le 26 ?" },
  );
  const id = createGoal(hub, "Relancer la Banque du Nord après l'entretien", 5);
  await until(() => store.goals.get(id)!.status === "waiting");
  assert.match(store.goals.get(id)!.reason!, /besoin de toi : Le 25 ou le 26/);
  assert.equal(controlGoal(hub, id, "resume", "Le 26, c'est sûr"), "done");
  await until(() => store.goals.get(id)!.status === "done");
  assert.match(prompts.at(-1)!, /- Charles : Le 26, c'est sûr/);
  assert.equal(controlGoal(hub, id, "resume"), "already");
});

test("objectif qui tourne en rond, ou qui atteint sa limite : Clark s'arrête et attend", async () => {
  const loop = setup(() => ({ status: "progress", summary: "J'ai relu les notes des candidatures" }));
  const a = createGoal(loop.hub, "Mettre de l'ordre dans mes candidatures", 10);
  await until(() => loop.store.goals.get(a)!.status === "waiting");
  assert.equal(loop.store.goals.get(a)!.turns, 2);
  assert.match(loop.store.goals.get(a)!.reason!, /en rond/);

  const steps = ["Relances écrites pour Studio Pixel", "Agenda vérifié pour novembre", "Notes rangées dans dossier", "Portfolio exporté en PDF", "Devis comparés entre fournisseurs", "Tableau budget complété", "Rapport hebdomadaire envoyé"];
  let n = 0;
  const limit = setup(() => ({ status: "progress", summary: steps[n++ % steps.length] }));
  const b = createGoal(limit.hub, "Trier tous mes mails de la semaine", 2);
  await until(() => limit.store.goals.get(b)!.status === "waiting");
  assert.equal(limit.store.goals.get(b)!.turns, 2);
  assert.match(limit.store.goals.get(b)!.reason!, /limite de 2 tours/);
  controlGoal(limit.hub, b, "resume");
  await until(() => limit.store.goals.get(b)!.turns === 7 && limit.store.goals.get(b)!.status === "waiting");
  assert.equal(limit.store.goals.get(b)!.max_turns, 7, "reprendre ajoute cinq tours");
});

test("objectif : pas de tour sans quota, pause et arrêt par Charles", async () => {
  const { hub, store } = setup(() => ({ status: "progress", summary: "avance" }));
  hub.setQuota({ plan: "max", windows: [{ label: "Fenêtre de 5 h", usedPercent: 95, durationMins: 300, resetsAt: null }], reached: false, readAt: Date.now() });
  const id = createGoal(hub, "Préparer le rendu Java Club", 5);
  await until(() => store.goals.get(id)!.status === "waiting");
  assert.equal(store.goals.get(id)!.turns, 0);
  assert.match(store.goals.get(id)!.reason!, /quota presque épuisé/);
  assert.equal(controlGoal(hub, id, "pause"), "done");
  assert.equal(controlGoal(hub, id, "stop"), "done");
  assert.equal(store.goals.get(id)!.status, "stopped");
  assert.equal(controlGoal(hub, 999, "stop"), "missing");
});

test("report_goal hors d'un objectif : refusé", () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const taskId = journal.create(OWNER_CHAT, "chat", "Salut");
  const r = memoryTools(store, { taskId: () => taskId, writeRefusal: () => null }).report_goal.run({ status: "done", summary: "Fini !" });
  assert.match(r, /pas un tour d'objectif/);
});
