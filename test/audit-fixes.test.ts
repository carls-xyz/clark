import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { applyImport, exportConfig } from "../src/core/config-export.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub } from "../src/core/hub.ts";
import { onStop } from "../src/core/stops.ts";
import { once } from "../src/dev/in-flight.ts";
import { addProject, cancelWaitingTurn, isWaitingSlot, sendReviewComments, startDev, startDevTask } from "../src/dev/runner.ts";
import { devChat } from "../src/dev/store.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";
import { waitFor } from "./_wait.ts";

const root = mkdtempSync(join(tmpdir(), "clark-audit-"));
process.env.CLARK_DEV_DIR = join(root, "worktrees");
process.env.CLARK_COMMANDS_DIR = join(root, "commands");
process.env.CLARK_PERSONALITY_FILE = join(root, "personnalite.md");
process.env.CLARK_PLUGINS_DIR = join(root, "plugins");
after(() => rmSync(root, { recursive: true, force: true }));

const config: Config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "départ\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "x");
  return dir;
}

function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: { engine: string; prompt: string; mode: string; cwd?: string }[] = [];
  const fake = (engine: string) =>
    (async (deps: any, taskId: number, opts: RunOptions) => {
      runs.push({ engine, prompt: opts.prompt, mode: opts.mode, cwd: opts.cwd });
      if (opts.cwd) writeFileSync(join(opts.cwd, "a.txt"), `${engine} ${runs.length}\n`);
      // « lent » : l'agent garde sa place jusqu'à ce qu'on l'arrête.
      if (opts.prompt.includes("lent")) {
        deps.journal.setStatus(taskId, "running");
        await new Promise<void>((r) => onStop(taskId, r));
        deps.journal.finish(taskId, "failed", "Arrêté par Charles.", 0);
        return { text: "Arrêté.", costUsd: 0, status: "failed" };
      }
      deps.journal.finish(taskId, "done", `Fait (${engine}).`, 0);
      return { text: "Fait.", costUsd: 0, status: "done" };
    }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute: fake("claude"), executors: { claude: fake("claude"), codex: fake("codex") } });
  return { store, journal, hub, runs };
}

test("reprise après redémarrage : sur le moteur de la tâche (pas le principal), dans sa copie", async () => {
  const dir = repo("reprise");
  const { store, journal, hub, runs } = setup();
  const p = (await addProject(hub, { name: "reprise", path: dir })) as any;
  const t = startDevTask(hub, { projectId: p.id, instruction: "Change a.txt proprement", engine: "codex" }) as any;
  await waitFor(() => store.dev.get(t.id)!.status === "review");
  assert.equal(journal.lastByLabel(`dev:${t.id}`)!.engine, "codex", "le moteur est noté dès le départ");

  // Clark coupé pendant un tour Codex qui ne faisait que lire.
  const id = journal.create(devChat(t.id), `dev:${t.id}`, "Retouche demandée par Charles pour la tâche dev");
  journal.setStatus(id, "running");
  journal.setEngine(id, "codex");
  journal.setSession(id, "thread-codex");
  journal.announceStep({ taskId: id, toolUseId: "r", tool: "Read", input: {}, tier: "workspace" });
  runs.length = 0;
  await hub.recover();
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].engine, "codex");
  assert.equal(runs[0].mode, "recovery");
  assert.equal(runs[0].cwd, store.dev.get(t.id)!.worktree);
});

test("tour en attente d'une place, coupé par un redémarrage : relancé, pas annoncé prêt avec l'ancien résultat", async () => {
  const dir = repo("attente");
  const { store, hub, runs } = setup();
  const p = (await addProject(hub, { name: "attente", path: dir })) as any;
  const t = startDevTask(hub, { projectId: p.id, instruction: "Change a.txt proprement" }) as any;
  await waitFor(() => store.dev.get(t.id)!.status === "review");
  assert.equal(store.dev.get(t.id)!.pending_turn, null, "noté puis effacé dès que le tour démarre");

  // État laissé par une retouche qui attendait une place quand Clark s'est arrêté.
  store.dev.update(t.id, { status: "working", pending_turn: JSON.stringify({ prompt: "Retouche demandée par Charles : plus foncé", images: ["/nulle/part.jpg"] }) });
  runs.length = 0;
  startDev(hub);
  await waitFor(() => store.dev.get(t.id)!.status === "review" && runs.length === 1);
  assert.match(runs[0].prompt, /plus foncé/);
  assert.equal(store.dev.get(t.id)!.rounds, 2);
  assert.equal(store.dev.get(t.id)!.pending_turn, null);
});

test("sauvegarde : une automatisation dev revient en automatisation dev, sur le projet du même nom", async () => {
  const dir = repo("auto");
  const a = setup();
  const pa = (await addProject(a.hub, { name: "auto", path: dir })) as any;
  a.store.automations.create({ name: "Tests du soir", prompt: "Lance les tests et corrige", frequency: "daily", time: "19:00", kind: "dev", projectId: pa.id, engine: "codex", effort: "high", precheck: "test -f a.txt" });
  const data = exportConfig({ hub: a.hub, settings: null, notify: null });

  const b = setup();
  const done = await applyImport({ hub: b.hub, settings: null, notify: null }, data);
  assert.equal(done.automations, 1, done.skipped.join(" "));
  const [auto] = b.store.automations.list();
  assert.equal(auto.kind, "dev");
  assert.equal(auto.project_id, b.store.dev.projects()[0].id);
  assert.deepEqual([auto.engine, auto.effort, auto.precheck], ["codex", "high", "test -f a.txt"]);

  // Projet absent sur la nouvelle machine : l'automatisation est sautée et dite, pas changée en message.
  const c = setup();
  const lost = await applyImport({ hub: c.hub, settings: null, notify: null }, { ...data, projects: [] });
  assert.equal(c.store.automations.list().length, 0);
  assert.match(lost.skipped.join(" "), /Tests du soir : projet auto absent/);
});

test("numéro de tâche redonné après le retrait d'un projet : rien de l'ancienne tâche ne reste", async () => {
  const dir = repo("ids");
  const { store, hub } = setup();
  const p = (await addProject(hub, { name: "ids", path: dir })) as any;
  const t = startDevTask(hub, { projectId: p.id, instruction: "Change a.txt proprement" }) as any;
  await waitFor(() => store.dev.get(t.id)!.status === "review");
  store.setSession(devChat(t.id), "ancienne-session");
  store.dev.update(t.id, { status: "discarded" });
  assert.equal(store.dev.removeProject(p.id), "done");

  const p2 = (await addProject(hub, { name: "ids", path: dir })) as any;
  const id = store.dev.create({ projectId: p2.id, title: "Nouvelle", instruction: "Autre chose à faire", engine: null, branch: "b2", worktree: join(root, "w2") });
  assert.equal(id, t.id, "SQLite redonne le numéro");
  assert.equal(store.getSession(devChat(id)), null, "pas la session de l'ancienne tâche");
  assert.equal(store.dev.checkpoints(id).length, 0);
  assert.ok(!hub.deps.conversation.recent(devChat(id)).length, "pas son fil");
});

test("arrêter une tâche qui attend un agent libre : elle sort de la file, rien ne part", async () => {
  const before = process.env.CLARK_DEV_PARALLEL;
  process.env.CLARK_DEV_PARALLEL = "1";
  try {
    const dir = repo("file");
    const { store, journal, hub, runs } = setup();
    const p = (await addProject(hub, { name: "file", path: dir })) as any;
    const done = startDevTask(hub, { projectId: p.id, instruction: "Change a.txt proprement" }) as any;
    await waitFor(() => store.dev.get(done.id)!.status === "review");
    const comment = store.dev.addComment({ taskId: done.id, file: "a.txt", side: "new", start: 1, end: 1, snippet: "x", body: "plus court" });

    // Un agent lent prend la seule place ; une retouche et une nouvelle tâche attendent.
    const busy = startDevTask(hub, { projectId: p.id, instruction: "Tâche lent : relis la page et attends" }) as any;
    await waitFor(() => journal.lastByLabel(`dev:${busy.id}`)?.status === "running");
    assert.equal(sendReviewComments(hub, done.id), "done");
    assert.equal(store.dev.comments(done.id)[0].sent_round, 2);
    const fresh = startDevTask(hub, { projectId: p.id, instruction: "Ajoute une ligne à a.txt" }) as any;
    await waitFor(() => isWaitingSlot(done.id) && isWaitingSlot(fresh.id));
    const count = runs.length;

    assert.equal(cancelWaitingTurn(hub, done.id), true);
    await waitFor(() => store.dev.get(done.id)!.status === "review");
    assert.match(store.dev.get(done.id)!.error!, /version précédente est intacte/);
    assert.equal(store.dev.get(done.id)!.rounds, 1);
    assert.equal(store.dev.comments(done.id).find((c) => c.id === comment)!.sent_round, null, "le commentaire redevient à envoyer");
    assert.equal(cancelWaitingTurn(hub, fresh.id), true);
    await waitFor(() => store.dev.get(fresh.id)!.status === "failed");
    assert.equal(cancelWaitingTurn(hub, fresh.id), false, "plus dans la file");

    const run = journal.lastByLabel(`dev:${busy.id}`)!;
    assert.equal(hub.stopTask(run.id), "stopped");
    await waitFor(() => store.dev.get(busy.id)!.status === "failed");
    assert.equal(runs.length, count, "aucun des deux tours annulés n'a lancé d'agent");
  } finally {
    if (before === undefined) delete process.env.CLARK_DEV_PARALLEL;
    else process.env.CLARK_DEV_PARALLEL = before;
  }
});

test("double clic : une action longue ne tourne qu'une fois à la fois pour une même cible", async () => {
  let calls = 0;
  let finish!: () => void;
  const slow = () => {
    calls++;
    return new Promise<string>((r) => (finish = () => r("done")));
  };
  const first = once("pr:task:1", "already", slow);
  assert.equal(await once("pr:task:1", "already", slow), "already");
  assert.equal(await once("pr:task:2", "already", async () => "autre"), "autre", "une autre cible passe");
  finish();
  assert.equal(await first, "done");
  assert.equal(calls, 1);
  assert.equal(await once("pr:task:1", "already", async () => "encore"), "encore", "libre une fois finie");
});
