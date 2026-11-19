import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { git } from "./git.ts";

const run = promisify(execFile);

/**
 * Points de reprise d'une tâche dev : après chaque tour de l'agent, l'état de la copie
 * (fichiers suivis et nouveaux, hors ignorés) est gardé dans un commit à part, attaché à une
 * référence refs/clark/dev/<tâche>/tour-<n>. Ni la branche ni l'index de la copie ne bougent.
 * « Revenir à ce tour » remet la copie dans cet état.
 */

const ref = (task: number, round: number) => `refs/clark/dev/${task}/tour-${round}`;

/** Photographie la copie : un arbre construit dans un index temporaire, puis un commit hors branche. */
export async function snapshot(worktree: string, base: string, task: number, round: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "clark-ckpt-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index"), GIT_TERMINAL_PROMPT: "0" };
    const g = async (args: string[]) => (await run("git", args, { cwd: worktree, env, maxBuffer: 20 * 1024 * 1024 })).stdout.trim();
    await g(["read-tree", base]);
    await g(["add", "-A"]);
    const tree = await g(["write-tree"]);
    const sha = await g(["-c", "user.name=Clark", "-c", "user.email=clark@localhost", "commit-tree", tree, "-p", base, "-m", `Tâche dev #${task}, tour ${round}`]);
    await git(worktree, ["update-ref", ref(task, round), sha]);
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Remet la copie dans l'état d'un tour : les fichiers changés ou ajoutés depuis reviennent,
 * ceux créés après sont retirés (sauf les fichiers ignorés par git, comme node_modules).
 */
export async function restore(worktree: string, sha: string) {
  // Les fichiers nouveaux depuis ce tour (pas encore suivis) : retirés seulement s'ils ne sont pas dans l'état visé.
  await git(worktree, ["add", "--intent-to-add", "--all"]);
  await git(worktree, ["read-tree", "-u", "--reset", sha]);
  await git(worktree, ["clean", "-fd", "-q"]);
  // L'index revient à la base de la tâche : le diff est recalculé par rapport à elle, comme avant.
  await git(worktree, ["reset", "-q"]);
}

/** Les références d'une tâche disparaissent avec elle (acceptée ou jetée). */
export async function dropCheckpoints(repo: string, task: number) {
  const refs = (await git(repo, ["for-each-ref", "--format=%(refname)", `refs/clark/dev/${task}/`]).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  for (const r of refs) await git(repo, ["update-ref", "-d", r]).catch(() => {});
}
