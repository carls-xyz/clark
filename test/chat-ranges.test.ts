import assert from "node:assert/strict";
import { test } from "node:test";
import { Conversation } from "../src/core/conversation.ts";
import { goalChat } from "../src/core/goals.ts";
import { IDEAS_CHAT } from "../src/core/ideas.ts";
import { OWNER_CHAT } from "../src/core/hub.ts";
import { devChat, devCritiqueChat, devGroupChat, devReviewChat, moveCritiqueChats } from "../src/dev/store.ts";
import { Store } from "../src/memory/store.ts";
import { automationChat } from "../src/scheduler/automations.ts";
import { HEARTBEAT_CHAT } from "../src/scheduler/heartbeat.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

test("fils à part : aucune conversation n'en partage une autre (numéros 1 à 999)", () => {
  const kinds: [string, (id: number) => number][] = [
    ["objectif", goalChat],
    ["tâche dev", devChat],
    ["plan de groupe", devGroupChat],
    ["relecture", devReviewChat],
    ["critique", devCritiqueChat],
    ["automatisation", automationChat],
  ];
  const owner = new Map<number, string>([
    [OWNER_CHAT, "ta conversation"],
    [HEARTBEAT_CHAT, "tour de veille"],
    [IDEAS_CHAT, "tour d'idées"],
  ]);
  for (const [name, chat] of kinds)
    for (let id = 1; id < 1000; id++) {
      const c = chat(id);
      assert.ok(!owner.has(c), `${name} #${id} (fil ${c}) tombe sur : ${owner.get(c)}`);
      owner.set(c, `${name} #${id}`);
    }
});

test("anciennes critiques (5 000 000 + id) : déplacées une fois, la session suit sauf si une automatisation a le même numéro", () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  new Conversation(store.db);
  const crit = (id: number) => {
    const t = journal.create(5_000_000 + id, `devcrit:${id}`, "critique");
    store.db.prepare("INSERT INTO messages (chat_id, role, text, task_id) VALUES (?, 'clark', 'avis', ?)").run(5_000_000 + id, t);
    store.setSession(5_000_000 + id, `session-${id}`);
    return t;
  };
  const a = crit(3);
  const b = crit(4);
  // L'automatisation n° 3 existe : la session du fil 5 000 003 est ambiguë.
  for (let i = 0; i < 3; i++) store.automations.create({ name: `Auto ${i + 1}`, prompt: "Fais le point", frequency: "daily", time: "09:00" });
  const auto = journal.create(5_000_003, "chat", "Fais le point");

  assert.equal(moveCritiqueChats(store.db), 2);
  assert.equal(journal.get(a)!.chat_id, devCritiqueChat(3));
  assert.equal(journal.get(b)!.chat_id, devCritiqueChat(4));
  assert.equal(journal.get(auto)!.chat_id, 5_000_003, "la tâche de l'automatisation reste à sa place");
  const msgChat = (t: number) => (store.db.prepare("SELECT chat_id FROM messages WHERE task_id = ?").get(t) as { chat_id: number }).chat_id;
  assert.equal(msgChat(a), devCritiqueChat(3));
  assert.equal(store.getSession(5_000_003), null, "session ambiguë : retirée");
  assert.equal(store.getSession(devCritiqueChat(3)), null);
  assert.equal(store.getSession(devCritiqueChat(4)), "session-4", "sans automatisation n° 4 : la session suit");
  assert.equal(moveCritiqueChats(store.db), 0, "déjà fait : rien à refaire");
});
