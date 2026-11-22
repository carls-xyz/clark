import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { cleanTitle, Conversation, NEW_CONVERSATION_NOTE } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null };

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition jamais atteinte");
};

function setup(titler?: (p: string) => Promise<string>) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const prompts: string[] = [];
  const execute = (async (deps: any, taskId: number, opts: any) => {
    prompts.push(opts.prompt);
    deps.journal.finish(taskId, "done", "Voici tes trois relances pour Studio Pixel.", 0);
    return { text: "Voici tes trois relances pour Studio Pixel.", costUsd: 0, status: "done" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, ...(titler ? { titler } : {}) });
  return { store, journal, conversation, hub, prompts };
}

/** Recule l'activité de la conversation ouverte de `hours` heures. */
function age(c: Conversation, store: Store, hours: number) {
  const at = new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const id = c.current(OWNER_CHAT);
  store.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, id);
  store.db.prepare("UPDATE conversation_current SET opened_at = ? WHERE chat_id = ?").run(at, OWNER_CHAT);
}

test("titre : nettoyé, une ligne, ni guillemets ni point final", () => {
  assert.equal(cleanTitle("« Relances Studio Pixel ».\n"), "Relances Studio Pixel");
  assert.equal(cleanTitle("Titre : Résumé mensuel du journal"), "Résumé mensuel du journal");
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("x".repeat(90)), null);
});

test("longue pause : ton message suivant ouvre une nouvelle conversation, l'ancienne garde sa session", async () => {
  const before = process.env.CLARK_NEW_CONVERSATION_HOURS;
  process.env.CLARK_NEW_CONVERSATION_HOURS = "4";
  try {
    const { store, conversation, hub } = setup();
    await hub.enqueue(OWNER_CHAT, "Prépare mes relances", "chat", "web");
    const first = conversation.current(OWNER_CHAT);
    store.setSession(OWNER_CHAT, "session-1");

    // Une heure plus tard : même conversation.
    age(conversation, store, 1);
    await hub.enqueue(OWNER_CHAT, "Et pour Banque du Nord ?", "chat", "web");
    assert.equal(conversation.current(OWNER_CHAT), first);

    // Cinq heures de calme : nouvelle conversation, l'ancienne garde sa session.
    store.setSession(OWNER_CHAT, "session-1");
    age(conversation, store, 5);
    await hub.enqueue(OWNER_CHAT, "Autre chose : mon portfolio", "chat", "web");
    const second = conversation.current(OWNER_CHAT);
    assert.notEqual(second, first);
    assert.equal(conversation.conversation(first)!.session_id, "session-1");
    assert.deepEqual(
      conversation.messagesOf(second).filter((m) => m.role !== "system" || m.text !== NEW_CONVERSATION_NOTE).map((m) => [m.role, m.text]),
      [
        ["user", "Autre chose : mon portfolio"],
        ["clark", "Voici tes trois relances pour Studio Pixel."],
      ],
    );

    // Une conversation rouverte n'est pas « calme depuis longtemps » : on y reste.
    age(conversation, store, 10);
    assert.ok(conversation.switchTo(OWNER_CHAT, first));
    await hub.enqueue(OWNER_CHAT, "Je reprends les relances", "chat", "web");
    assert.equal(conversation.current(OWNER_CHAT), first);

    // 0 : jamais.
    process.env.CLARK_NEW_CONVERSATION_HOURS = "0";
    age(conversation, store, 50);
    await hub.enqueue(OWNER_CHAT, "Toujours là ?", "chat", "web");
    assert.equal(conversation.current(OWNER_CHAT), first);
  } finally {
    if (before === undefined) delete process.env.CLARK_NEW_CONVERSATION_HOURS;
    else process.env.CLARK_NEW_CONVERSATION_HOURS = before;
  }
});

test("titre : trouvé par Clark après sa première réponse, jamais à la place du tien", async () => {
  const asked: string[] = [];
  const { conversation, hub } = setup(async (p) => {
    asked.push(p);
    return "« Relances Studio Pixel »";
  });
  await hub.enqueue(OWNER_CHAT, "Tu peux me préparer les relances pour Studio Pixel et la Banque du Nord stp", "chat", "web");
  const id = conversation.current(OWNER_CHAT);
  await until(() => conversation.conversation(id)!.title === "Relances Studio Pixel");
  assert.match(asked[0], /Studio Pixel et la Banque du Nord/);
  assert.match(asked[0], /Voici tes trois relances/);

  // Déjà titrée : on ne redemande pas.
  await hub.enqueue(OWNER_CHAT, "Merci", "chat", "web");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(asked.length, 1);

  // Renommée par toi : plus jamais remplacée.
  await hub.newConversation(OWNER_CHAT);
  await hub.enqueue(OWNER_CHAT, "Point sur le portfolio", "chat", "web");
  const other = conversation.current(OWNER_CHAT);
  await until(() => asked.length === 2);
  assert.ok(conversation.rename(other, "Mon portfolio"));
  assert.equal(conversation.setAutoTitle(other, "Autre titre"), false);
  assert.equal(conversation.conversation(other)!.title, "Mon portfolio");
});
