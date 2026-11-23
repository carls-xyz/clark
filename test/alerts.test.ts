import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { AlertStore, alertMessage, emptyState, stepAlerts } from "../src/core/alerts.ts";
import { Conversation } from "../src/core/conversation.ts";
import { errorSignature, healthReport, repeatedErrors, type HealthReport } from "../src/core/health.ts";
import { createHub } from "../src/core/hub.ts";
import { defaultPrefs, NotifyStore, notifyAllowed, setNotifyStore } from "../src/core/notify.ts";
import { createPinger } from "../src/core/ping.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const root = mkdtempSync(join(tmpdir(), "clark-alerts-"));
after(() => rmSync(root, { recursive: true, force: true }));

const engine = { id: "moteur:claude", text: "Claude n'est pas connecté.", alert: "urgent" as const };
const disk = { id: "disque", text: "Peu de place sur le disque : 1.5 Go libres.", alert: "normal" as const };
const quiet = { id: "file", text: "Une tâche attend.", alert: undefined };

test("alertes : confirmées sur deux relevés, une seule fois, levées après deux relevés sans elles", () => {
  let s = emptyState();
  let r = stepAlerts(s, [engine, quiet], 0);
  assert.deepEqual(r.raised, [], "vu une fois : rien");
  r = stepAlerts(r.state, [engine, quiet], 60_000);
  assert.deepEqual(r.raised.map((a) => a.id), ["moteur:claude"], "deux fois : alerte ; un point sans alerte n'en déclenche jamais");
  assert.equal(r.raised[0].urgent, true);
  s = r.state;
  for (let i = 2; i < 6; i++) {
    r = stepAlerts(s, [engine], i * 60_000);
    assert.deepEqual(r.raised, [], "toujours là : pas de nouvelle alerte");
    s = r.state;
  }
  r = stepAlerts(s, [], 7 * 60_000);
  assert.deepEqual(r.cleared, [], "absent une fois : pas encore levée");
  r = stepAlerts(r.state, [engine], 8 * 60_000);
  assert.deepEqual([r.raised, r.cleared], [[], []], "revenu aussitôt : ni levée, ni nouvelle alerte");
  r = stepAlerts(stepAlerts(r.state, [], 9 * 60_000).state, [], 10 * 60_000);
  assert.deepEqual(r.cleared.map((a) => a.id), ["moteur:claude"]);
  assert.deepEqual(stepAlerts(r.state, [], 11 * 60_000).cleared, [], "levée une seule fois");
  assert.deepEqual(r.state.history.map((e) => e.kind), ["alerte", "levée"]);
});

test("alertes : plusieurs points nouveaux partent dans un seul message ; urgent si l'un l'est", () => {
  const r = stepAlerts(stepAlerts(emptyState(), [engine, disk], 0).state, [engine, disk], 60_000);
  const msg = alertMessage(r)!;
  assert.equal(msg.urgent, true);
  assert.match(msg.text, /Santé de Clark, à régler :\n- Claude n'est pas connecté\.\n- Peu de place/);
  assert.equal(alertMessage({ raised: [], cleared: [] }), null);
  const normal = alertMessage(stepAlerts(stepAlerts(emptyState(), [disk], 0).state, [disk], 60_000))!;
  assert.equal(normal.urgent, false);
});

test("alertes : l'état survit au redémarrage ; la version de secours annoncée n'est pas renvoyée", () => {
  const db = new DatabaseSync(":memory:");
  const store = new AlertStore(db);
  store.set(stepAlerts(stepAlerts(emptyState(), [disk], 0).state, [disk], 60_000).state);
  const again = new AlertStore(db);
  assert.deepEqual(stepAlerts(again.get(), [disk], 120_000).raised, [], "déjà signalé avant le redémarrage");
  again.markActive("secours", "Je tourne sur une version de secours.", true);
  const secours = { id: "secours", text: "Clark tourne sur une version détachée.", alert: "urgent" as const };
  const r = stepAlerts(stepAlerts(again.get(), [secours], 0).state, [secours], 60_000);
  assert.deepEqual(r.raised, []);
});

test("erreurs répétées : signature stable (chiffres, identifiants, chemins, adresses, textes cités)", () => {
  const a = errorSignature("tâche 12 interrompue : Error: request to https://api.telegram.org/bot•••/sendMessage failed (id 3f9a2b1c)");
  const b = errorSignature("tâche 987 interrompue : Error: request to https://api.telegram.org/bot•••/getUpdates failed (id 77aa00ff11)");
  assert.equal(a, b);
  assert.equal(errorSignature("lecture de /Users/charles/a/b.txt impossible"), errorSignature("lecture de /home/x/c/d.md impossible"));
  assert.equal(errorSignature("souvenir « café » refusé"), errorSignature("souvenir « thé vert » refusé"));
  assert.notEqual(errorSignature("canal telegram : échec"), errorSignature("canal imessage : échec"));

  const line = (i: number) => `[clark] tâche ${i} interrompue : Error: quota épuisé`;
  const log = (n: number) => ["[clark] démarré", ...Array.from({ length: n }, (_, i) => line(i))].join("\n");
  assert.equal(repeatedErrors(log(20))[0].count, 20);

  // 19 fois : un point sur la page Santé, sans alerte ; 20 fois : alerte.
  const store = new Store(":memory:");
  const hub = createHub({ config: { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null }, store, journal: new TaskJournal(store.db), conversation: new Conversation(store.db) }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as unknown as typeof executeTask });
  const logFile = join(root, "clark.log");
  const report = () => healthReport(hub, { root, logFile, backupDir: join(root, "absent"), git: () => "abc", freeBytes: () => 50e9 }).problems.find((p) => p.id.startsWith("erreurs:"));
  writeFileSync(logFile, log(19));
  assert.equal(report()?.alert, undefined);
  writeFileSync(logFile, log(20));
  assert.equal(report()?.alert, "normal");
  assert.equal(report()?.id, `erreurs:${errorSignature("tâche 1 interrompue : Error: quota épuisé")}`);
});

test("heures calmes : une alerte urgente passe si tu l'as permis, le reste attend le résumé", () => {
  const db = new DatabaseSync(":memory:");
  const notify = new NotifyStore(db);
  const prefs = defaultPrefs();
  assert.equal(prefs.routes.health.telegram, true);
  assert.equal(prefs.routes.health.imessage, false);
  notify.set({ ...prefs, quiet: { on: true, from: "00:00", to: "23:59", approvals: true, alerts: true } });
  setNotifyStore(notify);
  try {
    const night = new Date();
    assert.equal(notifyAllowed("telegram", "alert", "urgent", night), true);
    assert.equal(notifyAllowed("telegram", "health", "normal", night), false, "non urgente : retenue");
    assert.equal(notifyAllowed("imessage", "alert", "urgent", night), false, "suit les canaux de « Santé de Clark »");
    notify.set({ ...prefs, quiet: { on: true, from: "00:00", to: "23:59", approvals: true, alerts: false } });
    assert.equal(notifyAllowed("telegram", "alert", "urgent", night), false, "case décochée : retenue aussi");
  } finally {
    setNotifyStore(null);
  }
});

test("ping externe : l'adresse quand tout va, /fail seulement si demandé, rien d'autre envoyé, une ligne par série d'échecs", async () => {
  const calls: { url: string; body: unknown }[] = [];
  let ok = true;
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body });
    return new Response("", { status: ok ? 200 : 503 });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  let level: "ok" | "bad" = "bad";
  const p = createPinger({ level: () => level, fetcher, env: { CLARK_PING_URL: "https://hc-ping.com/abc/" }, log: (l) => logs.push(l) });
  await p.ping();
  assert.equal(calls[0].url, "https://hc-ping.com/abc", "sans l'option : jamais /fail");
  assert.equal(calls[0].body, undefined, "aucune donnée");
  const withFail = createPinger({ level: () => level, fetcher, env: { CLARK_PING_URL: "https://hc-ping.com/abc", CLARK_PING_FAIL_ON_BAD: "1" }, log: (l) => logs.push(l) });
  await withFail.ping();
  assert.equal(calls[1].url, "https://hc-ping.com/abc/fail");
  level = "ok";
  await withFail.ping();
  assert.equal(calls[2].url, "https://hc-ping.com/abc");

  ok = false;
  await p.ping();
  await p.ping();
  await p.ping();
  assert.equal(logs.filter((l) => l.includes("impossible")).length, 1, "une seule ligne pour la série");
  assert.equal(p.status().failing, true);
  ok = true;
  await p.ping();
  assert.equal(logs.filter((l) => l.includes("de nouveau")).length, 1);
  assert.equal(createPinger({ level: () => "ok", env: {} }).status().configured, false);
});

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

test("surveillance locale : deux absences de réponse de suite relancent ; pas pendant la grâce ; une réponse remet à zéro", { timeout: 60_000 }, async () => {
  const dir = join(root, "wd");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, "../scripts/watchdog.sh"), join(dir, "scripts/watchdog.sh"));
  const restarts = join(root, "restarts");
  const fake = join(root, "fake-svc.sh");
  writeFileSync(fake, `#!/bin/bash\necho "$1" >> "${restarts}"\n`);
  chmodSync(fake, 0o755);
  const port = await freePort();
  const run = () => spawnSync("bash", [join(dir, "scripts/watchdog.sh")], { cwd: dir, encoding: "utf8", env: { ...process.env, CLARK_SERVICE_FAKE: fake, CLARK_WEB_PORT: String(port) } });
  const restarted = () => (existsSync(restarts) ? readFileSync(restarts, "utf8").trim().split("\n").length : 0);

  // Démarré il y a 10 s : grâce, rien.
  writeFileSync(join(dir, "data/started-at"), String(Math.floor(Date.now() / 1000) - 10));
  run();
  run();
  assert.equal(restarted(), 0);

  writeFileSync(join(dir, "data/started-at"), String(Math.floor(Date.now() / 1000) - 3600));
  run();
  assert.equal(restarted(), 0, "une seule absence : rien");
  run();
  assert.equal(restarted(), 1, "deux de suite : relancé");
  assert.ok(existsSync(join(dir, "data/watchdog-restart.txt")), "une note pour Clark");

  // Une réponse entre deux absences remet le compte à zéro.
  const { createServer: httpServer } = await import("node:http");
  run();
  const srv = httpServer((_q, r) => r.end("{}")).listen(port, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  // Sans bloquer ce processus : le petit serveur doit pouvoir répondre au script.
  const { spawn } = await import("node:child_process");
  await new Promise<void>((done) => spawn("bash", [join(dir, "scripts/watchdog.sh")], { cwd: dir, env: { ...process.env, CLARK_SERVICE_FAKE: fake, CLARK_WEB_PORT: String(port) } }).on("close", () => done()));
  await new Promise<void>((r) => srv.close(() => r()));
  run();
  assert.equal(restarted(), 1, "le compte est reparti de zéro");
});

test("/api/health : toujours 200 tant que Clark répond, avec le niveau et les points", async () => {
  const store = new Store(":memory:");
  const hub = createHub({ config: { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null }, store, journal: new TaskJournal(store.db), conversation: new Conversation(store.db) }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as unknown as typeof executeTask });
  const port = await freePort();
  const bad = { level: "bad", problems: [{ id: "secours", level: "bad", text: "x" }], version: { commit: "abc1234" } } as unknown as HealthReport;
  const web = await startWeb(hub, { port, health: () => bad });
  try {
    const body = await new Promise<{ status: number; json: any }>((resolveRes, reject) => {
      request({ host: "127.0.0.1", port, path: "/api/health", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolveRes({ status: res.statusCode ?? 0, json: JSON.parse(d) }));
      })
        .on("error", reject)
        .end();
    });
    assert.equal(body.status, 200);
    assert.equal(body.json.ok, true);
    assert.equal(body.json.level, "bad");
    assert.deepEqual(body.json.problems, ["secours"]);
    assert.equal(body.json.version, "abc1234");
  } finally {
    await web.close();
  }
});
