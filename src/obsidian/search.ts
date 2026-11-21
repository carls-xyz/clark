import { searchVault } from "./vault.ts";

export type VaultHit = { path: string; title: string; snippet: string; why?: string };

/**
 * Recherche dans le coffre : par mots, et par le sens quand l'index sémantique est prêt
 * (src/memory/semantic.ts le branche ici). Les deux listes sont fusionnées.
 */
let semantic: ((query: string, limit: number) => Promise<VaultHit[]>) | null = null;
export function setSemanticVaultSearch(f: typeof semantic) {
  semantic = f;
}

export async function searchVaultSmart(root: string, query: string, limit = 8): Promise<VaultHit[]> {
  const byWords: VaultHit[] = searchVault(root, query, limit).map((h) => ({ path: h.path, title: h.title, snippet: h.snippet, why: "mots" }));
  let bySense: VaultHit[] = [];
  try {
    bySense = (await semantic?.(query, limit)) ?? [];
  } catch {
    bySense = [];
  }
  const both = new Set(byWords.filter((w) => bySense.some((x) => x.path === w.path)).map((w) => w.path));
  const seen = new Set<string>();
  const out: VaultHit[] = [];
  // En alternance : le meilleur par le sens, le meilleur par mots, etc.
  for (let i = 0; out.length < limit && (i < bySense.length || i < byWords.length); i++) {
    for (const h of [bySense[i], byWords[i]]) {
      if (!h || seen.has(h.path)) continue;
      seen.add(h.path);
      out.push(both.has(h.path) ? { ...h, why: "mots et sens" } : h);
    }
  }
  return out.slice(0, limit);
}
