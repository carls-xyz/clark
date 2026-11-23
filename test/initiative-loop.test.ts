import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { BILAN_CHAT, BILAN_LABEL, learningForPrompt, measureInitiatives, parseVerdict, statsLines, verdictOf, weeklyBilan } from "../src/core/initiative-loop.ts";
import { Initiatives, type CategoryStats } from "../src/core/initiatives.ts";
import { calendarMonth } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { heartbeatPrompt } from "../src/scheduler/heartbeat.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null };

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition jamais atteinte");
};

function setup(result = "J'ai relu la PR #3 : à fusionner, deux remarques mineures.", status: "done" | "failed" = "done") {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const execute = (async (deps: any, taskId: number) => {
    deps.journal.finish(taskId, status, result, 0);
    return { text: result, costUsd: 0, status };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute });
  return { store, journal, hub };
}

const pr = { title: "Relire la PR #3", why: "Elle attend depuis 2 jours", action: "Relis la PR #3 et donne un avis", source: "tâche dev #11", category: "dev" as const, success: "La PR #3 relue avec un avis clair (fusionner ou corriger)" };

test("proposition : catégorie et critère de réussite (obligatoire pour l'outil) ; les anciennes passent en « autre »", () => {
  const store = new Store(":memory:");
  const tools = memoryTools(store, { taskId: () => 1, writeRefusal: () => null });
  const schema = z.object(tools.propose_initiative.shape);
  assert.ok(schema.safeParse(pr).success);
  assert.ok(!schema.safeParse({ ...pr, success: undefined }).success, "sans critère : refusé");
  assert.ok(!schema.safeParse({ ...pr, category: "nimporte" }).success);
  assert.match(tools.propose_initiative.run(pr), /Proposition #1/);
  const i = store.initiatives.get(1)!;
  assert.deepEqual([i.category, i.success], ["dev", pr.success]);

  // Une base d'avant la boucle : colonnes ajoutées, catégorie « autre ».
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE initiatives (id INTEGER PRIMARY KEY, title TEXT NOT NULL, title_key TEXT NOT NULL, why TEXT NOT NULL, action TEXT NOT NULL, source TEXT, status TEXT NOT NULL DEFAULT 'pending', decline_reason TEXT, task_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT)");
  db.exec("INSERT INTO initiatives (title, title_key, why, action) VALUES ('Vieux', 'vieux', 'x', 'y')");
  const old = new Initiatives(db).get(1)!;
  assert.deepEqual([old.category, old.success, old.outcome], ["autre", null, null]);
});

test("refus : « pas maintenant » reproposable après 3 jours ; « pas utile » mis de côté 30 jours", () => {
  const store = new Store(":memory:");
  const back = (id: number, days: number) => store.db.prepare("UPDATE initiatives SET decided_at = datetime('now', ?) WHERE id = ?").run(`-${days} days`, id);
  const a = store.initiatives.propose({ ...pr, title: "Trier les offres" });
  assert.equal(a.outcome, "proposed");
  store.initiatives.decide((a as { id: number }).id, "declined", undefined, "pas_maintenant");
  assert.equal(store.initiatives.propose({ ...pr, title: "Trier les offres" }).outcome, "declined_before", "tout de suite : non");
  back((a as { id: number }).id, 4);
  assert.equal(store.initiatives.propose({ ...pr, title: "Trier les offres" }).outcome, "proposed", "4 jours après : oui");

  const b = store.initiatives.propose({ ...pr, title: "Lire le blog de X" }) as { id: number };
  store.initiatives.decide(b.id, "declined", undefined, "pas_utile");
  back(b.id, 10);
  assert.equal(store.initiatives.propose({ ...pr, title: "Lire le blog de X" }).outcome, "declined_before");
  assert.equal(store.initiatives.get(b.id)!.decline_kind, "pas_utile");
});

test("parcours : acceptée → tâche exécutée liée → mesurée contre le critère → ton avis (3 jours)", async () => {
  const { store, journal, hub } = setup();
  const { id } = store.initiatives.propose(pr) as { id: number };
  assert.equal(hub.decideInitiative(id, "accept"), "done");
  await until(() => store.initiatives.get(id)!.exec_task_id !== null);
  const execId = store.initiatives.get(id)!.exec_task_id!;
  await until(() => journal.get(execId)?.status === "done");

  const asked: string[] = [];
  const judge = async (p: string) => (asked.push(p), '{"verdict":"atteint","note":"Relue, avis : fusionner."}');
  assert.equal(await measureInitiatives(hub, judge), 1);
  assert.match(asked[0], /Critère de réussite : La PR #3 relue/);
  assert.match(asked[0], /à fusionner, deux remarques/);
  const measured = store.initiatives.get(id)!;
  assert.deepEqual([measured.outcome, measured.outcome_note], ["atteint", "Relue, avis : fusionner."]);
  assert.equal(await measureInitiatives(hub, judge), 0, "mesurée une seule fois");

  assert.deepEqual(store.initiatives.awaitingFeedback().map((i) => i.id), [id]);
  assert.ok(store.initiatives.setFeedback(id, "utile"));
  assert.equal(store.initiatives.setFeedback(id, "inutile"), false, "un seul avis");
  assert.deepEqual(store.initiatives.awaitingFeedback(), []);

  // Trop tard (plus de 3 jours) : plus d'avis demandé.
  const { id: id2 } = store.initiatives.propose({ ...pr, title: "Autre chose" }) as { id: number };
  store.initiatives.setOutcome(id2, "partiel", "x");
  store.db.prepare("UPDATE initiatives SET outcome_at = datetime('now', '-4 days') WHERE id = ?").run(id2);
  assert.equal(store.initiatives.setFeedback(id2, "utile"), false);
});

test("mesure : tâche en échec → raté sans appeler le juge ; sans modèle → terminé ; réponse illisible → terminé", async () => {
  const failed = setup("plantage", "failed");
  const { id } = failed.store.initiatives.propose(pr) as { id: number };
  failed.hub.decideInitiative(id, "accept");
  await until(() => {
    const t = failed.store.initiatives.get(id)!.exec_task_id;
    return t !== null && failed.journal.get(t)?.status === "failed";
  });
  let calls = 0;
  await measureInitiatives(failed.hub, async () => (calls++, "{}"));
  assert.deepEqual([failed.store.initiatives.get(id)!.outcome, calls], ["rate", 0]);

  const nojudge = setup();
  const { id: n } = nojudge.store.initiatives.propose(pr) as { id: number };
  nojudge.hub.decideInitiative(n, "accept");
  await until(() => {
    const t = nojudge.store.initiatives.get(n)!.exec_task_id;
    return t !== null && nojudge.journal.get(t)?.status === "done";
  });
  await measureInitiatives(nojudge.hub);
  assert.equal(nojudge.store.initiatives.get(n)!.outcome, "termine");

  assert.deepEqual(parseVerdict('Voilà : {"verdict":"partiel","note":"Avis donné, sans détail."}'), { outcome: "partiel", note: "Avis donné, sans détail." });
  assert.equal(parseVerdict("je ne sais pas"), null);
});

test("bilan : taux par catégorie, et règles fixes « à éviter » / « ça marche »", () => {
  const s = (o: Partial<CategoryStats>): CategoryStats => ({ category: "relance", proposed: 0, accepted: 0, declined: 0, notUseful: 0, finished: 0, reached: 0, feedback: 0, useful: 0, ...o });
  assert.equal(verdictOf(s({ proposed: 6, accepted: 6, finished: 6, reached: 5, feedback: 4, useful: 4 })), "marche");
  assert.equal(verdictOf(s({ proposed: 4, accepted: 4, feedback: 3, useful: 0 })), "eviter", "acceptées mais jugées pas utiles");
  assert.equal(verdictOf(s({ proposed: 3, accepted: 0, declined: 3 })), "eviter", "toujours refusées");
  assert.equal(verdictOf(s({ proposed: 2, declined: 2, notUseful: 2 })), "eviter", "deux « pas utile »");
  assert.equal(verdictOf(s({ proposed: 2, accepted: 2 })), null, "trop peu pour conclure");
  const [line] = statsLines([s({ category: "tri", proposed: 3, accepted: 1, declined: 2, notUseful: 2 })]);
  assert.match(line, /Tri \(mails, offres\) \(tri\) : 3 proposées, 1 acceptée, 2 refusées comme pas utiles → à éviter/);

  const store = new Store(":memory:");
  for (const t of ["Relancer A", "Relancer B", "Relancer C"]) {
    const { id } = store.initiatives.propose({ ...pr, title: t, category: "relance" }) as { id: number };
    store.initiatives.decide(id, "accepted");
    store.initiatives.setOutcome(id, "atteint", null);
    store.initiatives.setFeedback(id, "utile");
  }
  const [rel] = store.initiatives.stats(30);
  assert.deepEqual([rel.category, rel.proposed, rel.accepted, rel.reached, rel.useful], ["relance", 3, 3, 3, 3]);
});

test("tour de veille : reçoit le bilan, les refus et ce qui a raté ; le bilan de la semaine va au Calendrier", () => {
  const { store, journal, hub } = setup();
  for (const t of ["Trier A", "Trier B"]) {
    const { id } = store.initiatives.propose({ ...pr, title: t, category: "tri" }) as { id: number };
    store.initiatives.decide(id, "declined", "je trie moi-même", "pas_utile");
  }
  const { id } = store.initiatives.propose(pr) as { id: number };
  store.initiatives.decide(id, "accepted");
  store.initiatives.setOutcome(id, "rate", "la PR était déjà fusionnée");

  const learning = learningForPrompt(hub);
  assert.match(learning, /Tri \(mails, offres\).*→ à éviter/);
  assert.match(learning, /« Trier A » : pas utile \(je trie moi-même\)/);
  assert.match(learning, /« Relire la PR #3 » : ratée \(la PR était déjà fusionnée\)/);
  const prompt = heartbeatPrompt([], store.initiatives.recentDecisions(), new Date(), undefined, [], learning);
  assert.match(prompt, /critère de réussite vérifiable/);
  assert.match(prompt, /Relire la PR #3 : accepté, raté/);
  assert.match(prompt, /Bilan de tes propositions sur 30 jours/);

  const bilan = weeklyBilan(hub);
  assert.match(bilan, /3 propositions, 1 acceptée/);
  const t = journal.create(BILAN_CHAT, BILAN_LABEL, "Bilan des propositions de la semaine");
  journal.finish(t, "done", bilan, 0);
  const at = journal.get(t)!.created_at;
  const entry = calendarMonth(hub, at.slice(0, 7)).runs.find((r) => r.taskId === t)!;
  assert.equal(entry.name, "Bilan des propositions");
  assert.match(entry.report!, /Bilan des propositions/);
  void OWNER_CHAT;
});

test("autonomie : la proposition lancée seule est liée à sa tâche ; annulée par toi, elle compte comme ratée", async () => {
  const { onStop } = await import("../src/core/stops.ts");
  const { decisionsOf, launchInitiative, undoDecision } = await import("../src/core/autonomy.ts");
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  let release!: () => void;
  const execute = (async (deps: any, taskId: number) => {
    deps.journal.setStatus(taskId, "running");
    await new Promise<void>((r) => {
      release = r;
      onStop(taskId, () => r());
    });
    deps.journal.finish(taskId, "failed", "arrêté", 0);
    return { text: "arrêté", costUsd: 0, status: "failed" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute });
  const { id } = store.initiatives.propose(pr) as { id: number };
  store.initiatives.decide(id, "accepted", undefined, undefined, true);
  const decisions = decisionsOf(store.db);
  const d = decisions.add({ kind: "veille", title: pr.title, reason: pr.why });
  launchInitiative(hub, store.initiatives.get(id)!, (ref) => decisions.setRef(d, ref.type, ref.id));
  await until(() => {
    const t = store.initiatives.get(id)!.exec_task_id;
    return t !== null && journal.get(t)?.status === "running";
  });
  assert.equal(store.initiatives.get(id)!.auto, 1);
  const r = undoDecision(hub, d);
  assert.ok(r.ok, JSON.stringify(r));
  const i = store.initiatives.get(id)!;
  assert.equal(i.outcome, "rate");
  assert.match(i.outcome_note!, /annulée par toi/);
  release?.();
});
