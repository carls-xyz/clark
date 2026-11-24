import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserDriver } from "../src/browser/driver.ts";
import { BrowserService, setBrowser } from "../src/browser/service.ts";
import { internalToken } from "../src/core/internal.ts";
import { onStop, wasStopped } from "../src/core/stops.ts";
import { Bindings } from "../src/engines/bindings.ts";
import { memoryServer } from "../src/memory/tools.ts";
import { effectOf, READ_ONLY_REFUSAL } from "../src/policy/permissions.ts";
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

async function setup(execute = askingAgent, opts: { db?: string; browser?: (hub: ReturnType<typeof createHub>) => BrowserService } = {}) {
  const port = await freePort();
  const store = new Store(opts.db ?? ":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config: config(port), store, journal, conversation }, { execute });
  const browser = opts.browser?.(hub);
  const web = await startWeb(hub, { port, browser });
  return { port, hub, journal, conversation, web, store, browser };
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

// JPEG d'un pixel, renvoyé tel quel par le faux navigateur.
const jpeg = Buffer.from("/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD876KKK9Q/sg//2Q==", "base64");

function visionBrowser(hub: ReturnType<typeof createHub>, actions: string[]) {
  let running = false;
  const driver: BrowserDriver = {
    available: () => true,
    running: () => running,
    visible: () => false,
    ensure: async () => { running = true; },
    open: async () => {},
    view: async () => ({ url: "https://example.org/", title: "Exemple", text: "", elements: [] }),
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    select: async () => {},
    scroll: async (direction) => { actions.push(direction); },
    back: async () => {},
    screenshot: async () => jpeg,
    close: async () => { running = false; },
    clickAt: async (x, y) => { actions.push(`clic ${x}, ${y}`); },
    pressKey: async (key) => { actions.push(key); },
  };
  const { journal } = hub.deps;
  return new BrowserService({
    driver,
    approve: (id, req) => hub.approveTask(id, req),
    taskAlive: (id) => !wasStopped(id) && journal.get(id)?.status === "running",
    readOnly: (id) => journal.get(id)?.access !== "write",
    onChange: () => hub.touch(),
  });
}

async function setupVision(db?: string) {
  const actions: string[] = [];
  const env = await setup(askingAgent, { db, browser: (hub) => visionBrowser(hub, actions) });
  const taskId = env.journal.create(OWNER_CHAT, "chat", "Regarde la page");
  env.journal.setStatus(taskId, "running");
  env.journal.setAccess(taskId, "write");
  const headers = { "Content-Type": "application/json", "X-Clark-Internal": internalToken() };
  const vision = (action: string, args = {}) => call(env.port, "/internal/browser", {
    method: "POST", headers, body: { taskId, action, args, vision: true },
  });
  return { ...env, taskId, vision, actions };
}

test("web vision : lecture seule, capture périmée et arrêt pendant l'accord", async (t) => {
  const { port, web, browser, hub, journal, taskId, vision, actions } = await setupVision();
  t.after(() => web.close());
  t.after(() => browser?.close());
  journal.setAccess(taskId, "read");
  const capture = await vision("screenshot");
  assert.equal(capture.status, 200);
  assert.equal(capture.body.image, jpeg.toString("base64"));
  const shotId = (await call(port, "/api/state")).body.browser.vision.shotId;
  const position = { x: 10, y: 20, shotId };
  assert.equal((await vision("click_at", position)).body.text, READ_ONLY_REFUSAL);
  assert.equal((await vision("key", { key: "Enter", shotId })).body.text, READ_ONLY_REFUSAL);
  assert.match((await vision("scroll", { direction: "up" })).body.text, /défilée/);

  journal.setAccess(taskId, "write");
  await vision("screenshot");
  assert.match((await vision("click_at", position)).body.text, /n'est plus la dernière/);
  assert.equal(hub.approvals().length, 0);

  const current = (await call(port, "/api/state")).body.browser.vision.shotId;
  // Le moteur interrompu peut mettre un instant à écrire son statut final.
  t.after(onStop(taskId, () => {}));
  const clicking = vision("click_at", { ...position, shotId: current });
  try {
    await until(() => hub.approvals().length === 1);
    const stopped = await call(port, `/api/tasks/${taskId}/stop`, { method: "POST", headers: json(port), body: {} });
    assert.equal(stopped.status, 200);
  } finally {
    const approval = hub.approvals()[0];
    if (approval) await call(port, `/api/approvals/${approval.id}`, { method: "POST", headers: json(port), body: { ok: true } });
  }
  assert.match((await clicking).body.text, /arrêtée pendant l'attente/);
  assert.deepEqual(actions, ["up"]);
  const state = (await call(port, "/api/state")).body.browser.vision;
  assert.equal(state.recent.at(-1).action, "click_at");
  assert.equal(state.recent.at(-1).granted, false);
});

test("web vision : JPEG authentifié et rafraîchissement SSE", async (t) => {
  const { port, web, browser, vision } = await setupVision();
  t.after(() => web.close());
  t.after(() => browser?.close());
  const base = `http://127.0.0.1:${port}`;
  const url = `${base}/api/browser/vision/screenshot`;
  const events = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(5000) });
  const reader = events.body!.getReader();
  try {
    const decoder = new TextDecoder();
    let pending = "";
    const nextState = async () => {
      while (!pending.includes("\n\n")) {
        const update = await reader.read();
        assert.ok(update.value);
        pending += decoder.decode(update.value, { stream: true });
      }
      const end = pending.indexOf("\n\n");
      const event = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const data = event.split("\n").find((line) => line.startsWith("data: "));
      assert.ok(data);
      return JSON.parse(data.slice(6));
    };
    assert.equal((await nextState()).browser.vision.shotId, null);
    await vision("screenshot");
    const state = await nextState();
    assert.ok(state.browser.vision.shotAt);
    assert.equal(state.browser.vision.recent.at(-1).action, "screenshot");
  } finally {
    await reader.cancel();
  }
  assert.equal((await call(port, "/api/browser/screenshot")).status, 403);
  assert.equal((await call(port, "/api/browser/vision/screenshot")).status, 403);
  const headers = { "X-Clark-Internal": internalToken() };
  assert.equal((await call(port, "/api/browser/screenshot", { headers: { ...headers, Origin: "https://example.org" } })).status, 403);
  assert.equal((await call(port, "/api/browser/screenshot", { headers: { ...headers, Host: "example.org" } })).status, 421);
  const internal = await fetch(url, { headers });
  assert.equal(internal.status, 200);
  assert.equal(internal.headers.get("content-type"), "image/jpeg");
  assert.equal(internal.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await internal.arrayBuffer()), jpeg);

  const page = await fetch(base);
  const cookie = page.headers.get("set-cookie")!.split(";")[0];
  await page.arrayBuffer();
  const ui = await fetch(`${base}/api/browser/screenshot`, { headers: { Cookie: cookie } });
  assert.equal(ui.status, 200);
  assert.deepEqual(Buffer.from(await ui.arrayBuffer()), jpeg);
});

async function checkImage(client: Client) {
  const result = await client.callTool({ name: "computer_screenshot", arguments: {} });
  assert.ok(Array.isArray(result.content));
  const [text, image] = result.content;
  assert.equal(text.type, "text");
  assert.match(text.text, /Capture v\d+/);
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.deepEqual(Buffer.from(image.data, "base64"), jpeg);
}

test("vision Claude : le serveur MCP en processus reçoit la vraie image", async () => {
  assert.equal(effectOf("mcp__memory__computer_screenshot"), "read");
  assert.equal(effectOf("mcp__memory__computer_scroll"), "read");
  assert.equal(effectOf("mcp__memory__computer_click_at"), "write");
  assert.equal(effectOf("mcp__memory__computer_key"), "write");
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config: config(0), store, journal, conversation }, { execute: askingAgent });
  const browser = visionBrowser(hub, []);
  const taskId = journal.create(OWNER_CHAT, "chat", "Regarde la page");
  setBrowser(browser);
  const claude = new Client({ name: "test-claude", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sdk = memoryServer(store, { taskId, readOnly: true }).instance;
  try {
    await sdk.connect(serverTransport);
    await claude.connect(clientTransport);
    await checkImage(claude);
  } finally {
    setBrowser(null);
    await claude.close();
    await sdk.close();
    await browser.close();
    store.db.close();
  }
});

test("web vision : le serveur MCP de Codex reçoit la vraie image", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clark-web-vision-"));
  const db = join(dir, "clark.sqlite");
  const { port, web, store, browser, taskId } = await setupVision(db);
  t.after(async () => {
    await browser?.close();
    await web.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const bindings = new Bindings(store.db);
  const binding = bindings.forThread(null);
  bindings.setTask(binding, taskId);
  const codex = new Client({ name: "test-codex", version: "1.0.0" });
  try {
    await codex.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/memory/mcp-server.ts", import.meta.url))],
      env: { CLARK_DB: db, CLARK_BINDING: binding, CLARK_INTERNAL_URL: `http://127.0.0.1:${port}`, CLARK_INTERNAL_TOKEN: internalToken() },
    }));
    await checkImage(codex);
  } finally {
    await codex.close();
  }
});
