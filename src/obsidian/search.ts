import { searchVault } from "./vault.ts";

export type VaultHit = { path: string; title: string; snippet: string; why?: string };

/**
 * Recherche dans le coffre : par mots, et par le sens (résultats de src/memory/semantic.ts,
 * passés par l'appelant). Les deux listes sont fusionnées en alternance.
 */
export async function searchVaultSmart(root: string, query: string, limit = 8, bySense: VaultHit[] = []): Promise<VaultHit[]> {
  const byWords: VaultHit[] = searchVault(root, query, limit).map((h) => ({ path: h.path, title: h.title, snippet: h.snippet, why: "mots" }));
  const both = new Set(byWords.filter((w) => bySense.some((x) => x.path === w.path)).map((w) => w.path));
  const words = new Map(byWords.map((w) => [w.path, w]));
  const seen = new Set<string>();
  const out: VaultHit[] = [];
  for (let i = 0; out.length < limit && (i < bySense.length || i < byWords.length); i++) {
    for (const h of [bySense[i], byWords[i]]) {
      if (!h || seen.has(h.path)) continue;
      seen.add(h.path);
      // Trouvée par le sens seulement : l'extrait vient de la recherche par mots s'il y en a un.
      out.push({ ...h, snippet: h.snippet || words.get(h.path)?.snippet || "", why: both.has(h.path) ? "mots et sens" : h.why });
    }
  }
  return out.slice(0, limit);
}
