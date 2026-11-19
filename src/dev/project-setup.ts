import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { git } from "./git.ts";
import type { Project } from "./store.ts";
import { killTree } from "../core/kill-tree.ts";

const run = promisify(execFile);

/**
 * Réglages par projet : ce qui prépare chaque nouvelle copie avant l'agent.
 * - Fichiers à copier : seulement des fichiers ignorés par git (le reste est déjà dans la copie),
 *   jamais un secret (.env, clés, identifiants) : la copie est lue par l'agent et peut finir dans un diff.
 * - Commande de préparation (ex. npm ci) : lancée hors du bac à sable, comme les tests, car elle a souvent
 *   besoin du réseau. C'est toi qui l'écris dans les réglages du projet.
 */

const SECRET = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials.*|secrets?(\..*)?|.*\.secret)$/i;

export function checkCopyPath(raw: string): string | null {
  const p = raw.trim().replace(/\/+$/, "");
  if (!p) return "Chemin vide.";
  if (isAbsolute(p) || normalize(p).split(sep).includes("..") || p.startsWith("~")) return `« ${p} » : un chemin relatif au dépôt, sans « .. ».`;
  if (p.split("/").some((part) => SECRET.test(part))) return `« ${p} » ressemble à un secret (.env, clé, identifiants) : il ne sera jamais copié dans la copie de l'agent.`;
  if (p === ".git" || p.startsWith(".git/")) return "Pas le dossier .git.";
  return null;
}

/** Vérifie la liste à l'enregistrement : chemins valides, existants, et ignorés par git. */
export async function validateCopyPaths(project: Project, list: string[]): Promise<string | null> {
  if (list.length > 20) return "20 chemins au plus.";
  for (const raw of list) {
    const bad = checkCopyPath(raw);
    if (bad) return bad;
    const p = raw.trim().replace(/\/+$/, "");
    if (!existsSync(join(project.path, p))) return `« ${p} » n'existe pas dans le dépôt.`;
    const ignored = await git(project.path, ["check-ignore", "-q", p]).then(() => true, () => false);
    if (!ignored) return `« ${p} » est suivi par git : il est déjà dans chaque copie.`;
  }
  return null;
}

/** Copie les fichiers choisis (clone APFS quand c'est possible : instantané, sans place en plus). */
async function copyPaths(project: Project, worktree: string): Promise<string[]> {
  const list: string[] = project.copy_paths ? JSON.parse(project.copy_paths) : [];
  const done: string[] = [];
  for (const p of list) {
    if (checkCopyPath(p)) continue;
    const from = join(project.path, p);
    const to = join(worktree, p);
    if (!existsSync(from) || lstatSync(from).isSymbolicLink() || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    await run("/bin/cp", ["-cR", from, to]).catch(() => run("/bin/cp", ["-R", from, to]));
    done.push(basename(p) === p ? p : p);
  }
  return done;
}

export type SetupLog = {
  copied: string[];
  command: string | null;
  ok: boolean;
  code: number | null;
  output: string;
  /** Fichiers non ignorés que la préparation a créés ou changés : ils apparaîtraient dans le diff. */
  dirty: string[];
  at: number;
};

/** Prépare une copie neuve : fichiers, puis commande du projet (10 minutes au plus). */
/**
 * Copies légères (idée reprise d'Orca) : les gros dossiers de dépendances déjà présents dans le
 * dépôt (et ignorés par git) sont partagés par un lien au lieu d'être réinstallés dans chaque
 * copie. Deux installations en parallèle, c'est beaucoup de disque et de mémoire sur 8 Go.
 */
export const SHARED_DIRS = ["node_modules", ".venv", "venv", "vendor/bundle"];
export async function linkSharedDirs(project: Project, worktree: string): Promise<string[]> {
  const linked: string[] = [];
  for (const dir of SHARED_DIRS) {
    const from = join(project.path, dir);
    const to = join(worktree, dir);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      await git(worktree, ["check-ignore", "-q", dir]);
    } catch {
      continue; // pas ignoré : le lien apparaîtrait dans le diff
    }
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to);
    linked.push(dir);
  }
  return linked;
}

/** Commande de préparation qui ne fait qu'installer les dépendances : inutile si elles sont partagées. */
const INSTALL_ONLY = /^\s*(npm (ci|install|i)|pnpm (install|i)|yarn( install)?|bun (install|i)|pip install -r requirements\.txt|bundle install)(\s+--?[\w=-]+)*\s*$/;

export async function prepareCopy(project: Project, worktree: string, timeoutMs = 10 * 60_000): Promise<SetupLog | null> {
  const copied = await copyPaths(project, worktree);
  const shared = await linkSharedDirs(project, worktree).catch(() => [] as string[]);
  const wanted = project.setup_command?.trim() || null;
  const command = wanted && shared.length && INSTALL_ONLY.test(wanted) ? null : wanted;
  const all = [...copied, ...shared.map((d) => `${d} (partagé)`)];
  if (!command && !all.length) return null;
  if (!command) return { copied: all, command: null, ok: true, code: 0, output: wanted ? `« ${wanted} » sauté : dépendances partagées avec le dépôt (${shared.join(", ")}).` : "", dirty: [], at: Date.now() };
  const r = await new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn("/bin/zsh", ["-lc", command], { cwd: worktree, env: { ...process.env, CI: "1" }, detached: true });
    let out = "";
    const keep = (d: Buffer) => (out = (out + d.toString()).slice(-6000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      killTree(child);
      done({ code: null, output: `${out}\n(arrêtée : plus de ${Math.round(timeoutMs / 60_000)} minutes)` });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output: out });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: null, output: err.message });
    });
  });
  const status = await git(worktree, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "");
  const dirty = status
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .slice(0, 20);
  return { copied: all, command, ok: r.code === 0, code: r.code, output: r.output, dirty, at: Date.now() };
}
