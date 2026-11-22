import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { parseReview, reviewDue, runReview } from "../src/core/memory-review.ts";
import { remindersOf } from "../src/core/reminders.ts";
import { memoryTools, parisToUtc } from "../src/memory/tools.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null } as Config;
function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const execute = (async (_d, taskId) => (journal.finish(taskId, "done", "ok", 0), { text: "ok", costUsd: 0, status: "done" as const })) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute });
  return { store, journal, conversation, hub };
}

test("relecture de mémoire : quand la faire", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  assert.ok(reviewDue(20, now, now), "20 demandes");
  assert.ok(!reviewDue(2, new Date("2026-11-20T09:00:00Z"), now), "trop peu");
  assert.ok(reviewDue(3, new Date("2026-11-20T09:40:00Z"), now), "calme depuis 20 min");
  assert.ok(!reviewDue(5, new Date("2026-11-20T09:55:00Z"), now), "conversation encore active");
});

test("relecture de mémoire : propositions lues, rangées dans le circuit habituel, sans relire deux fois", async () => {
  const { store, conversation, hub } = setup();
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Mon entretien à la Banque du Nord est le 25 novembre." });
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "Noté." });
  const prompts: string[] = [];
  const think = async (p: string) => (prompts.push(p), '{"memories":[{"kind":"event","content":"Entretien Banque du Nord le 25 novembre 2026"},{"kind":"oops","content":"ignoré"}]}');
  assert.equal(await runReview(hub, think, new Date("2026-11-20T10:00:00Z")), 1);
  assert.match(prompts[0], /Banque du Nord est le 25 novembre/);
  const [p] = store.proposals();
  assert.equal(p.content, "Entretien Banque du Nord le 25 novembre 2026");
  assert.match(p.source ?? "", /relecture de la conversation du 20 novembre/);
  assert.equal(await runReview(hub, think), 0, "rien de neuf depuis la dernière relecture");
  assert.deepEqual(parseReview("pas de json"), []);
});

test("recherche dans les conversations : par mots-clés et liste du jour", () => {
  const { store, conversation } = setup();
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Prépare la relance pour Studio Pixel" });
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "Voici le brouillon de relance." });
  const t = memoryTools(store, { taskId: () => 1, writeRefusal: () => null });
  assert.match(t.history_search.run({ query: "studio pixel" }), /Charles : Prépare la relance pour Studio Pixel/);
  assert.match(t.history_search.run({}), /dernière réponse : Voici le brouillon de relance\./);
  assert.match(t.history_search.run({ query: "introuvable" }), /Rien trouvé/);
});

test("rappels : seulement à ta demande, à l'heure de Paris", () => {
  const { store, journal } = setup();
  const mine = journal.create(OWNER_CHAT, "chat", "rappelle-moi");
  journal.setSource(mine, "telegram");
  const auto = journal.create(OWNER_CHAT, "chat", "consigne d'automatisation");
  journal.setSource(auto, "automation:relances");
  const fromCharles = memoryTools(store, { taskId: () => mine, writeRefusal: () => null });
  const fromAuto = memoryTools(store, { taskId: () => auto, writeRefusal: () => null });
  assert.match(fromAuto.remind_me.run({ text: "Relancer Studio Pixel", at: "2099-01-05T09:00" }), /^Refusé/);
  assert.match(fromAuto.create_automation.run({ name: "x", prompt: "faire x", frequency: "daily", time: "08:00" }), /^Refusé/);
  assert.match(fromCharles.remind_me.run({ text: "Relancer Studio Pixel", at: "2099-01-05T09:00" }), /^Rappel #1 prévu/);
  assert.equal(remindersOf(store.db).pending()[0].due_at, "2099-01-05 08:00:00", "9 h à Paris en hiver = 8 h UTC");
  assert.match(fromCharles.create_automation.run({ name: "Point du matin", prompt: "Fais le point de mes relances", frequency: "daily", time: "08:30" }), /créée et active/);
  assert.equal(parisToUtc("2026-07-01T09:00")?.toISOString(), "2026-07-01T07:00:00.000Z", "été : UTC+2");
});

test("git : un verrou momentané est réessayé au lieu d'échouer", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { git } = await import("../src/dev/git.ts");
  const dir = mkdtempSync(join(tmpdir(), "clark-lock-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a");
  writeFileSync(join(dir, ".git", "index.lock"), "");
  setTimeout(() => rmSync(join(dir, ".git", "index.lock")), 120);
  await git(dir, ["add", "a.txt"]);
  assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), /^A  a\.txt/m);
});

test("Toute l'équipe : chaque membre répond de son côté, en lecture seule, réponse signée", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: { prompt: string; access?: string; resume?: string }[] = [];
  const execute = (async (_d, taskId, opts) => {
    runs.push({ prompt: opts.prompt, access: opts.access, resume: opts.resume });
    const who = opts.prompt.match(/^\[Discussion directe — ([^\]]+)\]/)?.[1] ?? "?";
    journal.finish(taskId, "done", `Avis du ${who}`, 0);
    return { text: `Avis du ${who}`, costUsd: 0, status: "done" as const };
  }) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute } });
  const { submitRequest } = await import("../src/core/submit.ts");
  store.setSession(OWNER_CHAT, "session-clark");
  assert.equal(hub.openAgent("groupe").result, "ok");
  submitRequest(hub, "Ma page À propos est-elle trop longue ?", { source: "web" });
  for (let i = 0; i < 200 && runs.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs.length, 4);
  assert.ok(runs.every((r) => r.access === "read" && r.resume === undefined), "lecture seule, sans reprendre une autre session");
  for (let i = 0; i < 100 && conversation.messagesOf(conversation.current(OWNER_CHAT)).length < 5; i++) await new Promise((r) => setTimeout(r, 10));
  const msgs = conversation.messagesOf(conversation.current(OWNER_CHAT));
  assert.equal(msgs[0].role, "user");
  assert.deepEqual(msgs.slice(1).map((m) => m.agent).sort(), ["chercheur", "contenu", "redacteur", "relecteur"]);
  assert.equal(store.getSession(OWNER_CHAT), null, "la conversation de groupe est neuve, et les membres n'y écrivent pas de session");
});

test("plan avant une longue tâche : Démarrer, Annuler, ou démarrage seul sans réponse", async () => {
  process.env.CLARK_PLAN_WAIT_MIN = "0.002";
  const { store, journal } = setup();
  const mine = journal.create(OWNER_CHAT, "chat", "refais mon portfolio");
  journal.setSource(mine, "web");
  const t = memoryTools(store, { taskId: () => mine, writeRefusal: () => null });
  const plan = { understanding: "Tu veux une refonte du portfolio", steps: ["Lire les pages", "Proposer une maquette"] };
  assert.equal(await t.confirm_plan.run(plan), "Pas de réponse de Charles : démarre ce plan.");
  process.env.CLARK_PLAN_WAIT_MIN = "0.1";
  const pending = t.confirm_plan.run(plan);
  await new Promise((r) => setTimeout(r, 30));
  const q = store.questions.pending().at(-1)!;
  assert.match(q.question, /Plan :\n1\. Lire les pages/);
  store.questions.answer(q.id, "Annuler");
  assert.match(await pending, /^Charles annule/);
  delete process.env.CLARK_PLAN_WAIT_MIN;
});

test("relecture de mémoire : un bug constaté devient aussi une proposition de correction", async () => {
  const { store, conversation, hub } = setup();
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Les animations des dossiers sautent au chargement." });
  const think = async () =>
    JSON.stringify({
      memories: [{ kind: "fact", content: "Animations des dossiers buggées au chargement (portfolio)" }],
      actions: [{ title: "Corriger les animations des dossiers", why: "Bug constaté par Charles, pas encore corrigé.", action: "Corrige le saut des animations des dossiers dans le portfolio." }],
    });
  assert.equal(await runReview(hub, think), 2);
  const [i] = store.initiatives.pending();
  assert.equal(i.title, "Corriger les animations des dossiers");
  assert.match(i.source ?? "", /relecture de la conversation/);
});

test("Telegram parle à Clark, même si l'interface avait « Toute l'équipe » ouverte", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const prompts: string[] = [];
  const execute = (async (_d, taskId, opts) => (prompts.push(opts.prompt), journal.finish(taskId, "done", "ok", 0), { text: "ok", costUsd: 0, status: "done" as const })) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute } });
  const { submitRequest } = await import("../src/core/submit.ts");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Sujet avec Clark" });
  const clark = conversation.current(OWNER_CHAT);
  hub.openAgent("groupe");
  submitRequest(hub, "Corrige le bug des dossiers", { source: "telegram" });
  for (let i = 0; i < 100 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(prompts, ["Corrige le bug des dossiers"], "un seul tour, celui de Clark");
  assert.equal(conversation.current(OWNER_CHAT), clark);
});

test("rappel puis ta réponse : Clark reçoit ce qui s'est affiché depuis le dernier échange", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: string[] = [];
  const execute = (async (_d, taskId, opts) => (runs.push(opts.prompt), journal.finish(taskId, "done", "ok", 0), { text: "ok", costUsd: 0, status: "done" as const })) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute } });
  const { submitRequest } = await import("../src/core/submit.ts");
  submitRequest(hub, "Salut", { source: "telegram" });
  for (let i = 0; i < 100 && runs.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
  await hub.post(OWNER_CHAT, "Rappel : Connecter Codex.", "clark", "reply");
  submitRequest(hub, "Je le fais cet après-midi", { source: "telegram" });
  for (let i = 0; i < 100 && runs.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs[0], "Salut", "rien d'affiché avant : message tel quel");
  assert.match(runs[1], /^\[Affiché à Charles depuis votre dernier échange[\s\S]*Clark : Rappel : Connecter Codex\.\n\nMessage de Charles : Je le fais cet après-midi$/);
  const shown = conversation.recent(OWNER_CHAT).filter((m) => m.role === "user").map((m) => m.text);
  assert.deepEqual(shown, ["Salut", "Je le fais cet après-midi"], "le fil montre ce que tu as écrit");
});
