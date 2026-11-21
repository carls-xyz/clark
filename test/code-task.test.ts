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
  assert.equal((await code("Bash", { command: "npm test" }, ctx)).behavior, "allow");
  assert.equal(asked, 0);
  const chat = createPolicy({ store, journal, taskId, roots: [tmpdir()], approve });
  assert.equal((await chat("Bash", { command: "npm test" }, { ...ctx, toolUseID: "t2" })).behavior, "deny");
  assert.equal(asked, 1, "hors tâche de code : le bouton de Charles");
  // En lecture seule, même une tâche de code ne lance rien.
  const ro = createPolicy({ store, journal, taskId, roots: [tmpdir()], approve, autoBash: true, access: "read" });
  assert.equal((await ro("Bash", { command: "rm -rf x" }, { ...ctx, toolUseID: "t3" })).behavior, "deny");
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
