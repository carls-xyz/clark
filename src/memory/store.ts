import { DatabaseSync } from "node:sqlite";
import { Questions } from "../core/questions.ts";
import { Automations } from "../scheduler/automations.ts";
import { Posts } from "../social/posts.ts";
import { Initiatives } from "../core/initiatives.ts";
import { Outbox } from "../core/outbox.ts";
import { EngineChoices } from "../engines/choices.ts";
import { TerminalRequests } from "../terminal/terminal.ts";
import { McpServers } from "../mcp/servers.ts";
import { Goals } from "../core/goals.ts";
import { DevStore } from "../dev/store.ts";
import { VoiceSettings } from "../voice/voice.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MEMORY_KINDS = ["fact", "preference", "project", "person", "event", "lesson"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * proposed   : Clark l'a proposé, l'utilisateur n'a pas encore répondu. Jamais utilisé.
 * confirmed  : l'utilisateur l'a confirmé (ou corrigé). Utilisé tant qu'il n'a pas expiré.
 * rejected   : l'utilisateur l'a ignoré.
 * superseded : remplacé par une correction confirmée.
 */
export type MemoryStatus = "proposed" | "confirmed" | "rejected" | "superseded";

export type Memory = {
  id: number;
  kind: MemoryKind;
  content: string;
  tags: string;
  importance: number;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  archived: number;
  status: MemoryStatus;
  /** D'où vient l'information, écrit par Clark. NULL = souvenir d'avant la mémoire confirmée. */
  source: string | null;
  /** Tâche pendant laquelle Clark l'a proposé. */
  source_task_id: number | null;
  /** Dernier jour de validité (AAAA-MM-JJ), ou NULL. */
  expires_at: string | null;
  /** Souvenir confirmé que cette proposition corrige ; il reste actif jusqu'à la confirmation. */
  replaces_id: number | null;
  /** Texte proposé par Clark, quand l'utilisateur l'a corrigé avant de confirmer. */
  original_content: string | null;
  confirmed_at: string | null;
};

export type Proposal = Memory & { replaces_content: string | null };

export type ProposeResult =
  | { outcome: "proposed"; id: number }
  | { outcome: "already_confirmed"; id: number }
  | { outcome: "already_proposed"; id: number };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Un souvenir utilisable : confirmé, non archivé, pas expiré (le jour d'expiration compte encore). */
const ACTIVE = "m.archived = 0 AND m.status = 'confirmed' AND (m.expires_at IS NULL OR m.expires_at >= date('now', 'localtime'))";

/**
 * Mémoire longue de Clark : une base SQLite, recherche plein texte (FTS5,
 * insensible aux accents). Les vecteurs (sqlite-vec) viendront en V1 ;
 * FTS suffit tant qu'on est sous quelques milliers de souvenirs.
 *
 * La même base porte aussi les tables techniques (sessions, dépenses, audit)
 * pour n'avoir qu'un fichier à sauvegarder.
 */
export class Store {
  readonly db: DatabaseSync;
  /** Questions des agents à l'utilisateur (même base, pour que le serveur MCP de Codex y accède). */
  readonly questions: Questions;
  /** Automatisations planifiées réglées par l'utilisateur. */
  readonly automations: Automations;
  /** Brouillons du module Réseaux sociaux, en attente de validation. */
  readonly posts: Posts;
  /** Propositions du tour de veille (heartbeat), en attente de l'utilisateur. */
  readonly initiatives: Initiatives;
  /** Mails que Clark veut envoyer, en attente de ton accord. */
  readonly outbox: Outbox;
  /** Modèle et niveau de puissance choisis pour chaque moteur. */
  readonly choices: EngineChoices;
  /** Serveurs MCP ajoutés par l'utilisateur (Plugins). */
  readonly mcp: McpServers;
  /** Objectifs suivis sur plusieurs tours (mode objectif). */
  readonly goals: Goals;
  /** Côté dev : projets et tâches dans leurs copies du dépôt. */
  readonly dev: DevStore;
  readonly voice: VoiceSettings;
  /** Commandes proposées par Clark pour le Terminal de l'utilisateur (src/terminal/terminal.ts). */
  readonly terminal: TerminalRequests;
  private readonly listeners = new Set<(event: "proposed" | "changed", m?: Memory) => void>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    this.questions = new Questions(this.db);
    this.automations = new Automations(this.db);
    this.posts = new Posts(this.db);
    this.initiatives = new Initiatives(this.db);
    this.outbox = new Outbox(this.db);
    this.choices = new EngineChoices(this.db);
    this.mcp = new McpServers(this.db);
    this.goals = new Goals(this.db);
    this.dev = new DevStore(this.db);
    this.voice = new VoiceSettings(this.db);
    this.terminal = new TerminalRequests(this.db);
  }

  private migrate() {
    // Le lien souvenir ⇄ note Obsidian (src/obsidian/vault.ts) : créé ici pour exister avant toute lecture,
    // coffre branché ou non.
    this.db.exec(`CREATE TABLE IF NOT EXISTS obsidian_notes (
      memory_id    INTEGER PRIMARY KEY,
      file         TEXT NOT NULL,
      body_hash    TEXT NOT NULL,
      content_hash TEXT NOT NULL
    )`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           INTEGER PRIMARY KEY,
        kind         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tags         TEXT NOT NULL DEFAULT '',
        importance   INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        use_count    INTEGER NOT NULL DEFAULT 0,
        archived     INTEGER NOT NULL DEFAULT 0
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, tags,
        content='memories', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, tags ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
      END;

      CREATE TABLE IF NOT EXISTS sessions (
        chat_id    INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS spend (
        id       INTEGER PRIMARY KEY,
        day      TEXT NOT NULL DEFAULT (date('now', 'localtime')),
        usd      REAL NOT NULL,
        label    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit (
        id       INTEGER PRIMARY KEY,
        at       TEXT NOT NULL DEFAULT (datetime('now')),
        tool     TEXT NOT NULL,
        decision TEXT NOT NULL,
        detail   TEXT NOT NULL
      );
    `);
    // Mémoire confirmée. Les souvenirs d'avant restent confirmés et visibles,
    // avec une source vide : « provenance inconnue ».
    this.addColumn("memories", "status", "TEXT NOT NULL DEFAULT 'confirmed'");
    this.addColumn("memories", "source", "TEXT");
    this.addColumn("memories", "source_task_id", "INTEGER");
    this.addColumn("memories", "expires_at", "TEXT");
    this.addColumn("memories", "replaces_id", "INTEGER");
    this.addColumn("memories", "original_content", "TEXT");
    this.addColumn("memories", "confirmed_at", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS memories_proposed ON memories(status) WHERE status = 'proposed'");
    for (const p of this.proposals()) this.announced.add(p.id);
  }

  /** Propositions déjà signalées par ce processus (les autres viennent d'ailleurs). */
  private readonly announced = new Set<number>();

  /**
   * Le moteur Codex propose ses souvenirs depuis un autre processus (le serveur MCP) :
   * après chacun de ses appels, Clark signale ici les propositions qu'il ne connaît pas encore.
   */
  syncExternal() {
    for (const p of this.proposals()) {
      if (this.announced.has(p.id)) continue;
      this.announced.add(p.id);
      this.emit("proposed", p);
    }
  }

  private addColumn(table: string, column: string, definition: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** Prévient le hub (et l'interface) d'une proposition ou d'un changement de mémoire. */
  onMemory(listener: (event: "proposed" | "changed", m?: Memory) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: "proposed" | "changed", m?: Memory) {
    for (const listener of this.listeners) listener(event, m);
  }

  // ── Souvenirs ────────────────────────────────────────────────────────────

  get(id: number): Memory | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory | undefined;
  }

  /**
   * Souvenir confirmé d'emblée : réservé à ce que l'utilisateur écrit lui-même (et aux tests).
   * Clark, lui, passe toujours par propose().
   */
  remember(input: { kind: MemoryKind; content: string; tags?: string[]; importance?: number; source?: string; expiresAt?: string }): number {
    const content = input.content.trim();
    if (!content) throw new Error("Souvenir vide");
    const tags = normalizeTags(input.tags);

    // Doublon exact : on renforce l'existant au lieu d'en créer un second.
    const existing = this.db
      .prepare("SELECT id FROM memories m WHERE m.archived = 0 AND m.status = 'confirmed' AND lower(content) = lower(?)")
      .get(content) as { id: number } | undefined;
    if (existing) {
      this.db.prepare("UPDATE memories SET importance = min(5, importance + 1) WHERE id = ?").run(existing.id);
      return existing.id;
    }

    const result = this.db
      .prepare(
        `INSERT INTO memories (kind, content, tags, importance, status, source, expires_at, confirmed_at)
         VALUES (?, ?, ?, ?, 'confirmed', ?, ?, datetime('now'))`,
      )
      .run(input.kind, content, tags, clampImportance(input.importance), input.source ?? null, checkDate(input.expiresAt));
    this.emit("changed");
    return Number(result.lastInsertRowid);
  }

  /**
   * Clark propose un souvenir. Il n'est utilisé qu'une fois confirmé par l'utilisateur.
   * Avec replacesId, c'est une correction : l'ancienne version reste active d'ici là.
   */
  propose(input: {
    kind: MemoryKind;
    content: string;
    source: string;
    sourceTaskId?: number;
    expiresAt?: string;
    replacesId?: number;
    tags?: string[];
    importance?: number;
  }): ProposeResult {
    const content = input.content.trim();
    const source = input.source.trim();
    if (!content) throw new Error("Souvenir vide");
    if (!source) throw new Error("Source manquante : dis d'où vient l'information");
    if (input.replacesId !== undefined) {
      const old = this.get(input.replacesId);
      if (!old || old.archived || old.status !== "confirmed") throw new Error(`Souvenir #${input.replacesId} introuvable parmi les souvenirs confirmés`);
    }

    const same = this.db
      .prepare("SELECT id, status FROM memories m WHERE m.archived = 0 AND m.status IN ('confirmed','proposed') AND lower(content) = lower(?)")
      .get(content) as { id: number; status: MemoryStatus } | undefined;
    if (same?.status === "confirmed") return { outcome: "already_confirmed", id: same.id };
    if (same?.status === "proposed") return { outcome: "already_proposed", id: same.id };

    const r = this.db
      .prepare(
        `INSERT INTO memories (kind, content, tags, importance, status, source, source_task_id, expires_at, replaces_id)
         VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        content,
        normalizeTags(input.tags),
        clampImportance(input.importance),
        source,
        input.sourceTaskId ?? null,
        checkDate(input.expiresAt),
        input.replacesId ?? null,
      );
    const id = Number(r.lastInsertRowid);
    this.announced.add(id);
    this.emit("proposed", this.get(id));
    return { outcome: "proposed", id };
  }

  /** Propositions en attente, avec le texte du souvenir qu'elles corrigent. */
  proposals(): Proposal[] {
    return this.db
      .prepare(
        `SELECT m.*, old.content AS replaces_content FROM memories m
         LEFT JOIN memories old ON old.id = m.replaces_id
         WHERE m.status = 'proposed' AND m.archived = 0 ORDER BY m.id`,
      )
      .all() as Proposal[];
  }

  /**
   * Confirme une proposition, telle quelle ou corrigée par l'utilisateur.
   * false si elle n'est plus en attente (déjà traitée).
   */
  confirm(id: number, correction?: { content?: string; expiresAt?: string | null }): boolean {
    const m = this.get(id);
    if (!m || m.archived || m.status !== "proposed") return false;
    const content = correction?.content?.trim();
    const expiresAt = correction && "expiresAt" in correction ? checkDate(correction.expiresAt ?? undefined) : m.expires_at;
    const corrected = content !== undefined && content !== "" && content !== m.content;

    this.db.exec("BEGIN");
    try {
      if (m.replaces_id !== null) {
        this.db.prepare("UPDATE memories SET status = 'superseded', archived = 1 WHERE id = ? AND status = 'confirmed'").run(m.replaces_id);
      }
      // Un souvenir confirmé identique existe déjà : on le garde, la proposition devient inutile.
      const twin = this.db
        .prepare("SELECT id FROM memories WHERE archived = 0 AND status = 'confirmed' AND lower(content) = lower(?) AND id != ?")
        .get(corrected ? content : m.content, id) as { id: number } | undefined;
      if (twin) {
        this.db.prepare("UPDATE memories SET status = 'rejected' WHERE id = ?").run(id);
      } else {
        this.db
          .prepare(
            `UPDATE memories SET status = 'confirmed', confirmed_at = datetime('now'), expires_at = ?,
               content = ?, original_content = ? WHERE id = ?`,
          )
          .run(expiresAt, corrected ? content : m.content, corrected ? m.content : null, id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.emit("changed");
    return true;
  }

  /** Ignore une proposition. Le souvenir corrigé, s'il y en a un, reste tel quel. */
  ignore(id: number): boolean {
    const ok = this.db.prepare("UPDATE memories SET status = 'rejected' WHERE id = ? AND status = 'proposed' AND archived = 0").run(id).changes > 0;
    if (ok) this.emit("changed");
    return ok;
  }

  /** Recherche plein texte, classée par pertinence puis importance. */
  recall(query: string, limit = 8): Memory[] {
    const match = toFtsQuery(query);
    if (!match) return this.top(limit);
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ? AND ${ACTIVE}
         ORDER BY bm25(memories_fts) - m.importance * 0.5
         LIMIT ?`,
      )
      .all(match, limit) as Memory[];
    this.touch(rows.map((r) => r.id));
    return rows;
  }

  /** Les souvenirs actifs les plus importants : injectés dans le prompt de chaque session. */
  top(limit = 15): Memory[] {
    return this.db
      .prepare(
        `SELECT m.* FROM memories m WHERE ${ACTIVE}
         ORDER BY m.importance DESC, m.use_count DESC, m.created_at DESC LIMIT ?`,
      )
      .all(limit) as Memory[];
  }

  /** Correction directe, réservée à l'utilisateur (Clark propose une correction avec propose). */
  update(id: number, content: string): boolean {
    const r = this.db.prepare("UPDATE memories SET content = ? WHERE id = ? AND archived = 0").run(content.trim(), id);
    if (r.changes > 0) this.emit("changed");
    return r.changes > 0;
  }

  /** Oubli doux : archivé, jamais supprimé (on peut revenir en arrière). */
  forget(id: number): boolean {
    const ok = this.db.prepare("UPDATE memories SET archived = 1 WHERE id = ? AND archived = 0").run(id).changes > 0;
    if (ok) this.emit("changed");
    return ok;
  }

  /** Nombre de souvenirs actifs (confirmés, non expirés). */
  count(): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM memories m WHERE ${ACTIVE}`).get() as { n: number }).n;
  }

  private touch(ids: number[]) {
    const stmt = this.db.prepare(
      "UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?",
    );
    for (const id of ids) stmt.run(id);
  }

  // ── Sessions de conversation (une par conversation) ───────────────────

  getSession(chatId: number): string | null {
    const row = this.db.prepare("SELECT session_id FROM sessions WHERE chat_id = ?").get(chatId) as
      | { session_id: string }
      | undefined;
    return row?.session_id ?? null;
  }

  setSession(chatId: number, sessionId: string) {
    this.db
      .prepare(
        `INSERT INTO sessions (chat_id, session_id) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = datetime('now')`,
      )
      .run(chatId, sessionId);
  }

  clearSession(chatId: number) {
    this.db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
  }

  // ── Dépenses et audit ──────────────────────────────────────────────────

  addSpend(usd: number, label: string) {
    this.db.prepare("INSERT INTO spend (usd, label) VALUES (?, ?)").run(usd, label);
  }

  spentToday(): number {
    const row = this.db
      .prepare("SELECT coalesce(sum(usd), 0) AS total FROM spend WHERE day = date('now', 'localtime')")
      .get() as { total: number };
    return row.total;
  }

  /** Une tâche planifiée (ex. « brief ») a-t-elle déjà tourné aujourd'hui ? */
  ranToday(label: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM spend WHERE label = ? AND day = date('now', 'localtime') LIMIT 1")
      .get(label);
  }

  audit(tool: string, decision: string, detail: unknown) {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    this.db.prepare("INSERT INTO audit (tool, decision, detail) VALUES (?, ?, ?)").run(tool, decision, text.slice(0, 4000));
  }
}

function normalizeTags(tags: string[] | undefined): string {
  return (tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).join(" ");
}

function checkDate(date: string | undefined | null): string | null {
  if (date === undefined || date === null || date === "") return null;
  if (!DATE.test(date) || Number.isNaN(Date.parse(date))) throw new Error(`Date d'expiration invalide (attendu AAAA-MM-JJ) : ${date}`);
  return date;
}

function clampImportance(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/**
 * Transforme une question libre en requête FTS5 sûre : chaque mot devient un
 * préfixe entre guillemets, reliés par OR (le classement bm25 fait le tri).
 * Les mots de moins de 3 lettres sont ignorés.
 */
export function toFtsQuery(text: string): string {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  return [...new Set(words)].map((w) => `"${w}"*`).join(" OR ");
}
