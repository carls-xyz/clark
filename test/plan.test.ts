import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "./_wait.ts";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { nextBatch, parsePlan, stepLabel, type PlanStep } from "../src/core/plan.ts";
import { createTeam, StaleAttempt, TEAM_LABEL } from "../src/core/team.ts";
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

/** Le plan de la recette : deux analyses indépendantes, puis le Relecteur qui attend les deux. */
const PORTFOLIO_PLAN = `Voici l'équipe.
\`\`\`json
{"steps": [
  {"key": "a11y", "role": "temporaire", "name": "Spécialiste Accessibilité", "mission": "Auditer contrastes, navigation clavier et textes alternatifs", "deliverable": "Liste des problèmes d'accessibilité, par gravité", "dependsOn": []},
  {"key": "contenu", "role": "contenu", "name": "x", "mission": "", "deliverable": "Liste des textes à reprendre", "dependsOn": []},
  {"key": "revue", "role": "relecteur", "name": "x", "mission": "Prioriser les corrections des deux rapports", "deliverable": "Corrections priorisées", "dependsOn": ["a11y", "contenu"]}
]}
\`\`\``;

// ── Lecture et vérification du plan ──────────────────────────────────────

test("plan : spécialistes, dépendances, et droits fixés par le code", () => {
  const plan = parsePlan(PORTFOLIO_PLAN);
  assert.equal(plan.kind, "graph");
  if (plan.kind !== "graph") return;
  assert.deepEqual(
    plan.steps.map((s) => [s.key, s.name, s.access, s.dependsOn]),
    [
      ["a11y", "Spécialiste Accessibilité", "read", []],
      ["contenu", "Spécialiste Contenu", "read", []],
      ["revue", "Relecteur", "read", ["a11y", "contenu"]],
    ],
  );
  // Un spécialiste temporaire ne peut pas se donner le droit d'écrire, même si le plan le prétend.
  const sneaky = parsePlan(`{"steps":[{"key":"x","role":"temporaire","name":"Pirate","mission":"écrire partout","deliverable":"fichiers","access":"write","dependsOn":[]}]}`);
  assert.equal(sneaky.kind === "graph" && sneaky.steps[0].access, "read");
  const writer = parsePlan(`{"steps":[{"key":"r","role":"redacteur","deliverable":"brouillon","dependsOn":[]}]}`);
  assert.equal(writer.kind === "graph" && writer.steps[0].access, "write");
});

test("plan : illisible, en boucle ou incohérent → équipe habituelle, avec la raison", () => {
  assert.deepEqual(parsePlan(`{"standard": true}`).kind, "standard");
  assert.match((parsePlan("je ne sais pas") as { reason: string }).reason, /illisible/);
  const cycle = `{"steps":[{"key":"a","role":"chercheur","deliverable":"x","dependsOn":["b"]},{"key":"b","role":"chercheur","deliverable":"y","dependsOn":["a"]}]}`;
  assert.match((parsePlan(cycle) as { reason: string }).reason, /boucle/);
  const unknown = `{"steps":[{"key":"a","role":"chercheur","deliverable":"x","dependsOn":["zz"]}]}`;
  assert.match((parsePlan(unknown) as { reason: string }).reason, /inconnu/);
  const many = JSON.stringify({ steps: Array.from({ length: 7 }, (_, i) => ({ key: `s${i}`, role: "chercheur", deliverable: "x", dependsOn: [] })) });
  assert.match((parsePlan(many) as { reason: string }).reason, /plus de 6/);
});

test("parallélisme : deux en lecture seule au plus, un rédacteur part seul, les dépendances attendent", () => {
  const s = (key: string, access: "read" | "write", dependsOn: string[] = []): PlanStep => ({ key, role: "temporaire", name: key, mission: "m", deliverable: "d", dependsOn, access });
  const steps = [s("a", "read"), s("b", "read"), s("c", "read"), s("w", "write"), s("z", "read", ["a", "b"])];
  assert.deepEqual(nextBatch(steps, new Set(), new Set()).map((x) => x.key), ["a", "b"], "deux lecteurs");
  assert.deepEqual(nextBatch(steps, new Set(["a", "b", "c"]), new Set()).map((x) => x.key), ["z"], "z attend a et b");
  assert.deepEqual(nextBatch([s("w", "write"), s("v", "write")], new Set(), new Set()).map((x) => x.key), ["w"], "un rédacteur à la fois");
});

// ── La recette : revue de portfolio ──────────────────────────────────────

type Call = RunOptions & { label: string; startedAt: number; endedAt?: number };

/** Faux agents : le plan de la recette, des analyses qui prennent un peu de temps, une synthèse. */
function portfolioAgents() {
  const calls: Call[] = [];
  const execute: typeof executeTask = async (deps, taskId, run) => {
    const t = deps.journal.get(taskId)!;
    const call: Call = { ...run, label: t.label, startedAt: Date.now() };
    calls.push(call);
    deps.journal.setStatus(taskId, "running");
    let text = "";
    if (t.label === "plan") text = PORTFOLIO_PLAN;
    else if (t.label === stepLabel("a11y")) {
      await new Promise((r) => setTimeout(r, 40));
      text = "A11Y : contraste insuffisant sur la page Projets (source : app/globals.css)";
    } else if (t.label === stepLabel("contenu")) {
      await new Promise((r) => setTimeout(r, 40));
      text = "CONTENU : la page À propos est trop longue (source : app/a-propos/page.tsx)";
    } else if (t.label === stepLabel("revue")) text = "1. Contraste (bloquant) 2. Page À propos";
    else if (t.label === "synthese") text = "Trouvé : contraste et longueur. À trancher : refonte de la page À propos ?";
    call.endedAt = Date.now();
    deps.journal.finish(taskId, "done", text, 0, run.attempt);
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

test("recette : Accessibilité (créé pour l'occasion) et Contenu en parallèle, le Relecteur attend les deux", async () => {
  const { execute, calls } = portfolioAgents();
  const { hub, journal, conversation } = setup(execute);
  await hub.enqueue(OWNER_CHAT, "Fais une revue de mon portfolio", TEAM_LABEL, "web");

  assert.deepEqual(calls.map((c) => c.label), ["plan", "node:a11y", "node:contenu", "node:revue", "synthese"]);
  const [a11y, contenu, revue] = [calls[1], calls[2], calls[3]];
  assert.ok(contenu.startedAt < a11y.endedAt!, "les deux analyses ont tourné en même temps");
  assert.ok(revue.startedAt >= Math.max(a11y.endedAt!, contenu.endedAt!), "le Relecteur part après les deux");
  assert.match(revue.prompt, /A11Y : contraste/);
  assert.match(revue.prompt, /CONTENU : la page À propos/);
  assert.ok(calls.every((c) => c.access === "read"), "tout le monde en lecture seule, Clark compris");
  assert.match(a11y.prompt, /spécialiste créé par Clark pour cette mission/);

  const final = conversation.recent(OWNER_CHAT).filter((m) => m.role === "clark").at(-1)!.text;
  assert.match(final, /Équipe :\*\* Spécialiste Accessibilité \(temporaire\), Spécialiste Contenu, Relecteur/);
  assert.match(final, /À trancher/);
  assert.equal(journal.get(1)!.status, "done");
});

test("recette : coupure avec un seul rapport prêt → rapport gardé, l'autre analyse reprise, relecture après les deux", async () => {
  const { execute, calls } = portfolioAgents();
  const { hub, journal } = setup(execute);

  // État laissé par la coupure : plan fait, Accessibilité rendue, Contenu en pleine lecture.
  const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Fais une revue de mon portfolio");
  journal.setStatus(parent, "running");
  const plan = journal.create(OWNER_CHAT, "plan", "[Équipe de Clark — Plan]", parent);
  journal.finish(plan, "done", PORTFOLIO_PLAN, 0);
  const a11y = journal.create(OWNER_CHAT, "node:a11y", "[Équipe de Clark — Spécialiste Accessibilité]\n…", parent);
  journal.finish(a11y, "done", "A11Y : contraste insuffisant (rapport d'avant la coupure)", 0);
  const contenu = journal.create(OWNER_CHAT, "node:contenu", "[Équipe de Clark — Spécialiste Contenu]\n…", parent);
  journal.setStatus(contenu, "running");
  journal.setSession(contenu, "session-contenu");
  const oldAttempt = journal.startAttempt(contenu);
  journal.announceStep({ taskId: contenu, toolUseId: "r1", tool: "Read", input: { file_path: "/portfolio/app/page.tsx" }, tier: "ask" });

  // L'interface montre où en est l'équipe avant la reprise.
  const view = snapshot(hub).running[0].team!;
  assert.deepEqual(view.agents.map((a) => [a.name, a.status]), [
    ["Spécialiste Accessibilité", "done"],
    ["Spécialiste Contenu", "running"],
    ["Relecteur", "waiting"],
    ["Synthèse de Clark", "waiting"],
  ]);

  await hub.recover();
  await waitFor(() => calls.length >= 3);

  assert.deepEqual(calls.map((c) => c.label), ["node:contenu", "node:revue", "synthese"], "ni le plan ni Accessibilité ne sont refaits");
  assert.equal(calls[0].mode, "recovery");
  assert.equal(calls[0].resume, "session-contenu", "Contenu reprend sa propre session");
  assert.notEqual(calls[0].attempt, oldAttempt, "nouvelle tentative, nouvel identifiant");
  assert.match(calls[1].prompt, /rapport d'avant la coupure/, "le rapport gardé est transmis au Relecteur");
  assert.match(calls[1].prompt, /CONTENU : la page À propos/);
  assert.equal(journal.get(parent)!.status, "done");
  assert.equal(journal.steps(contenu)[0].attempt, oldAttempt, "l'étape coupée reste rattachée à son ancienne tentative");
});

test("tentatives : le résultat tardif d'une ancienne tentative n'est jamais pris", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  let replaced = false;
  const execute: typeof executeTask = async (deps, taskId, run) => {
    const t = deps.journal.get(taskId)!;
    if (t.label === "plan") {
      deps.journal.finish(taskId, "done", PORTFOLIO_PLAN, 0, run.attempt);
      return { text: PORTFOLIO_PLAN, costUsd: 0, status: "done" };
    }
    if (!replaced && t.label === "node:a11y") {
      // Pendant que cette tentative tourne, une autre prend la tâche (relance, reprise…).
      replaced = true;
      deps.journal.startAttempt(taskId);
    }
    const text = t.label === "node:a11y" ? "résultat périmé" : "rapport légitime";
    const applied = deps.journal.finish(taskId, "done", text, 0, run.attempt);
    assert.equal(applied, t.label !== "node:a11y", "seule la clôture de la tentative en cours est acceptée");
    return { text, costUsd: 0, status: "done" };
  };
  const team = createTeam({ deps: { config, store, journal }, execute, approverFor: () => async () => false });
  const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Revue de portfolio");
  await assert.rejects(team.run(parent), StaleAttempt);
  const a11y = journal.children(parent).find((c) => c.label === "node:a11y")!;
  assert.notEqual(a11y.result, "résultat périmé");
  assert.notEqual(a11y.status, "done", "la tâche n'est pas close par l'ancienne tentative");
  assert.equal(journal.children(parent).find((c) => c.label === "node:contenu")!.result, "rapport légitime", "l'autre agent du lot n'est pas touché");
});
