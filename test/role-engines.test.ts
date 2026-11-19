import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "./_wait.ts";
import { parseRoleEngines, type Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { TEAM_LABEL } from "../src/core/team.ts";
import { snapshot } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const base: Config = {
  telegram: null,
  hasApiKey: true,
  engine: "codex",
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

test("réglage : CLARK_ROLE_ENGINES lu et vérifié", () => {
  assert.deepEqual(parseRoleEngines("redacteur=codex, relecteur=Claude"), { redacteur: "codex", relecteur: "claude" });
  assert.deepEqual(parseRoleEngines(""), {});
  assert.throws(() => parseRoleEngines("graphiste=codex"), /rôle inconnu/);
  assert.throws(() => parseRoleEngines("relecteur=gpt"), /moteur inconnu/);
});

/** Un faux moteur qui note quels agents il a fait tourner. */
function fakeEngine(name: string, log: string[]) {
  const execute: typeof executeTask = async (deps, taskId, run) => {
    const t = deps.journal.get(taskId)!;
    log.push(`${name}:${t.label}`);
    deps.journal.setStatus(taskId, "running");
    const text = t.label === "plan" ? '{"standard": true}' : t.label.startsWith("relecteur") ? "VERDICT : OK" : `fait par ${name}`;
    if (!run.keepOpen) deps.journal.finish(taskId, "done", text, 0, run.attempt);
    return { text, costUsd: 0, status: "done" };
  };
  return execute;
}

function setup(roleEngines: Config["roleEngines"], available: ("claude" | "codex")[]) {
  const log: string[] = [];
  const executors = Object.fromEntries(available.map((n) => [n, fakeEngine(n, log)]));
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const hub = createHub(
    { config: { ...base, roleEngines }, store, journal, conversation: new Conversation(store.db) },
    { execute: executors.codex, executors },
  );
  return { hub, journal, log };
}

test("regard croisé : Codex cherche et rédige, Claude relit", async () => {
  const { hub, journal, log } = setup({ relecteur: "claude" }, ["codex", "claude"]);
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");
  assert.deepEqual(log, ["codex:plan", "codex:chercheur", "codex:redacteur:1", "claude:relecteur:1"]);
  assert.deepEqual(
    journal.children(1).map((c) => [c.label, c.engine]),
    [
      ["plan", "codex"],
      ["chercheur", "codex"],
      ["redacteur:1", "codex"],
      ["relecteur:1", "claude"],
    ],
    "chaque agent garde la trace de son moteur",
  );
});

test("moteur demandé indisponible : le moteur principal prend le relais, et l'interface le dit", async () => {
  const { hub, log } = setup({ relecteur: "claude" }, ["codex"]);
  assert.deepEqual(
    hub.roleEngines().find((r) => r.role === "relecteur"),
    { role: "relecteur", wanted: "claude", actual: "codex", special: true },
  );
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");
  assert.ok(log.includes("codex:relecteur:1"));
  assert.equal(snapshot(hub).clark.roleEngines.find((r) => r.role === "relecteur")!.actual, "codex");
});

test("reprise : un agent repart sur le moteur qui l'a commencé, même si le réglage a changé", async () => {
  const { hub, journal, log } = setup({}, ["codex", "claude"]); // réglage actuel : tout sur Codex
  const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Prépare mes relances");
  journal.setStatus(parent, "running");
  const plan = journal.create(OWNER_CHAT, "plan", "x", parent);
  journal.finish(plan, "done", '{"standard": true}', 0);
  const c = journal.create(OWNER_CHAT, "chercheur", "x", parent);
  journal.setStatus(c, "running");
  journal.setEngine(c, "claude");
  journal.setSession(c, "session-claude");
  journal.announceStep({ taskId: c, toolUseId: "r", tool: "Read", input: {}, tier: "workspace" });

  await hub.recover();
  await waitFor(() => log.length >= 2);
  assert.equal(log[0], "claude:chercheur", "repris sur Claude, pas sur Codex");
  assert.equal(log[1], "codex:redacteur:1", "les agents suivants suivent le réglage actuel");
});

test("reprise : moteur d'origine devenu indisponible → l'équipe s'arrête et le dit, sans changer de moteur en douce", async () => {
  const { hub, journal, log } = setup({}, ["codex"]);
  const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Prépare mes relances");
  journal.setStatus(parent, "running");
  const plan = journal.create(OWNER_CHAT, "plan", "x", parent);
  journal.finish(plan, "done", '{"standard": true}', 0);
  const c = journal.create(OWNER_CHAT, "chercheur", "[Équipe de Clark — Chercheur]", parent);
  journal.setStatus(c, "running");
  journal.setEngine(c, "claude");
  journal.setSession(c, "session-claude");
  journal.announceStep({ taskId: c, toolUseId: "r", tool: "Read", input: {}, tier: "workspace" });

  await hub.recover();
  await waitFor(() => journal.get(parent)!.status === "failed");
  assert.deepEqual(log, []);
  assert.equal(journal.get(parent)!.status, "failed");
  assert.match(journal.get(parent)!.result!, /moteur claude, qui n'est plus disponible/);
});

test("interface : le moteur de chaque agent est connu, même avant qu'il parte", async () => {
  const { hub, journal } = setup({ relecteur: "claude" }, ["codex", "claude"]);
  const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Prépare mes relances");
  journal.setStatus(parent, "running");
  const plan = journal.create(OWNER_CHAT, "plan", "x", parent);
  journal.finish(plan, "done", '{"standard": true}', 0);
  const agents = snapshot(hub).running[0].team!.agents;
  assert.deepEqual(
    agents.map((a) => [a.name, a.engine]),
    [
      ["Chercheur", "codex"],
      ["Rédacteur", "codex"],
      ["Relecteur", "claude"],
    ],
  );
});
