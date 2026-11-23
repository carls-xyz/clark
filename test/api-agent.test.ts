import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { createApiEngine, toolSpecs } from "../src/engines/api-agent.ts";
import { activeProviders, splitModelKey } from "../src/engines/providers.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = (): Config => ({ telegram: null, hasApiKey: true, engine: "api", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null });
const ENV = { MISTRAL_API_KEY: "test-key" } as NodeJS.ProcessEnv;

/** Faux Mistral : une liste de modèles, et des réponses dans l'ordre (un appel d'outil, puis le texte). */
function fakeMistral(replies: object[]) {
  const bodies: any[] = [];
  const headers: Record<string, string>[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    headers.push((init?.headers ?? {}) as Record<string, string>);
    // Seul Mistral répond (Ollama n'est pas lancé).
    if (!String(url).startsWith("https://api.mistral.ai/")) throw new Error("connexion refusée");
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mistral-large-latest" }, { id: "mistral-embed" }] }), { status: 200 });
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies.shift() ?? { content: "fin" };
    return new Response(JSON.stringify({ choices: [{ message: next }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, bodies, headers };
}

function setup(replies: object[]) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const m = fakeMistral(replies);
  const api = createApiEngine({ fetcher: m.fetcher, env: ENV, system: () => "Tu es Clark (test)." });
  const ran: string[] = [];
  const claude = (async (deps: any, taskId: number) => {
    ran.push("claude");
    deps.journal.finish(taskId, "done", "claude", 0);
    return { text: "claude", costUsd: 0, status: "done" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config: config(), store, journal, conversation }, { execute: api.execute as unknown as typeof executeTask, executors: { claude } });
  hub.setConnection("claude", { ready: true, account: "abonnement", problem: null });
  return { store, journal, conversation, hub, api, ran, ...m };
}

test("fournisseurs : actifs dès que la clé est dans .env ; Ollama seulement s'il répond ; modèles utilisables seulement", async () => {
  const down = (async () => {
    throw new Error("refusé");
  }) as unknown as typeof fetch;
  assert.deepEqual(
    (await activeProviders(down, ENV)).map((p) => p.id),
    ["mistral"],
  );
  const { api } = setup([]);
  assert.deepEqual(await api.status(), { ready: true, account: "Mistral", problem: null });
  const models = await api.models();
  assert.deepEqual(
    models.map((m) => [m.id, m.name]),
    [["mistral:mistral-large-latest", "Mistral · mistral-large-latest"]],
    "pas les modèles d'embedding",
  );
  assert.deepEqual(splitModelKey("openrouter:meta-llama/llama-3.3:free"), { provider: "openrouter", model: "meta-llama/llama-3.3:free" });
});

test("outils de Clark au format OpenAI : un schéma JSON par outil", () => {
  const store = new Store(":memory:");
  const specs = toolSpecs(memoryTools(store, { taskId: () => 1, writeRefusal: () => null }) as never);
  const recall = specs.find((s) => s.function.name === "recall")!;
  assert.ok(recall, "recall est proposé");
  assert.equal((recall.function.parameters as { type: string }).type, "object");
  assert.ok(specs.length > 20);
});

test("boucle : le modèle demande un outil, Clark l'exécute, puis répond ; la conversation est gardée", async () => {
  const { store, journal, hub, bodies, headers } = setup([
    { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "recall", arguments: JSON.stringify({ query: "relances" }) } }] },
    { content: "Tu n'as rien noté sur les relances." },
    { content: "Toujours rien." },
  ]);
  await hub.enqueue(OWNER_CHAT, "Où en sont mes relances ?", "chat", "web");
  const t = journal.get(Number(store.db.prepare("SELECT max(id) AS id FROM tasks").get()!.id))!;
  assert.equal(t.status, "done");
  assert.equal(t.result, "Tu n'as rien noté sur les relances.");
  assert.equal(bodies[0].model, "mistral-large-latest");
  assert.equal(headers.find((h) => h.Authorization)?.Authorization, "Bearer test-key");
  assert.ok(bodies[0].tools.some((x: any) => x.function.name === "recall"));
  // Le résultat de l'outil revient au modèle, lié à sa demande.
  const toolMsg = bodies[1].messages.find((m: any) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "c1");
  // L'étape est notée dans le journal de la tâche.
  assert.ok(journal.steps(t.id).some((s) => s.tool === "mcp__memory__recall" && s.status === "done"));

  // Message suivant : la conversation précédente est renvoyée au modèle.
  await hub.enqueue(OWNER_CHAT, "Et maintenant ?", "chat", "web");
  const last = bodies.at(-1);
  assert.ok(last.messages.some((m: any) => m.content === "Où en sont mes relances ?"));
  assert.equal(last.messages.at(-1).content, "Et maintenant ?");
});

test("lecture seule : un outil qui écrit est refusé, avec la raison renvoyée au modèle", async () => {
  const { hub, bodies } = setup([
    { content: null, tool_calls: [{ id: "w1", type: "function", function: { name: "propose_memory", arguments: JSON.stringify({ kind: "fact", content: "x", source: "y" }) } }] },
    { content: "D'accord, je ne note rien." },
  ]);
  await hub.enqueue(OWNER_CHAT, "Note ça", "chat", "web", { access: "read" });
  const toolMsg = bodies[1].messages.find((m: any) => m.role === "tool");
  assert.match(toolMsg.content, /lecture seule/);
});

test("tâche de code avec « Autres IA » en moteur principal : elle part sur Claude", async () => {
  const { hub, ran } = setup([]);
  await hub.enqueue(2001, "Corrige le bug", "dev:1", "clark");
  assert.deepEqual(ran, ["claude"]);
});
