import { join } from "node:path";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Git pour le côté dev : chaque tâche travaille dans sa propre copie du dépôt (un worktree,
 * sur une branche clark/…). C'est Clark qui fait les opérations git, hors du bac à sable ;
 * l'agent, lui, ne fait que modifier des fichiers dans sa copie.
 */
/**
 * Git sous charge (idées reprises d'Orca, MIT) : plusieurs tâches, la réunion d'un groupe et le
 * suivi des PR touchent le même dépôt. Un verrou momentané (« index.lock … File exists ») est
 * réessayé après 50, 150 puis 400 ms ; et pas plus de 4 commandes git à la fois (2 pour le
 * réseau), pour ménager un Mac de 8 Go.
 */
const LOCK_RETRY_MS = [50, 150, 400];
const isLockContention = (err: unknown) => /\.lock'?:? File exists|Unable to create '[^']+\.lock'|Impossible de créer '[^']+\.lock'|another git process/i.test(String((err as { stderr?: unknown })?.stderr ?? (err instanceof Error ? err.message : err)));

function semaphore(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
const localGit = semaphore(4);
const networkGit = semaphore(2);
const NETWORK = new Set(["fetch", "push", "pull", "clone", "ls-remote"]);

export async function git(cwd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
  const gate = sub && NETWORK.has(sub) ? networkGit : localGit;
  return gate(async () => {
    for (let i = 0; ; i++) {
      try {
        const { stdout } = await run("git", args, { cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env } });
        return stdout;
      } catch (err) {
        if (i >= LOCK_RETRY_MS.length || !isLockContention(err)) throw err;
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS[i]));
      }
    }
  });
}

/** Le dossier est-il la racine d'un dépôt git ? Renvoie la racine, ou null. */
export async function repoRoot(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return (await git(path, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}

/** La branche par défaut : celle du dépôt distant si elle est connue, sinon la branche courante. */
export async function defaultBranch(repo: string): Promise<string> {
  try {
    const ref = (await git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
    if (ref) return ref.replace(/^refs\/remotes\/origin\//, "");
  } catch {}
  return (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * D'où partir (idée reprise d'Orca) : la base à jour du dépôt distant plutôt qu'une branche
 * locale en retard, sans jamais perdre de commits locaux non poussés. Sans réseau ou sans
 * dépôt distant : la branche locale, comme avant.
 */
const lastFetch = new Map<string, number>();
export async function freshBase(repo: string, base: string): Promise<{ ref: string; note: string | null }> {
  try {
    await git(repo, ["remote", "get-url", "origin"]);
  } catch {
    return { ref: base, note: null };
  }
  const key = `${repo}#${base}`;
  // Un fetch récent (moins de 30 s) suffit : plusieurs tâches lancées ensemble n'en font qu'un.
  if (Date.now() - (lastFetch.get(key) ?? 0) > 30_000) {
    try {
      await git(repo, ["fetch", "--quiet", "--no-tags", "origin", base], { timeoutMs: 20_000 });
      lastFetch.set(key, Date.now());
    } catch {
      return { ref: base, note: "dépôt distant injoignable : je pars de la branche locale" };
    }
  }
  const remote = `origin/${base}`;
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}`]);
  } catch {
    return { ref: base, note: null };
  }
  const count = async (range: string) => Number((await git(repo, ["rev-list", "--count", range]).catch(() => "0")).trim()) || 0;
  const ahead = await count(`${remote}..${base}`);
  const behind = await count(`${base}..${remote}`);
  if (ahead > 0) return { ref: base, note: behind ? `ta branche ${base} a ${ahead} commit(s) non poussés et ${behind} de retard sur ${remote} : je pars de ta version locale` : null };
  return { ref: behind ? remote : base, note: behind ? `${base} local avait ${behind} commit(s) de retard : je pars de ${remote}, à jour` : null };
}

/** Crée la copie : une nouvelle branche partie de la branche de base (à jour si possible). Renvoie le commit de départ. */
export async function addWorktree(repo: string, dir: string, branch: string, base: string, startRef = base): Promise<string> {
  // Extraction des fichiers en parallèle (plus rapide sur un gros dépôt), sauf réglage contraire de l'utilisateur.
  await git(repo, ["-c", "checkout.workers=4", "worktree", "add", "-b", branch, dir, startRef]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** Supprime la copie ; la branche aussi si deleteBranch (« Jeter »). */
export async function removeWorktree(repo: string, dir: string, branch: string, deleteBranch: boolean) {
  if (existsSync(dir)) await git(repo, ["worktree", "remove", "--force", dir]);
  else await git(repo, ["worktree", "prune"]);
  if (deleteBranch && (await branchExists(repo, branch))) await git(repo, ["branch", "-D", branch]);
}

export type FileChange = { path: string; status: "ajouté" | "modifié" | "supprimé" | "renommé"; added: number; removed: number; binary: boolean };
export type Diff = { files: FileChange[]; patch: string; added: number; removed: number };

const STATUS: Record<string, FileChange["status"]> = { A: "ajouté", M: "modifié", D: "supprimé", R: "renommé" };

/**
 * Ce que l'agent a changé depuis le commit de départ, fichiers nouveaux compris. On marque
 * les nouveaux fichiers « à suivre » (sans contenu) pour qu'ils apparaissent dans le diff.
 */
export async function worktreeDiff(dir: string, baseCommit: string): Promise<Diff> {
  await git(dir, ["add", "--intent-to-add", "--all"]);
  const numstat = await git(dir, ["diff", "--numstat", "-M", baseCommit]);
  const names = await git(dir, ["diff", "--name-status", "-M", baseCommit]);
  const patch = await git(dir, ["diff", "-M", "--no-color", baseCommit]);
  const status = new Map<string, FileChange["status"]>();
  for (const line of names.split("\n").filter(Boolean)) {
    const [code, ...paths] = line.split("\t");
    status.set(paths.at(-1)!, STATUS[code[0]] ?? "modifié");
  }
  const files: FileChange[] = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, r, ...rest] = line.split("\t");
      const raw = rest.join("\t");
      const path = raw.includes(" => ") ? raw.replace(/\{([^}]*) => ([^}]*)\}/, "$2").replace(/^.* => /, "") : raw;
      const binary = a === "-";
      return { path, status: status.get(path) ?? "modifié", added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary };
    });
  return { files, patch, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}

/** « Accepter » : tout le travail de la copie devient un commit sur sa branche. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ["add", "--all"]);
  const staged = (await git(dir, ["diff", "--cached", "--name-only"])).trim();
  if (!staged) return null;
  // Sans crochets (hooks) : un crochet modifié par l'agent ne doit jamais tourner hors du bac à sable.
  await git(dir, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-verify", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/**
 * Bilan de fin de tour de l'agent de code (idée reprise d'Orca) : sa dernière ligne dit
 * « BILAN : réussi », « BILAN : échoué — raison » ou « BILAN : bloqué — ce qu'il faut ».
 * Sans ligne lisible : on se fie au statut du tour, comme avant.
 */
export function parseDevReport(text: string | null | undefined): { outcome: "succeeded" | "failed" | "blocked" | null; reason: string | null } {
  const m = (text ?? "").match(/BILAN\s*:\s*(réussi|reussi|échoué|echoue|échec|bloqué|bloque)\s*(?:[—–:-]\s*(.+))?\s*$/im);
  if (!m) return { outcome: null, reason: null };
  const word = m[1].toLowerCase();
  const outcome = word.startsWith("r") ? "succeeded" : word.startsWith("b") ? "blocked" : "failed";
  return { outcome, reason: m[2]?.trim() || null };
}

/**
 * Aperçu des conflits sans toucher à aucune copie (idée reprise d'Orca) : git merge-tree
 * calcule la fusion en mémoire. Renvoie les fichiers en conflit ([] : la fusion passerait).
 */
export async function previewConflicts(repo: string, a: string, b: string): Promise<string[]> {
  try {
    await git(repo, ["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", a, b]);
    return [];
  } catch (err) {
    // Code 1 : conflits. Sortie : l'arbre, puis les fichiers en conflit, séparés par des NUL.
    const out = String((err as { stdout?: unknown }).stdout ?? "");
    const parts = out.split("\0").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) throw err;
    return [...new Set(parts.slice(1))];
  }
}

/** La consigne de résolution d'un conflit (règles adaptées de celles d'Orca, MIT). */
export function resolvePrompt(files: string[], ours: string, theirs: string): string {
  return `La copie contient une fusion en cours : « ${theirs} » dans « ${ours} ». Ces fichiers ont des conflits :
${files.map((f) => `- ${f}`).join("\n")}

Résous chaque conflit :
- lis les deux versions (entre <<<<<<<, ======= et >>>>>>>) et le code autour, pour comprendre l'intention de chacune ;
- garde les deux intentions quand c'est possible ; si elles s'excluent, choisis la plus récente et dis-le ;
- retire tous les marqueurs, et vérifie qu'il n'en reste aucun dans le dépôt ;
- ne touche à rien d'autre ; n'utilise pas git (Clark termine la fusion quand Charles accepte).
Dans ton résumé : fichier par fichier, ce que tu as gardé et pourquoi.`;
}

/**
 * L'état actuel d'une copie, figé dans un commit temporaire, sans toucher à son index ni à sa
 * branche (index à part, jeté après) : sert à calculer un aperçu de fusion pendant que la
 * copie peut être acceptée ou retouchée.
 */
export async function snapshotCommit(dir: string): Promise<string> {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "clark-index-"));
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  try {
    await git(dir, ["read-tree", "HEAD"], { env });
    await git(dir, ["add", "-A"], { env });
    const tree = (await git(dir, ["write-tree"], { env })).trim();
    return (await git(dir, ["-c", "user.email=clark@local", "-c", "user.name=Clark", "commit-tree", tree, "-p", "HEAD", "-m", "aperçu"])).trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
