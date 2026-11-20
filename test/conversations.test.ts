import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation, NEW_CONVERSATION_NOTE } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
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
} as Config;

function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config, store, journal, conversation }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as typeof executeTask });
  return { store, journal, conversation, hub };
}

test("conversations : l'ancien fil unique est découpé à chaque « Nouvelle conversation »", () => {
  const db = new DatabaseSync(":memory:");
  // Base d'avant : messages sans conversation.
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, task_id INTEGER, source TEXT, kind TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const ins = db.prepare("INSERT INTO messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)");
  ins.run(1, "user", "Premier sujet", "2026-11-10 09:00:00");
  ins.run(1, "clark", "Réponse 1", "2026-11-10 09:01:00");
  ins.run(1, "system", NEW_CONVERSATION_NOTE, "2026-11-11 10:00:00");
  ins.run(1, "user", "Deuxième sujet", "2026-11-11 10:01:00");
  const c = new Conversation(db);
  const list = c.list(1);
  assert.deepEqual(list.map((x) => x.title), ["Deuxième sujet", "Premier sujet"]);
  assert.equal(c.current(1), list[0].id, "la dernière reste l'ouverte");
  assert.deepEqual(c.messagesOf(list[1].id).map((m) => m.text), ["Premier sujet", "Réponse 1"]);
});

test("conversations : une nouvelle conversation vide resert, une utilisée part dans la liste", () => {
  const { conversation } = setup();
  const first = conversation.current(OWNER_CHAT);
  assert.equal(conversation.startNew(OWNER_CHAT), first, "rien écrit : pas de conversation vide en plus");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "  Prépare   mes relances  " });
  const second = conversation.startNew(OWNER_CHAT);
  assert.notEqual(second, first);
  assert.deepEqual(conversation.list(OWNER_CHAT).map((x) => x.title), ["Prépare mes relances"], "titre = premier message, espaces réduits");
});

test("conversations : la réponse d'une tâche reste dans la conversation où elle a été demandée", () => {
  const { conversation, journal } = setup();
  const taskId = journal.create(OWNER_CHAT, "chat", "question");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "question", taskId });
  const asked = conversation.current(OWNER_CHAT);
  conversation.startNew(OWNER_CHAT);
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "réponse", taskId });
  assert.deepEqual(conversation.messagesOf(asked).map((m) => m.text), ["question", "réponse"]);
  assert.deepEqual(conversation.messagesOf(conversation.current(OWNER_CHAT)), []);
});

test("conversations : rouvrir une conversation rend sa session à l'agent, et garde celle qu'on quitte", async () => {
  const { conversation, store, hub, journal } = setup();
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Sujet A" });
  const a = conversation.current(OWNER_CHAT);
  store.setSession(OWNER_CHAT, "session-a");
  await hub.newConversation();
  assert.equal(store.getSession(OWNER_CHAT), null, "nouvelle conversation : session neuve");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Sujet B" });
  const b = conversation.current(OWNER_CHAT);
  store.setSession(OWNER_CHAT, "session-b");

  assert.equal(hub.switchConversation(a), "ok");
  assert.equal(conversation.current(OWNER_CHAT), a);
  assert.equal(store.getSession(OWNER_CHAT), "session-a");
  assert.equal(conversation.conversation(b)?.session_id, "session-b");

  // Une demande en cours : on ne change pas (sa fin écrirait la session au mauvais endroit).
  journal.create(OWNER_CHAT, "chat", "en cours");
  assert.equal(hub.switchConversation(b), "busy");
  assert.equal(hub.switchConversation(9999), "unknown");
});

test("agents comme contacts : écrire au Chercheur l'envoie à lui, en lecture seule, dans sa conversation", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: { prompt: string; access?: string }[] = [];
  const execute = (async (_deps, taskId, opts) => {
    runs.push({ prompt: opts.prompt, access: opts.access });
    journal.finish(taskId, "done", "Ici le Chercheur.", 0);
    return { text: "Ici le Chercheur.", costUsd: 0, status: "done" as const };
  }) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute } });
  const { submitRequest } = await import("../src/core/submit.ts");

  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Sujet avec Clark" });
  const clarkConv = conversation.current(OWNER_CHAT);
  assert.equal(hub.openAgent("chercheur").result, "ok");
  const conv = conversation.current(OWNER_CHAT);
  assert.notEqual(conv, clarkConv);
  assert.equal(conversation.conversation(conv)?.agent, "chercheur");

  submitRequest(hub, "Où en est Studio Pixel ?", { source: "web", mode: "team" });
  for (let i = 0; i < 50 && !runs.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs.length, 1, "pas d'équipe dans une discussion directe : un seul tour");
  assert.match(runs[0].prompt, /^\[Discussion directe — Chercheur\]/);
  assert.match(runs[0].prompt, /Où en est Studio Pixel \?/);
  assert.equal(runs[0].access, "read", "le Chercheur lit seulement");
  // Le fil montre le message tel que Charles l'a tapé, pas la consigne.
  for (let i = 0; i < 50 && conversation.messagesOf(conv).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(conversation.messagesOf(conv).filter((m) => m.role !== "system").map((m) => m.text), ["Où en est Studio Pixel ?", "Ici le Chercheur."]);

  // Non-lus : la réponse compte jusqu'à ce que Charles la voie.
  assert.equal(conversation.list(OWNER_CHAT).find((c) => c.id === conv)?.unread, 1);
  hub.markSeen(conv);
  assert.equal(conversation.list(OWNER_CHAT).find((c) => c.id === conv)?.unread, 0);

  // Revenir à Clark rouvre sa dernière conversation.
  assert.deepEqual(hub.openAgent(null), { result: "ok", id: clarkConv });
  assert.equal(conversation.latestWith(OWNER_CHAT, "chercheur"), conv);
});

test("conversations : l'avis d'un membre du groupe arrivé après « Nouvelle conversation » reste dans le groupe", () => {
  const { conversation, journal } = setup();
  conversation.startNew(OWNER_CHAT, "groupe");
  const group = conversation.current(OWNER_CHAT);
  const parent = journal.create(OWNER_CHAT, "groupe", "question");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "question", taskId: parent });
  const child = journal.create(OWNER_CHAT, "avis:relecteur", "consigne", parent);
  conversation.startNew(OWNER_CHAT);
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "mon avis", taskId: child, agent: "relecteur" });
  assert.deepEqual(conversation.messagesOf(group).map((m) => m.text), ["question", "mon avis"]);
  assert.deepEqual(conversation.messagesOf(conversation.current(OWNER_CHAT)), []);
});

test("conversations : une alerte sur le fil de Charles n'attire pas la réponse du tour de veille", () => {
  const { conversation, journal } = setup();
  const ownerConv = conversation.current(OWNER_CHAT);
  const beat = journal.create(0, "heartbeat", "tour");
  conversation.add({ chatId: OWNER_CHAT, role: "system", text: "L'agent du tour de veille est bloqué", taskId: beat });
  conversation.add({ chatId: 0, role: "clark", text: "Rien à signaler.", taskId: beat });
  assert.deepEqual(conversation.messagesOf(ownerConv).map((m) => m.text), ["L'agent du tour de veille est bloqué"]);
  assert.deepEqual(conversation.messagesOf(conversation.current(0)).map((m) => m.text), ["Rien à signaler."]);
});

test("conversations : un rappel posté pendant une discussion avec un agent va chez Clark", () => {
  const { conversation } = setup();
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "salut Clark" });
  const clark = conversation.current(OWNER_CHAT);
  conversation.startNew(OWNER_CHAT, "chercheur");
  const mousse = conversation.current(OWNER_CHAT);
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "Rappel : brancher Google" });
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Mousse, cherche ça" });
  assert.deepEqual(conversation.messagesOf(clark).map((m) => m.text), ["salut Clark", "Rappel : brancher Google"]);
  assert.deepEqual(conversation.messagesOf(mousse).map((m) => m.text), ["Mousse, cherche ça"]);
});

test("conversations : triées sur la dernière activité, et listées même sans message de Charles", () => {
  const db = new DatabaseSync(":memory:");
  const conversation = new Conversation(db);
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "ancienne" });
  const old = conversation.current(OWNER_CHAT);
  conversation.startNew(OWNER_CHAT);
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "récente" });
  db.exec("UPDATE conversations SET updated_at = '2026-11-01 10:00:00'");
  conversation.switchTo(OWNER_CHAT, old);
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "réponse tardive" });
  assert.deepEqual(conversation.list(OWNER_CHAT).map((c) => c.title), ["ancienne", "récente"], "la réponse remonte la conversation");
  // Que des réponses (un avis arrivé seul) : listée, avec un titre daté, et rouvrable.
  conversation.startNew(OWNER_CHAT);
  const lone = conversation.current(OWNER_CHAT);
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "un avis", agent: "relecteur" });
  assert.match(conversation.list(OWNER_CHAT)[0].title, /^Conversation du /);
  assert.ok(conversation.hasContent(lone));
  assert.equal(conversation.latestWith(OWNER_CHAT, null), lone, "Clark : la plus récente qui a du contenu");
});

test("conversations : la réparation remet les messages mal rangés à leur place", () => {
  const { conversation, journal, store } = setup();
  conversation.startNew(OWNER_CHAT, "groupe");
  const group = conversation.current(OWNER_CHAT);
  const parent = journal.create(OWNER_CHAT, "groupe", "question");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "question", taskId: parent });
  const child = journal.create(OWNER_CHAT, "avis:contenu", "consigne", parent);
  conversation.startNew(OWNER_CHAT);
  const other = conversation.current(OWNER_CHAT);
  // Comme avant le correctif : l'avis rangé dans la conversation ouverte.
  store.db.prepare("INSERT INTO messages (chat_id, role, text, task_id, conversation_id, agent) VALUES (?, 'clark', 'avis égaré', ?, ?, 'contenu')").run(OWNER_CHAT, child, other);
  assert.equal(conversation.repairTaskMessages(), 1);
  assert.deepEqual(conversation.messagesOf(group).map((m) => m.text), ["question", "avis égaré"]);
  assert.equal(conversation.repairTaskMessages(), 0, "une deuxième fois : rien à faire");
});
