import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * iMessage sur le Mac : lecture dans la base de Messages (lecture seule, il faut l'« accès complet
 * au disque » pour node), envoi par l'app Messages (AppleScript, autorisation demandée une fois).
 */

export type RawMessage = {
  id: number;
  text: string;
  fromMe: boolean;
  at: number;
  /** Numéro ou adresse de l'expéditeur (null pour toi). */
  handle: string | null;
  chatId: number;
};

export type ChatInfo = {
  id: number;
  guid: string;
  /** Numéro, adresse, ou identifiant de groupe. */
  ident: string;
  name: string | null;
  group: boolean;
  participants: string[];
};

export type ConversationSummary = ChatInfo & { last: number; unread: number; lastText: string; lastFromMe: boolean };

export interface MessagesBackend {
  status(): { access: boolean; problem: string | null };
  maxId(): number;
  since(rowid: number, limit?: number): RawMessage[];
  conversations(sinceMs: number, limit: number): ConversationSummary[];
  read(chatId: number, limit: number): RawMessage[];
  chat(chatId: number): ChatInfo | undefined;
  /** Nom du contact pour un numéro ou une adresse (carnet d'adresses), sinon null. */
  name(handle: string): string | null;
  send(chat: ChatInfo, text: string): Promise<void>;
}

const APPLE_EPOCH_MS = 978_307_200_000;
/** Dates de Messages : nanosecondes (ou secondes, anciennes bases) depuis le 1er janvier 2001. */
export const appleDate = (d: number | bigint | null) => {
  const n = Number(d ?? 0);
  return n > 1e12 ? n / 1e6 + APPLE_EPOCH_MS : n * 1000 + APPLE_EPOCH_MS;
};
export const toAppleDate = (ms: number) => (ms - APPLE_EPOCH_MS) * 1e6;
/**
 * En SQL, la date en millisecondes depuis 2001 : les nanosecondes de Messages dépassent ce que
 * JavaScript sait représenter (node:sqlite refuse de les lire telles quelles).
 */
const DATE_MS = "(CASE WHEN m.date > 1000000000000 THEN m.date / 1000000 ELSE m.date * 1000 END)";
const fromAppleMs = (ms: number | null) => Number(ms ?? 0) + APPLE_EPOCH_MS;

/**
 * Depuis macOS Ventura, le texte est souvent seulement dans attributedBody (format « typedstream ») :
 * la chaîne suit le marqueur NSString, précédée de sa longueur.
 */
export function textFromAttributedBody(raw: Uint8Array | null | undefined): string {
  if (!raw) return "";
  const b = Buffer.from(raw);
  const at = b.indexOf("NSString");
  if (at < 0) return "";
  const plus = b.indexOf(0x2b, at + 8);
  if (plus < 0 || plus > at + 16) return "";
  let p = plus + 1;
  let len = b[p++];
  if (len === 0x81) {
    len = b.readUInt16LE(p);
    p += 2;
  } else if (len === 0x82) {
    len = b.readUIntLE(p, 3);
    p += 3;
  }
  return b.subarray(p, p + len).toString("utf8");
}

/** « +33 6 12 34 56 78 », « 06 12 34 56 78 » → mêmes 9 derniers chiffres ; une adresse en minuscules. */
export function handleKey(h: string): string {
  if (h.includes("@")) return h.trim().toLowerCase();
  const digits = h.replace(/\D/g, "");
  return digits.slice(-9);
}

export const chatsDb = () => process.env.CLARK_IMESSAGE_DB?.trim() || join(homedir(), "Library/Messages/chat.db");
const ADDRESS_BOOK = join(homedir(), "Library/Application Support/AddressBook");

const SEND_SCRIPT = `on run argv
  set theText to item 1 of argv
  set theChat to item 2 of argv
  set theHandle to item 3 of argv
  tell application "Messages"
    try
      send theText to chat id theChat
    on error
      set theService to first account whose service type = iMessage
      send theText to participant theHandle of theService
    end try
  end tell
end run`;

export class MacMessages implements MessagesBackend {
  private db: DatabaseSync | null = null;
  private problem: string | null = null;
  private names: Map<string, string> | null = null;
  private namesAt = 0;

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    try {
      if (!existsSync(chatsDb())) throw new Error("introuvable");
      this.db = new DatabaseSync(chatsDb(), { readOnly: true });
      this.db.prepare("SELECT 1 FROM message LIMIT 1").get();
      this.problem = null;
      return this.db;
    } catch {
      this.db = null;
      this.problem = "no_access";
      return null;
    }
  }

  status() {
    const ok = this.open() !== null;
    return { access: ok, problem: ok ? null : this.problem };
  }

  maxId() {
    const db = this.open();
    return db ? Number((db.prepare("SELECT MAX(ROWID) AS n FROM message").get() as { n: number | null }).n ?? 0) : 0;
  }

  private rows(sql: string, ...params: (number | string)[]): RawMessage[] {
    const db = this.open();
    if (!db) return [];
    return (db.prepare(sql).all(...params) as any[]).map((r) => ({
      id: Number(r.id),
      text: (r.text ?? "") || textFromAttributedBody(r.body),
      fromMe: r.fromMe === 1,
      at: fromAppleMs(r.date),
      handle: r.handle ?? null,
      chatId: Number(r.chatId),
    }));
  }

  since(rowid: number, limit = 200) {
    return this.rows(
      `SELECT m.ROWID AS id, m.text, m.attributedBody AS body, m.is_from_me AS fromMe, ${DATE_MS} AS date, h.id AS handle, cmj.chat_id AS chatId
       FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.ROWID > ? AND m.item_type = 0 ORDER BY m.ROWID LIMIT ?`,
      rowid,
      limit,
    );
  }

  read(chatId: number, limit: number) {
    return this.rows(
      `SELECT * FROM (SELECT m.ROWID AS id, m.text, m.attributedBody AS body, m.is_from_me AS fromMe, ${DATE_MS} AS date, h.id AS handle, cmj.chat_id AS chatId
       FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE cmj.chat_id = ? AND m.item_type = 0 ORDER BY m.ROWID DESC LIMIT ?) ORDER BY id`,
      chatId,
      limit,
    );
  }

  chat(chatId: number): ChatInfo | undefined {
    const db = this.open();
    if (!db) return undefined;
    const c = db.prepare("SELECT ROWID AS id, guid, chat_identifier AS ident, display_name AS name, style FROM chat WHERE ROWID = ?").get(chatId) as any;
    if (!c) return undefined;
    const participants = (db.prepare("SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?").all(chatId) as { id: string }[]).map((p) => p.id);
    return { id: Number(c.id), guid: c.guid, ident: c.ident, name: c.name || null, group: c.style === 43, participants };
  }

  conversations(sinceMs: number, limit: number): ConversationSummary[] {
    const db = this.open();
    if (!db) return [];
    const rows = db
      .prepare(
        `SELECT c.ROWID AS id, MAX(${DATE_MS}) AS last, SUM(CASE WHEN m.is_from_me = 0 AND m.is_read = 0 THEN 1 ELSE 0 END) AS unread
         FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id
         WHERE ${DATE_MS} > ? AND m.item_type = 0 GROUP BY c.ROWID ORDER BY last DESC LIMIT ?`,
      )
      .all(sinceMs - APPLE_EPOCH_MS, limit) as { id: number; last: number; unread: number }[];
    return rows.flatMap((r) => {
      const info = this.chat(Number(r.id));
      const last = this.read(Number(r.id), 1)[0];
      return info ? [{ ...info, last: fromAppleMs(r.last), unread: Number(r.unread ?? 0), lastText: last?.text ?? "", lastFromMe: last?.fromMe ?? false }] : [];
    });
  }

  name(handle: string): string | null {
    if (!this.names || Date.now() - this.namesAt > 3600_000) this.loadNames();
    return this.names?.get(handleKey(handle)) ?? null;
  }

  /** Carnet d'adresses (Contacts) : lu une fois par heure, en lecture seule. */
  private loadNames() {
    this.names = new Map();
    this.namesAt = Date.now();
    const sources = join(ADDRESS_BOOK, "Sources");
    const files = [join(ADDRESS_BOOK, "AddressBook-v22.abcddb")];
    try {
      for (const s of readdirSync(sources)) files.push(join(sources, s, "AddressBook-v22.abcddb"));
    } catch {}
    for (const file of files) {
      if (!existsSync(file)) continue;
      try {
        const db = new DatabaseSync(file, { readOnly: true });
        const rows = db
          .prepare(
            `SELECT r.ZFIRSTNAME AS f, r.ZLASTNAME AS l, r.ZORGANIZATION AS o, p.ZFULLNUMBER AS v FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
             UNION ALL SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESS FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK`,
          )
          .all() as { f: string | null; l: string | null; o: string | null; v: string | null }[];
        for (const r of rows) {
          const name = [r.f, r.l].filter(Boolean).join(" ") || r.o;
          if (r.v && name) this.names.set(handleKey(r.v), name);
        }
        db.close();
      } catch {}
    }
  }

  async send(chat: ChatInfo, text: string) {
    await run("/usr/bin/osascript", ["-e", SEND_SCRIPT, text, chat.guid, chat.participants[0] ?? chat.ident], { timeout: 30_000 });
  }
}
