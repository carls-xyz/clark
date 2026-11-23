import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { loginCodexWithKey } from "../src/engines/codex.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = (): Config => ({ telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null });

function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const ran: string[] = [];
  const fake = (name: string) =>
    (async (deps: any, taskId: number) => {
      ran.push(name);
      deps.journal.finish(taskId, "done", `réponse de ${name}`, 0);
      return { text: `réponse de ${name}`, costUsd: 0, status: "done" };
    }) as unknown as typeof executeTask;
  const hub = createHub({ config: config(), store, journal, conversation }, { execute: fake("claude"), executors: { codex: fake("codex") } });
  hub.setConnection("claude", { ready: true, account: "abonnement", problem: null });
  hub.setConnection("codex", { ready: true, account: "ChatGPT", problem: null });
  hub.setCatalog("codex", { readAt: Date.now(), models: [{ id: "gpt-x", name: "GPT X", description: "", efforts: ["low"], defaultEffort: null }] });
  return { store, hub, ran };
}

test("moteur principal : changé à chaud, les tâches suivantes partent sur le nouveau", async () => {
  const { store, hub, ran } = setup();
  await hub.enqueue(OWNER_CHAT, "Salut", "chat", "web");
  assert.deepEqual(ran, ["claude"]);

  assert.equal(hub.setMainEngine("codex"), null);
  assert.equal(hub.deps.config.engine, "codex");
  assert.equal(hub.engine().name, "codex");
  assert.equal(hub.engine().account, "ChatGPT");
  await hub.enqueue(OWNER_CHAT, "Et maintenant ?", "chat", "web");
  assert.deepEqual(ran, ["claude", "codex"]);
  assert.ok(store.db.prepare("SELECT 1 FROM audit WHERE tool = 'engine_main'").get(), "le changement est tracé");

  // Retour sur Claude : son exécuteur de départ.
  assert.equal(hub.setMainEngine("claude"), null);
  await hub.enqueue(OWNER_CHAT, "Encore", "chat", "web");
  assert.deepEqual(ran, ["claude", "codex", "claude"]);
});

test("moteur principal : refusé s'il n'est pas connecté ; la liste ne propose que les connectés", () => {
  const { hub } = setup();
  hub.setConnection("codex", { ready: false, account: null, problem: "pas connecté" });
  assert.match(hub.setMainEngine("codex")!, /Codex n'est pas connecté/);
  assert.equal(hub.deps.config.engine, "claude");
  assert.deepEqual(hub.availableEngines(), ["codex", "claude"].filter((n) => n !== "codex"));
});

test("Codex par clé d'API : la clé passe par l'entrée standard, jamais en argument", () => {
  const calls: { args: string[]; input: string; home: string | undefined }[] = [];
  const run = ((cmd: string, args: string[], opts: any) => {
    calls.push({ args, input: opts.input, home: opts.env.CODEX_HOME });
    return { status: 0 };
  }) as any;
  assert.equal(loginCodexWithKey("sk-test-123", run), true);
  assert.deepEqual(calls[0].args, ["login", "--with-api-key"]);
  assert.equal(calls[0].input, "sk-test-123\n");
  assert.ok(!calls[0].args.join(" ").includes("sk-test"));
  assert.match(calls[0].home ?? "", /codex-home/);
  assert.equal(loginCodexWithKey("x", (() => ({ status: 1 })) as any), false);
});
