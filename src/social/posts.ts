import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { paths } from "../config.ts";

/**
 * Brouillons de publication du module Réseaux sociaux. Clark prépare, Charles valide.
 * Clark ne publie jamais : une fois validé, le brouillon est rangé dans
 * workspace/social/a-publier/ (vidéo + légende), prêt à être publié ou programmé
 * dans l'outil de la plateforme.
 */
export type Platform = "tiktok";

export type Post = {
  id: number;
  platform: Platform;
  title: string;
  caption: string;
  /** JSON : liste de mots-clés sans # */
  hashtags: string;
  media_path: string;
  duration: number;
  width: number;
  height: number;
  status: "pending" | "approved" | "rejected" | "redo";
  feedback: string | null;
  export_path: string | null;
  task_id: number | null;
  created_at: string;
  decided_at: string | null;
};

export const hashtagsOf = (p: Pick<Post, "hashtags">): string[] => {
  try {
    const v = JSON.parse(p.hashtags);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "contenu";

export class Posts {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(event: "proposed" | "changed", p?: Post) => void>();
  private readonly announced = new Set<number>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS social_posts (
        id          INTEGER PRIMARY KEY,
        platform    TEXT NOT NULL,
        title       TEXT NOT NULL,
        caption     TEXT NOT NULL,
        hashtags    TEXT NOT NULL DEFAULT '[]',
        media_path  TEXT NOT NULL,
        duration    REAL NOT NULL,
        width       INTEGER NOT NULL,
        height      INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','redo')),
        feedback    TEXT,
        export_path TEXT,
        task_id     INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at  TEXT
      );
    `);
    for (const p of this.pending()) this.announced.add(p.id);
  }

  onEvent(listener: (event: "proposed" | "changed", p?: Post) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: "proposed" | "changed", p?: Post) {
    for (const l of this.listeners) l(event, p);
  }

  get(id: number): Post | undefined {
    return this.db.prepare("SELECT * FROM social_posts WHERE id = ?").get(id) as Post | undefined;
  }

  pending(): Post[] {
    return this.db.prepare("SELECT * FROM social_posts WHERE status = 'pending' ORDER BY id").all() as Post[];
  }

  approved(limit = 5): Post[] {
    return this.db.prepare("SELECT * FROM social_posts WHERE status = 'approved' ORDER BY decided_at DESC, id DESC LIMIT ?").all(limit) as Post[];
  }

  create(p: { platform: Platform; title: string; caption: string; hashtags: string[]; mediaPath: string; duration: number; width: number; height: number; taskId?: number }): number {
    const tags = p.hashtags.map((h) => h.replace(/^#/, "").trim()).filter(Boolean).slice(0, 10);
    const r = this.db
      .prepare("INSERT INTO social_posts (platform, title, caption, hashtags, media_path, duration, width, height, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.platform, p.title.trim(), p.caption.trim(), JSON.stringify(tags), p.mediaPath, p.duration, p.width, p.height, p.taskId ?? null);
    const id = Number(r.lastInsertRowid);
    this.announced.add(id);
    this.emit("proposed", this.get(id));
    return id;
  }

  /** Brouillon préparé depuis un autre processus (serveur de mémoire de Codex) : on le signale ici. */
  sync() {
    for (const p of this.pending()) {
      if (this.announced.has(p.id)) continue;
      this.announced.add(p.id);
      this.emit("proposed", p);
    }
  }

  /**
   * Validé : la vidéo et sa légende sont rangées dans workspace/social/a-publier/.
   * false si le brouillon n'attend plus de décision.
   */
  approve(id: number, dir = resolve(paths.workspace, "social/a-publier")): boolean {
    const p = this.get(id);
    if (!p || p.status !== "pending") return false;
    mkdirSync(dir, { recursive: true });
    const base = `${new Date().toISOString().slice(0, 10)}-${p.platform}-${slug(p.title)}-${p.id}`;
    const video = join(dir, `${base}.mp4`);
    copyFileSync(p.media_path, video);
    const tags = hashtagsOf(p).map((h) => `#${h}`).join(" ");
    writeFileSync(join(dir, `${base}.txt`), `${p.caption}${tags ? `\n\n${tags}` : ""}\n`);
    this.db.prepare("UPDATE social_posts SET status = 'approved', export_path = ?, decided_at = datetime('now') WHERE id = ?").run(video, id);
    this.emit("changed", this.get(id));
    return true;
  }

  decide(id: number, status: "rejected" | "redo", feedback?: string): boolean {
    const ok =
      this.db
        .prepare("UPDATE social_posts SET status = ?, feedback = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(status, feedback?.trim() || null, id).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }
}
