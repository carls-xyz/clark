import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { cleanJournal, dayBounds, journalOf, JOURNAL_DIR, recentJournalForPrompt, writeJournal } from "../src/core/daily-journal.ts";
import { buildSystemPrompt } from "../src/core/prompt.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null } as Config;

function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config, store, journal, conversation }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as unknown as typeof executeTask });
  return { store, conversation, hub };
}

test("journal : un jour de Paris, en heure de la base (hiver : minuit à Paris = 23 h UTC la veille)", () => {
  assert.deepEqual(dayBounds("2026-11-21"), { start: "2026-11-20 23:00:00", end: "2026-11-21 23:00:00" });
  assert.deepEqual(dayBounds("2026-07-14"), { start: "2026-07-13 22:00:00", end: "2026-07-14 22:00:00" });
});

test("journal : seules les sections attendues, et seulement des liens vers des notes qui existent", () => {
  const text = "Voici le journal :\n## En bref\nOn a branché [[Obsidian]] et corrigé [[Le portfolio (1)]].\n## Ce qu'on a fait\n- truc";
  const r = cleanJournal(text, new Set(["Le portfolio (1)"]))!;
  assert.match(r.body, /^## En bref/);
  assert.match(r.body, /branché Obsidian et corrigé \[\[Le portfolio \(1\)\]\]/);
  assert.equal(r.brief, "On a branché Obsidian et corrigé [[Le portfolio (1)]].");
  assert.equal(cleanJournal("pas de section", new Set()), null);
});

test("journal : écrit le soir à partir des faits du jour, dans la base et le coffre ; relu au début d'une conversation", async () => {
  const { store, conversation, hub } = setup();
  const vault = mkdtempSync(join(tmpdir(), "clark-journal-"));
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Branche Google stp" });
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "C'est branché." });
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Merci, demain on fait Codex" });
  let seen = "";
  const think = async (prompt: string) => {
    seen = prompt;
    return "## En bref\nCharles a branché Google ; Codex est prévu demain.\n## Ce qu'on a fait\n- Google branché\n## Ce que j'ai décidé seul\nRien.\n## En suspens\n- Connecter Codex";
  };
  assert.equal(await writeJournal(hub, day, think, vault), day);
  assert.match(seen, /Branche Google stp/, "le journal part des vraies conversations");
  assert.match(seen, /rien d'inventé/);
  const file = join(vault, JOURNAL_DIR, `Journal ${day}.md`);
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /^---\ntype: journal\ndate: /);
  assert.match(recentJournalForPrompt(store.db), /Codex est prévu demain/);
  assert.match(buildSystemPrompt(store, join(vault, "rien")), /## Ces derniers jours \(ton journal\)[\s\S]*Codex est prévu demain/);
  assert.equal(journalOf(store.db).get(day)?.brief, "Charles a branché Google ; Codex est prévu demain.");
});

test("journal : rien d'écrit pour une journée presque vide", async () => {
  const { hub } = setup();
  let called = false;
  const r = await writeJournal(hub, "2026-11-01", async () => ((called = true), "## En bref\nx"), null);
  assert.equal(r, null);
  assert.equal(called, false, "pas d'appel au modèle pour rien");
});
