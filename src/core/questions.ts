import type { DatabaseSync } from "node:sqlite";

/**
 * Questions d'un agent à Charles (idée reprise de l'orchestration d'Orca : un worker
 * demande au lieu de deviner, puis attend la réponse). Elles passent par la base pour
 * fonctionner aussi depuis le serveur MCP de Codex, qui tourne dans un autre processus.
 */
export type Question = {
  id: number;
  task_id: number;
  agent: string | null;
  question: string;
  /** Choix proposés (JSON). Vide : réponse libre. */
  options: string;
  status: "pending" | "answered" | "expired";
  answer: string | null;
  created_at: string;
  answered_at: string | null;
};

export const QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

export class Questions {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(event: "asked" | "changed", q?: Question) => void>();
  private readonly announced = new Set<number>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS questions (
        id          INTEGER PRIMARY KEY,
        task_id     INTEGER NOT NULL,
        agent       TEXT,
        question    TEXT NOT NULL,
        options     TEXT NOT NULL DEFAULT '[]',
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','expired')),
        answer      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at TEXT
      );
    `);
    for (const q of this.pending()) this.announced.add(q.id);
  }

  onEvent(listener: (event: "asked" | "changed", q?: Question) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: "asked" | "changed", q?: Question) {
    for (const l of this.listeners) l(event, q);
  }

  get(id: number): Question | undefined {
    return this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Question | undefined;
  }

  pending(): Question[] {
    return this.db.prepare("SELECT * FROM questions WHERE status = 'pending' ORDER BY id").all() as Question[];
  }

  ask(q: { taskId: number; agent?: string | null; question: string; options?: string[] }): number {
    const options = (q.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 6);
    const r = this.db
      .prepare("INSERT INTO questions (task_id, agent, question, options) VALUES (?, ?, ?, ?)")
      .run(q.taskId, q.agent ?? null, q.question.trim(), JSON.stringify(options));
    const id = Number(r.lastInsertRowid);
    this.announced.add(id);
    this.emit("asked", this.get(id));
    return id;
  }

  /** Une question posée depuis un autre processus (serveur MCP de Codex) : on la signale ici. */
  sync() {
    for (const q of this.pending()) {
      if (this.announced.has(q.id)) continue;
      this.announced.add(q.id);
      this.emit("asked", q);
    }
  }

  /** false si la question n'attend plus de réponse. */
  answer(id: number, text: string): boolean {
    const ok =
      this.db
        .prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(text.trim(), id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }

  expire(id: number): boolean {
    const ok = this.db.prepare("UPDATE questions SET status = 'expired' WHERE id = ? AND status = 'pending'").run(id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }

  /** Au démarrage : les questions d'avant la coupure ne seront plus lues ; l'agent repris redemandera. */
  expireAll(): number {
    const n = Number(this.db.prepare("UPDATE questions SET status = 'expired' WHERE status = 'pending'").run().changes);
    if (n) this.emit("changed");
    return n;
  }

  /**
   * Attend la réponse en relisant la base : marche dans le même processus comme depuis
   * le serveur MCP. null = pas de réponse dans le délai (la question expire).
   */
  async wait(id: number, opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
    const deadline = Date.now() + (opts.timeoutMs ?? QUESTION_TIMEOUT_MS);
    const poll = opts.pollMs ?? 400;
    while (Date.now() < deadline && !opts.signal?.aborted) {
      const q = this.get(id);
      if (!q || q.status === "expired") return null;
      if (q.status === "answered") return q.answer ?? "";
      await new Promise((r) => setTimeout(r, poll));
    }
    this.expire(id);
    return null;
  }
}

export const optionsOf = (q: Question): string[] => {
  try {
    const v = JSON.parse(q.options);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
