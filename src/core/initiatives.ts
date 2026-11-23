import type { DatabaseSync } from "node:sqlite";

/**
 * Propositions de Clark (heartbeat) : pendant son tour de veille, Clark repère ce qui
 * mérite ton attention et te propose d'agir. Rien ne part sans toi : tu acceptes (la
 * proposition devient une tâche) ou tu refuses (Clark s'en souvient et ne la refait pas).
 */
export type InitiativeMode = "chat" | "team" | "goal";

/** Le genre de proposition : le bilan se fait catégorie par catégorie. */
export const INITIATIVE_CATEGORIES = ["relance", "echeance", "tri", "dev", "compte", "info", "autre"] as const;
export type InitiativeCategory = (typeof INITIATIVE_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<InitiativeCategory, string> = {
  relance: "Relances",
  echeance: "Échéances",
  tri: "Tri (mails, offres)",
  dev: "Dev (PR, code)",
  compte: "Comptes et sécurité",
  info: "Résumer, lire",
  autre: "Autre",
};
/** Pourquoi tu refuses : « pas maintenant » laisse reproposer dans 3 jours, les autres mettent de côté 30 jours. */
export const DECLINE_KINDS = ["pas_utile", "pas_maintenant", "deja_fait", "autre"] as const;
export type DeclineKind = (typeof DECLINE_KINDS)[number];
export const DECLINE_LABEL: Record<DeclineKind, string> = { pas_utile: "Pas utile", pas_maintenant: "Pas maintenant", deja_fait: "Déjà fait", autre: "Autre raison" };
export const SNOOZE_DAYS = 3;
/** Le résultat d'une proposition lancée : critère atteint, en partie, raté ; « termine » = fini, pas évalué (sans modèle). */
export type Outcome = "atteint" | "partiel" | "rate" | "termine";
/** Ton avis sur une proposition terminée : demandé pendant 3 jours. */
export const FEEDBACK_DAYS = 3;

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
  /** La tâche qui a fait la proposition (tour de veille). */
  task_id: number | null;
  created_at: string;
  decided_at: string | null;
  category: InitiativeCategory;
  /** Le critère de réussite, vérifiable : ce qui doit être vrai une fois l'action faite. */
  success: string | null;
  decline_kind: DeclineKind | null;
  /** Ce qu'a lancé l'acceptation : la tâche exécutée, ou l'objectif. */
  exec_task_id: number | null;
  exec_goal_id: number | null;
  outcome: Outcome | null;
  outcome_note: string | null;
  outcome_at: string | null;
  feedback: "utile" | "inutile" | null;
  feedback_at: string | null;
  /** Lancée par Clark seul (autonomie), pas acceptée par toi. */
  auto: number;
};

/** Le bilan d'une catégorie sur une période. */
export type CategoryStats = { category: InitiativeCategory; proposed: number; accepted: number; declined: number; notUseful: number; finished: number; reached: number; feedback: number; useful: number };

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
    // Boucle d'initiatives : catégorie, critère de réussite, exécution, résultat, ton avis.
    const add = (name: string, def: string) => {
      if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE initiatives ADD COLUMN ${name} ${def}`);
    };
    add("category", "TEXT NOT NULL DEFAULT 'autre'");
    add("success", "TEXT");
    add("decline_kind", "TEXT");
    add("exec_task_id", "INTEGER");
    add("exec_goal_id", "INTEGER");
    add("outcome", "TEXT");
    add("outcome_note", "TEXT");
    add("outcome_at", "TEXT");
    add("feedback", "TEXT");
    add("feedback_at", "TEXT");
    add("auto", "INTEGER NOT NULL DEFAULT 0");
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

  /** Les dernières décisions de l'utilisateur, données au tour de veille suivant. */
  recentDecisions(limit = 10): Initiative[] {
    return this.db.prepare("SELECT * FROM initiatives WHERE status != 'pending' ORDER BY decided_at DESC, id DESC LIMIT ?").all(limit) as Initiative[];
  }

  propose(i: { title: string; why: string; action: string; source?: string; taskId?: number; mode?: InitiativeMode; category?: InitiativeCategory; success?: string }): ProposeOutcome {
    const key = normalize(i.title);
    // Refusée « pas maintenant » : reproposable après 3 jours ; autrement refusée : 30 jours.
    const same = this.db
      .prepare(
        `SELECT id, status FROM initiatives WHERE title_key = ?
           AND (status = 'pending' OR (status = 'declined' AND decided_at >= datetime('now', CASE WHEN decline_kind = 'pas_maintenant' THEN ? ELSE ? END)))
         ORDER BY id DESC LIMIT 1`,
      )
      .get(key, `-${SNOOZE_DAYS} days`, `-${DECLINE_MEMORY_DAYS} days`) as { id: number; status: string } | undefined;
    if (same) return { outcome: same.status === "pending" ? "duplicate" : "declined_before", id: same.id };
    if (this.pending().length >= MAX_PENDING) return { outcome: "full" };
    const r = this.db
      .prepare("INSERT INTO initiatives (title, title_key, why, action, source, task_id, mode, category, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(i.title.trim(), key, i.why.trim(), i.action.trim(), i.source?.trim() || null, i.taskId ?? null, i.mode ?? "chat", i.category ?? "autre", i.success?.trim() || null);
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

  decide(id: number, status: "accepted" | "declined", reason?: string, kind?: DeclineKind, auto = false): boolean {
    const ok =
      this.db
        .prepare("UPDATE initiatives SET status = ?, decline_reason = ?, decline_kind = ?, auto = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(status, status === "declined" ? reason?.trim() || null : null, status === "declined" ? (kind ?? "autre") : null, auto ? 1 : 0, id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }

  /** Ce qu'a lancé l'acceptation : la tâche exécutée, ou l'objectif. */
  linkExecution(id: number, ref: { type: "task" | "goal"; id: number }) {
    this.db.prepare(`UPDATE initiatives SET ${ref.type === "task" ? "exec_task_id" : "exec_goal_id"} = ? WHERE id = ?`).run(ref.id, id);
    this.emit("changed", this.get(id));
  }

  /** Acceptées, lancées, pas encore mesurées. */
  toMeasure(): Initiative[] {
    return this.db.prepare("SELECT * FROM initiatives WHERE status = 'accepted' AND outcome IS NULL AND (exec_task_id IS NOT NULL OR exec_goal_id IS NOT NULL) ORDER BY id").all() as Initiative[];
  }

  byExecution(ref: { type: "task" | "goal"; id: number }): Initiative | undefined {
    return this.db.prepare(`SELECT * FROM initiatives WHERE ${ref.type === "task" ? "exec_task_id" : "exec_goal_id"} = ? ORDER BY id DESC LIMIT 1`).get(ref.id) as Initiative | undefined;
  }

  setOutcome(id: number, outcome: Outcome, note: string | null): boolean {
    const ok = this.db.prepare("UPDATE initiatives SET outcome = ?, outcome_note = ?, outcome_at = datetime('now') WHERE id = ?").run(outcome, note, id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }

  /** Ton avis : seulement sur une proposition terminée, et dans les 3 jours. */
  setFeedback(id: number, feedback: "utile" | "inutile", now = new Date()): boolean {
    const i = this.get(id);
    if (!i || !i.outcome || i.feedback || !i.outcome_at) return false;
    if (now.getTime() - Date.parse(`${i.outcome_at.replace(" ", "T")}Z`) > FEEDBACK_DAYS * 86_400_000) return false;
    const ok = this.db.prepare("UPDATE initiatives SET feedback = ?, feedback_at = datetime('now') WHERE id = ?").run(feedback, id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }

  /** Terminées, sans ton avis, depuis moins de 3 jours. */
  awaitingFeedback(now = new Date()): Initiative[] {
    const since = new Date(now.getTime() - FEEDBACK_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    return this.db.prepare("SELECT * FROM initiatives WHERE outcome IS NOT NULL AND feedback IS NULL AND outcome_at >= ? ORDER BY outcome_at DESC").all(since) as Initiative[];
  }

  /** Les dernières propositions, quel que soit leur état (le parcours complet, pour Activité). */
  recent(limit = 10): Initiative[] {
    return this.db.prepare("SELECT * FROM initiatives ORDER BY id DESC LIMIT ?").all(limit) as Initiative[];
  }

  /** Le bilan par catégorie sur les derniers jours (proposées pendant la période). */
  stats(days = 30, now = new Date()): CategoryStats[] {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const rows = this.db.prepare("SELECT * FROM initiatives WHERE created_at >= ?").all(since) as Initiative[];
    const by = new Map<InitiativeCategory, CategoryStats>();
    for (const i of rows) {
      const c = (INITIATIVE_CATEGORIES as readonly string[]).includes(i.category) ? i.category : "autre";
      const s = by.get(c) ?? { category: c, proposed: 0, accepted: 0, declined: 0, notUseful: 0, finished: 0, reached: 0, feedback: 0, useful: 0 };
      s.proposed++;
      if (i.status === "accepted") s.accepted++;
      if (i.status === "declined") s.declined++;
      if (i.decline_kind === "pas_utile") s.notUseful++;
      if (i.outcome && i.outcome !== "termine") s.finished++;
      if (i.outcome === "atteint") s.reached++;
      if (i.feedback) s.feedback++;
      if (i.feedback === "utile") s.useful++;
      by.set(c, s);
    }
    return [...by.values()].sort((a, b) => b.proposed - a.proposed);
  }
}
