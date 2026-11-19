import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parisParts } from "../scheduler/automations.ts";

/**
 * Sauvegarde de la base chaque nuit (VACUUM INTO : une copie cohérente, même pendant que Clark
 * tourne), dans data/backups/clark-AAAA-MM-JJ.db. Les 7 dernières sont gardées.
 */
export const KEEP_BACKUPS = 7;
export const BACKUP_HOUR = 3;

export function backupNow(db: DatabaseSync, dir: string, day: string, keep = KEEP_BACKUPS): string | null {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `clark-${day}.db`);
  if (existsSync(file)) return null;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(dir)
    .filter((f) => /^clark-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .slice(0, -keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
}

export function startBackups(db: DatabaseSync, dir: string, now: () => Date = () => new Date()): () => void {
  const tick = () => {
    const p = parisParts(now());
    if (p.hour !== BACKUP_HOUR || !db.isOpen) return;
    try {
      const file = backupNow(db, dir, p.date);
      if (file) console.log(`[clark] base sauvegardée : ${file}`);
    } catch (err) {
      console.warn("[clark] sauvegarde de la base impossible :", err instanceof Error ? err.message : err);
    }
  };
  const timer = setInterval(tick, 10 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
