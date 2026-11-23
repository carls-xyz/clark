import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parisParts } from "../scheduler/automations.ts";

/**
 * Sauvegardes.
 *
 * - Locale : chaque nuit à 3 h, une copie cohérente de la base (VACUUM INTO, même pendant que Clark tourne),
 *   vérifiée (PRAGMA integrity_check), dans data/backups/clark-AAAA-MM-JJ.db. Les 7 dernières sont gardées.
 * - Hors machine (facultative, CLARK_BACKUP_REPO) : chaque nuit à 3 h 30, une « copie préparée » (la base
 *   vérifiée, la mémoire cœur, la personnalité, la connexion Google, le dossier de travail sans les copies des
 *   tâches dev, et un manifeste) part dans un dépôt restic, chiffré. Rien n'est lu directement dans le dossier
 *   de Clark : .env et les connexions des moteurs ne peuvent pas s'y glisser.
 * - Exercice de restauration, chaque semaine : la dernière sauvegarde (distante, sinon locale) est restaurée
 *   dans un dossier temporaire et vérifiée. Le résultat est sur la page Santé ; un échec y fait une alerte.
 */
export const KEEP_BACKUPS = 7;
export const BACKUP_HOUR = 3;
export const REMOTE_MINUTE = 30;
export const DRILL_HOUR = 4;
/** Sans exercice réussi depuis tant de jours : un point sur la page Santé. */
export const DRILL_MAX_DAYS = 8;
/** Rétention restic : 7 quotidiennes, 4 hebdomadaires, 6 mensuelles ; données supprimées le dimanche seulement. */
export const RETENTION = ["--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6"];

/** Jamais dans une sauvegarde, même placés dans un dossier copié. */
const SECRET = /^\.env|^auth\.json$|\.pem$|\.key$|^id_(rsa|ed25519|ecdsa)|^credentials|^\.netrc$|restic-password/i;

/** Les tables qu'un exercice de restauration relit. */
const CORE_TABLES = ["memories", "messages", "tasks"];

/** Vérifie une base : intégrité, et (si demandé) que les tables principales se lisent. Renvoie l'erreur, ou null. */
export function checkDatabase(file: string, tables: string[] = []): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const r = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
    if (r?.integrity_check !== "ok") return `intégrité : ${r?.integrity_check ?? "illisible"}`;
    for (const t of tables) db.prepare(`SELECT count(*) AS n FROM ${t}`).get();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0] : String(err);
  } finally {
    db?.close();
  }
}

/** Copie à chaud, puis vérifiée ; une copie abîmée est supprimée et l'erreur levée. */
function vacuumInto(db: DatabaseSync, file: string, check: (file: string) => string | null = checkDatabase) {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const bad = check(file);
  if (bad) {
    rmSync(file, { force: true });
    throw new Error(`copie de la base abîmée (${bad})`);
  }
}

export function backupNow(db: DatabaseSync, dir: string, day: string, keep = KEEP_BACKUPS, check?: (file: string) => string | null): string | null {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `clark-${day}.db`);
  if (existsSync(file)) return null;
  vacuumInto(db, file, check);
  const old = readdirSync(dir)
    .filter((f) => /^clark-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .slice(0, -keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
}

// ── La copie préparée ─────────────────────────────────────────────────

export type Manifest = { version: 1; at: string; host: string; commit: string | null; files: { path: string; size: number; sha256: string }[] };

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(relative(base, p));
  }
  return out.sort();
}

/**
 * Prépare dans `out` (vidé d'abord) ce qui part en sauvegarde : la base vérifiée, memory/, personnalite.md,
 * data/google/ (sauf google: false), workspace/ sans dev/, et manifest.json. Aucun secret (voir SECRET).
 */
export function prepareBundle(opts: { root: string; db: DatabaseSync; out: string; google?: boolean; commit?: string | null; now?: Date }): Manifest {
  const { root, out } = opts;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "data"), { recursive: true });
  vacuumInto(opts.db, join(out, "data", "clark.db"));
  const keep = (src: string) => !SECRET.test(basename(src));
  const copy = (from: string, to: string, filter: (src: string) => boolean = keep) => {
    if (existsSync(from)) cpSync(from, to, { recursive: true, filter, dereference: false });
  };
  copy(join(root, "memory"), join(out, "memory"));
  copy(join(root, "personnalite.md"), join(out, "personnalite.md"));
  if (opts.google !== false) copy(join(root, "data", "google"), join(out, "data", "google"));
  const dev = join(root, "workspace", "dev");
  copy(join(root, "workspace"), join(out, "workspace"), (src) => keep(src) && src !== dev && !src.startsWith(`${dev}/`));
  const files = listFiles(out).map((p) => ({ path: p, size: statSync(join(out, p)).size, sha256: sha256(join(out, p)) }));
  const manifest: Manifest = { version: 1, at: (opts.now ?? new Date()).toISOString(), host: hostname(), commit: opts.commit ?? null, files };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Vérifie une copie restaurée : manifeste, chaque fichier (taille, empreinte), et la base. Renvoie l'erreur, ou null. */
export function verifyBundle(dir: string): string | null {
  const mf = join(dir, "manifest.json");
  if (!existsSync(mf)) return "manifeste absent";
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
  } catch {
    return "manifeste illisible";
  }
  for (const f of m.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) return `fichier manquant : ${f.path}`;
    if (statSync(p).size !== f.size || sha256(p) !== f.sha256) return `fichier différent : ${f.path}`;
  }
  const db = join(dir, "data", "clark.db");
  if (!existsSync(db)) return "base absente";
  const bad = checkDatabase(db, CORE_TABLES);
  return bad ? `base : ${bad}` : null;
}

/** Dans une restauration restic, la copie est rangée sous son chemin d'origine : on retrouve le dossier du manifeste. */
export function findBundle(dir: string): string | null {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = findBundle(join(dir, e.name));
    if (found) return found;
  }
  return null;
}

// ── L'état des sauvegardes (page Santé, alertes) ──────────────────────

export type Result = { at: string; ok: boolean; detail: string | null };
export type BackupStatus = { local: Result | null; remote: (Result & { snapshots: number | null }) | null; drill: (Result & { source: "distante" | "locale" }) | null };

export class BackupStatusStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  }
  get(): BackupStatus {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'backup_status'").get() as { value: string } | undefined;
    try {
      return { local: null, remote: null, drill: null, ...(row ? (JSON.parse(row.value) as Partial<BackupStatus>) : {}) };
    } catch {
      return { local: null, remote: null, drill: null };
    }
  }
  set(patch: Partial<BackupStatus>) {
    const next = { ...this.get(), ...patch };
    this.db.prepare("INSERT INTO app_settings (key, value) VALUES ('backup_status', ?) ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(JSON.stringify(next));
  }
}

// ── restic ────────────────────────────────────────────────────────────

export type ResticRun = (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

/** Le vrai restic. La sortie d'erreur remonte dans le message (sans secret : rien n'est passé en argument). */
export const realRestic: ResticRun = (args, env) =>
  new Promise((resolve, reject) => {
    execFile("restic", args, { env, timeout: 60 * 60_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((String(stderr).trim().split("\n").at(-1) || err.message).slice(0, 300)));
      else resolve(String(stdout));
    });
  });

/** Variables passées à restic : le dépôt, le fichier du mot de passe, les identifiants du stockage. Pas le reste de .env. */
const PASS_THROUGH = /^(B2_|AWS_|AZURE_|GOOGLE_PROJECT_ID$|GOOGLE_APPLICATION_CREDENTIALS$|OS_|ST_|RCLONE_|HOME$|PATH$|TMPDIR$|USER$|LANG$)/;

export type RemoteConfig = { repo: string; passwordFile: string };

export function remoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig | { error: string } | null {
  const repo = env.CLARK_BACKUP_REPO?.trim();
  if (!repo) return null;
  const passwordFile = env.CLARK_BACKUP_PASSWORD_FILE?.trim();
  if (!passwordFile) return { error: "CLARK_BACKUP_PASSWORD_FILE manque (le fichier du mot de passe du dépôt)" };
  if (!existsSync(passwordFile)) return { error: `fichier du mot de passe introuvable : ${passwordFile}` };
  return { repo, passwordFile };
}

export function resticEnv(cfg: RemoteConfig, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { RESTIC_REPOSITORY: cfg.repo, RESTIC_PASSWORD_FILE: cfg.passwordFile };
  for (const [k, v] of Object.entries(env)) if (PASS_THROUGH.test(k) && v !== undefined) out[k] = v;
  return out;
}

export const BUNDLE_DIR = (root: string) => join(root, "data", "backups", "lot");

/**
 * Sauvegarde distante : copie préparée (dans un dossier fixe : restic regroupe par chemin), envoi, rétention ;
 * les données en trop ne sont supprimées que le dimanche (prune, le plus coûteux). Renvoie le nombre de sauvegardes.
 */
export async function remoteBackup(opts: { root: string; db: DatabaseSync; cfg: RemoteConfig; run?: ResticRun; env?: NodeJS.ProcessEnv; commit?: string | null; now?: Date }): Promise<number | null> {
  const run = opts.run ?? realRestic;
  const env = resticEnv(opts.cfg, opts.env);
  const out = BUNDLE_DIR(opts.root);
  const now = opts.now ?? new Date();
  try {
    prepareBundle({ root: opts.root, db: opts.db, out, google: (opts.env ?? process.env).CLARK_BACKUP_GOOGLE?.trim().toLowerCase() !== "off", commit: opts.commit, now });
    await run(["backup", out, "--tag", "clark", "--host", hostname(), "--quiet"], env);
    const sunday = parisParts(now).weekday === 7;
    await run(["forget", "--tag", "clark", "--group-by", "host,tags", ...RETENTION, ...(sunday ? ["--prune"] : []), "--quiet"], env);
    const list = JSON.parse(await run(["snapshots", "--tag", "clark", "--json"], env)) as unknown[];
    return Array.isArray(list) ? list.length : null;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Restaure une sauvegarde restic (« latest » ou un identifiant) dans `target`, et rend le dossier de la copie. */
export async function remoteFetch(opts: { cfg: RemoteConfig; snapshot: string; target: string; run?: ResticRun; env?: NodeJS.ProcessEnv }): Promise<string> {
  const run = opts.run ?? realRestic;
  const env = resticEnv(opts.cfg, opts.env);
  const id = opts.snapshot === "latest" ? "latest" : opts.snapshot.replace(/[^\w]/g, "");
  await run(["restore", id, "--tag", "clark", "--target", opts.target], env);
  const dir = findBundle(opts.target);
  if (!dir) throw new Error("restauration sans manifeste (ce n'est pas une sauvegarde de Clark ?)");
  return dir;
}

/**
 * Exercice de restauration. Avec un dépôt : restic check, puis la dernière sauvegarde restaurée à part et vérifiée.
 * Sans : la dernière sauvegarde locale, vérifiée. Le dossier temporaire est toujours supprimé.
 */
export async function drill(opts: { backupDir: string; cfg: RemoteConfig | null; run?: ResticRun; env?: NodeJS.ProcessEnv; now?: Date }): Promise<Result & { source: "distante" | "locale" }> {
  const at = (opts.now ?? new Date()).toISOString();
  const tmp = mkdtempSync(join(tmpdir(), "clark-exercice-"));
  try {
    if (opts.cfg) {
      const run = opts.run ?? realRestic;
      await run(["check", "--quiet"], resticEnv(opts.cfg, opts.env));
      const dir = await remoteFetch({ cfg: opts.cfg, snapshot: "latest", target: tmp, run, env: opts.env });
      const bad = verifyBundle(dir);
      return { at, ok: !bad, detail: bad, source: "distante" };
    }
    const last = existsSync(opts.backupDir)
      ? readdirSync(opts.backupDir)
          .filter((f) => /^clark-\d{4}-\d{2}-\d{2}\.db$/.test(f))
          .sort()
          .at(-1)
      : undefined;
    if (!last) return { at, ok: false, detail: "aucune sauvegarde locale", source: "locale" };
    const copy = join(tmp, last);
    cpSync(join(opts.backupDir, last), copy);
    const bad = checkDatabase(copy, CORE_TABLES);
    return { at, ok: !bad, detail: bad ? `${last} : ${bad}` : last, source: "locale" };
  } catch (err) {
    return { at, ok: false, detail: err instanceof Error ? err.message : String(err), source: opts.cfg ? "distante" : "locale" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Jour de l'exercice (1 = lundi … 7 = dimanche), ou null s'il est coupé. */
export function drillDay(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = (env.CLARK_BACKUP_DRILL_DAY ?? "7").trim().toLowerCase();
  if (v === "off" || v === "0") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : 7;
}

/**
 * La planification : un relevé toutes les 10 minutes. 3 h : la copie locale ; 3 h 30 : la sauvegarde distante
 * (une fois par jour) ; 4 h le jour choisi : l'exercice. Une ligne au journal par opération, jamais par relevé.
 */
export function startBackups(db: DatabaseSync, dir: string, opts: { root?: string; status?: BackupStatusStore; run?: ResticRun; commit?: () => string | null; now?: () => Date } = {}): () => void {
  const now = opts.now ?? (() => new Date());
  const status = opts.status;
  let remoteDay: string | null = null;
  let drillDone: string | null = null;
  let busy = false;
  const tick = async () => {
    const p = parisParts(now());
    if (!db.isOpen || busy) return;
    busy = true;
    try {
      if (p.hour === BACKUP_HOUR) {
        try {
          const file = backupNow(db, dir, p.date);
          if (file) {
            console.log(`[clark] base sauvegardée : ${file}`);
            status?.set({ local: { at: now().toISOString(), ok: true, detail: basename(file) } });
          }
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          console.warn("[clark] sauvegarde de la base impossible :", why);
          status?.set({ local: { at: now().toISOString(), ok: false, detail: why } });
        }
      }
      const cfg = remoteConfig();
      if (opts.root && status && cfg && p.hour === BACKUP_HOUR && p.minute >= REMOTE_MINUTE && remoteDay !== p.date) {
        remoteDay = p.date;
        if ("error" in cfg) {
          status.set({ remote: { at: now().toISOString(), ok: false, detail: cfg.error, snapshots: null } });
          console.warn(`[clark] sauvegarde distante : ${cfg.error}`);
        } else {
          try {
            const n = await remoteBackup({ root: opts.root, db, cfg, run: opts.run, commit: opts.commit?.() ?? null, now: now() });
            status.set({ remote: { at: now().toISOString(), ok: true, detail: null, snapshots: n } });
            console.log(`[clark] sauvegarde distante faite (${n ?? "?"} gardées)`);
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            status.set({ remote: { at: now().toISOString(), ok: false, detail: why, snapshots: status.get().remote?.snapshots ?? null } });
            console.warn(`[clark] sauvegarde distante impossible : ${why}`);
          }
        }
      }
      const day = drillDay();
      if (status && day !== null && p.weekday === day && p.hour === DRILL_HOUR && drillDone !== p.date) {
        drillDone = p.date;
        const c = remoteConfig();
        const r = await drill({ backupDir: dir, cfg: c && !("error" in c) ? c : null, run: opts.run, now: now() });
        status.set({ drill: r });
        console.log(r.ok ? `[clark] exercice de restauration réussi (${r.source})` : `[clark] exercice de restauration en échec (${r.source}) : ${r.detail}`);
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 10 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
