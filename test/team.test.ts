import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { parseVerdict, TEAM_LABEL } from "../src/core/team.ts";
import { snapshot } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
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

const FACTS = `- Studio Pixel : entretien le 12 novembre (source : note-1-studio-pixel.md)
- Banque du Nord : entretien le 25 novembre selon l'en-tête, le 26 selon le corps (source : note-2-banque-nord.md)
- Agence Onde : dossier avant le 30 novembre (source : note-3-agence-onde.md)`;

type Call = { label: string; prompt: string; mode: string; access?: string; keepOpen?: boolean; statusDuringCall?: string };

/** Faux agents sans attente. `strict` : le Relecteur refuse toujours. */
function agents(opts: { strict?: boolean } = {}) {
  const calls: Call[] = [];
  const execute: typeof executeTask = async (deps, taskId, run) => {
    if (deps.journal.get(taskId)!.label === "plan") {
      // Clark choisit l'équipe habituelle pour un écrit.
      deps.journal.finish(taskId, "done", '{"standard": true}', 0);
      return { text: '{"standard": true}', costUsd: 0, status: "done" };
    }
    const task = deps.journal.get(taskId)!;
    calls.push({ label: task.label, prompt: run.prompt, mode: run.mode, access: run.access, keepOpen: run.keepOpen });
    deps.journal.setStatus(taskId, "running");
    let text: string;
    if (run.prompt.includes("Vérification en lecture seule")) {
      text = "#1 : PAS FAIT — brouillon-v1.md absent";
    } else if (task.label === "chercheur") {
      text = FACTS;
    } else if (task.label.startsWith("redacteur")) {
      const second = run.prompt.includes("Le Relecteur a demandé des corrections");
      text = `Relance Banque du Nord : merci pour l'entretien du ${second ? "25 ou 26 novembre (date à confirmer)" : "26 novembre"}.`;
    } else {
      const draft = run.prompt.split("Brouillon à relire :")[1] ?? "";
      text = opts.strict
        ? "VERDICT : À CORRIGER\n- Le ton reste trop formel.\n- Il manque les dates d'envoi."
        : /à confirmer/.test(draft)
          ? "VERDICT : OK\n- Entretien Banque du Nord : 25 ou 26 novembre selon la note, à confirmer."
          : "VERDICT : À CORRIGER\n- L'entretien Banque du Nord est daté du 25 ou du 26 novembre selon la note : ne pas affirmer le 26.";
    }
    // Comme les vrais moteurs : une étape « keepOpen » ne clôt pas la tâche.
    if (!run.keepOpen) deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  };
  return { execute, calls };
}

function setup(execute: typeof executeTask) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config, store, journal, conversation }, { execute });
  return { store, journal, conversation, hub };
}

const lastClark = (c: Conversation) => c.recent(OWNER_CHAT).filter((m) => m.role === "clark").at(-1)?.text ?? "";

// ── Scénario 1 : parcours complet ────────────────────────────────────────

test("équipe : le Chercheur cite les notes, le Relecteur signale le 25/26, le brouillon laisse la date à confirmer", async () => {
  const { execute, calls } = agents();
  const { hub, journal, conversation } = setup(execute);

  await hub.enqueue(OWNER_CHAT, "Prépare mes relances de candidature", TEAM_LABEL, "web");

  assert.deepEqual(calls.map((c) => c.label), ["chercheur", "redacteur:1", "relecteur:1", "redacteur:2", "relecteur:2"]);

  // Transmission : chaque agent reçoit le travail du précédent.
  assert.ok(calls[1].prompt.includes("note-2-banque-nord.md"), "le Rédacteur reçoit les faits du Chercheur");
  assert.ok(calls[2].prompt.includes("entretien du 26 novembre"), "le Relecteur reçoit le brouillon");
  assert.ok(calls[3].prompt.includes("daté du 25 ou du 26 novembre"), "la v2 reçoit les corrections du Relecteur");

  const final = lastClark(conversation);
  assert.match(final, /Brouillon validé par le Relecteur/);
  assert.match(final, /25 ou 26 novembre \(date à confirmer\)/);
  assert.match(final, /25 ou 26 novembre selon la note, à confirmer/);
  assert.equal(journal.get(1)!.status, "done");
  assert.ok(journal.children(1).every((c) => c.status === "done"));

  // Les sessions des agents ne remplacent pas celle de la conversation.
  assert.equal(conversation.recent(OWNER_CHAT)[0].text, "Prépare mes relances de candidature");
});

// ── Scénario 2 : coupure pendant une écriture ─────────────────────────────

test("équipe : coupure pendant l'écriture du Rédacteur → recherche conservée, écriture à vérifier, rien ne repart sans Charles", async () => {
  const { execute, calls } = agents();
  const { hub, journal, store } = setup(execute);

  // État laissé par une coupure : Chercheur terminé, Rédacteur en train d'écrire.
  const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Prépare mes relances de candidature");
  journal.setStatus(parent, "running");
  const chercheur = journal.create(OWNER_CHAT, "chercheur", "[consigne]", parent);
  journal.finish(chercheur, "done", FACTS, 0);
  const redacteur = journal.create(OWNER_CHAT, "redacteur:1", "[consigne du Rédacteur]", parent);
  journal.setStatus(redacteur, "running");
  journal.setSession(redacteur, "session-redacteur");
  journal.announceStep({ taskId: redacteur, toolUseId: "w1", tool: "Write", input: { file_path: "/ws/equipe/1/brouillon-v1.md" }, tier: "workspace" });
  store.setSession(OWNER_CHAT, "session-conversation");

  await hub.recover();

  assert.equal(calls.length, 0, "aucun agent ne repart tout seul");
  assert.equal(journal.get(parent)!.status, "needs_check");
  assert.equal(journal.get(chercheur)!.status, "done");
  assert.equal(journal.get(chercheur)!.result, FACTS, "le résultat de la recherche est conservé");
  assert.match(journal.get(parent)!.result!, /Déjà terminé, et conservé : Chercheur/);
  assert.match(journal.get(parent)!.result!, /Rédacteur était en train d'écrire/);
  assert.match(journal.get(parent)!.result!, /brouillon-v1\.md/);

  // L'interface montre l'arbre, avec le Rédacteur « à vérifier ».
  const view = snapshot(hub);
  assert.equal(view.checks.length, 1);
  assert.deepEqual(view.checks[0].team!.agents.map((a) => a.status), ["done", "needs_check", "waiting"]);
  assert.match(view.checks[0].uncertain[0], /brouillon-v1\.md/);

  // Charles reprend : le Chercheur n'est pas relancé. Le Rédacteur vérifie d'abord EN LECTURE SEULE
  // (droit imposé au moteur), puis reprend avec le droit d'écrire.
  assert.equal(hub.resolveCheck(parent, "resume"), "resumed");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    calls.slice(0, 2).map((c) => [c.label, c.mode, c.access, c.keepOpen ?? false]),
    [
      ["redacteur:1", "recovery", "read", true],
      ["redacteur:1", "recovery", "write", false],
    ],
  );
  assert.match(calls[0].prompt, /Vérification en lecture seule/);
  assert.match(calls[1].prompt, /Vérification terminée/);
  assert.equal(journal.steps(redacteur)[0].status, "verified");
  assert.ok(!calls.some((c) => c.label === "chercheur"), "le Chercheur n'est jamais relancé");
  assert.equal(journal.get(parent)!.status, "done");
  assert.equal(store.getSession(OWNER_CHAT), "session-conversation");
});

test("équipe : Abandonner arrête l'équipe et ses agents", async () => {
  const { execute, calls } = agents();
  const { hub, journal } = setup(execute);
  const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Prépare mes relances");
  journal.setStatus(parent, "running");
  const r = journal.create(OWNER_CHAT, "redacteur:1", "[consigne]", parent);
  journal.setStatus(r, "running");
  journal.setSession(r, "s");
  journal.announceStep({ taskId: r, toolUseId: "w1", tool: "Write", input: { file_path: "/ws/b.md" }, tier: "workspace" });
  await hub.recover();
  assert.equal(hub.resolveCheck(parent, "drop"), "abandoned");
  assert.equal(journal.get(parent)!.status, "abandoned");
  assert.equal(journal.get(r)!.status, "abandoned");
  assert.equal(calls.length, 0);
});

test("équipe : coupure pendant une lecture du Chercheur → l'équipe reprend seule", async () => {
  const { execute, calls } = agents();
  const { hub, journal } = setup(execute);
  const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Prépare mes relances");
  journal.setStatus(parent, "running");
  const c = journal.create(OWNER_CHAT, "chercheur", "[consigne]", parent);
  journal.setStatus(c, "running");
  journal.setSession(c, "s");
  journal.announceStep({ taskId: c, toolUseId: "r1", tool: "Read", input: { file_path: "/ws/a.md" }, tier: "workspace" });
  await hub.recover();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([calls[0].label, calls[0].mode, calls[0].access], ["chercheur", "recovery", "read"], "reprise seule, toujours en lecture seule");
  assert.equal(journal.get(parent)!.status, "done");
});

// ── Scénario 3 : limite de relecture ─────────────────────────────────────

test("équipe : après 2 relectures refusées, Clark s'arrête et montre brouillon, verdict et points ouverts", async () => {
  const { execute, calls } = agents({ strict: true });
  const { hub, conversation, journal } = setup(execute);
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");

  assert.deepEqual(calls.map((c) => c.label), ["chercheur", "redacteur:1", "relecteur:1", "redacteur:2", "relecteur:2"]);
  const final = lastClark(conversation);
  assert.match(final, /Brouillon arrêté après 2 relectures/);
  assert.match(final, /Relance Banque du Nord/, "le brouillon est affiché");
  assert.match(final, /Verdict du Relecteur :\*\* à corriger/);
  assert.match(final, /- Le ton reste trop formel\.\n- Il manque les dates d'envoi\./);
  assert.equal(journal.get(1)!.status, "done");
});

test("verdict du Relecteur : lu avec ou sans accent, illisible = à corriger", () => {
  assert.deepEqual(parseVerdict("ok.\nVERDICT : OK\n- à confirmer : x"), { ok: true, points: ["à confirmer : x"] });
  assert.equal(parseVerdict("Verdict: a corriger\n- y").ok, false);
  const none = parseVerdict("Ça me paraît bien.");
  assert.equal(none.ok, false);
  assert.match(none.points[0], /pas donné de verdict/);
});
