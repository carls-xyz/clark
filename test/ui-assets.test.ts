import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub } from "../src/core/hub.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null } as Config;

/** GET brut : le chemin part tel quel (pas de normalisation des « .. » par le client). */
const get = (port: number, path: string) =>
  new Promise<{ status: number; type: string; csp: string; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: `localhost:${port}` } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), csp: String(res.headers["content-security-policy"]), body }));
    });
    req.on("error", reject);
    req.end();
  });

test("composants ui-sdk : servis par Clark lui-même, sans sortir de leur dossier, CSP inchangée", async () => {
  const store = new Store(":memory:");
  const hub = createHub({ config, store, journal: new TaskJournal(store.db), conversation: new Conversation(store.db) });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const web = await startWeb(hub, { port });
  try {
    const js = await get(port, "/ui/web.js");
    assert.equal(js.status, 200);
    assert.match(js.type, /^text\/javascript/);
    assert.match(js.csp, /style-src 'self';/, "la CSP n'est pas élargie");
    assert.equal((await get(port, "/ui/web/alert-dialog.js")).status, 200);
    assert.match((await get(port, "/ui/web.css")).type, /^text\/css/);
    for (const path of ["/ui/../package.json", "/ui/%2e%2e/package.json", "/ui/web/../../package.json", "/ui/web/nope.js", "/ui/README.md"]) {
      assert.equal((await get(port, path)).status, 404, path);
    }
    const page = await get(port, "/");
    assert.match(page.body, /<meta property="csp-nonce" \/>/, "ui-sdk passe par des feuilles construites");
    assert.match(page.body, /<script type="module" src="\/ui\/web\.js"><\/script>/);
  } finally {
    await web.close();
  }
});
