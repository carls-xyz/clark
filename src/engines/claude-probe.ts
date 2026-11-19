import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "./claude-auth.ts";
import type { ModelChoice } from "./choices.ts";
import { windowLabel, type Quota, type QuotaWindow } from "./quota.ts";

/**
 * Ce que Claude Code dit de ton abonnement, sans envoyer de message au modèle (rien n'est
 * consommé) : les modèles proposés, avec leurs niveaux de puissance, et l'usage du forfait
 * (fenêtres de 5 h et de 7 jours), comme la commande /usage.
 *
 * La lecture de l'usage passe par une API que le SDK marque comme expérimentale : si elle
 * change ou échoue, le quota reste inconnu, le reste continue de marcher.
 */
export function claudeModels(list: ModelInfo[]): ModelChoice[] {
  return list.map((m) => ({
    id: m.value,
    name: m.displayName,
    description: m.description,
    efforts: m.supportsEffort ? [...(m.supportedEffortLevels ?? [])] : [],
    defaultEffort: null,
  }));
}

const WINDOWS: [key: string, mins: number, suffix: string][] = [
  ["five_hour", 300, ""],
  ["seven_day", 7 * 24 * 60, ""],
  ["seven_day_opus", 7 * 24 * 60, " (Opus)"],
  ["seven_day_sonnet", 7 * 24 * 60, " (Sonnet)"],
];

/** Réponse de l'usage de Claude Code → le même format que le quota de Codex. */
export function claudeQuota(usage: any, now = Date.now()): Quota | null {
  if (!usage?.rate_limits_available || !usage.rate_limits) return null;
  const windows: QuotaWindow[] = [];
  for (const [key, mins, suffix] of WINDOWS) {
    const w = usage.rate_limits[key];
    if (!w || typeof w.utilization !== "number") continue;
    const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN;
    windows.push({ label: windowLabel(mins) + suffix, usedPercent: Math.max(0, Math.min(100, w.utilization)), durationMins: mins, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null });
  }
  if (!windows.length) return null;
  return { plan: usage.subscription_type ?? null, windows, reached: windows.some((w) => w.usedPercent >= 100), readAt: now };
}

/**
 * Pendant une tâche, Claude Code signale l'état du forfait (rate_limit_event). On n'en
 * retient que le refus : la limite est atteinte. Les pourcentages viennent de la relecture.
 */
let limitListener: (info: { status: string; resetsAt?: number }) => void = () => {};
export function onClaudeLimit(fn: typeof limitListener) {
  limitListener = fn;
}
export function reportClaudeLimit(info: { status: string; resetsAt?: number }) {
  limitListener(info);
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} : pas de réponse en ${ms / 1000} s`)), ms).unref())]);

export async function probeClaude(opts: { env?: Record<string, string | undefined> } = {}): Promise<{ models: ModelChoice[]; quota: Quota | null; quotaError: string | null }> {
  const abort = new AbortController();
  // Entrée en flux qui n'envoie rien : la session s'ouvre, on lui pose nos questions, puis on la ferme.
  async function* idle(): AsyncGenerator<never> {
    await new Promise((r) => abort.signal.addEventListener("abort", r, { once: true }));
  }
  const q = query({ prompt: idle(), options: { env: opts.env ?? claudeEnv(), settingSources: [], strictMcpConfig: true, abortController: abort, tools: [] } });
  // Les messages de la session (initialisation…) doivent être lus pour qu'elle avance.
  const drain = (async () => {
    try {
      for await (const _ of q);
    } catch {
      // fermeture
    }
  })();
  try {
    const models = claudeModels(await withTimeout(q.supportedModels(), 30_000, "liste des modèles"));
    let quota: Quota | null = null;
    let quotaError: string | null = null;
    try {
      quota = claudeQuota(await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 30_000, "usage"));
      if (!quota) quotaError = "Claude Code ne donne pas de quota pour cette connexion (clé API, ou forfait sans limites lisibles).";
    } catch (err) {
      quotaError = err instanceof Error ? err.message : String(err);
    }
    return { models, quota, quotaError };
  } finally {
    abort.abort();
    q.close();
    await drain;
  }
}
