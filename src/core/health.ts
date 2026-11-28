import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AlertState } from "./alerts.ts";
import { DRILL_MAX_DAYS, drillDay, remoteConfig, type BackupStatus } from "./backup.ts";
import type { PingStatus } from "./ping.ts";
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
/**
 * Un point à regarder. id : stable d'un relevé à l'autre (« moteur:claude », « disque »…), pour les
 * alertes. alert : ce point mérite une alerte (Telegram) ; « urgent » passe même pendant les heures calmes.
 */
export type Problem = { id: string; level: Exclude<Level, "ok">; text: string; href?: string; alert?: "normal" | "urgent" };

export type HealthSources = {
  root: string;
  logFile: string;
  backupDir: string;
  now?: Date;
  /** Lecture git (remplacée dans les tests). */
  git?: (args: string[]) => string | null;
  /** Place libre du disque, en octets (remplacée dans les tests). */
  freeBytes?: (path: string) => number | null;
  /** État des sauvegardes (locale, distante, exercice) et réglage du dépôt (remplacé dans les tests). */
  backup?: () => BackupStatus;
  remoteConfig?: () => ReturnType<typeof remoteConfig>;
  /** Alertes en cours et dernières envoyées ; ping externe ; surveillance locale installée. */
  alerts?: () => AlertState;
  ping?: () => PingStatus;
  watchdog?: () => boolean;
};

/** La surveillance locale est-elle installée (agent launchd, ou minuteur systemd) ? */
export function watchdogInstalled(home = homedir()): boolean {
  return existsSync(join(home, "Library/LaunchAgents/local.clark.watchdog.plist")) || existsSync(join(home, ".config/systemd/user/clark-watchdog.timer"));
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Seuils : au-delà, un problème. */
export const LIMITS = { queuedMinutes: 15, failures24h: 3, failureStreak: 3, backupHours: 36, repeatedError: 5, alertError: 20, quotaPercent: 90, freeGBWarn: 2, freeGBBad: 0.5 } as const;

const parseAt = (at: string) => Date.parse(`${at.replace(" ", "T")}Z`);

/** Un arrêt voulu par l'utilisateur (bouton « Arrêter ») n'est pas un échec à compter ni à signaler. */
export const userStopped = (result: string | null | undefined) => /Arrêté à ta demande|arrêté par Charles/.test(result ?? "");

type Finished = { id: number; engine: string; status: string; result: string | null; updated_at: string };

/**
 * Échecs en série : par moteur, les dernières tâches terminées qui ont toutes échoué de la même façon, sans
 * réussite depuis. C'est le signe d'une panne (et non d'un raté isolé) : un moteur « connecté » dont chaque
 * conversation échoue à l'ouverture ne se voit ni dans son état ni dans son quota. Les arrêts voulus sont ignorés.
 */
export function failureStreaks(rows: Finished[], sinceMs: number): { engine: string; count: number; cause: string }[] {
  // Les nombres changent d'un échec à l'autre (durées, identifiants) : la cause se compare sans eux.
  const key = (r: string | null) => (r ?? "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 160);
  const out: { engine: string; count: number; cause: string }[] = [];
  for (const engine of new Set(rows.map((r) => r.engine))) {
    const mine = rows.filter((r) => r.engine === engine && !userStopped(r.result)).sort((a, b) => b.id - a.id);
    const first = mine[0];
    if (!first || first.status !== "failed" || parseAt(first.updated_at) < sinceMs) continue;
    let count = 0;
    for (const r of mine) {
      if (r.status !== "failed" || key(r.result) !== key(first.result)) break;
      count++;
    }
    if (count >= LIMITS.failureStreak) out.push({ engine, count, cause: redactSecrets((first.result ?? "").replace(/\s+/g, " ").trim()).slice(0, 140) });
  }
  return out;
}

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
export function logTail(file: string, max = 400_000): string {
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
/**
 * La signature d'une erreur : ce qui ne change pas d'une occurrence à l'autre. Chiffres, identifiants
 * (hexadécimaux, UUID), chemins, adresses et textes cités sont remplacés, la casse et les espaces
 * ramenés ; puis un condensé court. Deux « tâche 12 interrompue » et « tâche 13 interrompue » : même signature.
 */
export function errorSignature(line: string): string {
  const key = line
    .toLowerCase()
    .replace(/https?:\/\/[^\s"'«»)]+/g, "<url>")
    .replace(/(?:\/[\w.@~+-]+){2,}/g, "<chemin>")
    .replace(/[«"'][^«»"']{0,200}[»"']/g, "<texte>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return createHash("sha1").update(key).digest("hex").slice(0, 10);
}

/**
 * Toutes les signatures d'erreur depuis le dernier démarrage, triées par fréquence, SANS troncature.
 * `repeatedErrors` n'en garde que les 8 premières pour la page Santé ; l'auto-amélioration a besoin
 * du relevé complet pour suivre une base de comparaison stable même quand une signature quitte le top 8.
 */
export function countErrors(log: string): { text: string; count: number; signature: string }[] {
  const start = log.lastIndexOf("[clark] démarré");
  const lines = (start >= 0 ? log.slice(start) : log).split("\n");
  const counts = new Map<string, { text: string; count: number; signature: string }>();
  for (const line of lines) {
    if (!line.startsWith("[clark]")) continue;
    if (!/erreur|error|impossible|échec|plant|refus|non envoy|non remise|introuvable|expired|timeout/i.test(line)) continue;
    const text = redactSecrets(line.replace(/^\[clark\]\s*/, "").trim()).slice(0, 220);
    const signature = errorSignature(text);
    const e = counts.get(signature);
    if (e) e.count++;
    else counts.set(signature, { text, count: 1, signature });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function repeatedErrors(log: string): { text: string; count: number; signature: string }[] {
  return countErrors(log).slice(0, 8);
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
  if (oldestQueued !== null && oldestQueued >= LIMITS.queuedMinutes) problems.push({ id: "file", level: "warn", text: `Une tâche attend depuis ${oldestQueued} min sans démarrer.`, href: "#activite" });

  // Agents silencieux.
  const stalled = hub.stalled().length;
  if (stalled) problems.push({ id: "silencieux", level: "warn", text: `${stalled} agent${stalled > 1 ? "s" : ""} silencieux.`, href: "#activite" });

  // Moteurs : connexion et quota.
  const engines = (["claude", "codex"] as const)
    .map((name) => {
      const conn = hub.connection(name);
      if (!conn) return null;
      const q = hub.quotaOf(name);
      const tight = tightest(q);
      const main = name === hub.deps.config.engine;
      const label = name === "claude" ? "Claude" : "Codex";
      if (conn.ready === false) problems.push({ id: `moteur:${name}`, level: main ? "bad" : "warn", text: `${label} n'est pas connecté${conn.problem ? ` : ${conn.problem}` : ""}.`, href: "#reglages/moteurs", ...(main ? { alert: "urgent" as const } : {}) });
      else if (q?.reached) problems.push({ id: `quota:${name}`, level: main ? "bad" : "warn", text: `Quota ${label} atteint.`, href: "#reglages/moteurs", ...(main ? { alert: "normal" as const } : {}) });
      else if (tight && tight.usedPercent >= LIMITS.quotaPercent) problems.push({ id: `quota-haut:${name}`, level: "warn", text: `Quota ${label} presque épuisé (${Math.round(tight.usedPercent)} %).`, href: "#reglages/moteurs" });
      return { name, label, main, ready: conn.ready, problem: conn.problem, quotaPercent: tight ? Math.round(tight.usedPercent) : null, quotaLabel: tight?.label ?? null, resetsAt: tight?.resetsAt ?? null };
    })
    .filter((e) => e !== null);

  // Échecs des dernières 24 h (tes demandes et le travail de fond, pas les sous-étapes).
  const since = new Date(now.getTime() - 24 * HOUR).toISOString().slice(0, 19).replace("T", " ");
  const failures = (
    store.db
      .prepare("SELECT id, label, prompt, status, result, updated_at FROM tasks WHERE parent_id IS NULL AND status IN ('failed', 'needs_check', 'abandoned') AND updated_at >= ? ORDER BY id DESC LIMIT 40")
      .all(since) as { id: number; label: string; prompt: string; status: string; result: string | null; updated_at: string }[]
  )
    .filter((f) => !userStopped(f.result))
    .slice(0, 20);
  if (failures.length >= LIMITS.failures24h) problems.push({ id: "echecs", level: "warn", text: `${failures.length} tâches en échec ces dernières 24 h.`, href: "#activite" });

  // Échecs en série d'un moteur : une panne, pas un raté isolé. Celle-là part en alerte.
  const finished = store.db
    .prepare("SELECT id, engine, status, result, updated_at FROM tasks WHERE parent_id IS NULL AND engine IS NOT NULL AND status IN ('done', 'failed', 'needs_check', 'abandoned') ORDER BY id DESC LIMIT 60")
    .all() as Finished[];
  for (const s of failureStreaks(finished, now.getTime() - 24 * HOUR)) {
    const label = s.engine === "claude" ? "Claude" : s.engine === "codex" ? "Codex" : s.engine;
    problems.push({ id: `echecs-suite:${s.engine}`, level: "warn", text: `${label} : les ${s.count} dernières tâches ont échoué de la même façon — ${s.cause}`, href: "#sante", alert: "normal" });
  }

  // Erreurs répétées depuis le démarrage.
  const errors = repeatedErrors(logTail(src.logFile));
  for (const e of errors.filter((x) => x.count >= LIMITS.repeatedError).slice(0, 2))
    problems.push({ id: `erreurs:${e.signature}`, level: "warn", text: `Erreur répétée ${e.count} fois : ${e.text.slice(0, 120)}`, ...(e.count >= LIMITS.alertError ? { alert: "normal" as const } : {}) });

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
  if (backupHours === null) problems.push({ id: "sauvegarde", level: "warn", text: "Aucune sauvegarde de la base pour l'instant (elle se fait chaque nuit à 3 h)." });
  else if (backupHours >= LIMITS.backupHours) problems.push({ id: "sauvegarde", level: "warn", text: `Dernière sauvegarde il y a ${backupHours} h.` });
  const bs = src.backup?.() ?? { local: null, remote: null, drill: null };
  if (bs.local && !bs.local.ok && Date.parse(bs.local.at) > (backupAt ?? 0)) problems.push({ id: "sauvegarde", level: "warn", text: `Dernière sauvegarde locale en échec : ${bs.local.detail ?? "raison inconnue"}.` });
  // Hors machine : seulement si CLARK_BACKUP_REPO est réglé.
  const remoteCfg = (src.remoteConfig ?? remoteConfig)();
  const hoursSince = (at: string) => Math.round((now.getTime() - Date.parse(at)) / HOUR);
  if (remoteCfg && "error" in remoteCfg) problems.push({ id: "sauvegarde-distante", alert: "normal", level: "warn", text: `Sauvegarde distante mal réglée : ${remoteCfg.error}.` });
  else if (remoteCfg && bs.remote && !bs.remote.ok) problems.push({ id: "sauvegarde-distante", alert: "normal", level: "warn", text: `Sauvegarde distante en échec : ${bs.remote.detail ?? "raison inconnue"}.` });
  else if (remoteCfg && bs.remote?.ok && hoursSince(bs.remote.at) >= LIMITS.backupHours) problems.push({ id: "sauvegarde-distante", alert: "normal", level: "warn", text: `Dernière sauvegarde distante il y a ${hoursSince(bs.remote.at)} h.` });
  // Exercice de restauration : en échec, ou pas réussi depuis 8 jours.
  if (drillDay() !== null && bs.drill) {
    if (!bs.drill.ok) problems.push({ id: "exercice-sauvegarde", alert: "normal", level: "warn", text: `Exercice de restauration en échec (sauvegarde ${bs.drill.source}) : ${bs.drill.detail ?? "raison inconnue"}.` });
    else if (hoursSince(bs.drill.at) >= DRILL_MAX_DAYS * 24) problems.push({ id: "exercice-sauvegarde", alert: "normal", level: "warn", text: `Pas d'exercice de restauration réussi depuis ${Math.round(hoursSince(bs.drill.at) / 24)} jours.` });
  }

  // Version : le commit qui tourne, sa branche, la dernière version qui a démarré (scripts/service.sh).
  const commit = git(["rev-parse", "HEAD"]);
  const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const goodFile = join(src.root, "data", "last-good-commit");
  const lastGood = existsSync(goodFile) ? readFileSync(goodFile, "utf8").trim() || null : null;
  if (commit && !branch) problems.push({ id: "secours", alert: "urgent", level: "bad", text: `Clark tourne sur une version détachée (${commit.slice(0, 7)}) : sans doute la version de secours après un redémarrage raté.` });

  // Place : la base, le disque, la mémoire de Clark.
  let dbBytes: number | null = null;
  try {
    dbBytes = statSync(join(src.root, "data", "clark.db")).size;
  } catch {
    dbBytes = null;
  }
  const free = (src.freeBytes ?? diskFree)(src.root);
  const freeGB = free === null ? null : Math.round((free / 1e9) * 10) / 10;
  if (freeGB !== null && freeGB < LIMITS.freeGBBad) problems.push({ id: "disque", alert: "urgent", level: "bad", text: `Disque presque plein : ${freeGB} Go libres.` });
  else if (freeGB !== null && freeGB < LIMITS.freeGBWarn) problems.push({ id: "disque", alert: "normal", level: "warn", text: `Peu de place sur le disque : ${freeGB} Go libres.` });

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
    backup: {
      last: lastBackup,
      hoursAgo: backupHours,
      count: backups.length,
      remote: { configured: Boolean(remoteCfg && !("error" in remoteCfg)), at: bs.remote?.at ?? null, ok: bs.remote?.ok ?? null, detail: bs.remote?.detail ?? (remoteCfg && "error" in remoteCfg ? remoteCfg.error : null), snapshots: bs.remote?.snapshots ?? null },
      drill: drillDay() === null ? null : (bs.drill ?? { at: null, ok: null, detail: null, source: null }),
    },
    version: { commit: commit?.slice(0, 7) ?? null, branch, lastGood: lastGood?.slice(0, 7) ?? null, uptimeMinutes: Math.round(process.uptime() / 60), node: process.version, system: platformInfo().name },
    alerts: src.alerts ? { active: Object.values(src.alerts().active), history: [...src.alerts().history].reverse() } : { active: [], history: [] },
    ping: src.ping?.() ?? { configured: false, lastOk: null, failing: false, lastError: null },
    watchdog: (src.watchdog ?? watchdogInstalled)(),
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
