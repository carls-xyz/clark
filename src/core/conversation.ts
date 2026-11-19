import type { DatabaseSync } from "node:sqlite";

/**
 * Fil de la conversation, tel que Charles le voit : ses messages, les réponses
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
  /** Canal d'origine d'un message de Charles : "web", "telegram" ou "clark" (brief). */
  source: string | null;
  /** Genre de notification (reply, approval, dev, pr, stalled, proposals, system) : décide où elle part. */
  kind: string | null;
  /** Agent qui a écrit (conversation « Toute l'équipe ») ; null : l'agent de la conversation. */
  agent?: string | null;
  created_at: string;
};

/** Note posée quand Charles ouvre une nouvelle conversation (aussi envoyée sur Telegram). */
export const NEW_CONVERSATION_NOTE = "Nouvelle conversation. Ma mémoire longue reste intacte.";

export type ConversationRow = { id: number; chat_id: number; title: string | null; session_id: string | null; agent: string | null; seen_id: number; created_at: string; updated_at: string };
export type ConversationSummary = { id: number; title: string; agent: string | null; at: string; created_at: string; preview: string | null; preview_role: string | null; unread: number };

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
    // L'agent à qui Charles parle (null : Clark), et le dernier message qu'il a vu (non-lus).
    if (!convCols.some((c) => c.name === "agent")) db.exec("ALTER TABLE conversations ADD COLUMN agent TEXT");
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

  /** Un message de Charles date la conversation et lui donne son titre (son premier message). */
  private touchConversation(id: number, role: Role, text: string, at?: string) {
    if (role !== "user") return;
    const title = text.replace(/\s+/g, " ").trim().slice(0, 80);
    this.db
      .prepare("UPDATE conversations SET updated_at = COALESCE(?, datetime('now')), title = COALESCE(title, ?) WHERE id = ?")
      .run(at ?? null, title || null, id);
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

  /** Une conversation neuve devient l'ouverte. Celle d'avant, si Charles n'y a rien écrit, resservira. */
  startNew(chatId: number, agent: string | null = null): number {
    const cur = this.current(chatId);
    const used = this.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'user' LIMIT 1").get(cur);
    if (!used && (this.conversation(cur)?.agent ?? null) === agent) return cur;
    const id = this.create(chatId, undefined, agent);
    this.setCurrent(chatId, id);
    return id;
  }

  /** La conversation la plus récente avec cet agent (null : Clark), utilisée ou non. */
  latestWith(chatId: number, agent: string | null): number | null {
    const row = this.db
      .prepare("SELECT id FROM conversations WHERE chat_id = ? AND agent IS ? ORDER BY (title IS NULL), updated_at DESC, id DESC LIMIT 1")
      .get(chatId, agent) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** La conversation où une tâche a été demandée (null : pas encore de message). */
  conversationOfTask(taskId: number): number | null {
    const row = this.db.prepare("SELECT conversation_id FROM messages WHERE task_id = ? AND conversation_id IS NOT NULL ORDER BY id LIMIT 1").get(taskId) as { conversation_id: number } | undefined;
    return row?.conversation_id ?? null;
  }

  /** Charles a vu la conversation jusqu'à son dernier message. */
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

  /** Les conversations où Charles a écrit, la plus récente d'abord. */
  list(chatId: number, limit = 50): ConversationSummary[] {
    return this.db
      .prepare(
        `SELECT c.id, c.title, c.agent, c.updated_at AS at, c.created_at,
           (SELECT m.text FROM messages m WHERE m.conversation_id = c.id AND m.role != 'system' ORDER BY m.id DESC LIMIT 1) AS preview,
           (SELECT m.role FROM messages m WHERE m.conversation_id = c.id AND m.role != 'system' ORDER BY m.id DESC LIMIT 1) AS preview_role,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'clark' AND m.id > c.seen_id) AS unread
         FROM conversations c
         WHERE c.chat_id = ? AND c.title IS NOT NULL
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(chatId, limit) as ConversationSummary[];
  }

  /** Les messages d'une conversation, du plus ancien au plus récent. */
  messagesOf(id: number, limit = 200): Message[] {
    return (
      this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?").all(id, limit) as Message[]
    ).reverse();
  }

  onAdd(listener: (m: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(m: { chatId: number; role: Role; text: string; taskId?: number; source?: string; kind?: string; agent?: string | null }): Message {
    // La suite d'une tâche (réponse, étape) reste dans la conversation où elle a été demandée,
    // même si Charles en a ouvert une autre entre-temps.
    const ofTask =
      m.taskId === undefined
        ? undefined
        : (this.db.prepare("SELECT conversation_id FROM messages WHERE task_id = ? AND conversation_id IS NOT NULL ORDER BY id LIMIT 1").get(m.taskId) as
            | { conversation_id: number }
            | undefined);
    const conv = ofTask?.conversation_id ?? this.current(m.chatId);
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
