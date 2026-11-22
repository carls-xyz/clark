import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { inThread, noteCategory } from "../src/core/thread.ts";
import { unseenNotes } from "../src/core/unseen.ts";
import { activityNotes, threadMessages } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null };

function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const fake = (async () => ({ text: "ok", costUsd: 0, status: "done" })) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute: fake });
  return { store, journal, conversation, hub };
}

test("fil : toi, Clark, et les notes de vos échanges ; le reste part dans Activité", () => {
  const chats = new Map([
    [1, OWNER_CHAT],
    [2, 2012],
  ]);
  const chatOf = (id: number) => chats.get(id);
  const sys = (text: string, task_id: number | null = null, kind: string | null = "system") => ({ role: "system" as const, text, task_id, kind });
  assert.ok(inThread({ role: "user", text: "Salut", task_id: 1, kind: null }, OWNER_CHAT, chatOf));
  assert.ok(inThread({ role: "clark", text: "Salut", task_id: null, kind: "reply" }, OWNER_CHAT, chatOf));
  // Un morceau de ton échange : reste.
  assert.ok(inThread(sys("Je continue.", 1), OWNER_CHAT, chatOf));
  assert.ok(inThread(sys("Ça a planté de mon côté : x", 1), OWNER_CHAT, chatOf));
  // Des évènements : partent.
  assert.ok(!inThread(sys("Validé (Chercheur) : Read sur /x", 1), OWNER_CHAT, chatOf), "accord donné");
  assert.ok(!inThread(sys("Clark propose de retenir : « x »", 1), OWNER_CHAT, chatOf), "souvenir, même lié à ta tâche");
  assert.ok(!inThread(sys("Souvenir confirmé : « x »."), OWNER_CHAT, chatOf));
  assert.ok(!inThread(sys("Tâche dev #12 acceptée", 2, "dev"), OWNER_CHAT, chatOf));
  assert.ok(!inThread(sys("Une note liée à une tâche dev", 2), OWNER_CHAT, chatOf), "tâche d'une autre conversation");
  assert.ok(!inThread(sys("Objectif #2 en attente"), OWNER_CHAT, chatOf), "sans tâche");
  assert.ok(!inThread(sys("PR #1 : mergée.", null, "pr"), OWNER_CHAT, chatOf));

  assert.equal(noteCategory({ kind: "pr", text: "PR" }), "dev");
  assert.equal(noteCategory({ kind: "system", text: "J'ai retenu : « x »" }), "memoire");
  assert.equal(noteCategory({ kind: "system", text: "Clark te propose : « x »" }), "propositions");
  assert.equal(noteCategory({ kind: "system", text: "Validé : ls" }), "accords");
  assert.equal(noteCategory({ kind: "stalled", text: "L'agent…" }), "agents");
  assert.equal(noteCategory({ kind: "system", text: "Objectif #2 en attente" }), "autres");
});

test("fil et Activité depuis la base ; Clark relit quand même les notes avec ton message suivant", () => {
  const { journal, conversation, hub } = setup();
  const ask = journal.create(OWNER_CHAT, "chat", "Range mes mails");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Range mes mails", taskId: ask });
  conversation.add({ chatId: OWNER_CHAT, role: "system", text: "Je continue.", taskId: ask });
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "C'est fait.", taskId: ask, kind: "reply" });
  conversation.add({ chatId: OWNER_CHAT, role: "system", text: "Tâche dev #3 prête à relire", kind: "dev" });
  conversation.add({ chatId: OWNER_CHAT, role: "system", text: "Souvenir confirmé : « Charles aime le café ».", kind: "system" });

  const current = conversation.messagesOf(conversation.current(OWNER_CHAT));
  assert.deepEqual(
    threadMessages(hub, current).map((m) => m.text),
    ["Range mes mails", "Je continue.", "C'est fait."],
  );
  const notes = activityNotes(hub);
  assert.deepEqual(
    notes.map((n) => [n.category, n.text]),
    [
      ["memoire", "Souvenir confirmé : « Charles aime le café »."],
      ["dev", "Tâche dev #3 prête à relire"],
    ],
    "les plus récentes d'abord",
  );
  // Rien n'est perdu pour Clark : il voit ces notes avec ton message suivant.
  const told = unseenNotes(conversation, conversation.current(OWNER_CHAT))!;
  assert.match(told, /Tâche dev #3 prête à relire/);
  assert.match(told, /Souvenir confirmé/);
});

test("notes de reprise : elles citent ton message, jamais les notes ajoutées pour l'agent", async () => {
  const { askedText, checkAlertText } = await import("../src/tasks/journal.ts");
  const prompt = "[Affiché à Charles depuis votre dernier échange, envoyé en ton nom par Clark :]\n- 10:00 note : x\n\nMessage de Charles : Range mes mails";
  assert.equal(askedText(prompt), "Range mes mails");
  assert.equal(askedText("Range mes mails"), "Range mes mails");
  assert.match(checkAlertText({ prompt } as any, []), /^J'ai été coupé pendant « Range mes mails »/);
});
