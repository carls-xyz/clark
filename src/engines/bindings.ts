import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Liaison fil Codex → tâche Clark, pour le serveur de mémoire.
 *
 * Codex lance un serveur de mémoire par fil. Clark lui passe une clé propre au fil
 * (variable CLARK_BINDING, fixée à l'ouverture du fil). Avant chaque tour, Clark
 * note ici quelle tâche tourne sur ce fil ; après le tour, il l'efface. Le serveur
 * de mémoire retrouve ainsi la tâche qui l'appelle, sans deviner, et refuse
 * d'écrire s'il ne la trouve pas.
 */
export class Bindings {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_bindings (
        binding    TEXT PRIMARY KEY,
        thread_id  TEXT UNIQUE,
        task_id    INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** Clé déjà attribuée à ce fil, ou une nouvelle. */
  forThread(threadId: string | null): string {
    if (threadId) {
      const row = this.db.prepare("SELECT binding FROM codex_bindings WHERE thread_id = ?").get(threadId) as { binding: string } | undefined;
      if (row) return row.binding;
    }
    const binding = randomUUID();
    this.db.prepare("INSERT INTO codex_bindings (binding, thread_id) VALUES (?, ?)").run(binding, threadId);
    return binding;
  }

  /** Une fois l'identifiant du fil connu (après thread/start). */
  attach(binding: string, threadId: string) {
    this.db.prepare("UPDATE codex_bindings SET thread_id = ?, updated_at = datetime('now') WHERE binding = ?").run(threadId, binding);
  }

  setTask(binding: string, taskId: number | null) {
    this.db.prepare("UPDATE codex_bindings SET task_id = ?, updated_at = datetime('now') WHERE binding = ?").run(taskId, binding);
  }
}

export type BoundTask = { id: number; status: string; access: string | null };

/**
 * Côté serveur de mémoire : la tâche liée à cette clé, si elle existe et tourne.
 * null = introuvable (clé absente ou inconnue, pas de tour en cours, tâche terminée).
 */
export function boundTask(db: DatabaseSync, binding: string | undefined): BoundTask | null {
  if (!binding) return null;
  try {
    const row = db
      .prepare(
        `SELECT t.id, t.status, t.access FROM codex_bindings b JOIN tasks t ON t.id = b.task_id
         WHERE b.binding = ?`,
      )
      .get(binding) as BoundTask | undefined;
    return row && row.status === "running" ? row : null;
  } catch {
    return null; // tables absentes : rien n'est lié
  }
}
