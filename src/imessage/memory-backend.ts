import type { ChatInfo, ConversationSummary, MessagesBackend, RawMessage } from "./backend.ts";
import { handleKey } from "./backend.ts";

/** Messages en mémoire, pour la démo et les tests : mêmes règles, aucune vraie conversation. */
export class MemoryMessages implements MessagesBackend {
  chats: ChatInfo[] = [];
  messages: RawMessage[] = [];
  contacts = new Map<string, string>();
  sent: { chat: number; text: string }[] = [];
  access = true;
  failSend: string | null = null;
  private next = 1;

  addChat(c: Omit<ChatInfo, "guid"> & { guid?: string }): ChatInfo {
    const chat = { guid: c.guid ?? `any;-;${c.ident}`, ...c };
    this.chats.push(chat);
    return chat;
  }

  push(chatId: number, text: string, fromMe: boolean, handle: string | null = null, at = Date.now()): RawMessage {
    const m = { id: this.next++, text, fromMe, at, handle, chatId };
    this.messages.push(m);
    return m;
  }

  status() {
    return { access: this.access, problem: this.access ? null : "no_access" };
  }
  maxId() {
    return this.messages.at(-1)?.id ?? 0;
  }
  since(rowid: number, limit = 200) {
    return this.messages.filter((m) => m.id > rowid).slice(0, limit);
  }
  read(chatId: number, limit: number) {
    return this.messages.filter((m) => m.chatId === chatId).slice(-limit);
  }
  chat(chatId: number) {
    return this.chats.find((c) => c.id === chatId);
  }
  conversations(sinceMs: number, limit: number): ConversationSummary[] {
    return this.chats
      .map((c) => {
        const ms = this.messages.filter((m) => m.chatId === c.id);
        const last = ms.at(-1);
        return last && last.at > sinceMs ? { ...c, last: last.at, unread: ms.filter((m) => !m.fromMe).length, lastText: last.text, lastFromMe: last.fromMe } : null;
      })
      .filter((c): c is ConversationSummary => c !== null)
      .sort((a, b) => b.last - a.last)
      .slice(0, limit);
  }
  name(handle: string) {
    return this.contacts.get(handleKey(handle)) ?? null;
  }
  async send(chat: ChatInfo, text: string) {
    if (this.failSend) throw new Error(this.failSend);
    this.sent.push({ chat: chat.id, text });
    this.push(chat.id, text, true);
  }
}
