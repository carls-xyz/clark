import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer } from "node:net";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub } from "../src/core/hub.ts";
import { accessRules, cameFromAfar, refusal } from "../src/gateway/access.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const MAC = "mac.tail1234.ts.net";

test("accès : localhost toujours ; l'adresse Tailscale seulement si elle est déclarée", () => {
  const none = accessRules(4310, {});
  assert.equal(refusal({ host: "localhost:4310" }, none), null);
  assert.equal(refusal({ host: "evil.example:4310" }, none)?.status, 421, "DNS rebinding");
  assert.ok(!none.origins.has(`https://${MAC}`));

  const a = accessRules(4310, { CLARK_WEB_HOSTS: ` https://${MAC}/ , autre.ts.net:8443` });
  assert.deepEqual(a.remote, [MAC, "autre.ts.net:8443"]);
  assert.ok(a.origins.has(`https://${MAC}`));
  assert.ok(a.origins.has("http://autre.ts.net:8443"));
  assert.equal(refusal({ host: MAC }, a), null);
});

test("accès : avec une liste de comptes, une requête venue par Tailscale doit porter l'un d'eux", () => {
  const a = accessRules(4310, { CLARK_WEB_HOSTS: MAC, CLARK_TAILSCALE_USERS: "Toi@Gmail.com" });
  // Sur ce Mac, sans relais : pas concerné.
  assert.equal(refusal({ host: "localhost:4310" }, a), null);
  assert.ok(!cameFromAfar({ host: "localhost:4310" }, a));
  // Relayée par tailscale serve (Host réécrit en local, origine et adresse du téléphone gardées).
  const relayed = { host: "127.0.0.1:4310", origin: `https://${MAC}`, "x-forwarded-for": "100.64.0.2" };
  assert.equal(refusal(relayed, a)?.status, 403, "sans compte");
  assert.equal(refusal({ ...relayed, "tailscale-user-login": "quelquun@autre.com" }, a)?.status, 403);
  assert.equal(refusal({ ...relayed, "tailscale-user-login": "toi@gmail.com" }, a), null);
});

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

test("interface : un envoi depuis le téléphone (origine Tailscale) passe une fois l'adresse déclarée", async () => {
  const config: Config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null };
  const store = new Store(":memory:");
  const hub = createHub({ config, store, journal: new TaskJournal(store.db), conversation: new Conversation(store.db) }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as unknown as typeof executeTask });
  const before = process.env.CLARK_WEB_HOSTS;
  const port = await freePort();
  const send = (origin: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/engines/refresh", method: "POST", headers: { Host: `127.0.0.1:${port}`, Origin: origin, "X-Forwarded-For": "100.64.0.2", "Content-Type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
  process.env.CLARK_WEB_HOSTS = MAC;
  const web = await startWeb(hub, { port });
  try {
    assert.equal(await send(`https://${MAC}`), 200);
    assert.equal(await send("https://ailleurs.example"), 403, "une autre origine reste refusée");
  } finally {
    await web.close();
    if (before === undefined) delete process.env.CLARK_WEB_HOSTS;
    else process.env.CLARK_WEB_HOSTS = before;
  }
});
