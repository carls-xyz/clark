import type { DatabaseSync } from "node:sqlite";

/**
 * Propositions de Clark (heartbeat) : pendant son tour de veille, Clark repère ce qui
 * mérite ton attention et te propose d'agir. Rien ne part sans toi : tu acceptes (la
 * proposition devient une tâche) ou tu refuses (Clark s'en souvient et ne la refait pas).
 */
export type InitiativeMode = "chat" | "team" | "goal";

export type Initiative = {
  id: number;
  title: string;
  why: string;
  /** Ce que Clark fera si tu acceptes : la consigne de la tâche. */
  action: string;
  /** D'où vient l'idée : un souvenir, une échéance, une tâche… */
  source: string | null;
  /** Ce que l'acceptation lance : un message à Clark, une équipe, ou un objectif de plusieurs tours. */
  mode: InitiativeMode;
  status: "pending" | "accepted" | "declined";
  decline_reason: string | null;
  task_id: number | null;
  created_at: string;
  decided_at: string | null;
};

/** Pas plus de propositions en attente que ça : au-delà, Clark attend que tu tranches. */
export const MAX_PENDING = 3;
/** Une proposition refusée n'est pas refaite pendant cette durée. */
export const DECLINE_MEMORY_DAYS = 30;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export type ProposeOutcome = { outcome: "proposed"; id: number } | { outcome: "duplicate" | "declined_before" | "full"; id?: number };

export class Initiatives {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(event: "proposed" | "changed", i?: Initiative) => void>();
  private readonly announced = new Set<number>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS initiatives (
        id             INTEGER PRIMARY KEY,
        title          TEXT NOT NULL,
        title_key      TEXT NOT NULL,
        why            TEXT NOT NULL,
        action         TEXT NOT NULL,
        source         TEXT,
        status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
        decline_reason TEXT,
        task_id        INTEGER,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at     TEXT
      );
    `);
    const cols = db.prepare("PRAGMA table_info(initiatives)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "mode")) db.exec("ALTER TABLE initiatives ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'");
    for (const i of this.pending()) this.announced.add(i.id);
  }

  onEvent(listener: (event: "proposed" | "changed", i?: Initiative) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: "proposed" | "changed", i?: Initiative) {
    for (const l of this.listeners) l(event, i);
  }

  get(id: number): Initiative | undefined {
    return this.db.prepare("SELECT * FROM initiatives WHERE id = ?").get(id) as Initiative | undefined;
  }

  pending(): Initiative[] {
    return this.db.prepare("SELECT * FROM initiatives WHERE status = 'pending' ORDER BY id").all() as Initiative[];
  }

  /** Les dernières décisions de Charles, données au tour de veille suivant. */
  recentDecisions(limit = 10): Initiative[] {
    return this.db.prepare("SELECT * FROM initiatives WHERE status != 'pending' ORDER BY decided_at DESC, id DESC LIMIT ?").all(limit) as Initiative[];
  }

  propose(i: { title: string; why: string; action: string; source?: string; taskId?: number; mode?: InitiativeMode }): ProposeOutcome {
    const key = normalize(i.title);
    const same = this.db
      .prepare(
        `SELECT id, status FROM initiatives WHERE title_key = ?
           AND (status = 'pending' OR (status = 'declined' AND decided_at >= datetime('now', ?)))
         ORDER BY id DESC LIMIT 1`,
      )
      .get(key, `-${DECLINE_MEMORY_DAYS} days`) as { id: number; status: string } | undefined;
    if (same) return { outcome: same.status === "pending" ? "duplicate" : "declined_before", id: same.id };
    if (this.pending().length >= MAX_PENDING) return { outcome: "full" };
    const r = this.db
      .prepare("INSERT INTO initiatives (title, title_key, why, action, source, task_id, mode) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(i.title.trim(), key, i.why.trim(), i.action.trim(), i.source?.trim() || null, i.taskId ?? null, i.mode ?? "chat");
    const id = Number(r.lastInsertRowid);
    this.announced.add(id);
    this.emit("proposed", this.get(id));
    return { outcome: "proposed", id };
  }

  /** Proposition faite depuis un autre processus (serveur de mémoire de Codex) : on la signale ici. */
  sync() {
    for (const i of this.pending()) {
      if (this.announced.has(i.id)) continue;
      this.announced.add(i.id);
      this.emit("proposed", i);
    }
  }

  decide(id: number, status: "accepted" | "declined", reason?: string): boolean {
    const ok =
      this.db
        .prepare("UPDATE initiatives SET status = ?, decline_reason = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(status, status === "declined" ? reason?.trim() || null : null, id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }
}
