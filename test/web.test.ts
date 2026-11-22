import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = (port: number): Config => ({
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: port,
  model: "claude-opus-5-5",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
});

/** Faux agent : demande une validation, puis répond selon la réponse. */
const askingAgent: typeof executeTask = async (deps, taskId, opts) => {
  const ok = await opts.approve({ tool: "Bash", summary: "Commande shell :\necho test" });
  const text = ok ? "fait" : "pas fait";
  deps.journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" };
};

/** Un port libre donné par le système (un port tiré au hasard peut être déjà pris). */
const freePort = () =>
  new Promise<number>((ok) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => ok(port));
    });
  });

async function setup(execute = askingAgent) {
  const port = await freePort();
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config: config(port), store, journal, conversation }, { execute });
  const web = await startWeb(hub, { port });
  return { port, hub, journal, conversation, web };
}

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { Host: `localhost:${port}`, ...opts.headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data.startsWith("{") ? JSON.parse(data) : data }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.end(JSON.stringify(opts.body));
    else req.end();
  });
}

const json = (port: number) => ({ "Content-Type": "application/json", Origin: `http://localhost:${port}` });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition jamais atteinte");
};

test("web : refuse un Host étranger (DNS rebinding)", async () => {
  const { port, web } = await setup();
  try {
    const res = await call(port, "/api/state", { headers: { Host: `evil.example:${port}` } });
    assert.equal(res.status, 421);
  } finally {
    await web.close();
  }
});

test("web : refuse une écriture venue d'une autre origine, ou sans JSON", async () => {
  const { port, web, journal } = await setup();
  try {
    const foreign = await call(port, "/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: { text: "efface tout" },
    });
    assert.equal(foreign.status, 403);
    const form = await call(port, "/api/messages", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: `http://localhost:${port}` },
      body: { text: "x" },
    });
    assert.equal(form.status, 415);
    assert.equal(journal.unfinished().length, 0);
  } finally {
    await web.close();
  }
});

test("web : un message devient une tâche, la validation se fait par l'API, une seule fois", async () => {
  const { port, web, hub, journal, conversation } = await setup();
  try {
    const sent = await call(port, "/api/messages", { method: "POST", headers: json(port), body: { text: "Lance echo" } });
    assert.equal(sent.status, 202);
    await until(() => hub.approvals().length === 1);

    const state = (await call(port, "/api/state")).body;
    assert.equal(state.approvals[0].summary, "Commande shell :\necho test");
    assert.equal(state.messages[0].text, "Lance echo");

    const id = state.approvals[0].id;
    assert.equal((await call(port, `/api/approvals/${id}`, { method: "POST", headers: json(port), body: { ok: true } })).status, 200);
    assert.equal((await call(port, `/api/approvals/${id}`, { method: "POST", headers: json(port), body: { ok: false } })).status, 409);

    await until(() => journal.unfinished().length === 0 && conversation.recent(OWNER_CHAT).some((m) => m.text === "fait"));
    assert.ok(conversation.recent(OWNER_CHAT).some((m) => m.role === "system" && m.text.startsWith("Validé")));
  } finally {
    await web.close();
  }
});

test("web : boutons Reprendre / Abandonner d'une tâche à vérifier", async () => {
  const { port, web, journal } = await setup();
  try {
    const id = journal.create(OWNER_CHAT, "chat", "Écris relances.md");
    journal.finish(id, "needs_check", "à vérifier", 0);
    const state = (await call(port, "/api/state")).body;
    assert.equal(state.checks[0].id, id);

    assert.equal((await call(port, `/api/tasks/${id}`, { method: "POST", headers: json(port), body: { action: "drop" } })).status, 200);
    assert.equal(journal.get(id)!.status, "abandoned");
    assert.equal((await call(port, `/api/tasks/${id}`, { method: "POST", headers: json(port), body: { action: "resume" } })).status, 409);
  } finally {
    await web.close();
  }
});

test("sans clé API : la tâche échoue proprement, avec la marche à suivre", async () => {
  const { executeTask } = await import("../src/core/agent.ts");
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const deps = { config: { ...config(0), hasApiKey: false }, store, journal };
  const id = journal.create(OWNER_CHAT, "chat", "Salut");
  const r = await executeTask(deps, id, { prompt: "Salut", resume: undefined, approve: async () => false, mode: "new" });
  assert.equal(r.status, "failed");
  assert.match(r.text, /ANTHROPIC_API_KEY/);
});

test("activité : la recherche parcourt tout l'historique, sans accents, mots dans n'importe quel ordre, page par page", async () => {
  const { port, journal, web } = await setup();
  try {
    const add = (prompt: string) => journal.finish(journal.create(OWNER_CHAT, "chat", prompt), "done", "ok", 0);
    add("Prépare la première relance pour Studio Pixel");
    for (let i = 0; i < 150; i++) add(`Bonjour ${i}`);
    for (let i = 0; i < 45; i++) add(`Point candidature ${i}`);

    const plain = await call(port, "/api/activity");
    assert.equal(plain.body.tasks.length, 40);
    assert.ok(!plain.body.tasks.some((t: any) => /Studio Pixel/.test(t.prompt)), "hors de la première page");

    const old = await call(port, `/api/activity?q=${encodeURIComponent("pixel PREMIERE")}`);
    assert.deepEqual(old.body.tasks.map((t: any) => t.prompt), ["Prépare la première relance pour Studio Pixel"]);
    assert.equal(old.body.more, false);

    const first = await call(port, `/api/activity?q=candidatures`);
    assert.equal(first.body.tasks.length, 40, "un pluriel trouve le singulier");
    assert.equal(first.body.more, true);
    const next = await call(port, `/api/activity?q=candidatures&before=${first.body.cursor}`);
    assert.equal(next.body.tasks.length, 5);
    assert.equal(next.body.more, false);
    const ids = [...first.body.tasks, ...next.body.tasks].map((t: any) => t.id);
    assert.equal(new Set(ids).size, 45, "aucun doublon d'une page à l'autre");
  } finally {
    await web.close();
  }
});

test("web : écrire le journal du jour, refusé sans la bonne origine, sans coffre ou sans moteur", async () => {
  const { port, web } = await setup();
  try {
    const foreign = await call(port, "/api/obsidian/journal", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: {} });
    assert.equal(foreign.status, 403);
    const noVault = await call(port, "/api/obsidian/journal", { method: "POST", headers: json(port), body: {} });
    assert.equal(noVault.status, 409);
    assert.equal(noVault.body.error, "Pas de coffre Obsidian branché");
  } finally {
    await web.close();
  }
  // Un coffre, mais pas de writeJournal (pas de moteur Claude).
  const p2 = await freePort();
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const hub = createHub({ config: config(p2), store, journal, conversation: new Conversation(store.db) }, { execute: askingAgent });
  const web2 = await startWeb(hub, { port: p2, obsidian: { status: () => ({ vault: "/coffre", lastSync: null, error: null, notes: 0 }), syncNow: () => {} } });
  try {
    const noEngine = await call(p2, "/api/obsidian/journal", { method: "POST", headers: json(p2), body: {} });
    assert.equal(noEngine.status, 409);
    assert.equal(noEngine.body.error, "Pas de moteur Claude pour écrire le journal");
  } finally {
    await web2.close();
  }
});
