import type { Memory } from "../memory/store.ts";

/**
 * Les souvenirs proches d'un souvenir (liens « Proche de » dans Obsidian). Rempli par la
 * recherche par le sens (src/memory/semantic.ts) quand elle est prête ; vide sinon.
 */
let finder: ((m: Memory) => string[]) | null = null;
export function setRelatedFinder(f: ((m: Memory) => string[]) | null) {
  finder = f;
}
export function relatedNotes(m: Memory): string[] {
  try {
    return finder?.(m) ?? [];
  } catch {
    return [];
  }
}
