import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { canActAlone, decisionsOf, parisDayStart, startAutonomy, undoDecision } from "../src/core/autonomy.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = {
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

const ENV = ["CLARK_AUTO_VEILLE", "CLARK_AUTO_LANCER", "CLARK_AUTO_SOUVENIRS", "CLARK_AUTO_MAX", "CLARK_AUTO_RESUME"];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

/** Mardi 19 novembre 2026, 15 h à Paris (14 h UTC) : en journée. */
const DAY = new Date("2026-11-19T14:00:00Z");
const NIGHT = new Date("2026-11-19T22:30:00Z");

function setup(now = DAY) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: string[] = [];
  const execute = (async (_d, taskId, opts) => {
    runs.push(opts.prompt);
    await new Promise((r) => setTimeout(r, 50));
    journal.finish(taskId, "done", "ok", 0);
    return { text: "ok", costUsd: 0, status: "done" as const };
  }) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute } });
  const stop = startAutonomy(hub, () => now);
  return { store, journal, conversation, hub, runs, stop };
}

const propose = (store: Store, mode: "chat" | "team" | "goal" = "chat", title = "Relancer Studio Pixel") =>
  store.initiatives.propose({ title, why: "La relance était prévue aujourd'hui.", action: "Prépare la relance de Studio Pixel.", source: "souvenir #3", mode });

test("autonomie : par défaut, Clark propose et attend (rien n'est lancé)", async () => {
  const { store, runs, stop } = setup();
  const r = propose(store);
  assert.equal(r.outcome, "proposed");
  assert.equal(store.initiatives.pending().length, 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs.length, 0);
  stop();
});

test("autonomie : veille « agit » → lancé tout de suite, noté, annonçable et annulable", async () => {
  process.env.CLARK_AUTO_VEILLE = "agit";
  const { store, hub, journal, runs, conversation, stop } = setup();
  propose(store);
  assert.equal(store.initiatives.pending().length, 0, "pas laissé en attente");
  const [d] = decisionsOf(store.db).recent();
  assert.equal(d.kind, "veille");
  assert.equal(d.ref_type, "task");
  for (let i = 0; i < 50 && !runs.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs[0], "Prépare la relance de Studio Pixel.");
  assert.ok(conversation.recent(OWNER_CHAT).some((m) => m.text.startsWith("J'ai décidé seul : « Relancer Studio Pixel »")));
  // Fini : trop tard pour annuler, et c'est dit.
  for (let i = 0; i < 50 && journal.get(d.ref_id!)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  const u = undoDecision(hub, d.id);
  assert.equal(u.ok, false);
  stop();
});

test("autonomie : une équipe ne part seule que si « lancer » est autorisé", () => {
  process.env.CLARK_AUTO_VEILLE = "agit";
  const { store, stop } = setup();
  propose(store, "team", "Préparer le dossier Agence Onde");
  assert.equal(store.initiatives.pending().length, 1, "veille autonome ne suffit pas pour une équipe");
  stop();
});

test("autonomie : la nuit et au-delà du plafond, Clark redemande", () => {
  process.env.CLARK_AUTO_VEILLE = "agit";
  const night = setup(NIGHT);
  propose(night.store);
  assert.equal(night.store.initiatives.pending().length, 1, "23 h 30 à Paris : proposé");
  night.stop();

  process.env.CLARK_AUTO_MAX = "1";
  const day = setup();
  propose(day.store, "chat", "Relancer Studio Pixel");
  propose(day.store, "chat", "Relancer la Banque du Nord");
  assert.equal(day.store.initiatives.pending().length, 1, "la deuxième t'attend");
  assert.deepEqual(canActAlone(decisionsOf(day.store.db), DAY), { ok: false, why: "j'ai déjà décidé seul 1 fois aujourd'hui (plafond 1)" });
  day.stop();
});

test("autonomie : souvenir retenu seul, oublié si on annule ; une correction reste demandée", () => {
  process.env.CLARK_AUTO_SOUVENIRS = "lui";
  const { store, hub, stop } = setup();
  const r = store.propose({ kind: "fact", content: "Entretien Banque du Nord le 25 novembre", source: "mail du 18/11" });
  assert.equal(r.outcome, "proposed");
  const id = (r as { id: number }).id;
  assert.equal(store.get(id)?.status, "confirmed");
  const [d] = decisionsOf(store.db).recent();
  assert.equal(d.ref_type, "memory");
  assert.deepEqual(undoDecision(hub, d.id), { ok: true, note: "souvenir oublié" });
  assert.equal(store.get(id)?.archived, 1);

  const base = store.propose({ kind: "fact", content: "Studio Pixel : relance le 20 novembre", source: "note-1" });
  store.confirm((base as { id: number }).id);
  const fix = store.propose({ kind: "fact", content: "Studio Pixel : relance le 21 novembre", source: "mail", replacesId: (base as { id: number }).id });
  assert.equal(store.get((fix as { id: number }).id)?.status, "proposed", "correction : à toi de trancher");
  stop();
});

test("autonomie : début de journée calculé à l'heure de Paris", () => {
  assert.equal(parisDayStart(DAY), "2026-11-18 23:00:00");
  assert.equal(parisDayStart(new Date("2026-07-01T10:00:00Z")), "2026-06-30 22:00:00");
});
