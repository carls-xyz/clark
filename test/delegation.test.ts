import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { startDelegations } from "../src/core/delegation-runner.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null } as Config;

test("chef d'orchestre : Clark confie une mission à Mousse, attend sa réponse, qui s'affiche signée", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: { prompt: string; access?: string; parent: number | null }[] = [];
  const execute = (async (_d, taskId, opts) => {
    runs.push({ prompt: opts.prompt, access: opts.access, parent: journal.get(taskId)!.parent_id });
    journal.finish(taskId, "done", "Studio Pixel : relance prévue le 20/11 (note-1).", 0);
    return { text: "Studio Pixel : relance prévue le 20/11 (note-1).", costUsd: 0, status: "done" as const };
  }) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute } });
  const stop = startDelegations(hub);
  const clarkTask = journal.create(OWNER_CHAT, "chat", "Où en est Studio Pixel ?");
  journal.setSource(clarkTask, "web");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Où en est Studio Pixel ?", taskId: clarkTask });
  const t = memoryTools(store, { taskId: () => clarkTask, writeRefusal: () => null });
  const answer = await t.delegate.run({ agent: "chercheur", mission: "Trouve où en est la candidature Studio Pixel dans les notes." });
  assert.match(answer, /^Réponse de Mousse \(Recherche\) :\nStudio Pixel : relance prévue/);
  assert.match(runs[0].prompt, /^\[Mission de Clark — Mousse\]\nTu es Mousse, le Chercheur/);
  assert.equal(runs[0].access, "read");
  assert.equal(runs[0].parent, clarkTask, "sous-tâche de la demande de Clark");
  const signed = conversation.messagesOf(conversation.current(OWNER_CHAT)).find((m) => m.agent === "chercheur");
  assert.equal(signed?.text, "Studio Pixel : relance prévue le 20/11 (note-1).");
  // Un agent en discussion directe ne peut pas déléguer.
  const direct = journal.create(OWNER_CHAT, "chat", "[Discussion directe — Mousse]\nbonjour");
  assert.match(await memoryTools(store, { taskId: () => direct, writeRefusal: () => null }).delegate.run({ agent: "redacteur", mission: "écris quelque chose de long" }), /^Refusé/);
  // Code sans projet ajouté : Clark le dit au lieu de coder lui-même.
  assert.match(await t.start_code_task.run({ instruction: "Corrige le bug des dossiers du portfolio" }), /Aucun projet de code/);
  stop();
});
