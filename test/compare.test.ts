import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { onStop } from "../src/core/stops.ts";
import { compareDevTask, keepComparedTask, startDevCompare } from "../src/dev/compare.ts";
import { addProject, startDevTask } from "../src/dev/runner.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const root = mkdtempSync(join(tmpdir(), "clark-compare-"));
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
  writeFileSync(join(dir, "c.txt"), "départ\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "x");
  return dir;
}

const config: Config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null };

const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "condition jamais atteinte");
};

/** Claude touche a.txt ; Codex touche a.txt et c.txt. slowCodex : Codex tourne jusqu'à ce qu'on l'arrête. */
function setup(slowCodex = false) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: { engine: string; effort?: string | null }[] = [];
  const fake = (engine: string) =>
    (async (deps: any, taskId: number, opts: RunOptions) => {
      runs.push({ engine, effort: opts.effort });
      if (opts.cwd) {
        writeFileSync(join(opts.cwd, "a.txt"), `${engine}\n`);
        if (engine === "codex") writeFileSync(join(opts.cwd, "c.txt"), "codex\n");
      }
      if (engine === "codex" && slowCodex) {
        deps.journal.setStatus(taskId, "running");
        await new Promise<void>((r) => onStop(taskId, r));
        deps.journal.finish(taskId, "failed", "Arrêté par Charles.", 0);
        return { text: "Arrêté.", costUsd: 0, status: "failed" };
      }
      deps.journal.finish(taskId, "done", `Fait (${engine}).`, 0);
      return { text: "Fait.", costUsd: 0, status: "done" };
    }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute: fake("claude"), executors: { claude: fake("claude"), codex: fake("codex") } });
  return { store, hub, runs, conversation };
}

const notes = (c: Conversation) => c.recent(OWNER_CHAT).filter((m) => m.role !== "user").map((m) => m.text);

test("comparer : deux copies, deux moteurs, une seule note quand les deux ont fini ; garder l'une jette l'autre", async () => {
  const dir = repo("cmp");
  const { store, hub, runs, conversation } = setup();
  const p = (await addProject(hub, { name: "cmp", path: dir })) as any;

  assert.deepEqual(startDevCompare(hub, { projectId: p.id, instruction: "Change a.txt proprement", sides: [{ engine: "claude" }, { engine: "claude" }] }), { ok: false, error: "Choisis deux agents différents (moteur, modèle ou effort)." });

  const r = startDevCompare(hub, { projectId: p.id, instruction: "Change a.txt proprement", sides: [{ engine: "claude" }, { engine: "codex", effort: "high" }] }) as any;
  assert.ok(r.ok);
  const [a, b] = r.ids;
  assert.equal(store.dev.get(a)!.compare_with, b);
  assert.equal(store.dev.get(b)!.compare_with, a);
  await until(() => store.dev.get(a)!.status === "review" && store.dev.get(b)!.status === "review");
  assert.deepEqual(runs.map((x) => x.engine).sort(), ["claude", "codex"]);
  assert.equal(runs.find((x) => x.engine === "codex")!.effort, "high");
  assert.notEqual(store.dev.get(a)!.worktree, store.dev.get(b)!.worktree, "chacun sa copie");
  const files = (id: number) => JSON.parse(store.dev.get(id)!.diff_stat!).files.map((f: { path: string }) => f.path);
  assert.deepEqual([files(a), files(b)], [["a.txt"], ["a.txt", "c.txt"]]);

  const ready = notes(conversation).filter((t) => /^Comparaison prête/.test(t));
  assert.equal(ready.length, 1, "une seule note pour les deux");
  assert.match(ready[0], new RegExp(`#${a} \\(Claude\\) prête, #${b} \\(Codex, effort high\\) prête`));
  assert.ok(!notes(conversation).some((t) => /^Tâche dev #\d+ prête/.test(t)), "pas de note par version");

  assert.deepEqual(await keepComparedTask(hub, 999), "missing");
  assert.equal(await keepComparedTask(hub, b), "done");
  assert.equal(store.dev.get(b)!.status, "accepted");
  assert.ok(store.dev.get(b)!.commit);
  await until(() => store.dev.get(a)!.status === "discarded" && !existsSync(store.dev.get(a)!.worktree));
  await until(() => notes(conversation).some((t) => t === `Comparaison tranchée : #${b} (Codex, effort high) gardée, #${a} (Claude) jetée.`));
});

test("comparer depuis une tâche : même consigne, autre agent ; garder pendant que l'autre travaille l'arrête puis la jette", async () => {
  const dir = repo("cmp2");
  const { store, hub } = setup(true);
  const p = (await addProject(hub, { name: "cmp2", path: dir })) as any;
  const t = startDevTask(hub, { projectId: p.id, instruction: "Change a.txt proprement", engine: "claude" }) as any;
  await until(() => store.dev.get(t.id)!.status === "review");

  assert.deepEqual(compareDevTask(hub, t.id, { engine: "claude" }), { ok: false, error: "Choisis un autre agent que celui de cette tâche." });
  const other = compareDevTask(hub, t.id, { engine: "codex" }) as any;
  assert.ok(other.ok);
  assert.equal(store.dev.get(other.id)!.instruction, "Change a.txt proprement");
  assert.equal(store.dev.get(t.id)!.compare_with, other.id);
  assert.deepEqual(compareDevTask(hub, t.id, { engine: "codex" }), { ok: false, error: "Cette tâche est déjà comparée à une autre." });
  await until(() => store.dev.get(other.id)!.status === "working" && hub.deps.journal.lastByLabel(`dev:${other.id}`)?.status === "running");

  assert.deepEqual(await keepComparedTask(hub, other.id), { error: "Cette version n'est pas prête : attends la fin de son tour." });
  assert.equal(await keepComparedTask(hub, t.id), "done");
  await until(() => store.dev.get(other.id)!.status === "discarded");
  assert.equal(store.dev.get(t.id)!.status, "accepted");
});
