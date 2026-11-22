import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { DEFAULT_SOURCES, IDEA_DIG_LABEL, IDEAS_CHAT, IDEAS_TOUR_LABEL, MAX_NEW } from "../src/core/ideas.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { effectOf } from "../src/policy/permissions.ts";
import { addIdeaFromOwner, decideIdea, ideaDigPrompt, ideaNote, ideasHour, ideasTourDecision, ideasTourPrompt, runIdeasTour, writeIdeaNote } from "../src/scheduler/ideas.ts";
import { heartbeatPrompt } from "../src/scheduler/heartbeat.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

// Jamais le vrai coffre de l'utilisateur pendant les tests.
const vault = mkdtempSync(join(tmpdir(), "clark-idees-"));
process.env.CLARK_OBSIDIAN_VAULT = vault;

const config: Config = {
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: 0,
  model: "claude-opus-5-5",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
};

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition jamais atteinte");
};

const idea = (title: string, origin: "scroll" | "toi" | "clark" = "scroll") => ({ title, pitch: `On construirait ${title}, simplement.`, why: "Ça colle à sa stack", origin });

/** onRun : ce que « l'agent » fait pendant la tâche (noter une idée, rendre un avis…). */
function setup(onRun: (store: Store, taskId: number, opts: RunOptions) => void = () => {}) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const calls: { taskId: number; opts: RunOptions }[] = [];
  const execute = (async (deps: any, taskId: number, opts: RunOptions) => {
    calls.push({ taskId, opts });
    onRun(store, taskId, opts);
    deps.journal.finish(taskId, "done", "ok", 0);
    return { text: "ok", costUsd: 0, status: "done" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute });
  const said = () => conversation.recent(OWNER_CHAT, 50).map((m) => m.text);
  return { store, journal, conversation, hub, calls, said };
}

test("idées : doublon, idée écartée retenue, plafond des idées à trier (sauf les tiennes)", () => {
  const s = new Store(":memory:");
  const a = s.ideas.add(idea("Tableau de bord des PR"));
  assert.equal(a.outcome, "added");
  assert.equal(s.ideas.add(idea("tableau de bord  des PR !")).outcome, "duplicate", "même titre à la casse et ponctuation près");
  const id = (a as { id: number }).id;
  assert.ok(s.ideas.setStatus(id, "dropped", { dropReason: "déjà fait" }));
  assert.equal(s.ideas.get(id)!.drop_reason, "déjà fait");
  assert.equal(s.ideas.add(idea("Tableau de bord des PR")).outcome, "dropped_before");

  for (let i = 0; i < MAX_NEW; i++) assert.equal(s.ideas.add(idea(`Projet numéro ${i}`)).outcome, "added");
  assert.equal(s.ideas.add(idea("Une de trop")).outcome, "full");
  assert.equal(s.ideas.add(idea("La mienne passe quand même", "toi")).outcome, "added", "une idée de l'utilisateur n'est jamais refusée pour ça");
});

test("idées : avis, recherche interrompue, sites parcourus", () => {
  const s = new Store(":memory:");
  const { id } = s.ideas.add(idea("Extension Safari")) as { id: number };
  s.ideas.setStatus(id, "digging");
  s.ideas.unstick(id);
  assert.equal(s.ideas.get(id)!.status, "new", "recherche coupée : l'idée revient à trier");
  s.ideas.setStatus(id, "digging");
  assert.ok(s.ideas.report(id, "later", "## Ce que c'est\nUne extension."));
  assert.equal(s.ideas.get(id)!.status, "dug");
  assert.equal(s.ideas.get(id)!.verdict, "later");
  s.ideas.setStatus(id, "kept");
  s.ideas.report(id, "go", "Nouvel avis");
  assert.equal(s.ideas.get(id)!.status, "kept", "un nouvel avis ne défait pas « gardée »");

  assert.deepEqual(s.ideas.sources(), DEFAULT_SOURCES);
  assert.deepEqual(s.ideas.setSources([" https://a.dev/x ", "pas un lien", "https://a.dev/x", "http://b.dev"]), ["https://a.dev/x", "http://b.dev"]);
  assert.deepEqual(s.ideas.sources(), ["https://a.dev/x", "http://b.dev"]);
});

test("outils : note_idea (scroll pendant le tour, sinon Clark), permis en lecture seule ; idea_report", () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const tour = journal.create(IDEAS_CHAT, IDEAS_TOUR_LABEL, "tour");
  const chat = journal.create(OWNER_CHAT, "chat", "salut");
  const none = memoryTools(store, { taskId: () => undefined, writeRefusal: () => null });
  const arg = { title: "Clark sur VPS", pitch: "Faire tourner Clark sur un petit serveur, joint par Tailscale.", why: "Il dort avec le Mac", source_url: "https://news.ycombinator.com/item?id=1", source_label: "Show HN" };
  assert.match(none.note_idea.run(arg), /^Refusé/);

  const ro = memoryTools(store, { taskId: () => tour, writeRefusal: () => "lecture seule" });
  assert.match(ro.note_idea.run(arg), /^Idée #1 notée/, "noter une idée n'agit sur rien : permis en lecture seule");
  assert.equal(store.ideas.get(1)!.origin, "scroll");
  assert.equal(store.ideas.get(1)!.source_label, "Show HN");
  assert.match(ro.note_idea.run(arg), /Déjà notée/);

  const fromChat = memoryTools(store, { taskId: () => chat, writeRefusal: () => null });
  fromChat.note_idea.run({ ...arg, title: "Résumé des PR du matin" });
  assert.equal(store.ideas.get(2)!.origin, "clark");

  assert.match(ro.idea_report.run({ id: 99, verdict: "go", report: "x".repeat(60) }), /introuvable/);
  assert.match(ro.idea_report.run({ id: 1, verdict: "go", report: "## Ce que c'est\n" + "x".repeat(60) }), /enregistré/);
  assert.equal(store.ideas.get(1)!.status, "dug");

  assert.equal(effectOf("mcp__memory__note_idea"), "read");
  assert.equal(effectOf("mcp__memory__idea_report"), "read");
});

test("consignes : le tour donne les sites, les idées déjà vues et les gardées ; la recherche donne l'idée", () => {
  const p = ideasTourPrompt(["https://news.ycombinator.com/show"], ["Vieille idée"], [{ title: "Idée gardée" } as any], new Date("2026-11-22T14:00:00Z"));
  assert.match(p, /\[Tour d'idées\]/);
  assert.match(p, /news\.ycombinator\.com\/show/);
  assert.match(p, /- Vieille idée/);
  assert.match(p, /- Idée gardée/);
  assert.match(p, /ne te connecte jamais/);
  assert.match(p, /nothing_new/);

  const d = ideaDigPrompt({ id: 7, title: "Extension", pitch: "Une extension", why: "Pour lui", source_url: "https://x.dev", source_label: "GitHub" } as any);
  assert.match(d, /\[Idée #7 à creuser\]/);
  assert.match(d, /idea_report \(id 7\)/);
  assert.match(d, /Source : https:\/\/x\.dev \(GitHub\)/);

  assert.match(heartbeatPrompt([], [], new Date(), undefined, ["Clark sur VPS"]), /Idées de projets que Charles a gardées[\s\S]*- Clark sur VPS/);
  assert.doesNotMatch(heartbeatPrompt([], []), /Idées de projets/);
});

test("tour d'idées : à l'heure, une fois par jour, pas avec trop d'idées à trier", () => {
  // 16 h à Paris (UTC+1).
  const at = new Date("2026-11-22T15:00:00Z");
  const base = { hour: 15, engineReady: true, ranToday: false, busy: false, newCount: 0, quotaPercent: null };
  assert.deepEqual(ideasTourDecision(base, at), { run: true, why: "maintenant" });
  assert.match(ideasTourDecision({ ...base, hour: null }, at).why, /coupé/);
  assert.match(ideasTourDecision({ ...base, hour: 17 }, at).why, /aujourd'hui à 17 h/);
  assert.match(ideasTourDecision({ ...base, ranToday: true }, at).why, /fait aujourd'hui/);
  assert.match(ideasTourDecision({ ...base, newCount: MAX_NEW }, at).why, /trie d'abord/);
  assert.match(ideasTourDecision({ ...base, busy: true }, at).why, /attend/);
  assert.match(ideasTourDecision({ ...base, engineReady: false }, at).why, /aucun moteur/);

  const before = process.env.CLARK_IDEAS_HOUR;
  process.env.CLARK_IDEAS_HOUR = "";
  assert.equal(ideasHour(), null, "vide : coupé");
  process.env.CLARK_IDEAS_HOUR = "9";
  assert.equal(ideasHour(), 9);
  if (before === undefined) delete process.env.CLARK_IDEAS_HOUR;
  else process.env.CLARK_IDEAS_HOUR = before;
});

test("tour d'idées : à part, en lecture seule, sans reprendre de session ; annoncé une fois à la fin", async () => {
  const { store, hub, calls, said } = setup((s, taskId) => {
    s.ideas.add({ ...idea("Clark sur VPS"), taskId });
    s.ideas.add({ ...idea("Résumé des PR"), taskId });
  });
  store.setSession(IDEAS_CHAT, "vieille-session");
  await runIdeasTour(hub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.access, "read");
  assert.equal(calls[0].opts.resume, undefined, "chaque tour repart de zéro");
  assert.match(calls[0].opts.prompt, /\[Tour d'idées\]/);
  await until(() => said().some((t) => t.startsWith("Tour d'idées : 2 idées notées")));
  assert.ok(!said().some((t) => t.includes("[Tour d'idées]")), "la consigne ne s'affiche pas dans ta conversation");
});

test("creuser : recherche en lecture seule ; avis annoncé, ou l'idée revient à trier", async () => {
  let answer = true;
  const { store, hub, calls, said } = setup((s, _taskId, opts) => {
    const id = Number(opts.prompt.match(/Idée #(\d+)/)?.[1]);
    if (answer) s.ideas.report(id, "go", "## Ce que c'est\nBien.");
  });
  const { id } = store.ideas.add(idea("Extension Safari")) as { id: number };
  assert.deepEqual(decideIdea(hub, id, "dig"), { ok: true });
  assert.equal(store.ideas.get(id)!.status, "digging");
  assert.equal((decideIdea(hub, id, "dig") as { status: number }).status, 409, "pas deux recherches en même temps");
  await until(() => store.ideas.get(id)!.status === "dug");
  assert.equal(calls[0].opts.access, "read");
  await until(() => said().some((t) => t.includes("creusée : à faire")));

  answer = false;
  const other = (store.ideas.add(idea("Autre idée")) as { id: number }).id;
  decideIdea(hub, other, "dig");
  await until(() => store.ideas.get(other)!.status === "new");
  await until(() => said().some((t) => t.includes("je n'ai pas pu la creuser")));
  const tasks = store.db.prepare("SELECT label, chat_id FROM tasks ORDER BY id").all() as { label: string; chat_id: number }[];
  assert.ok(tasks.every((t) => t.label === IDEA_DIG_LABEL && t.chat_id === IDEAS_CHAT));
});

test("garder écrit la note dans Clark/Idées ; lancer passe par ta conversation ; écarter, remettre, supprimer", async () => {
  const { store, hub, calls } = setup();
  const { id } = store.ideas.add(idea("Clark sur VPS")) as { id: number };
  store.ideas.report(id, "go", "## Premier pas\nLouer un VPS.");
  decideIdea(hub, id, "keep");
  assert.equal(store.ideas.get(id)!.status, "kept");
  const note = join(vault, "Clark", "Idées", "Clark sur VPS.md");
  assert.ok(existsSync(note));
  assert.match(readFileSync(note, "utf8"), /statut: gardée[\s\S]*# Clark sur VPS[\s\S]*## Avis de Clark[\s\S]*Louer un VPS/);

  decideIdea(hub, id, "start");
  await until(() => calls.length === 1);
  assert.equal(store.ideas.get(id)!.status, "started");
  assert.ok(store.ideas.get(id)!.task_id, "la tâche lancée est notée sur l'idée");
  assert.match(calls[0].opts.prompt, /Je lance l'idée #\d+ « Clark sur VPS »[\s\S]*start_code_task/);
  assert.equal((decideIdea(hub, id, "start") as { status: number }).status, 409);

  const other = (store.ideas.add(idea("Autre")) as { id: number }).id;
  decideIdea(hub, other, "drop");
  assert.equal(store.ideas.get(other)!.status, "dropped");
  decideIdea(hub, other, "reopen");
  assert.equal(store.ideas.get(other)!.status, "new");
  decideIdea(hub, other, "delete");
  assert.equal(store.ideas.get(other), undefined);
  assert.equal((decideIdea(hub, 999, "keep") as { status: number }).status, 404);
});

test("idée lancée en vrac : le lien devient la source, et Clark la creuse", async () => {
  const { store, hub, calls } = setup();
  const r = addIdeaFromOwner(hub, "  une appli qui range mes captures   https://github.com/x/y  ");
  assert.ok("id" in r);
  const i = store.ideas.get((r as { id: number }).id)!;
  assert.equal(i.origin, "toi");
  assert.equal(i.title, "une appli qui range mes captures");
  assert.equal(i.source_url, "https://github.com/x/y");
  await until(() => calls.length === 1);
  assert.match(calls[0].opts.prompt, /à creuser/);

  assert.equal((addIdeaFromOwner(hub, "ok") as { status: number }).status, 400);
  assert.match((addIdeaFromOwner(hub, "Une appli qui range mes captures") as { error: string }).error, /déjà/);
  const quiet = addIdeaFromOwner(hub, "Une idée sans recherche", false);
  assert.equal(store.ideas.get((quiet as { id: number }).id)!.status, "new");
});

test("note d'une idée : nom de fichier propre, rien sans coffre", () => {
  const i = { id: 1, title: 'Un "titre" / bizarre : ok', pitch: "P", why: null, status: "kept", verdict: null, report: null, source_url: null } as any;
  assert.match(ideaNote(i), /^---\ntype: idee\nstatut: gardée/);
  const root = mkdtempSync(join(tmpdir(), "clark-vault-"));
  mkdirSync(join(root, "Clark"), { recursive: true });
  assert.equal(writeIdeaNote(i, root), "Clark/Idées/Un titre bizarre ok.md");
  assert.equal(writeIdeaNote(i, null), null);
});
