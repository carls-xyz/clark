import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Bot } from "grammy";
import { Conversation } from "../src/core/conversation.ts";
import { createHub } from "../src/core/hub.ts";
import { createTelegram } from "../src/gateway/telegram.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { createPolicy } from "../src/policy/permissions.ts";
import { planRecovery, TaskJournal } from "../src/tasks/journal.ts";
import type { Config } from "../src/config.ts";

const ROOTS = ["/tmp/clark-ws"];

function setup(path = ":memory:") {
  const store = new Store(path);
  return { store, journal: new TaskJournal(store.db) };
}

function runningTask(journal: TaskJournal) {
  const id = journal.create(1, "chat", "Fais le point sur mes candidatures");
  journal.setStatus(id, "running");
  journal.setSession(id, "sess");
  return id;
}

// ── 1. Écriture sans validation ≠ outil sans effet ───────────────────────

test("coupure pendant un Write dans le workspace : vérification, pas de reprise automatique", async () => {
  const { store, journal } = setup();
  const id = runningTask(journal);
  const policy = createPolicy({ store, journal, taskId: id, roots: ROOTS, approve: async () => assert.fail("pas de bouton attendu") });
  const decision = await policy("Write", { file_path: "/tmp/clark-ws/relances.md", content: "…" }, {
    signal: new AbortController().signal,
    toolUseID: "w1",
  } as Parameters<typeof policy>[2]);
  assert.equal(decision?.behavior, "allow"); // toujours sans bouton en temps normal

  const plan = planRecovery(journal.get(id)!, journal.steps(id));
  assert.equal(plan.action, "check");
  assert.equal(plan.action === "check" && plan.uncertain[0].tool, "Write");
});

test("coupure pendant memory.remember : vérification", () => {
  const { journal } = setup();
  const id = runningTask(journal);
  journal.announceStep({ taskId: id, toolUseId: "m1", tool: "mcp__memory__remember", input: { kind: "fact", content: "Relance Studio Pixel le 2026-11-20" }, tier: "auto" });
  const plan = planRecovery(journal.get(id)!, journal.steps(id));
  assert.equal(plan.action, "check");
});

test("coupure pendant des lectures (fichier, web, recall) : reprise automatique", () => {
  const { journal } = setup();
  const id = runningTask(journal);
  for (const [i, tool] of ["Read", "Grep", "WebFetch", "mcp__memory__recall"].entries()) {
    journal.announceStep({ taskId: id, toolUseId: `r${i}`, tool, input: {}, tier: "auto" });
  }
  assert.equal(planRecovery(journal.get(id)!, journal.steps(id)).action, "resume");
});

test("écriture terminée avant la coupure : reprise automatique", () => {
  const { journal } = setup();
  const id = runningTask(journal);
  journal.announceStep({ taskId: id, toolUseId: "w2", tool: "Write", input: { file_path: "/tmp/clark-ws/a.md" }, tier: "workspace" });
  journal.completeStep("w2", "écrit", false);
  assert.equal(planRecovery(journal.get(id)!, journal.steps(id)).action, "resume");
});

test("un outil inconnu est traité comme une écriture", () => {
  const { journal } = setup();
  const id = runningTask(journal);
  journal.announceStep({ taskId: id, toolUseId: "x1", tool: "mcp__gmail__send", input: {}, tier: "ask" });
  assert.equal(journal.steps(id)[0].effect, "write");
});

test("une base créée avant la colonne effect est migrée en « write » par prudence", () => {
  const store = new Store(":memory:");
  store.db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, label TEXT NOT NULL, prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', session_id TEXT, result TEXT, cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE steps (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, tool_use_id TEXT NOT NULL UNIQUE, tool TEXT NOT NULL,
    input TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL, output TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO tasks (chat_id, label, prompt, status, session_id) VALUES (1, 'chat', 'ancienne', 'running', 's');
    INSERT INTO steps (task_id, tool_use_id, tool, input, tier, status) VALUES (1, 'old', 'Read', '{}', 'workspace', 'running');`);
  const journal = new TaskJournal(store.db);
  assert.equal(journal.steps(1)[0].effect, "write");
  assert.equal(planRecovery(journal.get(1)!, journal.steps(1)).action, "check");
});

// ── 2. Coupure brutale du processus (SIGKILL) ────────────────────────────

test("SIGKILL au milieu d'une écriture : le journal survit et la tâche part en vérification", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-kill-"));
  const db = join(dir, "clark.db");
  try {
    const child = spawnSync(process.execPath, [resolve(import.meta.dirname, "../test-support/crash-child.ts"), db], { encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", child.stderr);

    const { store, journal } = setup(db);
    const [task] = journal.unfinished();
    assert.ok(task, "la tâche coupée doit être retrouvée");
    const steps = journal.steps(task.id);
    assert.deepEqual(steps.map((s) => [s.tool, s.status]), [["Read", "done"], ["Write", "running"]]);
    assert.equal(planRecovery(task, steps).action, "check");
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. L'alerte « à vérifier » ne se perd pas ─────────────────────────────

const config: Config = {
  telegram: { token: "123:test", ownerId: 1 },
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

/** Bot dont l'API est simulée : aucun appel réseau. `fail` fait échouer les envois. */
const telegramOwner = { id: 1, is_bot: false as const, first_name: "Charles" };
const telegramBot = { id: 2, is_bot: true as const, first_name: "Clark", username: "clark_bot" };
const telegramChat = { id: 1, type: "private" as const, first_name: "Charles" };

function fakeBot() {
  const bot = new Bot(config.telegram!.token);
  const sent: { text: string; buttons: string[]; forceReply: boolean }[] = [];
  const state = { fail: false };
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe") return { ok: true, result: telegramBot } as never;
    if (method !== "sendMessage") return { ok: true, result: true } as never;
    if (state.fail) throw new Error("réseau coupé");
    const p = payload as { text: string; reply_markup?: { inline_keyboard?: { callback_data: string }[][]; force_reply?: boolean } };
    sent.push({ text: p.text, buttons: (p.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data), forceReply: Boolean(p.reply_markup?.force_reply) });
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 1, type: "private" } } } as never;
  });
  return { bot, sent, state };
}

function telegramMessage(bot: Bot, id: number, text: string, replyTo?: number) {
  return bot.handleUpdate({
    update_id: id,
    message: {
      message_id: id,
      chat: telegramChat,
      from: telegramOwner,
      date: 0,
      text,
      ...(text === "/taches" ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.length }] } : {}),
      ...(replyTo === undefined ? {} : {
        reply_to_message: { message_id: replyTo, chat: telegramChat, from: telegramBot, date: 0, text: "Une question", reply_to_message: undefined },
      }),
    },
  });
}

/** Hub + canal Telegram simulé, comme au démarrage de Clark. */
function startWith(store: Store, journal: TaskJournal, bot: Bot) {
  const hub = createHub({ config, store, journal, conversation: new Conversation(store.db) });
  createTelegram(hub, { ...config.telegram!, bot });
  return hub;
}

test("Telegram : une réponse libre rejoint la bonne question et une ancienne réponse ne lance pas de tâche", async () => {
  const { store, journal } = setup();
  try {
    const { bot, sent } = fakeBot();
    startWith(store, journal, bot);
    await bot.init();
    const task = runningTask(journal);
    const first = store.questions.ask({ taskId: task, question: "Quelle cible ?" });
    const second = store.questions.ask({ taskId: task, question: "Quel ton ?", options: ["Direct", "Formel"] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstMessage = sent.findIndex((message) => message.forceReply) + 1;
    const secondMessage = sent.findIndex((message) => message.buttons.includes(`qa:${second}:0`)) + 1;
    assert.ok(firstMessage);
    assert.ok(secondMessage);
    assert.deepEqual(sent[secondMessage - 1].buttons, [`qa:${second}:0`, `qa:${second}:1`]);

    await telegramMessage(bot, 200, "Recruteurs front", firstMessage);
    assert.equal(store.questions.get(first)?.answer, "Recruteurs front");
    assert.equal(store.questions.get(second)?.status, "pending");
    await telegramMessage(bot, 201, "Simple et chaleureux", secondMessage);
    assert.equal(store.questions.get(second)?.answer, "Simple et chaleureux");
    await telegramMessage(bot, 202, "Autre réponse", firstMessage);
    assert.match(sent.at(-1)?.text ?? "", /n'attend plus de réponse/);
    assert.equal(journal.unfinished().length, 1);

    // Une commande envoyée en réponse à une question reste une commande, pas une réponse.
    const third = store.questions.ask({ taskId: task, question: "Quelle date ?" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const thirdMessage = sent.length;
    await telegramMessage(bot, 203, "/taches", thirdMessage);
    assert.equal(store.questions.get(third)?.status, "pending", "la question attend toujours");
  } finally {
    store.db.close();
  }
});

test("Telegram : /taches affiche l'avancement de l'équipe et conserve les boutons de vérification", async () => {
  const { store, journal } = setup();
  try {
    const { bot, sent } = fakeBot();
    startWith(store, journal, bot);
    await bot.init();
    const check = journal.create(1, "chat", "Relance à vérifier");
    journal.finish(check, "needs_check", "Relance à vérifier", 0);
    const team = journal.create(1, "team", "Revue du portfolio");
    journal.setStatus(team, "running");
    const plan = journal.create(1, "plan", "Plan", team);
    journal.setStatus(plan, "running");
    memoryTools(store, { taskId: () => plan, writeRefusal: () => null }).report_progress.run({ note: "Je choisis les spécialistes" });
    await telegramMessage(bot, 200, "/taches");
    assert.deepEqual(sent[0].buttons, [`task:resume:${check}`, `task:drop:${check}`]);
    assert.match(sent[1].text, /Revue du portfolio/);
    assert.match(sent[1].text, /Clark \(plan\) · en cours — Je choisis les spécialistes/);
  } finally {
    store.db.close();
  }
});

test("alerte non envoyée au démarrage : renvoyée au démarrage suivant, avec ses boutons", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-alert-"));
  const db = join(dir, "clark.db");
  try {
    // Démarrage 1 : une écriture coupée, mais Telegram est injoignable.
    {
      const { store, journal } = setup(db);
      const id = runningTask(journal);
      journal.announceStep({ taskId: id, toolUseId: "w", tool: "Write", input: { file_path: "/tmp/clark-ws/r.md" }, tier: "workspace" });
      const { bot, sent, state } = fakeBot();
      state.fail = true;
      await startWith(store, journal, bot).recover();
      assert.equal(sent.length, 0);
      assert.equal(journal.get(id)!.status, "needs_check");
      assert.equal(journal.get(id)!.alerted_at, null);
      store.db.close();
    }
    // Démarrage 2 : Telegram répond, l'alerte part, une seule fois.
    {
      const { store, journal } = setup(db);
      const { bot, sent } = fakeBot();
      await startWith(store, journal, bot).recover();
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /relances|r\.md/);
      assert.deepEqual(sent[0].buttons, ["task:resume:1", "task:drop:1"]);
      assert.ok(journal.get(1)!.alerted_at);
      store.db.close();
    }
    // Démarrage 3 : déjà alertée, rien n'est renvoyé.
    {
      const { store, journal } = setup(db);
      const { bot, sent } = fakeBot();
      await startWith(store, journal, bot).recover();
      assert.equal(sent.length, 0);
      store.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arrêt entre l'enregistrement de needs_check et l'envoi : l'alerte part au démarrage", async () => {
  const { store, journal } = setup();
  const id = journal.create(1, "chat", "x");
  journal.finish(id, "needs_check", "Cette écriture a peut-être déjà eu lieu : Write r.md", 0); // puis arrêt
  const { bot, sent } = fakeBot();
  await startWith(store, journal, bot).recover();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Write r\.md/);
});

test("repasser en needs_check réarme l'alerte", () => {
  const { journal } = setup();
  const id = journal.create(1, "chat", "x");
  journal.finish(id, "needs_check", "a", 0);
  journal.markAlerted(id);
  journal.setStatus(id, "running"); // clic « Reprendre »
  journal.finish(id, "needs_check", "b", 0); // nouvelle coupure
  assert.equal(journal.get(id)!.alerted_at, null);
  assert.deepEqual(journal.unalerted().map((t) => t.id), [id]);
});
