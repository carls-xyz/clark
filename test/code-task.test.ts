import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";
import { createPolicy } from "../src/policy/permissions.ts";
import { claudeSandbox, sharedReadPaths } from "../src/engines/sandbox.ts";

test("tâche de code : le shell passe sans bouton (bac à sable) ; ailleurs, il demande toujours", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const taskId = journal.create(1, "dev:1", "x");
  let asked = 0;
  const approve = async () => ((asked++), false);
  const ctx = { toolUseID: "t1", signal: new AbortController().signal } as any;
  const code = createPolicy({ store, journal, taskId, roots: [tmpdir()], approve, autoBash: true });
  assert.equal(((await code("Bash", { command: "npm test" }, ctx)) as any).behavior, "allow");
  assert.equal(asked, 0);
  const chat = createPolicy({ store, journal, taskId, roots: [tmpdir()], approve });
  assert.equal(((await chat("Bash", { command: "npm test" }, { ...ctx, toolUseID: "t2" })) as any).behavior, "deny");
  assert.equal(asked, 1, "hors tâche de code : le bouton de Charles");
  // En lecture seule, même une tâche de code ne lance rien.
  const ro = createPolicy({ store, journal, taskId, roots: [tmpdir()], approve, autoBash: true, access: "read" });
  assert.equal(((await ro("Bash", { command: "rm -rf x" }, { ...ctx, toolUseID: "t3" })) as any).behavior, "deny");
});

test("tâche de code : seules les dépendances reliées deviennent lisibles, pas le reste du dépôt d'origine", () => {
  const root = mkdtempSync(join(tmpdir(), "clark-code-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "node_modules", "lib"), { recursive: true });
  writeFileSync(join(repo, ".env"), "SECRET=1");
  const copy = join(root, "copie");
  mkdirSync(copy);
  symlinkSync(join(repo, "node_modules"), join(copy, "node_modules"));
  mkdirSync(join(copy, "venv")); // un vrai dossier, pas un lien : rien à ouvrir
  const paths = sharedReadPaths(copy);
  assert.deepEqual(paths, [realpathSync(join(repo, "node_modules"))]);
  const sb = claudeSandbox(paths);
  assert.ok(sb?.filesystem?.allowRead?.includes(realpathSync(join(repo, "node_modules"))));
  assert.ok(!sb?.filesystem?.allowRead?.includes(realpathSync(repo)), "le dépôt (et son .env) reste fermé");
  assert.ok(!sb?.filesystem?.allowWrite?.includes(realpathSync(join(repo, "node_modules"))), "jamais en écriture");
});

test("copie de travail : node_modules partagé même quand le .gitignore écrit « node_modules/ » (avec la barre)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { linkSharedDirs } = await import("../src/dev/project-setup.ts");
  const root = mkdtempSync(join(tmpdir(), "clark-lien-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "node_modules", "lib"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@e", "-c", "user.name=T", "add", ".");
  git("-c", "user.email=t@e", "-c", "user.name=T", "commit", "-qm", "départ");
  const copy = join(root, "copie");
  git("worktree", "add", "-q", "--detach", copy, "main");
  const linked = await linkSharedDirs({ path: repo } as any, copy);
  assert.deepEqual(linked, ["node_modules"]);
  assert.deepEqual(sharedReadPaths(copy), [realpathSync(join(repo, "node_modules"))]);
  // Le lien est un fichier pour git : il ne doit pas apparaître dans le diff (ni partir dans un commit).
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: copy, encoding: "utf8" });
  assert.doesNotMatch(status, /node_modules/);
});

test("bac à sable : pas de réseau, mais un serveur de test peut écouter en local", () => {
  const sb = claudeSandbox();
  assert.deepEqual(sb?.network?.allowedDomains, []);
  assert.equal(sb?.network?.allowLocalBinding, true);
});
