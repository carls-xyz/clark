import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { addDays, catchUpMonth, catchUpWeek, cleanJournal, dayBounds, isoMonth, isoWeek, journalOf, JOURNAL_BUSY, JOURNAL_DIR, JOURNAL_UNUSABLE, lastMonthForPrompt, lastWeekForPrompt, mayTryJournal, MONTH_HOUR, MONTH_MINUTE, monthlyDue, needsRewrite, quietDay, recentJournalForPrompt, RETRY_DELAY_MS, startDailyJournal, writeJournal, writeJournalNow, writeMonthSummary, writeWeekSummary } from "../src/core/daily-journal.ts";
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

// Résumé de la semaine : tiré des seuls journaux du jour.
const WEEK_TEXT = "## En bref\nUne semaine sur le portfolio, voir [[Journal 2026-11-17]] et [[Inventé]].\n## Ce qui a avancé\n- PR prête\n## Décisions et changements\nRien.\n## En suspens\n- Merger la PR";
function fakeModel(text = WEEK_TEXT) {
  const calls: string[] = [];
  return { calls, think: async (prompt: string) => (calls.push(prompt), text) };
}
function twoJournals(db: Parameters<typeof journalOf>[0]) {
  journalOf(db).save("2026-11-17", "Mardi : PR du portfolio ouverte.", "## En bref\nMardi : PR du portfolio ouverte.");
  journalOf(db).save("2026-11-19", "Jeudi : preview Vercel au vert.", "## En bref\nJeudi : preview Vercel au vert.");
}

test("semaine : bornes ISO, y compris au changement d'année", () => {
  assert.deepEqual(isoWeek("2026-11-21"), { week: "2026-S47", start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(isoWeek("2026-11-16"), { week: "2026-S47", start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(isoWeek("2026-11-22"), { week: "2026-S47", start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(isoWeek("2027-01-01"), { week: "2026-S53", start: "2026-12-28", end: "2027-01-03" });
  assert.deepEqual(isoWeek("2024-12-31"), { week: "2025-S01", start: "2024-12-30", end: "2025-01-05" });
});

test("semaine : rien sous deux journaux, sans appeler le modèle", async () => {
  const { store, hub } = setup();
  journalOf(store.db).save("2026-11-17", "Mardi seul.", "## En bref\nMardi seul.");
  journalOf(store.db).save("2026-11-10", "Semaine d'avant.", "## En bref\nSemaine d'avant.");
  const m = fakeModel();
  assert.equal(await writeWeekSummary(hub, "2026-11-21", m.think, null), null);
  assert.equal(m.calls.length, 0);
});

test("semaine : le prompt part des journaux, pas des conversations ; liens filtrés ; note dans le coffre", async () => {
  const { store, conversation, hub } = setup();
  const vault = mkdtempSync(join(tmpdir(), "clark-semaine-"));
  twoJournals(store.db);
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Message de conversation secret-xyz" });
  const m = fakeModel();
  assert.equal(await writeWeekSummary(hub, "2026-11-21", m.think, vault), "2026-S47");
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0], /PR du portfolio ouverte/);
  assert.match(m.calls[0], /preview Vercel au vert/);
  assert.match(m.calls[0], /rien d'inventé/);
  assert.match(m.calls[0], /\[\[Journal 2026-11-17\]\]/);
  assert.doesNotMatch(m.calls[0], /secret-xyz/, "jamais les conversations");
  const w = journalOf(store.db).getWeek("2026-S47")!;
  assert.equal(w.start, "2026-11-16");
  assert.equal(w.end, "2026-11-22");
  assert.match(w.body, /\[\[Journal 2026-11-17\]\]/, "lien vers un journal de la semaine gardé");
  assert.doesNotMatch(w.body, /\[\[Inventé\]\]/);
  assert.match(w.body, /et Inventé\./, "texte du lien retiré conservé");
  const file = join(vault, JOURNAL_DIR, "Semaine 2026-S47.md");
  assert.ok(existsSync(file));
  const note = readFileSync(file, "utf8");
  assert.match(note, /^---\ntype: semaine\nweek: 2026-S47\nstart: 2026-11-16\nend: 2026-11-22\ntags: \[clark\/semaine\]\n---\n# Semaine 2026-S47 \(du 2026-11-16 au 2026-11-22\)/);
  assert.match(note, /- \[\[Journal 2026-11-17\]\]/);
  assert.match(note, /- \[\[Journal 2026-11-19\]\]/);
  assert.match(note, /Retour à \[\[Clark\]\]/);
});

test("semaine : rattrapage de la semaine passée au démarrage, une seule fois", async () => {
  const { store, hub } = setup();
  twoJournals(store.db);
  const m = fakeModel();
  const monday = new Date("2026-11-23T10:00:00Z");
  assert.equal(await catchUpWeek(hub, m.think, null, monday), "2026-S47");
  assert.ok(journalOf(store.db).getWeek("2026-S47"));
  assert.equal(await catchUpWeek(hub, m.think, null, monday), null);
  assert.equal(m.calls.length, 1, "pas réécrite au second appel");
});

test("semaine : relue au début d'une conversation", async () => {
  const { store, hub } = setup();
  assert.equal(lastWeekForPrompt(store.db), "");
  twoJournals(store.db);
  await writeWeekSummary(hub, "2026-S47", fakeModel().think, null);
  const brief = journalOf(store.db).getWeek("2026-S47")!.brief;
  assert.equal(lastWeekForPrompt(store.db), `La semaine dernière : ${brief}`);
  const sys = buildSystemPrompt(store, join(tmpdir(), "rien"));
  assert.match(sys, /## Ces derniers jours \(ton journal\)/);
  assert.ok(sys.includes(`La semaine dernière : ${brief}`));
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

// Résumé du mois : tiré des seuls journaux du jour, comme la semaine.
const MONTH_TEXT = "## En bref\nUn mois sur le portfolio, voir [[Journal 2026-10-02]] et [[Inventé]].\n## Ce qui a avancé\n- PR prête\n## Décisions et changements\nRien.\n## En suspens\n- Merger la PR";
/** Seme n journaux dans un même mois (jours pairs, pour rester dans le mois). */
function monthJournals(db: Parameters<typeof journalOf>[0], month = "2026-10", n = 5) {
  for (let i = 1; i <= n; i++) {
    const day = `${month}-${String(i * 2).padStart(2, "0")}`;
    journalOf(db).save(day, `Jour ${i}.`, `## En bref\nJour ${i} du mois.`);
  }
}

test("mois : bornes du mois calendaire (31 jours, février bissextile ou non, passage d'année)", () => {
  assert.deepEqual(isoMonth("2026-10-15"), { month: "2026-10", start: "2026-10-01", end: "2026-10-31" });
  assert.deepEqual(isoMonth("2026-02-10"), { month: "2026-02", start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(isoMonth("2024-02-10"), { month: "2024-02", start: "2024-02-01", end: "2024-02-29" });
  assert.deepEqual(isoMonth("2026-12-31"), { month: "2026-12", start: "2026-12-01", end: "2026-12-31" });
  assert.deepEqual(isoMonth("2027-01-01"), { month: "2027-01", start: "2027-01-01", end: "2027-01-31" });
});

test("mois : dû le 1er une fois l'heure atteinte, quel que soit le jour de semaine (même un dimanche)", () => {
  assert.equal(MONTH_HOUR, 23);
  assert.equal(MONTH_MINUTE, 45);
  // Le 1er, pile et au-delà de 23 h 45.
  assert.equal(monthlyDue({ date: "2026-10-01", hour: 23, minute: 45 }), true);
  assert.equal(monthlyDue({ date: "2026-10-01", hour: 23, minute: 50 }), true);
  // Le 1er, mais trop tôt.
  assert.equal(monthlyDue({ date: "2026-10-01", hour: 23, minute: 30 }), false);
  assert.equal(monthlyDue({ date: "2026-10-01", hour: 22, minute: 59 }), false);
  // Le 2 : jamais.
  assert.equal(monthlyDue({ date: "2026-10-02", hour: 23, minute: 50 }), false);
  // 2026-11-01 est un dimanche (l'hebdo se déclenche aussi) : le mensuel se déclenche quand même.
  const nov1 = new Date("2026-11-01T22:45:00Z");
  assert.equal(nov1.toLocaleDateString("en-US", { weekday: "long", timeZone: "Europe/Paris" }), "Sunday");
  assert.equal(monthlyDue({ date: "2026-11-01", hour: 23, minute: 45 }), true);
});

test("mois : rien sous cinq journaux, sans appeler le modèle", async () => {
  const { store, hub } = setup();
  monthJournals(store.db, "2026-10", 4);
  const m = fakeModel(MONTH_TEXT);
  assert.equal(await writeMonthSummary(hub, "2026-10", m.think, null), null);
  assert.equal(m.calls.length, 0);
  assert.equal(journalOf(store.db).getMonth("2026-10"), undefined);
});

test("mois : le prompt part des journaux, pas des conversations ; liens filtrés ; note et base", async () => {
  const { store, conversation, hub } = setup();
  const vault = mkdtempSync(join(tmpdir(), "clark-mois-"));
  monthJournals(store.db, "2026-10", 5);
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Message de conversation secret-xyz" });
  const m = fakeModel(MONTH_TEXT);
  assert.equal(await writeMonthSummary(hub, "2026-10", m.think, vault), "2026-10");
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0], /Jour 1 du mois/);
  assert.match(m.calls[0], /rien d'inventé/);
  assert.match(m.calls[0], /\[\[Journal 2026-10-02\]\]/);
  assert.doesNotMatch(m.calls[0], /secret-xyz/, "jamais les conversations");
  const mo = journalOf(store.db).getMonth("2026-10")!;
  assert.equal(mo.start, "2026-10-01");
  assert.equal(mo.end, "2026-10-31");
  assert.match(mo.body, /\[\[Journal 2026-10-02\]\]/, "lien vers un journal du mois gardé");
  assert.doesNotMatch(mo.body, /\[\[Inventé\]\]/);
  assert.match(mo.body, /et Inventé\./, "texte du lien retiré conservé");
  const file = join(vault, JOURNAL_DIR, "Mois 2026-10.md");
  assert.ok(existsSync(file));
  const note = readFileSync(file, "utf8");
  assert.match(note, /^---\ntype: mois\nmonth: 2026-10\nstart: 2026-10-01\nend: 2026-10-31\ntags: \[clark\/mois\]\n---\n# Mois 2026-10 \(du 2026-10-01 au 2026-10-31\)/);
  assert.match(note, /- \[\[Journal 2026-10-02\]\]/);
  assert.match(note, /- \[\[Journal 2026-10-10\]\]/);
  assert.match(note, /Retour à \[\[Clark\]\]/);
});

test("mois : écrit aussi sans coffre (vault null)", async () => {
  const { store, hub } = setup();
  monthJournals(store.db, "2026-10", 5);
  assert.equal(await writeMonthSummary(hub, "2026-10", fakeModel(MONTH_TEXT).think, null), "2026-10");
  assert.ok(journalOf(store.db).getMonth("2026-10"));
});

test("mois : un échec du coffre laisse la base vide (rejouable), la tentative suivante écrit la note", async () => {
  const { store, hub } = setup();
  monthJournals(store.db, "2026-10", 5);
  // Un « coffre » qui est en fait un fichier : mkdirSync sous un fichier échoue (ENOTDIR).
  const badVault = join(mkdtempSync(join(tmpdir(), "clark-mois-ko-")), "pas-un-dossier");
  writeFileSync(badVault, "x");
  const m = fakeModel(MONTH_TEXT);
  await assert.rejects(writeMonthSummary(hub, "2026-10", m.think, badVault));
  assert.equal(journalOf(store.db).getMonth("2026-10"), undefined, "rien en base tant que la note a échoué");
  // Seconde tentative, coffre valide : la note est écrite et la base renseignée.
  const vault = mkdtempSync(join(tmpdir(), "clark-mois-ok-"));
  assert.equal(await writeMonthSummary(hub, "2026-10", m.think, vault), "2026-10");
  assert.ok(existsSync(join(vault, JOURNAL_DIR, "Mois 2026-10.md")));
  assert.ok(journalOf(store.db).getMonth("2026-10"));
});

test("mois : rattrapage du dernier mois complet, une seule fois, sans toucher au mois en cours", async () => {
  const { store, hub } = setup();
  monthJournals(store.db, "2026-10", 5); // mois complet précédent
  monthJournals(store.db, "2026-11", 5); // mois en cours : ne doit pas être écrit
  const m = fakeModel(MONTH_TEXT);
  const inNovember = new Date("2026-11-15T10:00:00Z");
  assert.equal(await catchUpMonth(hub, m.think, null, inNovember), "2026-10");
  assert.ok(journalOf(store.db).getMonth("2026-10"));
  assert.equal(journalOf(store.db).getMonth("2026-11"), undefined, "jamais le mois en cours");
  assert.equal(await catchUpMonth(hub, m.think, null, inNovember), null);
  assert.equal(m.calls.length, 1, "pas réécrit au second appel");
});

test("mois : planificateur — le tick du dimanche 1er écrit le mois même après l'échec de l'hebdo", async (t) => {
  const { store, hub } = setup();
  const vault = mkdtempSync(join(tmpdir(), "clark-sched-"));
  // Cinq journaux en octobre (mois complet précédent).
  for (const d of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-10-27"]) journalOf(store.db).save(d, "Jour.", "## En bref\nJour du mois d'octobre.");
  // On casse l'hebdo : sa table disparaît, donc getWeek lève (erreur hors du try interne de weekIfMissing).
  store.db.exec("DROP TABLE weekly_summary");
  assert.throws(() => journalOf(store.db).getWeek("2026-S44"), "l'hebdo échoue bien");
  const flush = async () => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  };
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  // Horloge mutable : d'abord en octobre (le rattrapage ne vise QUE le mois précédent, septembre, vide).
  let clock = new Date("2026-10-15T08:00:00Z");
  const stop = startDailyJournal(hub, async () => MONTH_TEXT, () => vault, () => clock);
  // Le rattrapage du démarrage tourne seul (60 s), sans atteindre le tick (5 min).
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(journalOf(store.db).getMonth("2026-10"), undefined, "le rattrapage d'octobre ne touche pas octobre (il vise septembre)");
  assert.equal(journalOf(store.db).getMonth("2026-09"), undefined, "septembre vide : rien écrit non plus");
  // Puis dimanche 2026-11-01, 23 h 46 (Paris) : fenêtre hebdo ET fenêtre du mois ouvertes.
  clock = new Date("2026-11-01T22:46:00Z");
  assert.equal(clock.toLocaleDateString("en-US", { weekday: "long", timeZone: "Europe/Paris" }), "Sunday");
  // On atteint le prochain tick (à 5 min) : c'est lui, pas le rattrapage, qui agit maintenant.
  t.mock.timers.tick(5 * 60_000);
  await flush();
  stop();
  // Le tick a poursuivi après l'échec de l'hebdo : octobre est écrit en base et dans le coffre.
  assert.ok(journalOf(store.db).getMonth("2026-10"), "octobre écrit par le tick malgré l'hebdo en échec");
  assert.ok(existsSync(join(vault, JOURNAL_DIR, "Mois 2026-10.md")));
});

test("mois : nomme le mois réel (non trompeur) et apparaît dans le prompt système", async () => {
  const { store, hub } = setup();
  assert.equal(lastMonthForPrompt(store.db), "");
  monthJournals(store.db, "2026-10", 5);
  await writeMonthSummary(hub, "2026-10", fakeModel(MONTH_TEXT).think, null);
  const brief = journalOf(store.db).getMonth("2026-10")!.brief;
  assert.equal(lastMonthForPrompt(store.db), `En octobre 2026 : ${brief}`);
  const sys = buildSystemPrompt(store, join(tmpdir(), "rien"));
  assert.ok(sys.includes(`En octobre 2026 : ${brief}`));
});

test("journal : Mac endormi pendant le journal de 23 h → rattrapé le lendemain matin, sans redémarrage", async (t) => {
  const { store, hub } = busyDay();
  const day = parisToday();
  const flush = async () => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  };
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  // Le jour même, 23 h 30 à Paris (hiver : UTC+1).
  let clock = new Date(`${day}T22:30:00Z`);
  let asleep = true;
  const calls: string[] = [];
  const think = async (prompt: string) => {
    calls.push(prompt);
    if (asleep) throw new Error("API Error: Your computer went to sleep mid-response.");
    return journalText("Rattrapé au réveil.");
  };
  const stop = startDailyJournal(hub, think, () => null, () => clock);
  // Le rattrapage du démarrage (60 s) vise la veille, vide : il passe et rend le verrou.
  t.mock.timers.tick(60_000);
  await flush();
  t.mock.timers.tick(4 * 60_000);
  await flush();
  assert.ok(calls.length >= 1, "le journal de 23 h a été tenté");
  assert.equal(journalOf(store.db).get(day), undefined, "échec : rien d'écrit");
  // Pas de nouvel essai avant 30 min.
  const tried = calls.length;
  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.equal(calls.length, tried, "pas de nouvel essai dans les 30 min");
  // Le lendemain, 8 h à Paris : le Mac se réveille, la journée a changé.
  asleep = false;
  clock = new Date(`${addDays(day, 1)}T07:00:00Z`);
  t.mock.timers.tick(5 * 60_000);
  await flush();
  stop();
  assert.equal(journalOf(store.db).get(day)?.brief, "Rattrapé au réveil.", "la veille est rattrapée par le tick, sans redémarrage");
});
