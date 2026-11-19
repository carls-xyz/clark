import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "./_wait.ts";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { TEAM_LABEL } from "../src/core/team.ts";
import type { Transport } from "../src/engines/codex-app-server.ts";
import { createCodexEngine } from "../src/engines/codex.ts";
import { mergeQuota, readQuota, tightest, windowLabel, type Quota } from "../src/engines/quota.ts";
import { snapshot } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = {
  telegram: null,
  hasApiKey: false,
  engine: "codex",
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

/** Réponse au format de `account/rateLimits/read` (horodatages en secondes). */
const response = (used5h: number, extra: Record<string, unknown> = {}) => ({
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex",
    planType: "plus",
    primary: { usedPercent: used5h, windowDurationMins: 300, resetsAt: 1_795_050_000 },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1_795_400_000 },
    rateLimitReachedType: null,
    ...extra,
  },
  rateLimitsByLimitId: null,
});

test("lecture du quota : fenêtres, pourcentages, remise à zéro, limite atteinte", () => {
  const q = readQuota(response(38), 0)!;
  assert.equal(q.plan, "plus");
  assert.deepEqual(
    q.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]),
    [
      ["Fenêtre de 5 h", 38, 1_795_050_000_000],
      ["Fenêtre de 7 jours", 61, 1_795_400_000_000],
    ],
  );
  assert.equal(q.reached, false);
  assert.equal(tightest(q)!.usedPercent, 61);

  assert.equal(readQuota(response(100, { rateLimitReachedType: "rate_limit_reached" }))!.reached, true);
  assert.equal(readQuota({ ...response(10), ordinaryUsageAllowed: false })!.reached, true);
  assert.equal(readQuota({}), null, "pas de chiffres : rien d'inventé");
  assert.equal(windowLabel(60), "Fenêtre de 1 h");
});

test("mise à jour partielle : ce qui manque n'est pas effacé", () => {
  const first = readQuota(response(38))!;
  const next = mergeQuota(first, { rateLimits: { primary: { usedPercent: 52, windowDurationMins: 300, resetsAt: 1_795_050_000 } } })!;
  assert.deepEqual(next.windows.map((w) => w.usedPercent), [52, 61]);
  assert.equal(next.plan, "plus");
  assert.equal(mergeQuota(next, { rateLimits: { rateLimitReachedType: "rate_limit_reached" } })!.reached, true);
});

test("moteur Codex : quota lu, mis à jour pendant le tour, relu après", async () => {
  const seen: (Quota | null)[] = [];
  let toClark: (l: string) => void = () => {};
  let reads = 0;
  const transport: Transport = {
    write(line) {
      const m = JSON.parse(line);
      const reply = (result: unknown) => queueMicrotask(() => toClark(JSON.stringify({ id: m.id, result })));
      const send = (x: unknown) => queueMicrotask(() => toClark(JSON.stringify(x)));
      if (m.method === "initialize") reply({});
      else if (m.method === "account/read") reply({ account: { type: "chatgpt", planType: "plus" } });
      else if (m.method === "account/rateLimits/read") reply(response(reads++ === 0 ? 38 : 45));
      else if (m.method === "thread/start") reply({ thread: { id: "f" } });
      else if (m.method === "turn/start") {
        reply({ turn: { id: "u" } });
        send({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 44, windowDurationMins: 300, resetsAt: 1 } } } });
        send({ method: "turn/completed", params: { threadId: "f", turn: { status: "completed" } } });
      }
    },
    onLine: (fn) => (toClark = fn),
    onExit: () => {},
    close: () => {},
  };
  const engine = createCodexEngine({ transport: () => transport, onQuota: (q) => seen.push(q) });
  assert.equal((await engine.quota())!.windows[0].usedPercent, 38);

  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const id = journal.create(OWNER_CHAT, "chat", "x");
  await engine.execute({ config, store, journal }, id, { prompt: "x", resume: undefined, mode: "new", approve: async () => true });
  await waitFor(() => seen.length >= 3);

  assert.deepEqual(
    seen.map((q) => q?.windows[0].usedPercent),
    [38, 44, 45],
    "lecture, mise à jour pendant le tour, relecture après",
  );
  assert.equal(engine.lastQuota()!.windows[1].usedPercent, 61, "la fenêtre absente de la mise à jour est gardée");
});

function hubWith(quota: Quota, refreshQuota?: () => Promise<Quota | null>) {
  const calls: string[] = [];
  const execute: typeof executeTask = async (deps, taskId) => {
    if (deps.journal.get(taskId)!.label === "plan") {
      // Clark choisit l'équipe habituelle pour un écrit.
      deps.journal.finish(taskId, "done", '{"standard": true}', 0);
      return { text: '{"standard": true}', costUsd: 0, status: "done" };
    }
    calls.push(deps.journal.get(taskId)!.label);
    const text = deps.journal.get(taskId)!.label.startsWith("relecteur") ? "VERDICT : OK" : "…";
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  };
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config, store, journal, conversation }, { execute, refreshQuota });
  hub.setQuota(quota);
  return { hub, calls, conversation, journal };
}

const quotaAt = (used: number, reached = false): Quota => ({
  plan: "plus",
  windows: [{ label: "Fenêtre de 5 h", usedPercent: used, durationMins: 300, resetsAt: Date.now() + 3600_000 }],
  reached,
  readAt: Date.now(),
});

test("équipe : quota atteint → pas lancée, avec l'heure de remise à zéro", async () => {
  const { hub, calls, conversation, journal } = hubWith(quotaAt(100, true));
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");
  assert.deepEqual(calls, [], "aucun agent lancé");
  assert.equal(journal.get(1)!.status, "failed");
  assert.match(conversation.recent(OWNER_CHAT).at(-1)!.text, /Quota Codex atteint d'après la dernière lecture.*pas pu le revérifier.*à \d\d:\d\d/s);
});

test("équipe : quota presque épuisé → prévenu, puis lancée quand même", async () => {
  const { hub, calls, conversation } = hubWith(quotaAt(92));
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");
  assert.ok(conversation.recent(OWNER_CHAT).some((m) => /presque épuisé : 92 % de la fenêtre de 5 h/.test(m.text)));
  assert.deepEqual(calls, ["chercheur", "redacteur:1", "relecteur:1"]);

  const quiet = hubWith(quotaAt(40));
  await quiet.hub.enqueue(OWNER_CHAT, "x", TEAM_LABEL, "web");
  assert.ok(!quiet.conversation.recent(OWNER_CHAT).some((m) => /presque épuisé/.test(m.text)), "pas d'alerte sous 90 %");
});

test("interface : le quota fait partie de l'état", () => {
  const { hub } = hubWith(quotaAt(38));
  assert.equal(snapshot(hub).quota!.windows[0].usedPercent, 38);
});

// ── Quota épuisé mais remis à zéro depuis : relu avant de refuser ────────

const exhaustedSince = (msAgo: number): Quota => ({
  plan: "plus",
  windows: [{ label: "Fenêtre de 5 h", usedPercent: 100, durationMins: 300, resetsAt: Date.now() - msAgo }],
  reached: true,
  readAt: Date.now() - 6 * 3600_000,
});

test("équipe : ancien quota épuisé, remise à zéro passée → relu une fois, l'équipe part", async () => {
  let reads = 0;
  const { hub, calls, conversation } = hubWith(exhaustedSince(60_000), async () => {
    reads++;
    return quotaAt(3);
  });
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");
  assert.equal(reads, 1, "une seule relecture");
  assert.deepEqual(calls, ["chercheur", "redacteur:1", "relecteur:1"]);
  assert.equal(hub.quota()!.windows[0].usedPercent, 3, "l'interface affiche les chiffres frais");
  assert.ok(!conversation.recent(OWNER_CHAT).some((m) => /Quota Codex atteint/.test(m.text)));
});

test("équipe : quota épuisé et relu toujours épuisé → refus, sans boucler", async () => {
  let reads = 0;
  const { hub, calls, journal } = hubWith(quotaAt(100, true), async () => {
    reads++;
    return quotaAt(100, true);
  });
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");
  assert.equal(reads, 1);
  assert.deepEqual(calls, []);
  assert.equal(journal.get(1)!.status, "failed");
  assert.match(journal.get(1)!.result!, /je viens de le revérifier/);
});

test("équipe : relecture impossible AVANT la remise à zéro → refus, en disant que le quota n'a pas été revérifié", async () => {
  const { hub, calls, journal } = hubWith(quotaAt(100, true), async () => {
    throw new Error("Codex injoignable");
  });
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");
  assert.deepEqual(calls, []);
  assert.match(journal.get(1)!.result!, /d'après la dernière lecture \(à \d\d:\d\d\)\. Je n'ai pas pu le revérifier/);
});

test("moteur Codex : une relecture du quota qui échoue le signale au lieu de rendre l'ancien quota", async () => {
  let toClark: (l: string) => void = () => {};
  let fail = false;
  const transport: Transport = {
    write(line) {
      const m = JSON.parse(line);
      const answer = (x: unknown) => queueMicrotask(() => toClark(JSON.stringify({ id: m.id, ...(x as object) })));
      if (m.method === "initialize") answer({ result: {} });
      else if (m.method === "account/rateLimits/read") answer(fail ? { error: { code: -1, message: "injoignable" } } : { result: response(100, { rateLimitReachedType: "rate_limit_reached" }) });
    },
    onLine: (fn) => (toClark = fn),
    onExit: () => {},
    close: () => {},
  };
  const engine = createCodexEngine({ transport: () => transport });
  assert.equal((await engine.quota())!.reached, true);
  fail = true;
  await assert.rejects(engine.quota(), /injoignable/);
  assert.equal(engine.lastQuota()!.reached, true, "la dernière lecture reste affichée");
});

test("équipe : remise à zéro passée mais relecture impossible → lancée, avec un avertissement", async () => {
  const { hub, calls, conversation } = hubWith(exhaustedSince(60_000), async () => {
    throw new Error("Codex injoignable");
  });
  await hub.enqueue(OWNER_CHAT, "Prépare mes relances", TEAM_LABEL, "web");
  assert.deepEqual(calls, ["chercheur", "redacteur:1", "relecteur:1"]);
  assert.ok(conversation.recent(OWNER_CHAT).some((m) => /remise à zéro est passée et je n'ai pas pu le relire/.test(m.text)));
});

test("équipe : quota sous la limite et à jour → pas de relecture inutile", async () => {
  let reads = 0;
  const { hub } = hubWith(quotaAt(40), async () => {
    reads++;
    return quotaAt(40);
  });
  await hub.enqueue(OWNER_CHAT, "x", TEAM_LABEL, "web");
  assert.equal(reads, 0);
});
