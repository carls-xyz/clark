/**
 * Autres IA, par clé d'API : des fournisseurs qui parlent le format « chat completions » d'OpenAI
 * (OpenRouter, Mistral, Gemini, Ollama en local…). La clé reste dans .env ; un fournisseur est actif
 * dès que sa clé y est (Ollama : dès qu'il répond sur ce Mac).
 */
export type Provider = {
  id: string;
  label: string;
  baseUrl: string;
  /** Variable de .env qui porte la clé ; null : pas de clé (Ollama, en local). */
  keyEnv: string | null;
  /** Où créer la clé. */
  site: string;
};

export const PROVIDERS: Provider[] = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", site: "openrouter.ai" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", site: "console.mistral.ai" },
  { id: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", site: "aistudio.google.com" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", site: "console.groq.com" },
  { id: "ollama", label: "Ollama", baseUrl: `${(process.env.OLLAMA_HOST?.trim() || "http://localhost:11434").replace(/\/$/, "")}/v1`, keyEnv: null, site: "ollama.com" },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);
export const keyOf = (p: Provider, env: NodeJS.ProcessEnv = process.env) => (p.keyEnv ? env[p.keyEnv]?.trim() || null : null);

/** Identifiant d'un modèle chez Clark : « fournisseur:modèle » (le modèle peut contenir « / » ou « : »). */
export const modelKey = (provider: string, model: string) => `${provider}:${model}`;
export function splitModelKey(key: string): { provider: string; model: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  return { provider: key.slice(0, at), model: key.slice(at + 1) };
}

/** Au plus tant de modèles par fournisseur dans le menu (OpenRouter en a des centaines). */
export const MAX_MODELS = 40;

export type ProviderModel = { id: string; name: string };

/**
 * Les modèles d'un fournisseur, lus sur son API (/models). OpenRouter : seulement ceux qui savent
 * appeler des outils (sans outils, Clark ne peut ni chercher dans sa mémoire ni rien faire).
 */
export async function listModels(p: Provider, fetcher: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<ProviderModel[]> {
  const key = keyOf(p, env);
  const res = await fetcher(`${p.baseUrl}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "clé refusée" : `réponse ${res.status}`);
  const body = (await res.json()) as { data?: { id: string; name?: string; supported_parameters?: string[] }[]; models?: { name: string }[] };
  const list = body.data ?? [];
  return list
    .filter((m) => !m.supported_parameters || m.supported_parameters.includes("tools"))
    .map((m) => ({ id: m.id.replace(/^models\//, ""), name: (m.name ?? m.id).replace(/^models\//, "") }))
    .filter((m) => !/embed|whisper|tts|guard|moderation|image|vision-only|audio/i.test(m.id))
    .slice(0, MAX_MODELS);
}

/** Les fournisseurs utilisables maintenant : clé présente, ou Ollama qui répond. */
export async function activeProviders(fetcher: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<Provider[]> {
  const out: Provider[] = [];
  for (const p of PROVIDERS) {
    if (p.keyEnv) {
      if (keyOf(p, env)) out.push(p);
      continue;
    }
    // Ollama : seulement s'il tourne (réponse rapide, sinon on n'attend pas).
    const ok = await fetcher(`${p.baseUrl}/models`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) out.push(p);
  }
  return out;
}
