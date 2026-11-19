import type { DatabaseSync } from "node:sqlite";

/**
 * Modèle et niveau de puissance choisis pour chaque moteur, depuis l'interface. Rangés dans
 * la base : ils survivent au redémarrage et chaque nouvelle tâche lit le choix du moment.
 * null = le défaut du moteur (ou celui de .env).
 */
export type EngineChoice = { model: string | null; effort: string | null };

/** Un modèle proposé par un moteur, avec ses niveaux de puissance. */
export type ModelChoice = { id: string; name: string; description: string; efforts: string[]; defaultEffort: string | null; isDefault?: boolean };

/** Ce qu'un moteur propose, lu auprès de lui (jamais écrit en dur). */
export type Catalog = { models: ModelChoice[]; readAt: number };

export const EFFORT_LABELS: Record<string, string> = {
  none: "aucune",
  minimal: "minimale",
  low: "faible",
  medium: "moyenne",
  high: "élevée",
  xhigh: "très élevée",
  max: "maximale",
};

export class EngineChoices {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS engine_choices (
        engine TEXT PRIMARY KEY,
        model  TEXT,
        effort TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  get(engine: string): EngineChoice {
    const row = this.db.prepare("SELECT model, effort FROM engine_choices WHERE engine = ?").get(engine) as EngineChoice | undefined;
    return { model: row?.model ?? null, effort: row?.effort ?? null };
  }

  set(engine: string, c: EngineChoice) {
    this.db
      .prepare("INSERT INTO engine_choices (engine, model, effort) VALUES (?, ?, ?) ON CONFLICT(engine) DO UPDATE SET model = excluded.model, effort = excluded.effort, updated_at = datetime('now')")
      .run(engine, c.model, c.effort);
  }
}

/**
 * Vérifie un choix contre ce que le moteur propose. Sans liste lue (moteur pas encore
 * joint), on refuse : on ne devine pas les modèles. Renvoie une erreur lisible, ou null.
 */
export function checkChoice(c: EngineChoice, catalog: Catalog | null): string | null {
  if (!catalog) return "Je n'ai pas encore la liste des modèles de ce moteur : connecte-le, puis actualise.";
  if (c.model === null) return c.effort === null ? null : "Choisis un modèle avant un niveau de puissance.";
  const m = catalog.models.find((x) => x.id === c.model);
  if (!m) return `Modèle inconnu de ce moteur : ${c.model}`;
  if (c.effort !== null && !m.efforts.includes(c.effort)) return `${m.name} ne propose pas ce niveau de puissance : ${c.effort}`;
  return null;
}
