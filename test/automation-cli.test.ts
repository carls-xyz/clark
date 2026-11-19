import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { acceptDevTask, addProject, restoreDevRound, retouchDevTask, startDevTask } from "../src/dev/runner.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { launchAutomation } from "../src/scheduler/automation-run.ts";
import { automationChat } from "../src/scheduler/automations.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "clark-autocli-"));
process.env.CLARK_DEV_DIR = join(root, "worktrees");
after(() => rmSync(root, { recursive: true, force: true }));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(name: string) {
  const dir = join(root, name);
  execFileSync("mkdir", ["-p", dir]);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "départ\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "x");
  return dir;
}

const config = (port = 0): Config => ({
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: port,
  model: "m",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
});

const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "condition jamais atteinte");
};

/** Faux agent : premier tour, a.txt change ; tours suivants, b.txt apparaît et a.txt rechange. */
function setup(port = 0, approve = false) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: { prompt: string; engine: string; model?: string | null; effort?: string | null; chat: number }[] = [];
  const fake = (engine: string) =>
    (async (deps: any, taskId: number, opts: RunOptions) => {
      const t = deps.journal.get(taskId);
      runs.push({ prompt: opts.prompt, engine, model: opts.model, effort: opts.effort, chat: t.chat_id });
      if (approve) await opts.approve({ tool: "Bash", summary: "Commande shell :\necho x" });
      if (opts.cwd) {
        if (/Retouche/.test(opts.prompt)) {
          writeFileSync(join(opts.cwd, "a.txt"), "tour 2\n");
          writeFileSync(join(opts.cwd, "b.txt"), "nouveau\n");
        } else writeFileSync(join(opts.cwd, "a.txt"), "tour 1\n");
      }
      deps.journal.finish(taskId, "done", `Fait (${engine}).`, 0);
      return { text: "Fait.", costUsd: 0, status: "done" };
    }) as unknown as typeof executeTask;
  const hub = createHub({ config: config(port), store, journal, conversation }, { execute: fake("principal"), executors: { claude: fake("claude"), codex: fake("codex") } });
  return { store, journal, conversation, hub, runs };
}

test("automatisation : pré-vérification ratée → sautée ; tâche dev avec moteur, modèle et effort ; fil à part annoncé dans ta conversation", async () => {
  const dir = repo("auto");
  const { store, hub, runs, conversation } = setup();
  const p = (await addProject(hub, { name: "auto", path: dir })) as any;

  const devId = store.automations.create({ name: "Contraste", prompt: "Mets a.txt à jour pour le contraste", frequency: "daily", time: "09:00", kind: "dev", projectId: p.id, engine: "codex", model: "gpt-x", effort: "high", precheck: "test -f absent.txt", enabled: false });
  assert.equal(store.automations.get(devId)!.enabled, 0, "créée en pause");
  await launchAutomation(hub, store.automations.get(devId)!, { manual: true });
  assert.deepEqual(
    store.automations.runs(devId).map((r) => [r.status, r.manual]),
    [["skipped", 1]],
  );
  assert.match(store.automations.runs(devId)[0].note!, /Pré-vérification : code 1/);
  assert.equal(store.dev.list().length, 0, "sautée : rien de lancé");

  store.db.prepare("UPDATE automations SET precheck = 'test -f a.txt' WHERE id = ?").run(devId);
  await launchAutomation(hub, store.automations.get(devId)!, { slot: "2026-11-19T09:00" });
  const [run] = store.automations.runs(devId, 1);
  assert.equal(run.status, "started");
  assert.ok(run.dev_task_id);
  await until(() => store.dev.get(run.dev_task_id!)!.status === "review");
  assert.deepEqual([runs.at(-1)!.engine, runs.at(-1)!.model, runs.at(-1)!.effort], ["codex", "gpt-x", "high"]);
  assert.match(store.dev.get(run.dev_task_id!)!.title, /Contraste \(automatisation\)/);

  const ownId = store.automations.create({ name: "Point du soir", prompt: "Fais le point", frequency: "daily", time: "18:00", thread: "own" });
  await launchAutomation(hub, store.automations.get(ownId)!, { manual: true });
  await until(() => conversation.recent(OWNER_CHAT).some((m) => m.role === "clark" && /^Automatisation « Point du soir » : Fait \(principal\)/.test(m.text)));
  assert.equal(runs.at(-1)!.chat, automationChat(ownId), "dans son propre fil");
  assert.ok(!conversation.recent(OWNER_CHAT).some((m) => m.role === "user" && m.text === "Fais le point"), "la consigne n'encombre pas ta conversation");
});

test("automatisation dans son fil : ses demandes d'accord arrivent dans « À toi », avec son nom", async () => {
  const { store, hub } = setup(0, true);
  const id = store.automations.create({ name: "Ménage", prompt: "Range le dossier", frequency: "daily", time: "09:00", thread: "own" });
  await launchAutomation(hub, store.automations.get(id)!, { manual: true });
  await until(() => hub.approvals().length === 1);
  assert.equal(hub.approvals()[0].agent, "Automatisation « Ménage »");
  hub.resolveApproval(hub.approvals()[0].id, false);
});

test("points de reprise : un par tour ; revenir au tour 1 retire ce qui vient après, l'agent en est prévenu, accepter nettoie", async () => {
  const dir = repo("ckpt");
  const { store, hub, runs } = setup();
  const p = (await addProject(hub, { name: "ckpt", path: dir })) as any;
  const t = startDevTask(hub, { projectId: p.id, instruction: "Change a.txt pour le tour 1" }) as any;
  await until(() => store.dev.get(t.id)!.status === "review");
  assert.equal(retouchDevTask(hub, t.id, "Ajoute b.txt"), "done");
  await until(() => store.dev.get(t.id)!.status === "review" && store.dev.get(t.id)!.rounds === 2);
  const wt = store.dev.get(t.id)!.worktree;
  assert.deepEqual(
    store.dev.checkpoints(t.id).map((c) => c.round),
    [1, 2],
  );
  assert.ok(existsSync(join(wt, "b.txt")));

  assert.equal(await restoreDevRound(hub, t.id, 1), "done");
  assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "tour 1\n");
  assert.ok(!existsSync(join(wt, "b.txt")), "le fichier créé au tour 2 est retiré");
  const back = store.dev.get(t.id)!;
  assert.equal(back.at_round, 1);
  assert.deepEqual(JSON.parse(back.diff_stat!).files.map((f: { path: string }) => f.path), ["a.txt"]);
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), back.branch, "la branche ne bouge pas");

  // En avant : le tour 2 est toujours là.
  assert.equal(await restoreDevRound(hub, t.id, 2), "done");
  assert.ok(existsSync(join(wt, "b.txt")));
  assert.equal(store.dev.get(t.id)!.at_round, null);
  assert.equal(await restoreDevRound(hub, t.id, 1), "done");

  // La retouche suivante part du tour 1, et l'agent le sait.
  assert.equal(retouchDevTask(hub, t.id, "Ajoute b.txt autrement"), "done");
  await until(() => store.dev.get(t.id)!.rounds === 3 && store.dev.get(t.id)!.status === "review");
  assert.match(runs.at(-1)!.prompt, /^Charles est revenu à l'état de ton tour 1 : les changements de ton tour 2 sont annulés/);
  assert.equal(store.dev.get(t.id)!.agent_note, null, "dit une seule fois");

  assert.deepEqual(await restoreDevRound(hub, t.id, 9), { error: "Pas de point de reprise pour le tour 9." });
  assert.equal(await acceptDevTask(hub, t.id), "done");
  assert.equal(sh(dir, "for-each-ref", `refs/clark/dev/${t.id}/`), "", "les références disparaissent");
  assert.equal(store.dev.checkpoints(t.id).length, 0);
});

test("commande clark : message avec réponse, état, dev ; elle ne peut ni valider un accord ni répondre à ta place", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = repo("cli");
  const s = setup(port);
  const web = await startWeb(s.hub, { port });
  const bin = resolve(import.meta.dirname, "../bin/clark.mjs");
  const clark = (...a: string[]) => run(process.execPath, [bin, ...a], { env: { ...process.env, CLARK_WEB_PORT: String(port) }, timeout: 30_000 }).then(
    (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
    (e) => ({ code: e.code as number, out: String(e.stdout), err: String(e.stderr) }),
  );
  try {
    const reply = await clark("Bonjour", "Clark", "--attendre", "--json");
    assert.equal(reply.code, 0, reply.err);
    assert.equal(JSON.parse(reply.out).reply, "Fait.");
    const mine = s.conversation.recent(OWNER_CHAT).find((m) => m.role === "user")!;
    assert.deepEqual([mine.text, mine.source], ["Bonjour Clark", "cli"]);

    assert.deepEqual(JSON.parse((await clark("etat", "--json")).out), { engine: "claude", problem: null, running: 0, waiting: 0 });
    await addProject(s.hub, { name: "cli", path: dir });
    const dev = await clark("dev", "cli", "Change a.txt", "--moteur", "codex", "--attendre", "--json");
    assert.equal(JSON.parse(dev.out).status, "review", dev.err);
    assert.match((await clark("dev", "inconnu", "x")).err, /projet inconnu : inconnu \(projets : cli\)/);

    // Un accord en attente : « clark oui » n'est qu'un message ; l'accord reste à donner sur un bouton.
    const pending = s.hub.approvals().length;
    void s.hub.enqueue(OWNER_CHAT, "Tâche qui demande un accord", "chat", "web");
    const help = await clark("aide");
    assert.match(help.out, /Les accords et les réponses aux questions ne se donnent pas ici/);
    assert.ok(!/accord|approve|valider/i.test(help.out.split("\n").filter((l) => /^\s+clark /.test(l)).join("\n")), "aucune commande d'accord");
    assert.equal(s.hub.approvals().length, pending);
  } finally {
    await web.close();
  }
});
