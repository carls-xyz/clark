import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT, type Channel } from "../src/core/hub.ts";
import { optionsOf } from "../src/core/questions.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { createPolicy, effectOf } from "../src/policy/permissions.ts";
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

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "condition jamais atteinte");
};

test("question : posée, attendue, répondue une seule fois", async () => {
  const s = new Store(":memory:");
  const id = s.questions.ask({ taskId: 1, agent: "Rédacteur", question: "Ton formel ou détendu ?", options: ["Formel", "Détendu", ""] });
  assert.deepEqual(optionsOf(s.questions.get(id)!), ["Formel", "Détendu"], "options vides retirées");
  const waiting = s.questions.wait(id, { pollMs: 5 });
  assert.ok(s.questions.answer(id, "Détendu"));
  assert.equal(await waiting, "Détendu");
  assert.ok(!s.questions.answer(id, "Formel"), "une seule réponse");
});

test("question : sans réponse dans le délai → null, et elle expire", async () => {
  const s = new Store(":memory:");
  const id = s.questions.ask({ taskId: 1, question: "Quel jour ?" });
  assert.equal(await s.questions.wait(id, { timeoutMs: 30, pollMs: 5 }), null);
  assert.equal(s.questions.get(id)!.status, "expired");
  assert.ok(!s.questions.answer(id, "mardi"), "trop tard");
});

test("outil ask_charles : refusé sans tâche, sinon renvoie la réponse de Charles", async () => {
  const s = new Store(":memory:");
  const journal = new TaskJournal(s.db);
  const none = memoryTools(s, { taskId: () => undefined, writeRefusal: () => null });
  assert.match(await none.ask_charles.run({ question: "Quel jour ?" }), /je ne retrouve pas la tâche/);

  const task = journal.create(OWNER_CHAT, "redacteur:1", "x");
  const t = memoryTools(s, { taskId: () => task, writeRefusal: () => "lecture seule" });
  const pending = t.ask_charles.run({ question: "Quel jour pour les relances ?", options: ["Lundi", "Mardi"] });
  await until(() => s.questions.pending().length === 1);
  const q = s.questions.pending()[0];
  assert.equal(q.agent, "Rédacteur");
  s.questions.answer(q.id, "Mardi");
  assert.equal(await pending, "Réponse de Charles : Mardi", "permis même en lecture seule : poser une question n'écrit rien");
});

test("lecture seule : poser une question reste permis, c'est une lecture", async () => {
  assert.equal(effectOf("mcp__memory__ask_charles"), "read");
  const s = new Store(":memory:");
  const journal = new TaskJournal(s.db);
  const task = journal.create(OWNER_CHAT, "chercheur", "x");
  const policy = createPolicy({ store: s, journal, taskId: task, roots: ["/ws"], access: "read", approve: async () => false });
  const d = await policy("mcp__memory__ask_charles", { question: "x" }, { signal: new AbortController().signal, toolUseID: "q" } as Parameters<typeof policy>[2]);
  assert.equal(d?.behavior, "allow");
});

test("hub : une question posée par un autre processus (Codex) apparaît dans le fil et sur les canaux", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-q-"));
  try {
    const db = join(dir, "clark.db");
    const store = new Store(db);
    const journal = new TaskJournal(store.db);
    const conversation = new Conversation(store.db);
    const hub = createHub({ config, store, journal, conversation }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as typeof executeTask });
    const pushed: string[] = [];
    hub.addChannel({ name: "test", askQuestion: async (q) => void pushed.push(q.question) } satisfies Channel);

    // Le serveur MCP de Codex ouvre la même base dans son propre processus.
    const other = new Store(db);
    const id = other.questions.ask({ taskId: 7, agent: "Chercheur", question: "Quelle note fait foi ?", options: ["En-tête", "Corps"] });

    await until(() => pushed.length === 1);
    assert.match(conversation.recent(OWNER_CHAT).at(-1)!.text, /Le Chercheur te pose une question : « Quelle note fait foi \? »/);
    assert.equal(hub.questions()[0].id, id);

    assert.ok(hub.answerQuestion(id, "En-tête"));
    assert.equal(other.questions.get(id)!.answer, "En-tête", "le processus de Codex lit la réponse");
    assert.ok(!hub.answerQuestion(id, "Corps"));
    other.db.close();
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hub : au redémarrage, les questions d'avant la coupure expirent", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const hub = createHub({ config, store, journal, conversation: new Conversation(store.db) });
  const id = store.questions.ask({ taskId: 1, question: "x ?" });
  await hub.recover();
  assert.equal(store.questions.get(id)!.status, "expired");
  assert.equal(hub.questions().length, 0);
});

test("interface : répondre à une question (vide refusé, une seule réponse)", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const hub = createHub({ config: { ...config, webPort: port }, store, journal, conversation: new Conversation(store.db) });
  const web = await startWeb(hub, { port });
  const post = (path: string, body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method: "POST", headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Content-Type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  try {
    const id = store.questions.ask({ taskId: 1, question: "Quel ton ?", options: ["Formel"] });
    assert.equal(await post(`/api/questions/${id}`, { answer: "  " }), 400);
    assert.equal(await post(`/api/questions/${id}`, { answer: "Détendu, tutoiement" }), 200);
    assert.equal(store.questions.get(id)!.answer, "Détendu, tutoiement");
    assert.equal(await post(`/api/questions/${id}`, { answer: "Formel" }), 409);
  } finally {
    await web.close();
  }
});
