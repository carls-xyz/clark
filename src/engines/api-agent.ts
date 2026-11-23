import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { paths } from "../config.ts";
import type { Deps, RunOptions, RunResult } from "../core/agent.ts";
import { buildSystemPrompt } from "../core/prompt.ts";
import { onStop } from "../core/stops.ts";
import { memoryTools } from "../memory/tools.ts";
import { createPolicy, READ_ONLY_REFUSAL } from "../policy/permissions.ts";
import { activeProviders, keyOf, listModels, modelKey, providerById, splitModelKey, type Provider } from "./providers.ts";

/**
 * Moteur « Autres IA » : un modèle d'un fournisseur par clé d'API (OpenRouter, Mistral, Gemini,
 * Groq, Ollama…), sans agent tout fait. Clark fait tourner lui-même la boucle : le modèle demande
 * un outil, Clark le vérifie (mêmes règles et mêmes accords que pour Claude), l'exécute, rend le
 * résultat, jusqu'à la réponse. Les outils sont ceux de Clark (mémoire, mails, agenda, navigateur,
 * coffre, délégation…), pas ceux de code de Claude Code ou Codex : le code reste à ceux-là.
 */

export const API_ENGINE = "api" as const;
/** Tours outil → réponse au plus, par message. */
export const MAX_STEPS = 20;
/** Messages gardés d'un tour à l'autre (la conversation, sans le prompt système). */
const KEEP = 60;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** Sessions : la conversation avec le modèle, gardée par Clark (ces API ne gardent rien). */
class ApiSessions {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS api_sessions (id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  }
  get(id: string | undefined): ChatMessage[] {
    if (!id) return [];
    const row = this.db.prepare("SELECT messages FROM api_sessions WHERE id = ?").get(id) as { messages: string } | undefined;
    try {
      return row ? (JSON.parse(row.messages) as ChatMessage[]) : [];
    } catch {
      return [];
    }
  }
  save(id: string, messages: ChatMessage[]) {
    // On coupe au début d'un message de l'utilisateur : jamais un résultat d'outil sans sa demande.
    let kept = messages.slice(-KEEP);
    const first = kept.findIndex((m) => m.role === "user");
    kept = first > 0 ? kept.slice(first) : kept;
    this.db
      .prepare("INSERT INTO api_sessions (id, messages) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = datetime('now')")
      .run(id, JSON.stringify(kept));
  }
}

type ToolEntry = { description: string; shape: z.ZodRawShape; run: (a: any) => string | Promise<string> };

/** Les outils de Clark au format « function » d'OpenAI (schéma JSON tiré du schéma zod). */
export function toolSpecs(tools: Record<string, unknown>) {
  const specs: { type: "function"; function: { name: string; description: string; parameters: unknown } }[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const e = t as Partial<ToolEntry>;
    if (!e || typeof e.run !== "function" || typeof e.description !== "string" || !e.shape) continue;
    let parameters: Record<string, unknown>;
    try {
      parameters = z.toJSONSchema(z.object(e.shape), { unrepresentable: "any" }) as Record<string, unknown>;
    } catch {
      continue;
    }
    delete parameters.$schema;
    specs.push({ type: "function", function: { name, description: e.description.slice(0, 1000), parameters } });
  }
  return specs;
}

export type ApiEngineOptions = {
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Prompt système (remplacé dans les tests). */
  system?: (deps: Deps) => string;
};

export function createApiEngine(opts: ApiEngineOptions = {}) {
  const fetcher = opts.fetcher ?? fetch;
  const env = opts.env ?? process.env;
  let providers: Provider[] = [];

  async function status() {
    providers = await activeProviders(fetcher, env);
    return {
      ready: providers.length > 0,
      account: providers.length ? providers.map((p) => p.label).join(", ") : null,
      problem: providers.length ? null : "aucune clé : ajoute par exemple OPENROUTER_API_KEY, MISTRAL_API_KEY ou GEMINI_API_KEY dans .env (ou lance Ollama), puis redémarre",
    };
  }

  /** Les modèles de tous les fournisseurs actifs ; un fournisseur qui ne répond pas est sauté (et signalé). */
  async function models() {
    const out: { id: string; name: string; description: string; efforts: string[]; defaultEffort: null }[] = [];
    const errors: string[] = [];
    for (const p of providers) {
      try {
        for (const m of await listModels(p, fetcher, env)) out.push({ id: modelKey(p.id, m.id), name: `${p.label} · ${m.name}`, description: "", efforts: [], defaultEffort: null });
      } catch (err) {
        errors.push(`${p.label} : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!out.length && errors.length) throw new Error(errors.join(" ; "));
    return out;
  }

  async function complete(p: Provider, model: string, messages: ChatMessage[], tools: ReturnType<typeof toolSpecs>, signal: AbortSignal) {
    const key = keyOf(p, env);
    const res = await fetcher(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(p.id === "openrouter" ? { "X-Title": "Clark" } : {}) },
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools, tool_choice: "auto" } : {}) }),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(res.status === 401 || res.status === 403 ? `${p.label} a refusé la clé.` : res.status === 429 ? `${p.label} : limite atteinte, réessaie plus tard.` : `${p.label} a répondu ${res.status}${detail ? ` : ${detail}` : ""}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
    return body.choices?.[0]?.message ?? { content: "" };
  }

  async function execute(deps: Deps, taskId: number, run: RunOptions): Promise<RunResult> {
    const { store, journal } = deps;
    const task = journal.get(taskId);
    if (!task) throw new Error(`Tâche ${taskId} introuvable`);
    const fail = (text: string): RunResult => {
      journal.finish(taskId, "failed", text, 0, run.attempt);
      return { text, costUsd: 0, status: "failed" };
    };
    if (!providers.length) await status();
    const choice = run.model ?? store.choices.get(API_ENGINE).model;
    const picked = choice ? splitModelKey(choice) : null;
    const p = picked ? providerById(picked.provider) : providers[0];
    if (!p || !providers.some((x) => x.id === p.id)) return fail("Aucune autre IA n'est connectée : ajoute une clé d'API dans .env (Réglages › Moteurs › Autres IA), puis redémarre.");
    let model = picked?.model;
    if (!model) {
      const list = await listModels(p, fetcher, env).catch(() => []);
      model = list[0]?.id;
      if (!model) return fail(`${p.label} ne propose aucun modèle utilisable.`);
    }

    journal.setStatus(taskId, "running");
    journal.setAccess(taskId, run.access ?? "write");
    const sessions = new ApiSessions(store.db);
    const sessionId = run.resume && sessions.get(run.resume).length ? run.resume : randomUUID();
    journal.setSession(taskId, sessionId);
    if (task.parent_id === null) store.setSession(task.chat_id, sessionId);

    const tools = memoryTools(store, { taskId: () => taskId, writeRefusal: () => (run.access === "read" ? READ_ONLY_REFUSAL : null) }) as unknown as Record<string, ToolEntry>;
    const specs = toolSpecs(tools);
    const policy = createPolicy({ store, journal, taskId, roots: [paths.workspace, paths.coreMemory], approve: run.approve, access: run.access, attempt: run.attempt });
    const system = (opts.system ?? ((d: Deps) => buildSystemPrompt(d.store, paths.coreMemory)))(deps);
    const history = sessions.get(sessionId);
    const messages: ChatMessage[] = [...history, { role: "user", content: run.prompt }];

    const abort = new AbortController();
    const offStop = onStop(taskId, () => abort.abort());
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await complete(p, model, [{ role: "system", content: `${system}\n\nTu tournes sur ${p.label} (${model}). Tu as les outils de Clark, pas d'outils de code : pour du code, passe par start_code_task.` }, ...messages], specs, abort.signal);
        const calls = reply.tool_calls ?? [];
        messages.push({ role: "assistant", content: reply.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) {
          const text = (reply.content ?? "").trim() || "(pas de réponse)";
          sessions.save(sessionId, messages);
          if (!run.keepOpen) journal.finish(taskId, "done", text, 0, run.attempt);
          return { text, costUsd: 0, status: "done" };
        }
        for (const call of calls) {
          const name = call.function.name;
          let input: Record<string, unknown> = {};
          try {
            input = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
          } catch {
            messages.push({ role: "tool", tool_call_id: call.id, content: "Arguments illisibles (JSON attendu)." });
            continue;
          }
          const tool = tools[name];
          if (!tool || typeof tool.run !== "function") {
            messages.push({ role: "tool", tool_call_id: call.id, content: `Outil inconnu : ${name}.` });
            continue;
          }
          const toolUseId = `api-${taskId}-${call.id}`;
          const verdict = await policy(`mcp__memory__${name}`, input, { signal: abort.signal, toolUseID: toolUseId } as never);
          if (!verdict || verdict.behavior !== "allow") {
            const why = verdict && "message" in verdict && typeof verdict.message === "string" ? verdict.message : "Refusé.";
            journal.completeStep(toolUseId, why, true);
            messages.push({ role: "tool", tool_call_id: call.id, content: why });
            continue;
          }
          let out: string;
          let isError = false;
          try {
            out = String(await tool.run(input));
          } catch (err) {
            out = err instanceof Error ? err.message : String(err);
            isError = true;
          }
          journal.completeStep(toolUseId, out.slice(0, 4000), isError);
          messages.push({ role: "tool", tool_call_id: call.id, content: out.slice(0, 20_000) });
        }
        journal.touch();
      }
      sessions.save(sessionId, messages);
      return fail(`Arrêté après ${MAX_STEPS} appels d'outils sans réponse finale.`);
    } catch (err) {
      sessions.save(sessionId, messages);
      if (abort.signal.aborted) return fail("Arrêté à ta demande.");
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      offStop();
    }
  }

  return { status, models, execute, providers: () => providers };
}

export type ApiEngine = ReturnType<typeof createApiEngine>;
