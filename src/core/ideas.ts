import type { DatabaseSync } from "node:sqlite";

/**
 * Idées de projets (page Idées). Elles arrivent de trois façons :
 * - « scroll » : pendant le tour d'idées, Clark parcourt des sites avec son navigateur et note
 *   ce qui pourrait devenir un projet pour l'utilisateur ;
 * - « toi » : l'utilisateur lui lance une idée en vrac (une phrase, un lien) ;
 * - « clark » : une idée que Clark a eue en conversation ou pendant une autre tâche.
 *
 * Ensuite l'utilisateur trie : creuser (Clark fait une recherche et rend un avis), garder, écarter,
 * ou lancer (Clark en fait un plan ou une tâche de code). Rien n'est lancé sans lui.
 */
export type IdeaOrigin = "scroll" | "toi" | "clark";
/**
 * - new     : à trier ;
 * - digging : Clark est en train de la creuser ;
 * - dug     : creusée, avec un avis ;
 * - kept    : gardée par l'utilisateur (note dans Obsidian) ;
 * - dropped : écartée (Clark ne la repropose pas) ;
 * - started : lancée (confiée à Clark dans la conversation).
 */
export type IdeaStatus = "new" | "digging" | "dug" | "kept" | "dropped" | "started";
export type IdeaVerdict = "go" | "later" | "skip";

export type Idea = {
  id: number;
  title: string;
  title_key: string;
  /** Ce qu'on construirait, en deux ou trois phrases. */
  pitch: string;
  /** Pourquoi c'est pour l'utilisateur (ses projets, sa stack, ce qu'il aime). */
  why: string | null;
  origin: IdeaOrigin;
  source_url: string | null;
  /** D'où ça vient, lisible : « Show HN », « r/selfhosted », « ta note du 12/11 »… */
  source_label: string | null;
  status: IdeaStatus;
  verdict: IdeaVerdict | null;
  /** Le compte rendu de Clark quand il l'a creusée (Markdown). */
  report: string | null;
  drop_reason: string | null;
  task_id: number | null;
  created_at: string;
  updated_at: string;
};

export const IDEAS_TOUR_LABEL = "idees";
export const IDEA_DIG_LABEL = "idee";
/** Conversation à part pour le tour d'idées et les recherches : rien dans la tienne. */
export const IDEAS_CHAT = 3_000_000;
export const isIdeaLabel = (label: string) => label === IDEAS_TOUR_LABEL || label === IDEA_DIG_LABEL;

export const VERDICT_LABEL: Record<IdeaVerdict, string> = { go: "À faire", later: "Pour plus tard", skip: "À laisser" };
/** Pas plus de nouvelles idées à trier que ça : au-delà, le tour d'idées attend que l'utilisateur trie. */
export const MAX_NEW = 15;
/** Idées notées au plus par tour d'idées. */
export const MAX_PER_TOUR = 5;

export const DEFAULT_SOURCES = [
  "https://news.ycombinator.com/show",
  "https://github.com/trending?since=daily",
  "https://old.reddit.com/r/SideProject/top/?t=day",
  "https://old.reddit.com/r/selfhosted/top/?t=day",
  "https://old.reddit.com/r/LocalLLaMA/top/?t=day",
  "https://www.producthunt.com/",
  "https://x.com/home",
];

export const ideaKey = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export type AddOutcome = { outcome: "added"; id: number } | { outcome: "duplicate" | "dropped_before"; id: number } | { outcome: "full" };

export class Ideas {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(event: "added" | "changed", i?: Idea) => void>();
  private seen = "";

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS ideas (
        id           INTEGER PRIMARY KEY,
        title        TEXT NOT NULL,
        title_key    TEXT NOT NULL,
        pitch        TEXT NOT NULL,
        why          TEXT,
        origin       TEXT NOT NULL CHECK (origin IN ('scroll','toi','clark')),
        source_url   TEXT,
        source_label TEXT,
        status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','digging','dug','kept','dropped','started')),
        verdict      TEXT CHECK (verdict IN ('go','later','skip')),
        report       TEXT,
        drop_reason  TEXT,
        task_id      INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS ideas_key ON ideas (title_key);
      CREATE TABLE IF NOT EXISTS idea_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.seen = this.stamp();
  }

  onEvent(listener: (event: "added" | "changed", i?: Idea) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: "added" | "changed", i?: Idea) {
    this.seen = this.stamp();
    for (const l of this.listeners) l(event, i);
  }

  private stamp(): string {
    const r = this.db.prepare("SELECT count(*) AS n, coalesce(max(id), 0) AS id, coalesce(max(updated_at), '') AS at FROM ideas").get() as { n: number; id: number; at: string };
    return `${r.n}:${r.id}:${r.at}`;
  }

  /** Idées ajoutées ou changées par un autre processus (serveur de mémoire de Codex) : on le signale ici. */
  sync() {
    if (this.stamp() !== this.seen) this.emit("changed");
  }

  get(id: number): Idea | undefined {
    return this.db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as Idea | undefined;
  }

  /** Pour la page : les idées à trier et en cours d'abord, puis les plus récentes. */
  list(limit = 200): Idea[] {
    return this.db
      .prepare(
        `SELECT * FROM ideas ORDER BY
           CASE status WHEN 'digging' THEN 0 WHEN 'dug' THEN 1 WHEN 'new' THEN 2 WHEN 'kept' THEN 3 WHEN 'started' THEN 4 ELSE 5 END,
           updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as Idea[];
  }

  byStatus(status: IdeaStatus): Idea[] {
    return this.db.prepare("SELECT * FROM ideas WHERE status = ? ORDER BY id DESC").all(status) as Idea[];
  }

  /** Titres déjà vus (toutes les idées, écartées comprises) : le tour d'idées ne les refait pas. */
  knownTitles(limit = 80): string[] {
    return (this.db.prepare("SELECT title FROM ideas ORDER BY id DESC LIMIT ?").all(limit) as { title: string }[]).map((r) => r.title);
  }

  add(i: { title: string; pitch: string; why?: string | null; origin: IdeaOrigin; sourceUrl?: string | null; sourceLabel?: string | null; taskId?: number | null }): AddOutcome {
    const key = ideaKey(i.title);
    const same = this.db.prepare("SELECT id, status FROM ideas WHERE title_key = ? ORDER BY id DESC LIMIT 1").get(key) as { id: number; status: IdeaStatus } | undefined;
    if (same) return { outcome: same.status === "dropped" ? "dropped_before" : "duplicate", id: same.id };
    if (i.origin !== "toi" && this.byStatus("new").length >= MAX_NEW) return { outcome: "full" };
    const r = this.db
      .prepare("INSERT INTO ideas (title, title_key, pitch, why, origin, source_url, source_label, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(i.title.trim(), key, i.pitch.trim(), i.why?.trim() || null, i.origin, i.sourceUrl?.trim() || null, i.sourceLabel?.trim() || null, i.taskId ?? null);
    const id = Number(r.lastInsertRowid);
    this.emit("added", this.get(id));
    return { outcome: "added", id };
  }

  /** Change l'état d'une idée. false si elle n'existe pas. */
  setStatus(id: number, status: IdeaStatus, extra: { dropReason?: string | null; taskId?: number | null } = {}): boolean {
    const ok =
      this.db
        .prepare(
          `UPDATE ideas SET status = ?, drop_reason = CASE WHEN ? = 'dropped' THEN ? ELSE drop_reason END,
             task_id = coalesce(?, task_id), updated_at = datetime('now') WHERE id = ?`,
        )
        .run(status, status, extra.dropReason?.trim() || null, extra.taskId ?? null, id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }

  /** Compte rendu de Clark après l'avoir creusée. */
  report(id: number, verdict: IdeaVerdict, report: string): boolean {
    const ok =
      this.db
        .prepare("UPDATE ideas SET status = CASE WHEN status IN ('new','digging') THEN 'dug' ELSE status END, verdict = ?, report = ?, updated_at = datetime('now') WHERE id = ?")
        .run(verdict, report.trim(), id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }

  /** Une recherche interrompue (redémarrage, échec) : l'idée revient à trier au lieu de rester « en cours ». */
  unstick(id: number) {
    const ok = this.db.prepare("UPDATE ideas SET status = 'new', updated_at = datetime('now') WHERE id = ? AND status = 'digging'").run(id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
  }

  remove(id: number): boolean {
    const ok = this.db.prepare("DELETE FROM ideas WHERE id = ?").run(id).changes > 0;
    if (ok) this.emit("changed");
    return ok;
  }

  /** Les sites parcourus pendant le tour d'idées (réglables sur la page). */
  sources(): string[] {
    const row = this.db.prepare("SELECT value FROM idea_settings WHERE key = 'sources'").get() as { value: string } | undefined;
    if (!row) return [...DEFAULT_SOURCES];
    try {
      const list = JSON.parse(row.value);
      return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [...DEFAULT_SOURCES];
    } catch {
      return [...DEFAULT_SOURCES];
    }
  }

  setSources(list: string[]): string[] {
    const clean = [...new Set(list.map((s) => s.trim()).filter((s) => /^https?:\/\/\S+$/i.test(s)))].slice(0, 20);
    this.db.prepare("INSERT INTO idea_settings (key, value) VALUES ('sources', ?) ON CONFLICT DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
    this.emit("changed");
    return clean;
  }
}
