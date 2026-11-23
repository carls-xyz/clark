import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tightest } from "../engines/quota.ts";
import type { Hub } from "./hub.ts";
import { platformInfo } from "./platform.ts";
import { redactSecrets } from "./redact.ts";
import { askedText } from "../tasks/journal.ts";

/**
 * Page Santé : sur un écran, ce qu'il faut pour laisser Clark tourner seul. La file des tâches,
 * les moteurs et leurs quotas, les agents silencieux, les échecs récents, les erreurs qui se
 * répètent dans le journal, la dernière sauvegarde, la version qui tourne, la place qui reste.
 * Chaque point qui demande ton attention devient un « problème », avec son niveau.
 */
export type Level = "ok" | "warn" | "bad";
export type Problem = { level: Exclude<Level, "ok">; text: string; href?: string };

export type HealthSources = {
  root: string;
  logFile: string;
  backupDir: string;
  now?: Date;
  /** Lecture git (remplacée dans les tests). */
  git?: (args: string[]) => string | null;
  /** Place libre du disque, en octets (remplacée dans les tests). */
  freeBytes?: (path: string) => number | null;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Seuils : au-delà, un problème. */
export const LIMITS = { queuedMinutes: 15, failures24h: 3, backupHours: 36, repeatedError: 5, quotaPercent: 90, freeGBWarn: 2, freeGBBad: 0.5 } as const;

const parseAt = (at: string) => Date.parse(`${at.replace(" ", "T")}Z`);

function gitRunner(root: string) {
  return (args: string[]) => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    } catch {
      return null;
    }
  };
}

function diskFree(path: string): number | null {
  try {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** La fin du journal (les derniers 400 ko), sans tout relire. */
function logTail(file: string, max = 400_000): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Les erreurs du journal depuis le dernier démarrage, regroupées : une ligne « [clark] … » qui
 * parle d'échec, les chiffres remplacés (même erreur, autre tâche), secrets masqués.
 */
export function repeatedErrors(log: string): { text: string; count: number }[] {
  const start = log.lastIndexOf("[clark] démarré");
  const lines = (start >= 0 ? log.slice(start) : log).split("\n");
  const counts = new Map<string, { text: string; count: number }>();
  for (const line of lines) {
    if (!line.startsWith("[clark]")) continue;
    if (!/erreur|error|impossible|échec|plant|refus|non envoy|non remise|introuvable|expired|timeout/i.test(line)) continue;
    const text = redactSecrets(line.replace(/^\[clark\]\s*/, "").trim()).slice(0, 220);
    const key = text.replace(/\d+/g, "#");
    const e = counts.get(key);
    if (e) e.count++;
    else counts.set(key, { text, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 8);
}

export function healthReport(hub: Hub, src: HealthSources) {
  const now = src.now ?? new Date();
  const git = src.git ?? gitRunner(src.root);
  const { journal, store } = hub.deps;
  const problems: Problem[] = [];

  // File : en attente, en cours, la plus ancienne en attente.
  const open = journal.unfinished().filter((t) => t.parent_id === null);
  const queued = open.filter((t) => t.status === "queued");
  const running = open.filter((t) => t.status === "running");
  const oldestQueued = queued.length ? Math.round((now.getTime() - Math.min(...queued.map((t) => parseAt(t.created_at)))) / MIN) : null;
  if (oldestQueued !== null && oldestQueued >= LIMITS.queuedMinutes) problems.push({ level: "warn", text: `Une tâche attend depuis ${oldestQueued} min sans démarrer.`, href: "#activite" });

  // Agents silencieux.
  const stalled = hub.stalled().length;
  if (stalled) problems.push({ level: "warn", text: `${stalled} agent${stalled > 1 ? "s" : ""} silencieux.`, href: "#activite" });

  // Moteurs : connexion et quota.
  const engines = (["claude", "codex"] as const)
    .map((name) => {
      const conn = hub.connection(name);
      if (!conn) return null;
      const q = hub.quotaOf(name);
      const tight = tightest(q);
      const main = name === hub.deps.config.engine;
      const label = name === "claude" ? "Claude" : "Codex";
      if (conn.ready === false) problems.push({ level: main ? "bad" : "warn", text: `${label} n'est pas connecté${conn.problem ? ` : ${conn.problem}` : ""}.`, href: "#reglages/moteurs" });
      else if (q?.reached) problems.push({ level: main ? "bad" : "warn", text: `Quota ${label} atteint.`, href: "#reglages/moteurs" });
      else if (tight && tight.usedPercent >= LIMITS.quotaPercent) problems.push({ level: "warn", text: `Quota ${label} presque épuisé (${Math.round(tight.usedPercent)} %).`, href: "#reglages/moteurs" });
      return { name, label, main, ready: conn.ready, problem: conn.problem, quotaPercent: tight ? Math.round(tight.usedPercent) : null, quotaLabel: tight?.label ?? null, resetsAt: tight?.resetsAt ?? null };
    })
    .filter((e) => e !== null);

  // Échecs des dernières 24 h (tes demandes et le travail de fond, pas les sous-étapes).
  const since = new Date(now.getTime() - 24 * HOUR).toISOString().slice(0, 19).replace("T", " ");
  const failures = store.db
    .prepare("SELECT id, label, prompt, status, updated_at FROM tasks WHERE parent_id IS NULL AND status IN ('failed', 'needs_check', 'abandoned') AND updated_at >= ? ORDER BY id DESC LIMIT 20")
    .all(since) as { id: number; label: string; prompt: string; status: string; updated_at: string }[];
  if (failures.length >= LIMITS.failures24h) problems.push({ level: "warn", text: `${failures.length} tâches en échec ces dernières 24 h.`, href: "#activite" });

  // Erreurs répétées depuis le démarrage.
  const errors = repeatedErrors(logTail(src.logFile));
  for (const e of errors.filter((x) => x.count >= LIMITS.repeatedError).slice(0, 2)) problems.push({ level: "warn", text: `Erreur répétée ${e.count} fois : ${e.text.slice(0, 120)}` });

  // Sauvegarde de la base.
  let backups: string[] = [];
  try {
    backups = readdirSync(src.backupDir).filter((f) => /^clark-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  } catch {
    backups = [];
  }
  const lastBackup = backups.at(-1) ?? null;
  const backupAt = lastBackup ? statSync(join(src.backupDir, lastBackup)).mtime.getTime() : null;
  const backupHours = backupAt ? Math.round((now.getTime() - backupAt) / HOUR) : null;
  if (backupHours === null) problems.push({ level: "warn", text: "Aucune sauvegarde de la base pour l'instant (elle se fait chaque nuit à 3 h)." });
  else if (backupHours >= LIMITS.backupHours) problems.push({ level: "warn", text: `Dernière sauvegarde il y a ${backupHours} h.` });

  // Version : le commit qui tourne, sa branche, la dernière version qui a démarré (scripts/service.sh).
  const commit = git(["rev-parse", "HEAD"]);
  const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const goodFile = join(src.root, "data", "last-good-commit");
  const lastGood = existsSync(goodFile) ? readFileSync(goodFile, "utf8").trim() || null : null;
  if (commit && !branch) problems.push({ level: "bad", text: `Clark tourne sur une version détachée (${commit.slice(0, 7)}) : sans doute la version de secours après un redémarrage raté.` });

  // Place : la base, le disque, la mémoire de Clark.
  let dbBytes: number | null = null;
  try {
    dbBytes = statSync(join(src.root, "data", "clark.db")).size;
  } catch {
    dbBytes = null;
  }
  const free = (src.freeBytes ?? diskFree)(src.root);
  const freeGB = free === null ? null : Math.round((free / 1e9) * 10) / 10;
  if (freeGB !== null && freeGB < LIMITS.freeGBBad) problems.push({ level: "bad", text: `Disque presque plein : ${freeGB} Go libres.` });
  else if (freeGB !== null && freeGB < LIMITS.freeGBWarn) problems.push({ level: "warn", text: `Peu de place sur le disque : ${freeGB} Go libres.` });

  const level: Level = problems.some((p) => p.level === "bad") ? "bad" : problems.length ? "warn" : "ok";
  return {
    at: now.toISOString(),
    level,
    problems,
    queue: { queued: queued.length, running: running.length, oldestQueuedMinutes: oldestQueued },
    stalled,
    engines,
    failures: failures.map((f) => ({ id: f.id, label: f.label, title: redactSecrets(askedText(f.prompt).replace(/\s+/g, " ")).slice(0, 120), status: f.status, at: f.updated_at })),
    errors,
    backup: { last: lastBackup, hoursAgo: backupHours, count: backups.length },
    version: { commit: commit?.slice(0, 7) ?? null, branch, lastGood: lastGood?.slice(0, 7) ?? null, uptimeMinutes: Math.round(process.uptime() / 60), node: process.version, system: platformInfo().name },
    storage: { dbMB: dbBytes === null ? null : Math.round(dbBytes / 1e5) / 10, freeGB, memoryMB: Math.round(process.memoryUsage().rss / 1e6) },
  };
}

export type HealthReport = ReturnType<typeof healthReport>;

/** Le rapport gardé 20 s : l'état poussé à l'interface (souvent) n'en relit pas le journal à chaque fois. */
export function cachedHealth(hub: Hub, src: HealthSources, ttlMs = 20_000) {
  let last: { at: number; report: HealthReport } | null = null;
  return (fresh = false) => {
    if (!fresh && last && Date.now() - last.at < ttlMs) return last.report;
    last = { at: Date.now(), report: healthReport(hub, src) };
    return last.report;
  };
}
