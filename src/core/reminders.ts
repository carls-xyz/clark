import type { DatabaseSync } from "node:sqlite";
import { OWNER_CHAT, type Hub } from "./hub.ts";

/**
 * Rappels ponctuels créés depuis la conversation (« rappelle-moi demain à 9 h de… »).
 * Idée reprise d'OpenBot (rien de copié) : l'agent crée lui-même ses rappels et ses
 * automatisations, mais seulement quand c'est Charles qui le demande (jamais à cause d'un
 * mail, d'une page web ou d'un tour planifié : ce texte-là vient de l'extérieur).
 */
export type Reminder = { id: number; text: string; due_at: string; task_id: number | null; status: "pending" | "sent" | "cancelled"; created_at: string };

export class Reminders {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS reminders (
      id         INTEGER PRIMARY KEY,
      text       TEXT NOT NULL,
      due_at     TEXT NOT NULL,
      task_id    INTEGER,
      status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }
  /** due : instant UTC au format SQLite (« AAAA-MM-JJ HH:MM:SS »). */
  add(text: string, due: string, taskId?: number): number {
    return Number(this.db.prepare("INSERT INTO reminders (text, due_at, task_id) VALUES (?, ?, ?)").run(text.trim(), due, taskId ?? null).lastInsertRowid);
  }
  due(now = new Date()): Reminder[] {
    return this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at").all(toSql(now)) as Reminder[];
  }
  pending(): Reminder[] {
    return this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_at").all() as Reminder[];
  }
  mark(id: number, status: "sent" | "cancelled"): boolean {
    return this.db.prepare("UPDATE reminders SET status = ? WHERE id = ? AND status = 'pending'").run(status, id).changes > 0;
  }
}

export const toSql = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

const byDb = new WeakMap<DatabaseSync, Reminders>();
export function remindersOf(db: DatabaseSync): Reminders {
  let r = byDb.get(db);
  if (!r) byDb.set(db, (r = new Reminders(db)));
  return r;
}

/** Sources d'une demande écrite par Charles lui-même (pas un tour planifié, une proposition, un mail). */
export const CHARLES_SOURCES = new Set(["web", "telegram", "imessage", "cli"]);

/** Vérifie chaque minute les rappels arrivés à échéance et les envoie (fil + Telegram). */
export function startReminders(hub: Hub, now: () => Date = () => new Date()): () => void {
  const reminders = remindersOf(hub.deps.store.db);
  const tick = () => {
    for (const r of reminders.due(now())) {
      if (!reminders.mark(r.id, "sent")) continue;
      void hub.post(OWNER_CHAT, `Rappel : ${r.text}`, "clark", "reply");
    }
  };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
