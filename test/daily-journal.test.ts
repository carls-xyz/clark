import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { cleanJournal, dayBounds, journalOf, JOURNAL_BUSY, JOURNAL_DIR, JOURNAL_UNUSABLE, mayTryJournal, needsRewrite, quietDay, recentJournalForPrompt, RETRY_DELAY_MS, writeJournal, writeJournalNow } from "../src/core/daily-journal.ts";
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

const parisToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const journalText = (brief: string) => `## En bref\n${brief}\n## Ce qu'on a fait\n- x\n## Ce que j'ai décidé seul\nRien.\n## En suspens\nRien.`;
/** Deux demandes de Charles aujourd'hui : assez pour un journal. */
function busyDay() {
  const s = setup();
  s.conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Trie mes mails" });
  s.conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Et regarde la PR" });
  return s;
}

test("journal : une seconde écriture remplace la première, dans la base et dans le fichier", async () => {
  const { store, hub } = busyDay();
  const vault = mkdtempSync(join(tmpdir(), "clark-journal-"));
  const day = parisToday();
  await writeJournal(hub, day, async () => journalText("Première version de la journée."), vault);
  await writeJournal(hub, day, async () => journalText("Seconde version, plus complète."), vault);
  assert.equal(journalOf(store.db).get(day)?.brief, "Seconde version, plus complète.");
  const note = readFileSync(join(vault, JOURNAL_DIR, `Journal ${day}.md`), "utf8");
  assert.match(note, /Seconde version/);
  assert.doesNotMatch(note, /Première version/);
});

test("writeJournalNow : journée vide sans appel au modèle ; réponse inutilisable : une erreur claire", async () => {
  const { hub } = setup();
  let called = false;
  assert.equal(quietDay(hub, "2026-11-01"), true);
  assert.deepEqual(await writeJournalNow(hub, "2026-11-01", async () => ((called = true), ""), null), { empty: true });
  assert.equal(called, false);

  const busy = busyDay();
  const day = parisToday();
  await assert.rejects(writeJournalNow(busy.hub, day, async () => "pas de journal", null), { message: JOURNAL_UNUSABLE });
  assert.equal(journalOf(busy.store.db).get(day), undefined);
  assert.deepEqual(await writeJournalNow(busy.hub, day, async () => journalText("Une journée bien remplie."), null), { day });
});

test("writeJournalNow : un seul à la fois par base, verrou relâché après", async () => {
  const { hub } = busyDay();
  const day = parisToday();
  let release: (v: string) => void = () => {};
  const first = writeJournalNow(hub, day, () => new Promise<string>((ok) => (release = ok)), null);
  await assert.rejects(writeJournalNow(hub, day, async () => journalText("Ne doit pas passer."), null), { message: JOURNAL_BUSY });
  release(journalText("La première écriture aboutit."));
  assert.deepEqual(await first, { day });
  // Relâché, même après un échec.
  await assert.rejects(writeJournalNow(hub, day, async () => "rien", null), { message: JOURNAL_UNUSABLE });
  assert.deepEqual(await writeJournalNow(hub, day, async () => journalText("Et encore une fois."), null), { day });
});

test("needsRewrite : écrit à 15 h (Paris) → réécrit le soir ; écrit à 23 h 10 → gardé", () => {
  // Hiver : Paris = UTC+1.
  assert.equal(needsRewrite("2026-11-21 14:00:00", "2026-11-21"), true);
  assert.equal(needsRewrite("2026-11-21 22:10:00", "2026-11-21"), false);
  // Écrit la veille (impossible en pratique) : à refaire ; écrit le lendemain (rattrapage) : gardé.
  assert.equal(needsRewrite("2026-11-20 10:00:00", "2026-11-21"), true);
  assert.equal(needsRewrite("2026-11-22 08:00:00", "2026-11-21"), false);
});

test("réessai après une réponse inutilisable : un seul, 30 min après, puis abandon pour le jour", () => {
  const t = Date.UTC(2026, 10, 21, 22, 0);
  assert.equal(mayTryJournal(undefined, t), true);
  const once = { count: 1, at: t };
  assert.equal(mayTryJournal(once, t + 5 * 60_000), false);
  assert.equal(mayTryJournal(once, t + RETRY_DELAY_MS - 1), false);
  assert.equal(mayTryJournal(once, t + RETRY_DELAY_MS), true);
  assert.equal(RETRY_DELAY_MS, 30 * 60_000);
  const twice = { count: 2, at: t + RETRY_DELAY_MS };
  assert.equal(mayTryJournal(twice, t + 3 * RETRY_DELAY_MS), false);
});
