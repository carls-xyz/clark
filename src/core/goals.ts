import type { DatabaseSync } from "node:sqlite";

/**
 * Objectifs (mode objectif, idée reprise de Spettro) : l'utilisateur donne un but, Clark enchaîne
 * les tours jusqu'à l'atteindre. Chaque tour se termine par un compte rendu (report_goal) :
 * avancée, objectif atteint, ou blocage. Clark s'arrête seul s'il tourne en rond, s'il manque
 * de quota ou s'il atteint le nombre de tours permis, et attend alors l'utilisateur.
 *
 * Chaque objectif a sa propre conversation (GOAL_CHAT_BASE + id) : les tours se suivent
 * avec leur contexte, sans encombrer la conversation de l'utilisateur.
 */
export const GOAL_CHAT_BASE = 1000;
export const goalChat = (id: number) => GOAL_CHAT_BASE + id;
// Les fils 2000 et plus sont ceux des tâches dev (src/dev/store.ts).
export const isGoalChat = (chatId: number) => chatId >= GOAL_CHAT_BASE && chatId < 2000;
export const goalOfChat = (chatId: number) => (isGoalChat(chatId) ? chatId - GOAL_CHAT_BASE : null);
export const GOAL_LABEL_PREFIX = "goal:";
export const goalOfLabel = (label: string) => (label.startsWith(GOAL_LABEL_PREFIX) ? Number(label.slice(GOAL_LABEL_PREFIX.length)) || null : null);

/**
 * - active  : Clark enchaîne les tours.
 * - waiting : Clark attend l'utilisateur (blocage, tour qui tourne en rond, quota, limite de tours, échec).
 * - paused  : mis en pause par l'utilisateur.
 * - done    : objectif atteint.  - stopped : arrêté par l'utilisateur.
 */
export type GoalStatus = "active" | "waiting" | "paused" | "done" | "stopped";
export type GoalEventKind = "progress" | "done" | "blocked" | "note" | "system";

export type Goal = {
  id: number;
  objective: string;
  status: GoalStatus;
  reason: string | null;
  max_turns: number;
  turns: number;
  /** Dernier tour déjà évalué : une reprise ne réévalue pas le tour qui avait bloqué. */
  evaluated: number;
  summary: string | null;
  created_at: string;
  updated_at: string;
};

export type GoalEvent = { id: number; goal_id: number; turn: number; kind: GoalEventKind; text: string; next_step: string | null; task_id: number | null; created_at: string };

export const MAX_TURNS_LIMIT = 30;
export const DEFAULT_MAX_TURNS = 10;

export class Goals {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id         INTEGER PRIMARY KEY,
        objective  TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','waiting','paused','done','stopped')),
        reason     TEXT,
        max_turns  INTEGER NOT NULL DEFAULT 10,
        turns      INTEGER NOT NULL DEFAULT 0,
        evaluated  INTEGER NOT NULL DEFAULT 0,
        summary    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS goal_events (
        id         INTEGER PRIMARY KEY,
        goal_id    INTEGER NOT NULL REFERENCES goals(id),
        turn       INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        text       TEXT NOT NULL,
        next_step  TEXT,
        task_id    INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  create(objective: string, maxTurns = DEFAULT_MAX_TURNS): number {
    const turns = Math.max(1, Math.min(MAX_TURNS_LIMIT, Math.round(maxTurns)));
    const r = this.db.prepare("INSERT INTO goals (objective, max_turns) VALUES (?, ?)").run(objective.trim(), turns);
    this.changed();
    return Number(r.lastInsertRowid);
  }

  get(id: number): Goal | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Goal | undefined;
  }

  list(limit = 20): Goal[] {
    return this.db
      .prepare("SELECT * FROM goals ORDER BY CASE WHEN status IN ('active','waiting','paused') THEN 0 ELSE 1 END, id DESC LIMIT ?")
      .all(limit) as Goal[];
  }

  byStatus(...statuses: GoalStatus[]): Goal[] {
    return this.db.prepare(`SELECT * FROM goals WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`).all(...statuses) as Goal[];
  }

  setStatus(id: number, status: GoalStatus, reason: string | null = null, from?: GoalStatus[]): boolean {
    const guard = from ? ` AND status IN (${from.map(() => "?").join(",")})` : "";
    const ok =
      this.db.prepare(`UPDATE goals SET status = ?, reason = ?, updated_at = datetime('now') WHERE id = ?${guard}`).run(status, reason, id, ...(from ?? [])).changes > 0;
    if (ok) this.changed();
    return ok;
  }

  startTurn(id: number): number {
    this.db.prepare("UPDATE goals SET turns = turns + 1, updated_at = datetime('now') WHERE id = ?").run(id);
    this.changed();
    return this.get(id)!.turns;
  }

  markEvaluated(id: number) {
    this.db.prepare("UPDATE goals SET evaluated = turns WHERE id = ?").run(id);
  }

  /** L'utilisateur relève la limite pour continuer : au moins quelques tours de plus. */
  extend(id: number, extra = 5) {
    this.db.prepare("UPDATE goals SET max_turns = MIN(?, MAX(max_turns, turns + ?)), updated_at = datetime('now') WHERE id = ?").run(MAX_TURNS_LIMIT, extra, id);
    this.changed();
  }

  finish(id: number, summary: string) {
    this.db.prepare("UPDATE goals SET status = 'done', reason = NULL, summary = ?, updated_at = datetime('now') WHERE id = ?").run(summary, id);
    this.changed();
  }

  addEvent(e: { goalId: number; turn: number; kind: GoalEventKind; text: string; nextStep?: string | null; taskId?: number | null }) {
    this.db
      .prepare("INSERT INTO goal_events (goal_id, turn, kind, text, next_step, task_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.goalId, e.turn, e.kind, e.text.trim(), e.nextStep?.trim() || null, e.taskId ?? null);
    this.changed();
  }

  events(goalId: number, limit = 50): GoalEvent[] {
    return (this.db.prepare("SELECT * FROM goal_events WHERE goal_id = ? ORDER BY id DESC LIMIT ?").all(goalId, limit) as GoalEvent[]).reverse();
  }

  /** Le compte rendu d'un tour (le dernier si l'agent en a fait plusieurs). */
  reportOf(goalId: number, turn: number): GoalEvent | undefined {
    return this.db
      .prepare("SELECT * FROM goal_events WHERE goal_id = ? AND turn = ? AND kind IN ('progress','done','blocked') ORDER BY id DESC LIMIT 1")
      .get(goalId, turn) as GoalEvent | undefined;
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Deux comptes rendus qui disent la même chose : Clark tourne en rond. */
export function sameProgress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new Set(norm(a).split(" ").filter((w) => w.length > 3));
  const y = new Set(norm(b).split(" ").filter((w) => w.length > 3));
  if (!x.size || !y.size) return norm(a) === norm(b);
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.max(x.size, y.size) >= 0.8;
}
