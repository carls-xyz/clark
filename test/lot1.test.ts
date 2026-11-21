import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { announcesNextStep, parseVerdict } from "../src/core/finish-check.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { onSteer } from "../src/core/steer.ts";
import { submitRequest } from "../src/core/submit.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null } as Config;
const wait = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("fin de tâche : une réponse qui annonce la suite sans la faire est repérée", () => {
  assert.ok(announcesNextStep("J'ai lu les trois notes. Veux-tu que je continue avec les relances ?"));
  assert.ok(announcesNextStep("Les fichiers sont prêts. Je vais maintenant rédiger le mail."));
  assert.ok(announcesNextStep("Done with step 1. Shall I proceed?"));
  assert.ok(!announcesNextStep("Voici les trois relances, prêtes à envoyer."));
  assert.ok(!announcesNextStep("Tu préfères le ton formel ou direct ?"), "une vraie question à Charles n'est pas une suite");
});

test("fin de tâche : verdict du juge lu prudemment (dans le doute, fini)", () => {
  assert.deepEqual(parseVerdict('```json\n{"verdict":"continue","missing":["écrire le mail 3"]}\n```'), { verdict: "continue", missing: ["écrire le mail 3"] });
  assert.deepEqual(parseVerdict('{"verdict":"continue","missing":[]}'), { verdict: "done", missing: [] });
  assert.deepEqual(parseVerdict("je ne sais pas"), { verdict: "done", missing: [] });
  assert.equal(parseVerdict('{"verdict":"user"}').verdict, "user");
});

function setup(judge?: (p: string) => Promise<string>) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const prompts: string[] = [];
  const execute = (async (_d, taskId, opts) => {
    prompts.push(opts.prompt);
    journal.announceStep({ taskId, toolUseId: `s${taskId}`, tool: "Read", input: { file_path: "/w/a.md" }, tier: "read" as never });
    journal.completeStep(`s${taskId}`, "ok", false);
    const text = prompts.length === 1 ? "J'ai fait les deux premiers mails." : "Les trois mails sont prêts.";
    journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" as const };
  }) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute }, ...(judge ? { judge } : {}) });
  return { store, journal, conversation, hub, prompts };
}

test("fin de tâche : le juge voit qu'il manque une partie → Clark continue une fois, puis s'arrête", async () => {
  let calls = 0;
  const { hub, prompts, conversation } = setup(async () => (++calls === 1 ? '{"verdict":"continue","missing":["le troisième mail"]}' : '{"verdict":"done","missing":[]}'));
  submitRequest(hub, "Écris trois mails de relance", { source: "web" });
  await wait(() => prompts.length === 2 && calls === 2);
  assert.match(prompts[1], /^\[Suite automatique\][\s\S]*le troisième mail/);
  const texts = conversation.recent(OWNER_CHAT).map((m) => m.text);
  assert.ok(texts.includes("Je continue : il manque « le troisième mail »."));
  assert.equal(texts.at(-1), "Les trois mails sont prêts.");
});

test("message pendant le travail : glissé dans le tour en cours, pas mis en file", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const steered: string[] = [];
  let release!: () => void;
  const execute = (async (_d, taskId) => {
    journal.setStatus(taskId, "running");
    const off = onSteer(taskId, async (t) => (steered.push(t), true));
    await new Promise<void>((r) => (release = r));
    off();
    journal.finish(taskId, "done", "fini", 0);
    return { text: "fini", costUsd: 0, status: "done" as const };
  }) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute } });
  submitRequest(hub, "Range mes notes", { source: "web" });
  await wait(() => typeof release === "function" && journal.unfinished().some((t) => t.status === "running"));
  submitRequest(hub, "et aussi celles de lundi", { source: "web" });
  await wait(() => steered.length === 1);
  assert.match(steered[0], /^\[Message de Charles pendant que tu travailles\]\net aussi celles de lundi/);
  await wait(() => conversation.recent(OWNER_CHAT).some((m) => m.text === "et aussi celles de lundi"));
  assert.equal(journal.unfinished().length, 1, "aucune nouvelle tâche créée");
  release();
});

test("moteur de secours : coupé par défaut ; activé, quota Claude atteint → la demande part sur Codex, avec une note", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const used: string[] = [];
  const fake = (name: string) =>
    (async (_d, taskId) => {
      used.push(name);
      journal.finish(taskId, "done", `réponse ${name}`, 0);
      return { text: `réponse ${name}`, costUsd: 0, status: "done" as const };
    }) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute: fake("claude"), executors: { claude: fake("claude"), codex: fake("codex") } });
  hub.setConnection("codex", { ready: true, account: "ChatGPT", problem: null });
  hub.markLimitReached("claude", Date.now() + 3600_000);
  // Coupé (par défaut) : Codex ne prend pas le relais, la demande reste sur Claude.
  submitRequest(hub, "Bonjour", { source: "web" });
  await wait(() => used.length === 1);
  assert.deepEqual(used, ["claude"]);
  process.env.CLARK_BACKUP_ENGINE = "on";
  try {
    submitRequest(hub, "Re-bonjour", { source: "web" });
    await wait(() => used.length === 2);
    assert.deepEqual(used, ["claude", "codex"]);
    assert.ok(conversation.recent(OWNER_CHAT).some((m) => m.text === "Quota Claude atteint : je passe sur Codex jusqu'à la remise à zéro."));
  } finally {
    delete process.env.CLARK_BACKUP_ENGINE;
  }
});

test("tour planifié sans rien de neuf : rangé dans le fil sans notification", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const execute = (async (_d, taskId) => {
    store.db.prepare("UPDATE tasks SET outcome = 'quiet' WHERE id = ?").run(taskId);
    journal.finish(taskId, "done", "Rien à signaler.", 0);
    return { text: "Rien à signaler.", costUsd: 0, status: "done" as const };
  }) as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute, executors: { claude: execute } });
  const delivered: string[] = [];
  hub.addChannel({ name: "telegram", deliver: async (m: { text: string }) => void delivered.push(m.text) } as never);
  await hub.enqueue(OWNER_CHAT, "Vérifie mes relances", "chat", "automation:relances");
  const last = conversation.recent(OWNER_CHAT).at(-1)!;
  assert.equal(last.text, "Rien à signaler.");
  assert.equal(last.kind, "quiet");
  assert.equal(last.role, "system", "pas compté comme réponse non lue");
  assert.ok(!delivered.includes("Rien à signaler."));
});

test("bilan de l'agent de code : réussi / échoué / bloqué lu sur la dernière ligne", async () => {
  const { parseDevReport } = await import("../src/dev/git.ts");
  assert.deepEqual(parseDevReport("J'ai changé a.ts.\nBILAN : réussi"), { outcome: "succeeded", reason: null });
  assert.deepEqual(parseDevReport("Les tests cassent.\nBILAN : échoué — le module X n'existe pas"), { outcome: "failed", reason: "le module X n'existe pas" });
  assert.deepEqual(parseDevReport("BILAN : bloqué - il me faut la clé API"), { outcome: "blocked", reason: "il me faut la clé API" });
  assert.deepEqual(parseDevReport("Fini, sans bilan."), { outcome: null, reason: null });
});

test("base à jour : part du dépôt distant si la branche locale est en retard, garde les commits non poussés", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { freshBase } = await import("../src/dev/git.ts");
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString();
  const root = mkdtempSync(join(tmpdir(), "clark-base-"));
  const origin = join(root, "origin.git");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  const a = join(root, "a");
  g(root, "clone", "-q", origin, a);
  writeFileSync(join(a, "f"), "1");
  g(a, "add", "f");
  g(a, "commit", "-qm", "un");
  g(a, "push", "-q", "origin", "HEAD:main");
  const b = join(root, "b");
  g(root, "clone", "-q", origin, b);
  // Quelqu'un pousse un commit : b est en retard.
  writeFileSync(join(a, "f"), "2");
  g(a, "commit", "-qam", "deux");
  g(a, "push", "-q", "origin", "HEAD:main");
  const behind = await freshBase(b, "main");
  assert.equal(behind.ref, "origin/main");
  assert.match(behind.note ?? "", /1 commit\(s\) de retard/);
  // Un commit local non poussé : on ne le perd pas.
  writeFileSync(join(b, "g"), "x");
  g(b, "add", "g");
  g(b, "commit", "-qm", "local");
  const ahead = await freshBase(b, "main");
  assert.equal(ahead.ref, "main");
});
