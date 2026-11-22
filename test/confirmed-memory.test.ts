import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { buildSystemPrompt } from "../src/core/prompt.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { formatMemories } from "../src/memory/tools.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const NO_CORE = "/nonexistent-core-dir";
const SOURCE = "Charles, conversation du 2026-11-18 : « mes relances se font le lundi »";

test("une proposition n'est jamais utilisée avant d'être confirmée", () => {
  const s = new Store(":memory:");
  const r = s.propose({ kind: "preference", content: "Mes relances se font le lundi", source: SOURCE });
  assert.equal(r.outcome, "proposed");
  assert.equal(s.recall("relances").length, 0);
  assert.equal(s.top().length, 0);
  assert.equal(s.count(), 0);
  assert.doesNotMatch(buildSystemPrompt(s, NO_CORE), /lundi/);

  assert.ok(s.confirm(r.id));
  assert.equal(s.recall("relances")[0].content, "Mes relances se font le lundi");
  assert.equal(s.recall("relances")[0].source, SOURCE);
  assert.ok(!s.confirm(r.id), "une proposition ne se confirme qu'une fois");
});

test("une proposition ignorée n'est jamais utilisée", () => {
  const s = new Store(":memory:");
  const r = s.propose({ kind: "fact", content: "Charles a un chat", source: "supposition" });
  assert.ok(s.ignore(r.id));
  assert.equal(s.recall("chat").length, 0);
  assert.equal(s.proposals().length, 0);
});

test("une source est obligatoire, une date d'expiration doit être valide", () => {
  const s = new Store(":memory:");
  assert.throws(() => s.propose({ kind: "fact", content: "x y z", source: "  " }), /Source/);
  assert.throws(() => s.propose({ kind: "fact", content: "x y z", source: "moi", expiresAt: "30/11/2026" }), /expiration/);
});

test("une correction proposée laisse l'ancienne version active jusqu'à la confirmation", () => {
  const s = new Store(":memory:");
  const old = s.remember({ kind: "preference", content: "Mes relances se font le lundi", source: SOURCE });
  const r = s.propose({ kind: "preference", content: "Mes relances se font le mardi", source: "Charles, 2026-11-19", replacesId: old });

  assert.deepEqual(s.recall("relances").map((m) => m.content), ["Mes relances se font le lundi"]);
  assert.equal(s.proposals()[0].replaces_content, "Mes relances se font le lundi");

  assert.ok(s.confirm(r.id));
  assert.deepEqual(s.recall("relances").map((m) => m.content), ["Mes relances se font le mardi"]);
  assert.equal(s.get(old)!.status, "superseded");
});

test("ignorer une correction garde le souvenir d'origine", () => {
  const s = new Store(":memory:");
  const old = s.remember({ kind: "preference", content: "Mes relances se font le lundi", source: SOURCE });
  const r = s.propose({ kind: "preference", content: "Mes relances se font le jeudi", source: "Clark", replacesId: old });
  assert.ok(s.ignore(r.id));
  assert.deepEqual(s.recall("relances").map((m) => m.content), ["Mes relances se font le lundi"]);
});

test("un souvenir expiré n'est plus utilisé ; le jour d'expiration compte encore", () => {
  const s = new Store(":memory:");
  const today = s.db.prepare("SELECT date('now', 'localtime') AS d").get() as { d: string };
  s.remember({ kind: "event", content: "Salon de l'alternance hier", source: "affiche", expiresAt: "2000-01-01" });
  s.remember({ kind: "event", content: "Salon de l'alternance aujourd'hui", source: "affiche", expiresAt: today.d });
  assert.deepEqual(s.recall("salon alternance").map((m) => m.content), ["Salon de l'alternance aujourd'hui"]);
  assert.equal(s.count(), 1);
});

test("doublons : rien n'est reproposé s'il est déjà confirmé ou déjà en attente", () => {
  const s = new Store(":memory:");
  const id = s.remember({ kind: "fact", content: "Le Mac a 8 Go de RAM" });
  assert.deepEqual(s.propose({ kind: "fact", content: "le mac a 8 go de ram", source: "x" }), { outcome: "already_confirmed", id });
  const p = s.propose({ kind: "fact", content: "Charles est à l'IIM", source: "x" });
  assert.equal(s.propose({ kind: "fact", content: "Charles est à l'IIM", source: "y" }).outcome, "already_proposed");
  assert.equal(p.outcome, "proposed");
});

test("migration : les anciens souvenirs restent visibles et utilisés, avec « provenance inconnue »", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-mig-"));
  const db = join(dir, "clark.db");
  try {
    const old = new Store(db);
    // Base d'avant : on retire les colonnes ajoutées pour simuler l'ancien schéma.
    old.db.exec(`DROP TABLE memories; CREATE TABLE memories (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL DEFAULT 3, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
      INSERT INTO memories (kind, content) VALUES ('fact', 'Charles est étudiant à l''IIM');`);
    old.db.close();

    const s = new Store(db);
    const [m] = s.top();
    assert.equal(m.status, "confirmed");
    assert.equal(m.source, null);
    assert.match(formatMemories([m]), /provenance inconnue/);
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Le parcours demandé, de bout en bout ─────────────────────────────────

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

function post(port: number, path: string, body: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function open(db: string, port: number) {
  const store = new Store(db);
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config: config(port), store, journal, conversation });
  return { store, journal, conversation, hub };
}

test("Clark propose lundi, l'utilisateur corrige en mardi, redémarrage, nouvelle conversation : mardi, avec sa source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-scenario-"));
  const db = join(dir, "clark.db");
  const port = 20000 + Math.floor(Math.random() * 20000);
  try {
    // 1. Clark propose, pendant une tâche.
    {
      const { store, journal, conversation, hub } = open(db, port);
      const web = await startWeb(hub, { port });
      const task = journal.create(OWNER_CHAT, "chat", "Note que mes relances se font le lundi");
      store.setSession(OWNER_CHAT, "session-avant");
      const { id } = store.propose({ kind: "preference", content: "Mes relances se font le lundi", source: SOURCE, sourceTaskId: task });
      journal.finish(task, "done", "Je te propose de retenir ça.", 0);

      // La proposition est annoncée dans le fil.
      assert.ok(conversation.recent(OWNER_CHAT).some((m) => m.role === "system" && /propose de retenir.*lundi/.test(m.text)));

      // 2. L'utilisateur corrige en « mardi » depuis l'interface. Une correction vide est refusée.
      assert.equal((await post(port, `/api/memories/${id}`, { action: "correct", content: " " })).status, 400);
      const fixed = await post(port, `/api/memories/${id}`, { action: "correct", content: "Mes relances se font le mardi", expiresAt: null });
      assert.equal(fixed.status, 200);
      assert.equal(fixed.body.outcome, "corrected");
      assert.equal((await post(port, `/api/memories/${id}`, { action: "confirm" })).status, 409);

      await web.close();
      store.db.close();
    }

    // 3. Redémarrage, puis nouvelle conversation.
    {
      const { store, hub } = open(db, port);
      await hub.recover();
      await hub.newConversation();
      assert.equal(store.getSession(OWNER_CHAT), null, "la nouvelle conversation repart sans session");

      // 4. Ce que Clark voit en démarrant : mardi, avec la source d'origine et la trace de la correction.
      const prompt = buildSystemPrompt(store, NO_CORE);
      const line = prompt.split("\n").find((l) => l.includes("Mes relances se font"))!;
      assert.match(line, /Mes relances se font le mardi/);
      assert.match(line, /source : Charles, conversation du 2026-11-18/);
      assert.match(line, /corrigé par Charles/);

      const [hit] = store.recall("relances");
      assert.equal(hit.content, "Mes relances se font le mardi");
      assert.equal(hit.source, SOURCE);
      assert.equal(hit.original_content, "Mes relances se font le lundi");
      assert.equal(store.recall("lundi").length, 0, "la version lundi n'est plus un souvenir actif");
      store.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
