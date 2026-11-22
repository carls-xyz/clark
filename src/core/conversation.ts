import type { DatabaseSync } from "node:sqlite";

/**
 * Fil de la conversation, tel que l'utilisateur le voit : ses messages, les réponses
 * de Clark et les notes du système (reprise, validation…). Il est durable, pour
 * que l'interface web retrouve l'historique après un rechargement ou un redémarrage.
 * Ce n'est pas la mémoire de l'agent : celle-ci vit dans la session du SDK et les souvenirs.
 */
export type Role = "user" | "clark" | "system";

export type Message = {
  id: number;
  chat_id: number;
  role: Role;
  text: string;
  task_id: number | null;
  /** Canal d'origine d'un message de l'utilisateur : "web", "telegram" ou "clark" (brief). */
  source: string | null;
  /** Genre de notification (reply, approval, dev, pr, stalled, proposals, system) : décide où elle part. */
  kind: string | null;
  /** Agent qui a écrit (conversation « Toute l'équipe ») ; null : l'agent de la conversation. */
  agent?: string | null;
  created_at: string;
};

/** Note posée quand l'utilisateur ouvre une nouvelle conversation (aussi envoyée sur Telegram). */
export const NEW_CONVERSATION_NOTE = "Nouvelle conversation. Ma mémoire longue reste intacte.";

/** Un message de l'utilisateur ou d'un agent dans la conversation c (les notes du système ne comptent pas). */
const HAS_CONTENT = "EXISTS (SELECT 1 FROM messages hc WHERE hc.conversation_id = c.id AND hc.role != 'system')";

/** Titre d'une conversation sans message de l'utilisateur : sa date. */
function untitled(createdAt: string): string {
  const d = new Date(`${createdAt.replace(" ", "T")}Z`);
  return `Conversation du ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "Europe/Paris" })}`;
}

export type ConversationRow = { id: number; chat_id: number; title: string | null; session_id: string | null; agent: string | null; seen_id: number; pinned: number; created_at: string; updated_at: string };
export type ConversationSummary = { id: number; title: string; agent: string | null; at: string; created_at: string; preview: string | null; preview_role: string | null; unread: number; pinned: number };

export class Conversation {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(m: Message) => void>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY,
        chat_id    INTEGER NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('user','clark','system')),
        text       TEXT NOT NULL,
        task_id    INTEGER,
        source     TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
    `);
    const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "kind")) db.exec("ALTER TABLE messages ADD COLUMN kind TEXT");
    // Plusieurs conversations par canal : chacune garde ses messages et sa session de l'agent.
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         INTEGER PRIMARY KEY,
        chat_id    INTEGER NOT NULL,
        title      TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS conversation_current (
        chat_id         INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL
      );
    `);
    // L'agent qui a écrit ce message (conversation « Toute l'équipe » : chacun signe sa réponse).
    if (!cols.some((c) => c.name === "agent")) db.exec("ALTER TABLE messages ADD COLUMN agent TEXT");
    if (!cols.some((c) => c.name === "conversation_id")) {
      db.exec("ALTER TABLE messages ADD COLUMN conversation_id INTEGER");
      this.splitOldMessages();
    }
    db.exec("CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id)");
    const convCols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    // L'agent à qui l'utilisateur parle (null : Clark), et le dernier message qu'il a vu (non-lus).
    if (!convCols.some((c) => c.name === "agent")) db.exec("ALTER TABLE conversations ADD COLUMN agent TEXT");
    // Épinglée par l'utilisateur : en tête de la liste, quoi qu'il arrive.
    if (!convCols.some((c) => c.name === "pinned")) db.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    if (!convCols.some((c) => c.name === "seen_id")) {
      db.exec("ALTER TABLE conversations ADD COLUMN seen_id INTEGER NOT NULL DEFAULT 0");
      // Tout ce qui existait déjà est considéré comme lu.
      db.exec("UPDATE conversations SET seen_id = COALESCE((SELECT MAX(id) FROM messages m WHERE m.conversation_id = conversations.id), 0)");
    }
  }

  /**
   * Avant les conversations, « Nouvelle conversation » posait juste une note dans un fil unique :
   * ce fil est découpé à chaque note, chaque morceau devient une conversation.
   */
  private splitOldMessages() {
    const rows = this.db.prepare("SELECT id, chat_id, role, text, created_at FROM messages ORDER BY id").all() as Pick<Message, "id" | "chat_id" | "role" | "text" | "created_at">[];
    const current = new Map<number, number>();
    const setConv = this.db.prepare("UPDATE messages SET conversation_id = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        let conv = current.get(r.chat_id);
        if (conv === undefined || (r.role === "system" && r.text === NEW_CONVERSATION_NOTE)) {
          conv = this.create(r.chat_id, r.created_at);
          current.set(r.chat_id, conv);
        }
        setConv.run(conv, r.id);
        this.touchConversation(conv, r.role, r.text, r.created_at);
      }
      for (const [chat, conv] of current) this.setCurrent(chat, conv);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private create(chatId: number, at?: string, agent: string | null = null): number {
    const r = at
      ? this.db.prepare("INSERT INTO conversations (chat_id, created_at, updated_at) VALUES (?, ?, ?)").run(chatId, at, at)
      : this.db.prepare("INSERT INTO conversations (chat_id, agent) VALUES (?, ?)").run(chatId, agent);
    return Number(r.lastInsertRowid);
  }

  private setCurrent(chatId: number, conversationId: number) {
    this.db
      .prepare("INSERT INTO conversation_current (chat_id, conversation_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET conversation_id = excluded.conversation_id")
      .run(chatId, conversationId);
  }

  /**
   * Un message de l'utilisateur ou d'un agent date la conversation (la liste se trie sur la dernière
   * activité) ; le premier message de l'utilisateur lui donne son titre. Les notes du système ne comptent pas.
   */
  private touchConversation(id: number, role: Role, text: string, at?: string) {
    if (role === "system") return;
    const title = role === "user" ? text.replace(/\s+/g, " ").trim().slice(0, 80) || null : null;
    this.db
      .prepare("UPDATE conversations SET updated_at = COALESCE(?, datetime('now')), title = COALESCE(title, ?) WHERE id = ?")
      .run(at ?? null, title, id);
  }

  /** La conversation ouverte sur ce canal (créée au besoin). */
  current(chatId: number): number {
    const row = this.db.prepare("SELECT conversation_id FROM conversation_current WHERE chat_id = ?").get(chatId) as { conversation_id: number } | undefined;
    if (row) return row.conversation_id;
    const id = this.create(chatId);
    this.setCurrent(chatId, id);
    return id;
  }

  conversation(id: number): ConversationRow | undefined {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
  }

  /** Une conversation neuve devient l'ouverte. Celle d'avant, si l'utilisateur n'y a rien écrit, resservira. */
  startNew(chatId: number, agent: string | null = null): number {
    const cur = this.current(chatId);
    const used = this.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'user' LIMIT 1").get(cur);
    if (!used && (this.conversation(cur)?.agent ?? null) === agent) return cur;
    const id = this.create(chatId, undefined, agent);
    this.setCurrent(chatId, id);
    return id;
  }

  /** La conversation la plus récente avec cet agent (null : Clark) : d'abord une où il s'est passé quelque chose. */
  latestWith(chatId: number, agent: string | null): number | null {
    const row = this.db
      .prepare(`SELECT c.id FROM conversations c WHERE c.chat_id = ? AND c.agent IS ?
        ORDER BY (c.title IS NULL AND NOT ${HAS_CONTENT}), c.updated_at DESC, c.id DESC LIMIT 1`)
      .get(chatId, agent) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Une conversation qui a du contenu (un message de l'utilisateur ou d'un agent) : on peut la lister, la rouvrir. */
  hasContent(id: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM conversations c WHERE c.id = ? AND (c.title IS NOT NULL OR ${HAS_CONTENT})`).get(id));
  }

  /**
   * La conversation d'une tâche : celle de son premier message sur ce canal, sinon celle de la
   * tâche qui l'a lancée (avis d'un membre du groupe, mission confiée par Clark…). Une note posée
   * ailleurs (alerte sur le fil de l'utilisateur pour une tâche du tour de veille) ne l'attire pas.
   */
  conversationForTask(taskId: number, chatId: number): number | null {
    const own = this.db
      .prepare("SELECT conversation_id FROM messages WHERE task_id = ? AND chat_id = ? AND conversation_id IS NOT NULL ORDER BY id LIMIT 1")
      .get(taskId, chatId) as { conversation_id: number } | undefined;
    if (own) return own.conversation_id;
    if (!this.hasTasks()) return null;
    const seen = new Set<number>([taskId]);
    let id: number | null = taskId;
    while (id !== null) {
      const row = this.db.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(id) as { parent_id: number | null } | undefined;
      id = row?.parent_id ?? null;
      if (id === null || seen.has(id)) return null;
      seen.add(id);
      const up = this.db
        .prepare("SELECT conversation_id FROM messages WHERE task_id = ? AND chat_id = ? AND conversation_id IS NOT NULL ORDER BY id LIMIT 1")
        .get(id, chatId) as { conversation_id: number } | undefined;
      if (up) return up.conversation_id;
    }
    return null;
  }

  private tasksTable: boolean | null = null;
  private hasTasks(): boolean {
    if (!this.tasksTable) this.tasksTable = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get());
    return this.tasksTable;
  }

  /** La conversation où une tâche a été demandée (null : pas encore de message). */
  conversationOfTask(taskId: number): number | null {
    const row = this.db.prepare("SELECT conversation_id FROM messages WHERE task_id = ? AND conversation_id IS NOT NULL ORDER BY id LIMIT 1").get(taskId) as { conversation_id: number } | undefined;
    return row?.conversation_id ?? null;
  }

  /** L'utilisateur a vu la conversation jusqu'à son dernier message. */
  markSeen(id: number) {
    this.db.prepare("UPDATE conversations SET seen_id = COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id = ?), seen_id) WHERE id = ?").run(id, id);
  }

  /** Rouvre une conversation passée de ce canal. */
  switchTo(chatId: number, id: number): boolean {
    const c = this.conversation(id);
    if (!c || c.chat_id !== chatId) return false;
    this.setCurrent(chatId, id);
    return true;
  }

  /** La session de l'agent gardée avec la conversation, pour la reprendre plus tard. */
  saveSession(id: number, sessionId: string | null) {
    this.db.prepare("UPDATE conversations SET session_id = ? WHERE id = ?").run(sessionId, id);
  }

  /** Les conversations où il s'est passé quelque chose, la plus récemment active d'abord. */
  list(chatId: number, limit = 50): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.agent, c.pinned, c.updated_at AS at, c.created_at,
           (SELECT m.text FROM messages m WHERE m.conversation_id = c.id AND m.role != 'system' ORDER BY m.id DESC LIMIT 1) AS preview,
           (SELECT m.role FROM messages m WHERE m.conversation_id = c.id AND m.role != 'system' ORDER BY m.id DESC LIMIT 1) AS preview_role,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'clark' AND m.id > c.seen_id) AS unread
         FROM conversations c
         WHERE c.chat_id = ? AND (c.title IS NOT NULL OR ${HAS_CONTENT})
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(chatId, limit) as ConversationSummary[];
    // Sans message de l'utilisateur (que des réponses, des rappels) : un titre quand même.
    return rows.map((r) => ({ ...r, title: r.title ?? untitled(r.created_at) }));
  }

  /** L'utilisateur renomme une conversation (le titre ne bouge plus ensuite). */
  rename(id: number, title: string): boolean {
    const t = title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!t) return false;
    return this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(t, id).changes > 0;
  }

  setPinned(id: number, pinned: boolean): boolean {
    return this.db.prepare("UPDATE conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id).changes > 0;
  }

  /** Efface une conversation et ses messages, pour de bon (les tâches restent dans Activité). */
  remove(id: number) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversation_current WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Les messages d'une conversation, du plus ancien au plus récent. */
  messagesOf(id: number, limit = 200): Message[] {
    return (
      this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?").all(id, limit) as Message[]
    ).reverse();
  }

  /**
   * Où va un message qui ne suit aucune tâche. Ce que Clark poste de lui-même (rappel, décision
   * prise seul, souvenir retenu) va dans sa conversation à lui, pas dans celle d'un agent que
   * l'utilisateur a ouverte. Le reste (ce que l'utilisateur écrit, la note « Nouvelle conversation ») : l'ouverte.
   */
  private homeOf(m: { chatId: number; role: Role; text: string; agent?: string | null }): number {
    const cur = this.current(m.chatId);
    if (m.role === "user" || m.agent || m.text === NEW_CONVERSATION_NOTE) return cur;
    if ((this.conversation(cur)?.agent ?? null) === null) return cur;
    return this.latestWith(m.chatId, null) ?? this.create(m.chatId);
  }

  /**
   * Réparation des messages rangés avant ces règles : la suite d'une tâche rejoint la conversation
   * de la tâche (avis du groupe arrivés après « Nouvelle conversation », réponse du tour de veille
   * attirée par une alerte sur le fil de l'utilisateur). Sans effet sur ce qui est déjà bien rangé.
   */
  repairTaskMessages(): number {
    const rows = this.db.prepare("SELECT id, chat_id, task_id, conversation_id FROM messages WHERE task_id IS NOT NULL ORDER BY id").all() as {
      id: number;
      chat_id: number;
      task_id: number;
      conversation_id: number | null;
    }[];
    const move = this.db.prepare("UPDATE messages SET conversation_id = ? WHERE id = ?");
    const first = new Map<string, number>();
    let moved = 0;
    for (const r of rows) {
      const key = `${r.task_id}:${r.chat_id}`;
      let want = first.get(key);
      if (want === undefined) {
        // La tâche-mère d'abord : le premier message d'un avis a pu partir au mauvais endroit.
        want = this.parentConversation(r.task_id, r.chat_id) ?? r.conversation_id ?? undefined;
        if (want === undefined) continue;
        // Rangé dans une conversation d'un autre canal : il revient dans celle du sien.
        if (this.conversation(want)?.chat_id !== r.chat_id) want = this.current(r.chat_id);
        first.set(key, want);
      }
      if (r.conversation_id !== want) {
        move.run(want, r.id);
        moved++;
      }
    }
    // La date d'une conversation : sa dernière activité (message de l'utilisateur ou d'un agent).
    this.db.exec(`UPDATE conversations SET updated_at = COALESCE(
      (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id AND m.role != 'system'), created_at)`);
    return moved;
  }

  private parentConversation(taskId: number, chatId: number): number | null {
    if (!this.hasTasks()) return null;
    const row = this.db.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(taskId) as { parent_id: number | null } | undefined;
    return row?.parent_id ? this.conversationForTask(row.parent_id, chatId) : null;
  }

  onAdd(listener: (m: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(m: { chatId: number; role: Role; text: string; taskId?: number; source?: string; kind?: string; agent?: string | null }): Message {
    // La suite d'une tâche (réponse, étape) reste dans la conversation où elle a été demandée,
    // même si l'utilisateur en a ouvert une autre entre-temps.
    const conv = (m.taskId === undefined ? null : this.conversationForTask(m.taskId, m.chatId)) ?? this.homeOf(m);
    const r = this.db
      .prepare("INSERT INTO messages (chat_id, role, text, task_id, source, kind, conversation_id, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.chatId, m.role, m.text, m.taskId ?? null, m.source ?? null, m.kind ?? (m.role === "clark" ? "reply" : m.role === "system" ? "system" : null), conv, m.agent ?? null);
    this.touchConversation(conv, m.role, m.text);
    const saved = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(r.lastInsertRowid)) as Message;
    for (const listener of this.listeners) listener(saved);
    return saved;
  }

  get(id: number): Message | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message | undefined;
  }

  /** Les derniers messages, du plus ancien au plus récent. */
  recent(chatId: number, limit = 200): Message[] {
    return (
      this.db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?").all(chatId, limit) as Message[]
    ).reverse();
  }
}
