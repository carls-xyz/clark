import type { DatabaseSync } from "node:sqlite";

/**
 * Boîte d'envoi : aucun mail ne part sans toi. Clark y dépose le mail exact (destinataires,
 * objet, texte) ; tu le vois en entier et tu choisis Envoyer ou Refuser. C'est Clark (le
 * processus principal) qui envoie, une seule fois, après ton accord.
 */
export type OutboxMail = {
  id: number;
  task_id: number | null;
  to_addr: string;
  cc: string | null;
  subject: string;
  body: string;
  thread_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  /** pending → approved (envoi en cours) → sent | failed ; ou refused ; ou expired (pas de réponse). */
  status: "pending" | "approved" | "sent" | "failed" | "refused" | "expired";
  error: string | null;
  created_at: string;
  decided_at: string | null;
};

/** Le mail attend ton accord au plus ce temps ; ensuite il est abandonné, rien ne part. */
export const OUTBOX_TIMEOUT_MS = 30 * 60_000;

export class Outbox {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(event: "queued" | "changed", m?: OutboxMail) => void>();
  private readonly announced = new Set<number>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id          INTEGER PRIMARY KEY,
        task_id     INTEGER,
        to_addr     TEXT NOT NULL,
        cc          TEXT,
        subject     TEXT NOT NULL,
        body        TEXT NOT NULL,
        thread_id   TEXT,
        in_reply_to TEXT,
        refs        TEXT,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','sent','failed','refused','expired')),
        error       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at  TEXT
      );
    `);
    for (const m of this.pending()) this.announced.add(m.id);
  }

  onEvent(listener: (event: "queued" | "changed", m?: OutboxMail) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: "queued" | "changed", m?: OutboxMail) {
    for (const l of this.listeners) l(event, m);
  }

  get(id: number): OutboxMail | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxMail | undefined;
  }

  pending(): OutboxMail[] {
    return this.db.prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id").all() as OutboxMail[];
  }

  queue(m: { taskId: number; to: string; cc?: string | null; subject: string; body: string; threadId?: string | null; inReplyTo?: string | null; references?: string | null }): number {
    const r = this.db
      .prepare("INSERT INTO outbox (task_id, to_addr, cc, subject, body, thread_id, in_reply_to, refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.taskId, m.to, m.cc ?? null, m.subject, m.body, m.threadId ?? null, m.inReplyTo ?? null, m.references ?? null);
    const id = Number(r.lastInsertRowid);
    this.announced.add(id);
    this.emit("queued", this.get(id));
    return id;
  }

  /** Mail déposé depuis un autre processus (serveur de mémoire de Codex) : on le signale ici. */
  sync() {
    for (const m of this.pending()) {
      if (this.announced.has(m.id)) continue;
      this.announced.add(m.id);
      this.emit("queued", m);
    }
  }

  /** Passe d'un état à l'autre, seulement depuis l'état attendu : une décision ne compte qu'une fois. */
  transition(id: number, from: OutboxMail["status"], to: OutboxMail["status"], error?: string): boolean {
    const ok =
      this.db
        .prepare(`UPDATE outbox SET status = ?, error = ?, decided_at = COALESCE(decided_at, datetime('now')) WHERE id = ? AND status = ?`)
        .run(to, error ?? null, id, from).changes > 0;
    if (ok) this.emit("changed", this.get(id));
    return ok;
  }

  /** L'outil d'envoi attend ici la suite : envoyé, refusé, échoué ou abandonné. */
  async wait(id: number, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<OutboxMail> {
    const deadline = Date.now() + (opts.timeoutMs ?? OUTBOX_TIMEOUT_MS);
    const poll = opts.pollMs ?? 400;
    for (;;) {
      const m = this.get(id)!;
      if (m.status !== "pending" && m.status !== "approved") return m;
      if (Date.now() >= deadline && m.status === "pending") {
        this.transition(id, "pending", "expired");
        return this.get(id)!;
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}
