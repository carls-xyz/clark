import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { Conversation } from "../src/core/conversation.ts";
import { launchImprovement, proposeOne, sensitivePaths } from "../src/core/improve.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";
import type { Config } from "../src/config.ts";
import { openPullRequest, prDraft } from "../src/dev/groups.ts";

const NOW = new Date("2026-11-25T22:58:00Z");
const MIDNIGHT_PARIS = new Date("2026-11-25T23:00:00Z");

function setup() {
  const store = new Store(":memory:");
  const config: Config = {
    telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false,
    heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null,
  };
  const hub = createHub({ store, config, journal: new TaskJournal(store.db), conversation: new Conversation(store.db) });
  const add = (signature: string, count: number) => store.improve.upsertFiche({
    signature, source: "error", title: "Erreur récurrente", examples: ["Erreur récurrente : timeout"],
    before: { days: [{ day: "2026-11-24", count }], total: count },
  });
  return { hub, store, add };
}

test("propose la fiche la plus forte et garde le quota jusqu'à minuit à Paris", async () => {
  const { hub, store, add } = setup();
  add("faible", 5);
  add("forte", 10);
  const sent: unknown[] = [];
  hub.addChannel({
    name: "test",
    async deliver(message, improvement) {
      sent.push({ chat: message.chat_id, text: message.text, improvement });
    },
  });
  const fiche = proposeOne(hub, NOW)!;
  assert.equal(fiche.signature, "forte");
  assert.deepEqual(sent, [{
    chat: OWNER_CHAT,
    text: "Auto-amélioration : Erreur récurrente\nErreur récurrente : timeout\nAvant (10 occurrences) : 2026-11-24 : 10.",
    improvement: { id: fiche.id, proposedAt: fiche.updated_at },
  }]);
  assert.equal(proposeOne(hub, MIDNIGHT_PARIS), undefined, "une fiche est encore proposée");
  assert.equal(await hub.decideImprovement(fiche.id, "dismiss"), "done");
  assert.equal(store.improve.get(fiche.id)?.status, "dismissed");
  assert.equal(proposeOne(hub, NOW), undefined);
  assert.equal(proposeOne(hub, MIDNIGHT_PARIS)?.signature, "faible");
});

test("le sommeil dure trois jours et un ancien bouton ne peut pas décider sur la nouvelle proposition", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { hub, store, add } = setup();
  add("sommeil", 5);
  const fiche = proposeOne(hub, NOW)!;
  assert.equal(await hub.decideImprovement(fiche.id, "snooze", fiche.updated_at), "done");
  assert.equal(store.improve.get(fiche.id)?.status, "snoozed");
  const end = NOW.getTime() + 3 * 86_400_000;
  assert.equal(proposeOne(hub, new Date(end - 1)), undefined);
  const reproposed = proposeOne(hub, new Date(end))!;
  assert.equal(reproposed.id, fiche.id);
  assert.equal(await hub.decideImprovement(fiche.id, "launch", fiche.updated_at), "already");
  const launch = hub.decideImprovement(fiche.id, "launch", reproposed.updated_at);
  assert.equal(await hub.decideImprovement(fiche.id, "dismiss", reproposed.updated_at), "done");
  assert.equal(await launch, "already");
  assert.equal(proposeOne(hub, new Date(end + 86_400_000)), undefined);
});

test("Lancer exige le projet clark et lie la fiche à un binôme sans pilote automatique", async () => {
  const { hub, store, add } = setup();
  add("timeout", 5);
  add("autre", 4);
  const fiche = proposeOne(hub, NOW)!;
  assert.deepEqual(await hub.decideImprovement(fiche.id, "launch"), { error: "Projet dev « clark » introuvable." });
  assert.equal(store.improve.get(fiche.id)?.status, "proposed");

  store.dev.addProject({ name: "autre", path: "/autre", baseBranch: "main" });
  const projectId = store.dev.addProject({ name: "clark", path: "/clark", baseBranch: "main" });
  const result = launchImprovement(hub, fiche, NOW, (_hub, input) => {
    assert.equal(input.projectId, projectId);
    assert.equal(input.binome, true);
    assert.match(input.title!, /^Auto-amélioration : /);
    assert.match(input.instruction, /timeout[\s\S]*Avant \(5 occurrences\)[\s\S]*TEST[\s\S]*ne doit plus réapparaître/);
    const id = store.dev.createGroup({ ...input, title: input.title!, engine: "claude", planWorktree: "/plan" });
    store.dev.updateGroup(id, { mode: "binome" });
    const taskId = store.dev.create({
      projectId, title: "Corriger", instruction: input.instruction, engine: "codex",
      branch: "clark/corriger", worktree: "/copie",
    });
    store.dev.setGroup(taskId, id);
    return { ok: true, id };
  });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(store.dev.group(result.id)?.autopilot, 0);
  assert.equal(store.dev.groupTasks(result.id)[0].autopilot, 0);
  assert.equal(store.improve.get(fiche.id)?.group_id, result.id);
  assert.equal(store.improve.get(fiche.id)?.status, "launched");
  assert.equal(store.improve.get(fiche.id)?.decided_at, "2026-11-25 22:58:00");
  assert.equal(await hub.decideImprovement(fiche.id, "launch"), "already");
  assert.equal(proposeOne(hub, MIDNIGHT_PARIS), undefined);
});

test("les chemins des sites sensibles, des accords et de la politique sont signalés", () => {
  assert.deepEqual(
    sensitivePaths(["src/policy/x.ts", "src/browser/sensitive.ts", "src/core/hub.ts", "src/core/health.ts"]),
    ["src/policy/x.ts", "src/browser/sensitive.ts", "src/core/hub.ts"],
  );
});

test("la PR d'auto-amélioration garde l'avertissement donné par le diff réuni", async (t) => {
  const { hub, store } = setup();
  const projectId = store.dev.addProject({ name: "clark", path: "/clark", baseBranch: "main" });
  const title = "Auto-amélioration : Erreur récurrente";
  const id = store.dev.createGroup({ projectId, title, instruction: "Corriger l'erreur", engine: "claude", planWorktree: "/plan" });
  store.dev.updateGroup(id, { status: "integrated", branch: "clark/reunion" });
  let paths = "src/policy/x.ts\0src/core/health.ts\0";
  const diff = t.mock.method(childProcess, "execFileSync", (program: string, args: string[]) => {
    assert.equal(program, "git");
    assert.deepEqual(args, ["diff", "--name-only", "--no-renames", "-z", "refs/heads/main...refs/heads/clark/reunion", "--"]);
    return paths;
  });
  syncBuiltinESMExports();
  try {
    const draft = prDraft(hub, "group", id)!;
    assert.equal(draft.title, title);
    assert.match(draft.body, /^⚠️ Sensible :/);
    assert.deepEqual(await openPullRequest(hub, "group", id, { title, body: "Correctif" }), {
      error: "Garde la mention « ⚠️ Sensible : » au début de la description.",
    });
    paths = "src/core/health.ts\0";
    assert.match(prDraft(hub, "group", id)!.body, /^Corriger l'erreur/);
  } finally {
    diff.mock.restore();
    syncBuiltinESMExports();
  }
});
