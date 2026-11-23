import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { BackupStatusStore, backupNow, checkDatabase, drill, prepareBundle, remoteBackup, remoteConfig, remoteFetch, resticEnv, verifyBundle, type ResticRun } from "../src/core/backup.ts";
import { Conversation } from "../src/core/conversation.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const root = mkdtempSync(join(tmpdir(), "clark-sauvegardes-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Un Clark de test : une vraie base (tables principales), et des fichiers autour, dont des secrets à ne pas copier. */
function fakeClark(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "data", "google"), { recursive: true });
  const store = new Store(join(dir, "data", "clark.db"));
  new TaskJournal(store.db);
  new Conversation(store.db);
  store.remember({ kind: "fact", content: "Charles préfère le thé", importance: 3 });
  writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=secret");
  writeFileSync(join(dir, "data", "google", "token.json"), '{"refresh_token":"x"}');
  mkdirSync(join(dir, "memory"));
  writeFileSync(join(dir, "memory", "moi.md"), "Je suis Charles.");
  writeFileSync(join(dir, "memory", ".env.local"), "CACHE=1");
  writeFileSync(join(dir, "personnalite.md"), "Calme.");
  mkdirSync(join(dir, "workspace", "dev", "tache-1"), { recursive: true });
  writeFileSync(join(dir, "workspace", "dev", "tache-1", "a.txt"), "copie de tâche");
  writeFileSync(join(dir, "workspace", "relances.md"), "Studio Pixel");
  writeFileSync(join(dir, "workspace", "cle.pem"), "-----BEGIN");
  mkdirSync(join(dir, "data", "codex-home"), { recursive: true });
  writeFileSync(join(dir, "data", "codex-home", "auth.json"), "{}");
  return { dir, store };
}

test("copie préparée : base vérifiée, mémoire, personnalité, Google, travail sans dev/ ; jamais de secret", () => {
  const { dir, store } = fakeClark("lot");
  const out = join(root, "lot-out");
  const m = prepareBundle({ root: dir, db: store.db, out, commit: "abc1234" });
  const paths = m.files.map((f) => f.path);
  assert.ok(paths.includes("data/clark.db"));
  assert.ok(paths.includes("memory/moi.md"));
  assert.ok(paths.includes("personnalite.md"));
  assert.ok(paths.includes("data/google/token.json"));
  assert.ok(paths.includes("workspace/relances.md"));
  assert.ok(!paths.some((p) => p.startsWith("workspace/dev")), "pas les copies des tâches dev");
  for (const p of paths) assert.doesNotMatch(p, /(^|\/)\.env|auth\.json|\.pem$/, `secret copié : ${p}`);
  assert.equal(verifyBundle(out), null);
  assert.equal(m.commit, "abc1234");

  const noGoogle = prepareBundle({ root: dir, db: store.db, out, google: false });
  assert.ok(!noGoogle.files.some((f) => f.path.startsWith("data/google")), "CLARK_BACKUP_GOOGLE=off");

  // Un fichier modifié après coup : la vérification le voit.
  writeFileSync(join(out, "workspace", "relances.md"), "changé");
  assert.match(verifyBundle(out)!, /fichier différent : workspace\/relances\.md/);
});

test("sauvegarde locale : une copie abîmée est supprimée et signalée", () => {
  const { store } = fakeClark("local");
  const dir = join(root, "backups-local");
  assert.throws(() => backupNow(store.db, dir, "2026-11-23", 7, () => "intégrité : page 3 abîmée"), /copie de la base abîmée/);
  assert.ok(!existsSync(join(dir, "clark-2026-11-23.db")));
  assert.ok(backupNow(store.db, dir, "2026-11-23"));
  assert.equal(checkDatabase(join(dir, "clark-2026-11-23.db"), ["memories", "messages", "tasks"]), null);
});

/** Faux restic : un « dépôt » dans un dossier, une copie par sauvegarde ; restaure sous le chemin d'origine, comme restic. */
function fakeRestic(store: string) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: ResticRun = async (args, env) => {
    calls.push({ args, env });
    mkdirSync(store, { recursive: true });
    if (args[0] === "backup") {
      const id = `snap${readdirSync(store).length + 1}`;
      cpSync(args[1], join(store, id, args[1]), { recursive: true });
      return "";
    }
    if (args[0] === "snapshots") return JSON.stringify(readdirSync(store).map((id) => ({ id })));
    if (args[0] === "restore") {
      const ids = readdirSync(store).sort();
      const id = args[1] === "latest" ? ids.at(-1) : args[1];
      if (!id) throw new Error("aucune sauvegarde");
      cpSync(join(store, id), args[args.indexOf("--target") + 1], { recursive: true });
      return "";
    }
    return "";
  };
  return { run, calls };
}

test("sauvegarde distante : envoi, rétention (nettoyage le dimanche seulement), mot de passe par fichier, puis restauration vérifiée", async () => {
  const { dir, store } = fakeClark("distante");
  const pw = join(root, "restic-password");
  writeFileSync(pw, "mot-de-passe");
  const cfg = { repo: "b2:bucket:clark", passwordFile: pw };
  const r = fakeRestic(join(root, "depot"));
  const env = { B2_ACCOUNT_ID: "id", B2_ACCOUNT_KEY: "cle", TELEGRAM_BOT_TOKEN: "ne-pas-transmettre", PATH: process.env.PATH } as NodeJS.ProcessEnv;
  const monday = new Date("2026-11-23T02:30:00Z");
  const sunday = new Date("2026-11-29T02:30:00Z");
  assert.equal(await remoteBackup({ root: dir, db: store.db, cfg, run: r.run, env, now: monday }), 1);
  assert.equal(await remoteBackup({ root: dir, db: store.db, cfg, run: r.run, env, now: sunday }), 2);
  const forgets = r.calls.filter((c) => c.args[0] === "forget");
  assert.ok(!forgets[0].args.includes("--prune"), "lundi : pas de nettoyage");
  assert.ok(forgets[1].args.includes("--prune"), "dimanche : nettoyage");
  assert.deepEqual(forgets[0].args.slice(1, 5), ["--tag", "clark", "--group-by", "host,tags"]);
  for (const c of r.calls) {
    assert.ok(!c.args.join(" ").includes("mot-de-passe"), "jamais le mot de passe en argument");
    assert.equal(c.env.RESTIC_PASSWORD_FILE, pw);
    assert.equal(c.env.RESTIC_REPOSITORY, "b2:bucket:clark");
    assert.equal(c.env.B2_ACCOUNT_KEY, "cle");
    assert.equal(c.env.TELEGRAM_BOT_TOKEN, undefined, "le reste de .env n'est pas transmis");
  }
  assert.ok(!existsSync(join(dir, "data", "backups", "lot")), "la copie préparée ne reste pas");

  const target = join(root, "restaure");
  const restored = await remoteFetch({ cfg, snapshot: "latest", target, run: r.run, env });
  assert.equal(verifyBundle(restored), null);
  const db = new DatabaseSync(join(restored, "data", "clark.db"), { readOnly: true });
  assert.equal((db.prepare("SELECT content FROM memories").get() as { content: string }).content, "Charles préfère le thé");
  db.close();
});

test("exercice : réussi sur une sauvegarde saine, en échec sinon ; sans dépôt, sur la dernière sauvegarde locale", async () => {
  const { dir, store } = fakeClark("exercice");
  const pw = join(root, "pw2");
  writeFileSync(pw, "x");
  const cfg = { repo: "local:/tmp/x", passwordFile: pw };
  const r = fakeRestic(join(root, "depot2"));
  await remoteBackup({ root: dir, db: store.db, cfg, run: r.run });
  const ok = await drill({ backupDir: join(root, "rien"), cfg, run: r.run });
  assert.deepEqual([ok.ok, ok.source, ok.detail], [true, "distante", null]);
  assert.ok(r.calls.some((c) => c.args[0] === "check"), "restic check d'abord");

  // Une sauvegarde abîmée dans le dépôt : l'exercice échoue.
  const snap = readdirSync(join(root, "depot2"))[0];
  const lot = join(root, "depot2", snap, dir, "data", "backups", "lot");
  writeFileSync(join(lot, "personnalite.md"), "abîmée");
  const bad = await drill({ backupDir: join(root, "rien"), cfg, run: r.run });
  assert.equal(bad.ok, false);
  assert.match(bad.detail!, /fichier différent : personnalite\.md/);

  // Sans dépôt : la dernière sauvegarde locale.
  const local = join(root, "backups-exercice");
  assert.equal((await drill({ backupDir: local, cfg: null })).detail, "aucune sauvegarde locale");
  backupNow(store.db, local, "2026-11-22");
  const l = await drill({ backupDir: local, cfg: null });
  assert.deepEqual([l.ok, l.source], [true, "locale"]);
  writeFileSync(join(local, "clark-2026-11-23.db"), "pas une base");
  assert.equal((await drill({ backupDir: local, cfg: null })).ok, false);
});

test("réglage : rien sans CLARK_BACKUP_REPO ; erreur claire sans fichier de mot de passe ; état gardé", () => {
  assert.equal(remoteConfig({}), null);
  assert.match((remoteConfig({ CLARK_BACKUP_REPO: "b2:x:y" }) as { error: string }).error, /CLARK_BACKUP_PASSWORD_FILE/);
  assert.match((remoteConfig({ CLARK_BACKUP_REPO: "b2:x:y", CLARK_BACKUP_PASSWORD_FILE: "/nulle/part" }) as { error: string }).error, /introuvable/);
  assert.equal(resticEnv({ repo: "r", passwordFile: "p" }, { HOME: "/h", ANTHROPIC_API_KEY: "k" }).ANTHROPIC_API_KEY, undefined);
  const db = new DatabaseSync(":memory:");
  const s = new BackupStatusStore(db);
  s.set({ drill: { at: "2026-11-23T03:00:00Z", ok: false, detail: "x", source: "locale" } });
  s.set({ local: { at: "2026-11-23T02:00:00Z", ok: true, detail: "clark.db" } });
  assert.equal(new BackupStatusStore(db).get().drill?.ok, false, "un champ ne remplace pas les autres");
});

test("restore.sh : refuse sans confirmation ; met l'existant de côté, remet la sauvegarde, ne touche pas .env", { timeout: 60_000 }, () => {
  const { dir, store } = fakeClark("restaurer");
  // Le Clark à restaurer : ses scripts, une sauvegarde locale, puis un changement à défaire.
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const f of ["restore.sh", "backup.ts", "service.sh"]) cpSync(resolve(import.meta.dirname, "../scripts", f), join(dir, "scripts", f));
  cpSync(resolve(import.meta.dirname, "../src"), join(dir, "src"), { recursive: true });
  execFileSync("ln", ["-s", resolve(import.meta.dirname, "../node_modules"), join(dir, "node_modules")]);
  cpSync(resolve(import.meta.dirname, "../package.json"), join(dir, "package.json"));
  backupNow(store.db, join(dir, "data", "backups"), "2026-11-22");
  store.remember({ kind: "fact", content: "Ajouté après la sauvegarde", importance: 3 });
  store.db.close();

  const fake = join(root, "svc-restaurer.sh");
  writeFileSync(fake, `#!/bin/bash\necho "$1" >> "${join(root, "svc-calls")}"\n`);
  chmodSync(fake, 0o755);
  const env = { ...process.env, CLARK_SERVICE_FAKE: fake, CLARK_HEALTH_WAIT: "1", CLARK_WEB_PORT: "1", CLARK_BACKUP_REPO: "" };
  const refused = spawnSync("bash", [join(dir, "scripts/restore.sh"), "local:clark-2026-11-22.db"], { cwd: dir, env, input: "non\n", encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /Annulé : rien n'a été touché/);
  assert.ok(!existsSync(join(root, "svc-calls")), "Clark pas arrêté");

  const ok = spawnSync("bash", [join(dir, "scripts/restore.sh"), "local:clark-2026-11-22.db"], { cwd: dir, env, input: "RESTAURER\n", encoding: "utf8" });
  // Le faux service ne répond pas à /api/health : le script le dit, mais la restauration est faite.
  assert.match(ok.stdout, /Remise en place/);
  assert.deepEqual(readFileSync(join(root, "svc-calls"), "utf8").trim().split("\n"), ["stop", "start"]);
  const db = new DatabaseSync(join(dir, "data", "clark.db"), { readOnly: true });
  const contents = (db.prepare("SELECT content FROM memories").all() as { content: string }[]).map((m) => m.content);
  db.close();
  assert.deepEqual(contents, ["Charles préfère le thé"], "le souvenir ajouté après la sauvegarde est parti");
  const aside = readdirSync(join(dir, "data", "backups")).find((f) => f.startsWith("avant-restauration-"))!;
  assert.ok(existsSync(join(dir, "data", "backups", aside, "data", "clark.db")), "l'ancienne base est mise de côté");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "TELEGRAM_BOT_TOKEN=secret", ".env intact");
});

const hasRestic = spawnSync("restic", ["version"]).status === 0;
test("restic pour de vrai (si installé) : init, sauvegarde, exercice", { skip: !hasRestic && "restic n'est pas installé" }, async () => {
  const { dir, store } = fakeClark("vrai-restic");
  const pw = join(root, "pw-vrai");
  writeFileSync(pw, "mot-de-passe-de-test");
  const cfg = { repo: join(root, "depot-vrai"), passwordFile: pw };
  execFileSync("restic", ["init"], { env: resticEnv(cfg) });
  assert.equal(await remoteBackup({ root: dir, db: store.db, cfg }), 1);
  const r = await drill({ backupDir: join(root, "rien"), cfg });
  assert.deepEqual([r.ok, r.detail], [true, null]);
});

test("page Santé : sauvegarde distante en échec ou mal réglée, exercice en échec ou trop vieux → points avec alerte", async () => {
  const { healthReport } = await import("../src/core/health.ts");
  const { createHub } = await import("../src/core/hub.ts");
  const store = new Store(":memory:");
  const hub = createHub({ config: { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null }, store, journal: new TaskJournal(store.db), conversation: new Conversation(store.db) }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as never });
  const now = new Date("2026-11-23T10:00:00Z");
  const base = { root, logFile: join(root, "absent.log"), backupDir: join(root, "absent"), now, git: () => "abc", freeBytes: () => 50e9 };
  const ids = (o: object) => healthReport(hub, { ...base, ...o }).problems.filter((p) => p.alert).map((p) => p.id);
  const cfg = () => ({ repo: "b2:x:y", passwordFile: "/p" });

  assert.deepEqual(ids({ remoteConfig: () => null, backup: () => ({ local: null, remote: null, drill: null }) }), [], "rien de réglé, rien de nouveau");
  assert.deepEqual(ids({ remoteConfig: () => ({ error: "fichier du mot de passe introuvable" }) }), ["sauvegarde-distante"]);
  assert.deepEqual(ids({ remoteConfig: cfg, backup: () => ({ local: null, remote: { at: "2026-11-23T02:30:00Z", ok: false, detail: "réseau", snapshots: 3 }, drill: null }) }), ["sauvegarde-distante"]);
  assert.deepEqual(ids({ remoteConfig: cfg, backup: () => ({ local: null, remote: { at: "2026-11-23T02:30:00Z", ok: true, detail: null, snapshots: 3 }, drill: null }) }), []);
  assert.deepEqual(ids({ remoteConfig: () => null, backup: () => ({ local: null, remote: null, drill: { at: "2026-11-22T03:00:00Z", ok: false, detail: "base abîmée", source: "locale" } }) }), ["exercice-sauvegarde"]);
  assert.deepEqual(ids({ remoteConfig: () => null, backup: () => ({ local: null, remote: null, drill: { at: "2026-11-14T03:00:00Z", ok: true, detail: null, source: "locale" } }) }), ["exercice-sauvegarde"], "9 jours sans exercice réussi");
});
