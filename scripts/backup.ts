// Sauvegardes à la main (scripts/backup.sh appelle ce fichier) :
//   now                    sauvegarde locale du jour, puis distante si CLARK_BACKUP_REPO est réglé
//   init                   crée le dépôt restic (une fois, à la main : jamais créé tout seul)
//   snapshots              liste les sauvegardes distantes
//   drill                  exercice de restauration (distante, sinon locale), résultat sur la page Santé
//   fetch <id|latest|local:fichier.db> <dossier>   restaure à part et vérifie (utilisé par scripts/restore.sh)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "../src/config.ts";
import { BackupStatusStore, backupNow, checkDatabase, drill, realRestic, remoteBackup, remoteConfig, remoteFetch, resticEnv, verifyBundle } from "../src/core/backup.ts";
import { parisParts } from "../src/scheduler/automations.ts";

const backups = join(paths.root, "data", "backups");
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const commit = () => {
  try {
    return execFileSync("git", ["-C", paths.root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const config = () => {
  const c = remoteConfig();
  if (!c) return null;
  if ("error" in c) fail(c.error);
  return c as Exclude<typeof c, { error: string } | null>;
};

const [cmd, a, b] = process.argv.slice(2);
const openDb = () => new DatabaseSync(paths.db);

if (cmd === "now") {
  const db = openDb();
  const status = new BackupStatusStore(db);
  const file = backupNow(db, backups, parisParts(new Date()).date);
  console.log(file ? `Sauvegarde locale : ${file}` : "Sauvegarde locale du jour : déjà faite.");
  if (file) status.set({ local: { at: new Date().toISOString(), ok: true, detail: file.split("/").at(-1)! } });
  const cfg = config();
  if (cfg) {
    try {
      const n = await remoteBackup({ root: paths.root, db, cfg, commit: commit() });
      status.set({ remote: { at: new Date().toISOString(), ok: true, detail: null, snapshots: n } });
      console.log(`Sauvegarde distante faite (${n ?? "?"} gardées).`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      status.set({ remote: { at: new Date().toISOString(), ok: false, detail: why, snapshots: null } });
      fail(`Sauvegarde distante impossible : ${why}`);
    }
  } else console.log("Pas de sauvegarde distante (CLARK_BACKUP_REPO vide).");
  db.close();
} else if (cmd === "init") {
  const cfg = config() ?? fail("Règle d'abord CLARK_BACKUP_REPO et CLARK_BACKUP_PASSWORD_FILE dans .env.");
  console.log(await realRestic(["init"], resticEnv(cfg)));
  console.log("Dépôt créé. Garde le mot de passe dans ton gestionnaire : sans lui, les sauvegardes sont illisibles.");
} else if (cmd === "snapshots") {
  const cfg = config() ?? fail("Pas de sauvegarde distante (CLARK_BACKUP_REPO vide).");
  console.log(await realRestic(["snapshots", "--tag", "clark"], resticEnv(cfg)));
} else if (cmd === "drill") {
  const db = openDb();
  const cfg = config();
  const r = await drill({ backupDir: backups, cfg });
  new BackupStatusStore(db).set({ drill: r });
  db.close();
  console.log(r.ok ? `Exercice réussi (sauvegarde ${r.source}).` : `Exercice en échec (sauvegarde ${r.source}) : ${r.detail}`);
  if (!r.ok) process.exit(1);
} else if (cmd === "fetch") {
  if (!a || !b) fail("usage : fetch <id|latest|local:fichier.db> <dossier>");
  const target = resolve(b);
  mkdirSync(target, { recursive: true });
  if (a.startsWith("local:")) {
    // Une sauvegarde locale ne contient que la base : on la range comme une copie préparée (data/clark.db).
    const file = resolve(backups, a.slice(6).replace(/^.*\//, ""));
    if (!existsSync(file)) fail(`Sauvegarde locale introuvable : ${file}`);
    mkdirSync(join(target, "data"), { recursive: true });
    cpSync(file, join(target, "data", "clark.db"));
    const bad = checkDatabase(join(target, "data", "clark.db"), ["memories", "messages", "tasks"]);
    if (bad) fail(`Base abîmée : ${bad}`);
    console.log(target);
  } else {
    const cfg = config() ?? fail("Pas de sauvegarde distante (CLARK_BACKUP_REPO vide) : utilise local:<fichier>.");
    const dir = await remoteFetch({ cfg, snapshot: a, target });
    const bad = verifyBundle(dir);
    if (bad) fail(`Sauvegarde abîmée : ${bad}`);
    console.log(dir);
  }
} else {
  fail("usage : scripts/backup.sh now | init | snapshots | drill");
}
