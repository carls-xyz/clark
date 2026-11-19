import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "../core/hub.ts";
import { git } from "./git.ts";
import { SHARED_DIRS } from "./project-setup.ts";
import { worktreesDir } from "./runner.ts";

/**
 * Nettoyage des copies oubliées (idée reprise d'Orca, MIT) : une copie qui n'appartient plus à
 * aucune tâche ouverte (réunion ratée, coupure en pleine création, ancien aperçu…) occupe du
 * disque pour rien. Elle est retirée, sauf si elle contient des fichiers ignorés par git qu'on
 * ne saurait pas refaire (hors dépendances partagées) : alors on la garde et on le dit.
 */
const MIN_AGE_MS = 60 * 60_000;

export async function atRiskFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], { timeoutMs: 8_000 }).catch(() => "");
  return out
    .split("\n")
    .map((l) => l.trim().replace(/\/$/, ""))
    .filter((l) => l && !SHARED_DIRS.includes(l) && !l.startsWith(".DS_Store"))
    .slice(0, 20);
}

export async function sweepWorktrees(hub: Hub, now = Date.now()): Promise<{ removed: string[]; kept: { dir: string; files: string[] }[] }> {
  const { store } = hub.deps;
  const root = worktreesDir();
  const removed: string[] = [];
  const kept: { dir: string; files: string[] }[] = [];
  if (!existsSync(root)) return { removed, kept };
  const inUse = new Set<string>([
    ...store.dev.open().map((t) => t.worktree),
    ...store.dev.groups(200).map((g) => g.plan_worktree).filter((x): x is string => Boolean(x)),
  ]);
  const projects = store.dev.projects();
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (inUse.has(dir)) continue;
    // Copies préparées d'avance : les nôtres vivent 5 minutes ; une restée après une coupure part.
    if (name.startsWith(".") && !name.startsWith(".prewarm-")) continue;
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || now - statSync(dir).mtimeMs < MIN_AGE_MS) continue;
    const risky = await atRiskFiles(dir);
    if (risky.length) {
      kept.push({ dir, files: risky });
      continue;
    }
    // La copie appartient à l'un des projets : git la retire proprement (sa branche reste).
    const owner = projects.find((p) => existsSync(p.path));
    let done = false;
    for (const p of projects) {
      try {
        await git(p.path, ["worktree", "remove", "--force", dir]);
        done = true;
        break;
      } catch {}
    }
    if (done || !owner) removed.push(dir);
  }
  for (const p of projects) if (existsSync(p.path)) await git(p.path, ["worktree", "prune"]).catch(() => {});
  return { removed, kept };
}

/** Au démarrage puis toutes les 6 heures. */
export function startWorktreeSweep(hub: Hub): () => void {
  const run = () =>
    void sweepWorktrees(hub)
      .then((r) => {
        if (r.removed.length) console.log(`[clark] copies oubliées retirées : ${r.removed.length}`);
        for (const k of r.kept) console.warn(`[clark] copie gardée (fichiers à ne pas perdre : ${k.files.slice(0, 3).join(", ")}) : ${k.dir}`);
      })
      .catch((err) => console.warn("[clark] nettoyage des copies impossible :", err instanceof Error ? err.message : err));
  const first = setTimeout(run, 60_000);
  first.unref();
  const timer = setInterval(run, 6 * 3600_000);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
