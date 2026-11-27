import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { OWNER_CHAT } from "./conversation.ts";
import type { Hub } from "./hub.ts";
import { IMPROVE_WINDOW_DAYS, type Improvement, type ImproveSourceKind, type ImproveStore } from "./improve.ts";
import { redactSecrets } from "./redact.ts";
import type { PrStatus } from "../dev/pr.ts";

/**
 * Auto-amélioration, 3/3 : déployer prudemment, observer, revenir en arrière, faire le bilan.
 *
 * Le mécanisme est à part de improve.ts (détection + proposition + lancement du binôme) pour ne pas
 * l'alourdir. Tout ce qui touche au système (git, service, relevé de santé) est INJECTABLE : réel dans
 * l'index, simulé dans les tests — AUCUN redémarrage réel en test.
 *
 * Règle d'or : Clark n'ouvre, ne fusionne, ne déploie JAMAIS tout seul. Le déploiement part d'un clic de
 * l'utilisateur. Seul le RETOUR ARRIÈRE est automatique : c'est un filet de sécurité qui REVIENT à un état
 * déjà connu (le commit d'avant le déploiement), il n'engage rien de neuf.
 */

/** Fenêtre d'observation serrée après le déploiement (minutes). Défaut 2 h. */
export const WATCH_MINUTES_DEFAULT = 120;
/** Bilan trois jours après le déploiement. */
export const BILAN_DELAY_DAYS = 3;
/** Conversation et label du bilan d'auto-amélioration au Calendrier (distincts du bilan des propositions). */
export const AMELIORE_BILAN_CHAT = 7_000_002;
export const AMELIORE_BILAN_LABEL = "ameliore";

/** Résultat d'une commande injectée. */
export type RunResult = { ok: boolean; stdout: string; stderr: string };
export type RunGit = (args: string[]) => Promise<RunResult>;
export type RunService = (cmd: string) => Promise<RunResult>;

const execFileP = promisify(execFile);

/** git réel, borné au dépôt `root`. Ne lève pas : renvoie { ok:false } avec la sortie d'erreur. */
export function realGit(root: string): RunGit {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFileP("git", ["-C", root, ...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(err) };
    }
  };
}

/**
 * scripts/service.sh réel. Deux commandes servent ici :
 *  - `restart` : redémarrage de DÉPLOIEMENT (garde le contrôle de santé de service.sh et son éventuel retour
 *    à last-good-commit).
 *  - `restart --rollback` : redémarrage de RETOUR ARRIÈRE lancé par Clark. Il contrôle la santé mais n'installe
 *    JAMAIS la surveillance et ne revient JAMAIS à last-good-commit (qui pourrait désigner la version en
 *    régression) : Clark a déjà placé le dépôt sur le commit de secours, service.sh ne doit pas le défaire.
 * Le `cmd` peut donc contenir des arguments séparés par des espaces (ex. « restart --rollback »).
 * CLARK_RESTART_NO_INSTALL=1 : un redémarrage lancé PAR Clark ne doit de toute façon JAMAIS installer la
 * surveillance locale — aucun ajout silencieux. Seul `scripts/service.sh install`, lancé par l'utilisateur,
 * met en place le watchdog.
 *
 * Pour un `restart --rollback`, on exécute en priorité le script FIGÉ dans `data/clark-rollback-service.sh`
 * (voir pinRollbackScript) s'il existe : après un `git switch` sur le commit de secours, `scripts/service.sh`
 * du checkout est peut-être ANTÉRIEUR à cette fonctionnalité (il ignorerait `--rollback` et pourrait installer
 * la surveillance). Le script figé, lui, porte la version qui gère `--rollback` ; placé dans `data/`, son ROOT
 * (`dirname/..`) reste le dépôt. À défaut de script figé, on retombe sur `scripts/service.sh`.
 */
export function realService(root: string): RunService {
  return async (cmd) => {
    try {
      const env = { ...process.env, CLARK_RESTART_NO_INSTALL: "1" };
      const argv = cmd.split(/\s+/).filter(Boolean);
      const pinned = `${root}/data/clark-rollback-service.sh`;
      const isRollback = argv[0] === "restart" && argv.includes("--rollback");
      const script = isRollback && existsSync(pinned) ? pinned : `${root}/scripts/service.sh`;
      const { stdout, stderr } = await execFileP(script, argv, { cwd: root, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(err) };
    }
  };
}

/** L'état « avant » figé au déploiement, comparé pendant l'observation. */
export type RegressionBefore = {
  /** Signatures d'erreur connues au déploiement (toutes sources). */
  signatures: string[];
  /** Nombre de tâches en échec sur la fenêtre. */
  taskFailures: number;
  /** Dernier redémarrage par la surveillance locale connu (horodatage, ou null). */
  watchdogMarker: string | null;
  /** La santé était-elle déjà au rouge au déploiement ? */
  healthBad: boolean;
  /** Jour (Paris) du déploiement : la mesure « depuis le déploiement » somme les jours >= celui-ci. */
  deployDay: string;
  /** Occurrences de la signature VISÉE comptées À PARTIR du jour du déploiement, figées au déploiement. */
  targetFromDeployDay: number;
};

/** L'état observé pendant la fenêtre. */
export type RegressionDuring = {
  /** Occurrences de la signature visée APPARUES depuis le déploiement. */
  targetSinceDeploy: number;
  signatures: string[];
  taskFailures: number;
  watchdogMarker: string | null;
  healthBad: boolean;
};

export type RegressionSign = { code: "signature-visee" | "nouvelles-erreurs" | "echecs-taches" | "watchdog" | "sante-degradee"; detail: string };

/**
 * La règle de régression, PURE. Renvoie la liste des signes de régression détectés (vide = tout va bien).
 * Les détails sont des libellés fixes et des nombres : jamais une signature brute ni un extrait (défense).
 */
export function regression(before: RegressionBefore, during: RegressionDuring): RegressionSign[] {
  const signs: RegressionSign[] = [];
  if (during.targetSinceDeploy > 0) signs.push({ code: "signature-visee", detail: `la signature visée est réapparue (${during.targetSinceDeploy})` });
  const known = new Set(before.signatures);
  const fresh = during.signatures.filter((s) => !known.has(s));
  if (fresh.length) signs.push({ code: "nouvelles-erreurs", detail: `${fresh.length} nouvelle${fresh.length > 1 ? "s" : ""} signature${fresh.length > 1 ? "s" : ""} d'erreur` });
  if (during.taskFailures > before.taskFailures) signs.push({ code: "echecs-taches", detail: `échecs de tâches en hausse (${before.taskFailures} → ${during.taskFailures})` });
  if (during.watchdogMarker && during.watchdogMarker !== before.watchdogMarker) signs.push({ code: "watchdog", detail: "la surveillance locale a dû redémarrer Clark" });
  if (during.healthBad && !before.healthBad) signs.push({ code: "sante-degradee", detail: "la santé est passée au rouge" });
  return signs;
}

/**
 * Le résultat du bilan J+3, PUR. 'atteint' : la signature a disparu. 'partiel' : nettement moins souvent
 * mais pas nulle. 'rate' : toujours là au même rythme (ou presque).
 * On compare des rythmes PAR JOUR (la mesure « avant » couvre 7 jours, l'observation 3).
 */
export function bilanOutcome(beforePerDay: number, afterTotal: number, afterPerDay: number): "atteint" | "partiel" | "rate" {
  if (afterTotal === 0) return "atteint";
  if (beforePerDay > 0 && afterPerDay <= beforePerDay / 2) return "partiel";
  return "rate";
}

/** Le relevé d'état injectable (hors signature visée, calculée à part). */
export type SnapshotReader = (now: Date) => { signatures: string[]; taskFailures: number; watchdogMarker: string | null; healthBad: boolean };

export type ImproveDeployOptions = {
  root: string;
  git?: RunGit;
  service?: RunService;
  snapshot?: SnapshotReader;
  healthBad?: () => boolean;
  /**
   * Le commit que l'INSTANCE EN COURS exécute vraiment (figé au démarrage du processus) — distinct du HEAD
   * sur le disque. C'est lui qui dit si le redémarrage a bien remplacé le processus : un redémarrage refusé
   * laisse l'ancien processus, donc runningCommit reste l'ANCIEN commit même si le disque est déjà à jour.
   */
  runningCommit?: () => string;
  /**
   * Note un commit comme « dernière bonne version » (data/last-good-commit). Appelé lors du retour arrière,
   * AVANT le redémarrage, pour qu'AUCUNE version de service.sh — même antérieure à cette fonctionnalité,
   * embarquée dans le commit de secours — ne puisse « revenir au last-good » sur la version en régression.
   * Renvoie false si l'écriture a échoué : le retour arrière NE redémarre alors PAS (on ne masque pas l'échec).
   */
  recordGood?: (commit: string) => boolean;
  /**
   * Fige le `scripts/service.sh` ACTUEL (celui du disque AVANT le `git switch` de retour arrière, qui gère
   * `--rollback`) dans `data/clark-rollback-service.sh`, hors du checkout. Le redémarrage de retour arrière
   * passe par cette copie, jamais par le service.sh (peut-être ancien) embarqué dans le commit de secours.
   * Appelé UNIQUEMENT tant que le disque porte encore la version candidate (avant le switch) : une reprise,
   * disque déjà sur le secours, NE re-fige PAS (elle écraserait la bonne copie par le vieux script). Renvoie
   * false si la copie a échoué : le retour arrière NE redémarre alors PAS.
   */
  pinRollbackScript?: () => boolean;
  /**
   * Le script figé de retour arrière est-il présent (data/clark-rollback-service.sh) ? Garde-fou avant le
   * redémarrage automatique : s'il est absent (jamais figé, ou copie perdue), on NE redémarre PAS tout seul —
   * on ne veut pas lancer `restart --rollback` via un service.sh de secours peut-être antérieur à `--rollback`.
   */
  rollbackScriptReady?: () => boolean;
  /**
   * Marqueur de déploiement en cours (data/deploy-pending), lu par la surveillance locale (scripts/watchdog.sh).
   * Un redémarrage lancé PAR Clark tue aussi le service.sh qu'il a lancé (launchd et systemd arrêtent tout le
   * groupe du service) : le contrôle de santé de service.sh ne tourne donc jamais. Si la nouvelle version ne
   * démarre pas, plante en boucle ou gèle, AUCUN code de Clark ne tourne pour revenir en arrière. La
   * surveillance, elle, est un job à part : tant que ce marqueur existe et que le disque est sur la cible, elle
   * remet le commit de secours une fois le délai passé. markPending renvoie false si l'écriture échoue : on ne
   * redémarre alors PAS (pas de déploiement sans filet). clearPending est appelé dès que l'issue est tranchée.
   */
  markPending?: (recovery: string, target: string) => boolean;
  clearPending?: () => void;
  now?: () => Date;
  watchMinutes?: number;
  everyMs?: number;
};

type Resolved = Required<Omit<ImproveDeployOptions, "healthBad" | "everyMs">> & { everyMs: number };

/** Relevé réel par défaut : signatures et échecs depuis la base, redémarrage du watchdog et santé. */
function defaultSnapshot(hub: Hub, healthBad: () => boolean): SnapshotReader {
  const { store } = hub.deps;
  return (now: Date) => {
    const fromDay = parisDayMinus(now, IMPROVE_WINDOW_DAYS - 1);
    let signatures: string[] = [];
    try {
      signatures = (store.db.prepare("SELECT DISTINCT signature FROM improve_signatures WHERE day >= ?").all(fromDay) as { signature: string }[]).map((r) => r.signature);
    } catch {
      signatures = [];
    }
    let taskFailures = 0;
    try {
      const since = new Date(now.getTime() - IMPROVE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
      taskFailures = (store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id IS NULL AND status IN ('failed','needs_check','abandoned') AND updated_at >= ?").get(since) as { n: number }).n;
    } catch {
      taskFailures = 0;
    }
    let watchdogMarker: string | null = null;
    try {
      const row = store.db.prepare("SELECT value FROM app_settings WHERE key = 'last_watchdog_restart'").get() as { value: string } | undefined;
      watchdogMarker = row?.value ?? null;
    } catch {
      watchdogMarker = null;
    }
    let bad = false;
    try {
      bad = healthBad();
    } catch {
      bad = false;
    }
    return { signatures, taskFailures, watchdogMarker, healthBad: bad };
  };
}

const parisDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
function parisDayMinus(now: Date, n: number): string {
  const day = parisDay(now);
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
/** Écrit `data/last-good-commit` dans le dépôt. Renvoie false si l'écriture échoue (jamais d'exception). */
function defaultRecordGood(root: string): (commit: string) => boolean {
  return (commit) => {
    try {
      writeFileSync(`${root}/data/last-good-commit`, `${commit}\n`);
      return true;
    } catch {
      return false;
    }
  };
}
/** Copie le service.sh courant dans `data/clark-rollback-service.sh`. Renvoie false en cas d'échec. */
function defaultPinRollbackScript(root: string): () => boolean {
  return () => {
    try {
      const dest = `${root}/data/clark-rollback-service.sh`;
      copyFileSync(`${root}/scripts/service.sh`, dest);
      chmodSync(dest, 0o755);
      return true;
    } catch {
      return false;
    }
  };
}
/** Écrit `data/deploy-pending` : commit de secours, cible, heure (secondes). Renvoie false en cas d'échec. */
function defaultMarkPending(root: string): (recovery: string, target: string) => boolean {
  return (recovery, target) => {
    try {
      writeFileSync(`${root}/data/deploy-pending`, `${recovery}\n${target}\n${Math.floor(Date.now() / 1000)}\n`);
      return true;
    } catch {
      return false;
    }
  };
}
function defaultClearPending(root: string): () => void {
  return () => {
    try {
      rmSync(`${root}/data/deploy-pending`, { force: true });
    } catch {
      // Un marqueur resté en place est sans danger : la surveillance l'ignore dès que le disque n'est plus sur la cible.
    }
  };
}
/** Le script figé de retour arrière existe-t-il déjà dans `data/` ? */
function defaultRollbackScriptReady(root: string): () => boolean {
  return () => {
    try {
      return existsSync(`${root}/data/clark-rollback-service.sh`);
    } catch {
      return false;
    }
  };
}
/**
 * Lit un horodatage SQLite (« 2026-11-25 10:00:00 », UTC) OU ISO (« 2026-11-25T10:00:00Z »). On n'ajoute « Z »
 * que s'il n'y a pas déjà de marqueur de fuseau : le marqueur du watchdog est écrit en ISO finissant par Z
 * (scripts/watchdog.sh : `date -u +%FT%TZ`) — lui ajouter un second « Z » donnait une date invalide.
 */
const parseSqlUtc = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(/([Zz]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

function resolve(hub: Hub, opts: ImproveDeployOptions): Resolved {
  const healthBad = opts.healthBad ?? (() => false);
  return {
    root: opts.root,
    git: opts.git ?? realGit(opts.root),
    service: opts.service ?? realService(opts.root),
    snapshot: opts.snapshot ?? defaultSnapshot(hub, healthBad),
    runningCommit: opts.runningCommit ?? (() => ""),
    recordGood: opts.recordGood ?? defaultRecordGood(opts.root),
    pinRollbackScript: opts.pinRollbackScript ?? defaultPinRollbackScript(opts.root),
    rollbackScriptReady: opts.rollbackScriptReady ?? defaultRollbackScriptReady(opts.root),
    markPending: opts.markPending ?? defaultMarkPending(opts.root),
    clearPending: opts.clearPending ?? defaultClearPending(opts.root),
    now: opts.now ?? (() => new Date()),
    watchMinutes: opts.watchMinutes ?? (Number(process.env.CLARK_IMPROVE_WATCH_MINUTES) || WATCH_MINUTES_DEFAULT),
    everyMs: opts.everyMs ?? 5 * 60_000,
  };
}

/** Occurrences de la signature visée DEPUIS le jour du déploiement (sans fenêtre glissante). */
function targetSince(store: ImproveStore, source: ImproveSourceKind, signature: string, deployDay: string): number {
  return store.countFromDay(source, signature, deployDay);
}

/**
 * Verrou par dépôt : git et le service ne tolèrent pas deux séquences en parallèle. Toute opération qui
 * touche le dépôt ou le service (déploiement, finalisation, retour arrière) passe par là, en file, pour que
 * le retour arrière automatique de la boucle et un clic « Déployer » ne s'entrecroisent jamais.
 */
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(root) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  repoLocks.set(root, run.then(() => {}, () => {}));
  return run;
}

/**
 * Sur le clic « Déployer » d'une fiche 'merged'. Fige le commit d'avant (pour revenir) et l'état « avant »,
 * passe 'deploying', se replace sur `main` (au cas où un retour arrière précédent a laissé une HEAD
 * détachée), récupère la nouvelle version (`git pull --ff-only`), redémarre le service puis FINALISE
 * (vérifie santé et commit avant d'annoncer l'observation). Clark ne déploie jamais tout seul : c'est un clic.
 *
 * Toute la séquence passe par le verrou du dépôt : deux clics, ou un clic pendant le retour arrière de la
 * boucle, ne s'entrecroisent pas. Un nouveau déploiement est refusé tant qu'une autre fiche est en cours
 * (un retour arrière automatique reste possible pour elle).
 */
export async function deployImprovement(hub: Hub, id: number, opts: ImproveDeployOptions): Promise<"done" | "already" | { error: string }> {
  const r = resolve(hub, opts);
  return withRepoLock(r.root, async () => {
    const improve = hub.deps.store.improve;
    const fiche = improve.get(id);
    if (!fiche || fiche.status !== "merged") return "already";

    // Une seule amélioration à la fois sur le dépôt : tant qu'une autre est en déploiement, en observation
    // ou en retour arrière, on ne superpose pas un nouveau déploiement.
    const busy = improve.fiches(["deploying", "watching", "reverting"]).find((f) => f.id !== id);
    if (busy) {
      void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » pas déployée pour l'instant — « ${busy.title} » est encore en observation. Je retente quand elle est close.`, "system", "health");
      return { error: "Une autre amélioration est déjà en observation." };
    }

    // Le commit de fusion de la PR doit être CONNU avant de déployer : sinon on ne pourra pas vérifier que la
    // version récupérée contient bien la correction (on tirerait un origin/main « à l'aveugle »). Les fiches
    // dont la métadonnée manque encore sont REFUSÉES (pas déployées « comme avant ») ; detectMerges réactualise
    // ce champ depuis le statut de PR déjà relevé (sans réseau), et le bouton redevient actif au passage suivant.
    if (!fiche.merge_commit) {
      void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » pas encore déployable — le commit de fusion de la PR n'est pas connu. Je réessaie quand la métadonnée de la PR est à jour.`, "system", "health");
      return { error: "commit de fusion inconnu" };
    }

    const head = await r.git(["rev-parse", "HEAD"]);
    if (!head.ok || !head.stdout.trim()) {
      void hub.post(OWNER_CHAT, `Auto-amélioration : impossible de lire la version en cours, rien n'a été déployé pour « ${fiche.title} ».`, "system", "alert");
      return { error: "HEAD illisible" };
    }
    // Commit de SECOURS = la version que l'instance EXÉCUTE vraiment (runningCommit), pas le HEAD du disque :
    // on ne doit JAMAIS enregistrer comme secours un commit sur lequel l'instance ne tourne pas. Si le disque
    // et le processus divergent (ex. un retour arrière antérieur a laissé une HEAD détachée ailleurs), le point
    // de retour sûr est la version qui tourne. À défaut de runningCommit, on retombe sur le HEAD du disque.
    const diskHead = head.stdout.trim();
    const runningAtStart = r.runningCommit().trim();
    const commit = runningAtStart || diskHead; // cible du retour arrière
    const now = r.now();
    const snap = r.snapshot(now);
    const deployDay = parisDay(now);
    const baseline: RegressionBefore = { ...snap, deployDay, targetFromDeployDay: targetSince(improve, fiche.source, fiche.signature, deployDay) };
    if (!improve.setDeploying(id, commit, JSON.stringify(baseline), now)) return "already";

    // Remet le dépôt sur le commit de secours (la version qui tourne) et vérifie — utilisé quand une étape
    // échoue APRÈS qu'on a pu bouger HEAD : on ne dit « rien n'a changé » qu'après avoir confirmé la remise.
    const restoreToRecovery = async (): Promise<boolean> => {
      const sw = await r.git(["switch", "--detach", commit]);
      const back = await r.git(["rev-parse", "HEAD"]);
      return sw.ok && back.ok && back.stdout.trim() === commit;
    };

    // Échec d'une étape de PRÉPARATION (avant tout redémarrage). On ne rend le bouton « Déployer » (et on
    // n'efface les références de récupération) QUE si le dépôt est bien revenu sur le commit de secours. Sinon,
    // la fiche RESTE 'deploying' : les références sont gardées, un nouveau déploiement est bloqué (verrou « une
    // seule à la fois »), et la reprise (resumeDeploying → finalizeDeploy) retentera la remise au prochain
    // passage. On ne déclare jamais « rien n'a changé » tant que la remise n'est pas confirmée.
    const abortPrep = (restored: boolean): void => {
      if (restored) improve.backToMerged(id, r.now());
      else improve.setDeployPhase(id, "failed", r.now());
    };

    // Se replacer sur main d'abord : un retour arrière antérieur a pu laisser une HEAD détachée, et
    // `git pull --ff-only` n'avance que la branche suivie.
    const onMain = await r.git(["switch", "main"]);
    if (!onMain.ok) {
      const restored = await restoreToRecovery();
      abortPrep(restored);
      void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » non déployée — impossible de se replacer sur main (${firstLine(onMain.stderr)}).${restored ? " Rien n'a changé, le bouton « Déployer » reste." : " Remise du dépôt NON confirmée — je retente, interviens si besoin."}`, "system", "alert");
      return { error: "git switch main impossible" };
    }
    // La branche suivie DOIT être `main` ET son amont EXACTEMENT origin/main : on ne déploie ni depuis une autre
    // branche (ni une HEAD détachée), ni avec un amont inattendu ou illisible — sinon `pull --ff-only` pourrait
    // tirer une version qu'on ne contrôle pas. Un amont absent/illisible est REFUSÉ (on ne devine pas).
    const branchName = (await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const upstream = await r.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const upstreamRef = upstream.stdout.trim();
    const upstreamOk = upstream.ok && upstreamRef === "origin/main";
    if (branchName !== "main" || !upstreamOk) {
      const restored = await restoreToRecovery();
      abortPrep(restored);
      void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » non déployée — la branche suivie n'est pas origin/main (branche ${branchName || "inconnue"}, amont ${firstLine(upstreamRef) || "absent"}).${restored ? " Dépôt remis sur la version d'avant." : " Remise NON confirmée — interviens."}`, "system", "alert");
      return { error: "branche suivie incorrecte" };
    }
    const pull = await r.git(["pull", "--ff-only"]);
    if (!pull.ok) {
      // `git switch main` a déjà bougé HEAD (d'une éventuelle HEAD détachée vers la pointe locale de main) :
      // on NE peut PAS dire « rien n'a changé » sans remettre le dépôt là où on l'a pris. On restaure donc le
      // commit de secours et on vérifie, avant de rendre le bouton. Faute de quoi, on alerte fidèlement.
      const restored = await restoreToRecovery();
      abortPrep(restored);
      void hub.post(
        OWNER_CHAT,
        restored
          ? `Auto-amélioration : « ${fiche.title} » non déployée — la nouvelle version n'a pas pu être récupérée (git pull). Dépôt remis sur la version d'avant, le bouton « Déployer » reste.`
          : `Auto-amélioration : « ${fiche.title} » — échec du git pull ET la remise à la version d'avant n'est pas confirmée (${firstLine(pull.stderr)}). Vérifie l'état du dépôt.`,
        "system",
        "alert",
      );
      return { error: "git pull --ff-only impossible" };
    }
    // La cible = la version qu'on vient de récupérer. On la FIGE avant de redémarrer : la finalisation
    // (ici ou à la reprise) ne conclura « déployé » que si l'instance tourne VRAIMENT sur ce commit.
    const target = await r.git(["rev-parse", "HEAD"]);
    if (!target.ok || !target.stdout.trim()) {
      const restored = await restoreToRecovery();
      abortPrep(restored);
      void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » — version cible illisible après le git pull${restored ? ", dépôt remis sur la version d'avant" : " ET remise NON confirmée — interviens"}. Rien n'a été déployé.`, "system", "alert");
      return { error: "cible illisible" };
    }
    const targetCommit = target.stdout.trim();
    // La version candidate DOIT contenir le travail fusionné : le commit de fusion de la PR (désormais toujours
    // connu — un déploiement sans ce champ a été refusé plus haut) doit être un ancêtre de la cible. Sinon, on
    // tirerait un main qui n'inclut pas la correction (branche en retard, mauvais dépôt) — on refuse et on remet
    // le dépôt sur la version d'avant.
    if (fiche.merge_commit) {
      const anc = await r.git(["merge-base", "--is-ancestor", fiche.merge_commit, targetCommit]);
      if (!anc.ok) {
        const restored = await restoreToRecovery();
        abortPrep(restored);
        void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » non déployée — la version récupérée (${targetCommit.slice(0, 7)}) ne contient pas le commit de fusion de la PR (${fiche.merge_commit.slice(0, 7)}).${restored ? " Dépôt remis sur la version d'avant." : " Remise NON confirmée — interviens."}`, "system", "alert");
        return { error: "commit de fusion absent de la cible" };
      }
    }
    improve.setDeployTarget(id, targetCommit, r.now());
    // Filet de la surveillance locale, posé AVANT le redémarrage : sans lui, une version qui ne démarre pas
    // resterait en place. Faute de pouvoir le poser, on ne déploie pas.
    if (!r.markPending(commit, targetCommit)) {
      const restored = await restoreToRecovery();
      abortPrep(restored);
      void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » non déployée — je n'ai pas pu poser le filet de la surveillance locale (data/deploy-pending).${restored ? " Dépôt remis sur la version d'avant." : " Remise NON confirmée — interviens."}`, "system", "alert");
      return { error: "filet de déploiement impossible" };
    }
    improve.setDeployPhase(id, "restarting", r.now()); // phase persistée AVANT la commande de redémarrage
    // service.sh restart garde son propre contrôle de santé et revient à data/last-good-commit si Clark ne
    // répond pas. Ce redémarrage REMPLACE normalement le processus courant : dans ce cas, le code ci-dessous
    // n'est pas atteint, mais la fiche reste 'deploying' et la boucle la reprend dans la NOUVELLE instance.
    // S'il rend la main ici, c'est que le processus n'a PAS été remplacé (refus/échec) : finalizeDeploy le
    // verra (runningCommit resté l'ancien) et reviendra à 'merged'.
    const rs = await r.service("restart");
    const outcome = await finalizeDeploy(hub, r, id, rs);
    return outcome === "ok" ? "done" : outcome === "pending" ? "done" : { error: outcome };
  });
}

/**
 * Finalise une fiche 'deploying' : appelée après le restart (si le processus a survécu au redémarrage) ET par
 * la boucle au démarrage suivant (si le restart a remplacé le processus, la fiche est restée 'deploying', et
 * c'est la NOUVELLE instance qui finalise). On ne se fie PAS au HEAD du disque mais au commit RÉELLEMENT
 * exécuté par l'instance en cours (runningCommit) : il seul distingue « la nouvelle version tourne » d'un
 * redémarrage refusé où l'ancien processus continue malgré un disque déjà à jour. `restartResult` sert au
 * message quand on tient encore le résultat du redémarrage (chemin direct). Doit être appelée SOUS le verrou.
 */
async function finalizeDeploy(hub: Hub, r: Resolved, id: number, restartResult?: RunResult): Promise<"ok" | "pending" | string> {
  const improve = hub.deps.store.improve;
  const fiche = improve.get(id);
  if (!fiche || fiche.status !== "deploying") return "pending";
  const running = r.runningCommit().trim();
  if (!running) return "version en cours illisible à la finalisation"; // on retentera au prochain passage

  // Pas de cible figée : l'interruption est survenue AVANT le pull (aucune nouvelle version n'a été visée). Rien
  // n'a été déployé — l'instance tourne sur le commit de secours. On remet le disque sur ce commit (au cas où un
  // `git switch main` l'aurait avancé) et on revient à 'merged' sans effacer les références de récupération.
  if (!fiche.deploy_target) {
    const recovery = fiche.deploy_commit;
    let restored = true;
    if (recovery) {
      const diskNow = (await r.git(["rev-parse", "HEAD"])).stdout.trim();
      if (diskNow !== recovery) {
        const sw = await r.git(["switch", "--detach", recovery]);
        const back = await r.git(["rev-parse", "HEAD"]);
        restored = sw.ok && back.ok && back.stdout.trim() === recovery;
      }
    }
    if (restored) {
      r.clearPending();
      improve.failAfterRestart(id, r.now());
      void hub.post(OWNER_CHAT, `Auto-amélioration : le déploiement de « ${fiche.title} » a été interrompu avant d'avoir changé de version. Rien n'a changé, le bouton « Déployer » reste.`, "system", "alert");
      return "interrompu avant la cible";
    }
    improve.setDeployPhase(id, "failed", r.now());
    void hub.post(OWNER_CHAT, `Auto-amélioration : déploiement de « ${fiche.title} » interrompu, et la remise du dépôt sur la version qui tourne n'est pas confirmée. Interviens.`, "system", "alert");
    return "interrompu avant la cible (remise non confirmée)";
  }

  // L'instance en cours NE tourne PAS sur la cible : le redémarrage n'a pas remplacé le processus (refus ou
  // échec), ou le service est revenu à sa dernière bonne version. Rien n'a été déployé pour de vrai. Le disque,
  // lui, peut être resté sur la cible (le pull l'a avancé) : il faut le REMETTRE sur le commit de secours (la
  // version qui tourne) pour qu'une surveillance locale ne redémarre pas Clark sur la version non validée. On
  // ne conclut (et on ne libère le bouton) qu'après avoir vérifié la remise ; sinon on laisse la fiche
  // 'deploying' (reprenable) sans effacer les références de récupération.
  if (running !== fiche.deploy_target) {
    const recovery = fiche.deploy_commit;
    let restored = true;
    if (recovery && running === recovery) {
      const sw = await r.git(["switch", "--detach", recovery]);
      const back = await r.git(["rev-parse", "HEAD"]);
      restored = sw.ok && back.ok && back.stdout.trim() === recovery;
    } else if (recovery && running !== recovery) {
      // L'instance ne tourne ni sur la cible ni sur le commit de secours attendu : situation inattendue, on ne
      // devine pas où remettre le disque. On garde les références et on demande une intervention.
      restored = false;
    }
    const why =
      restartResult && !restartResult.ok
        ? "le redémarrage a échoué"
        : recovery && running === recovery
          ? "le service est resté sur l'ancienne version"
          : "l'instance en cours ne tourne pas sur la version visée";
    if (restored) {
      r.clearPending();
      improve.failAfterRestart(id, r.now()); // revenu à 'merged', phase 'failed', références de récupération gardées
      void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » n'a pas démarré sur la nouvelle version (${why}). Dépôt remis sur la version qui tourne, le bouton « Déployer » reste.`, "system", "alert");
      return "déploiement sans effet";
    }
    improve.setDeployPhase(id, "failed", r.now()); // laissée 'deploying' (reprenable), sans effacer les références
    void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » n'a pas démarré sur la nouvelle version (${why}) ET la remise du dépôt sur la version qui tourne n'est pas confirmée. Interviens — je ne touche plus au dépôt.`, "system", "alert");
    return "déploiement sans effet (remise non confirmée)";
  }
  // La nouvelle version tourne. Santé au rouge juste après : régression immédiate → retour arrière (persisté).
  if (r.snapshot(r.now()).healthBad) {
    r.clearPending(); // le retour arrière est pris en main ici : la surveillance n'a pas à s'en mêler
    await toRollback(hub, r, id, [{ code: "sante-degradee", detail: "la santé était au rouge juste après le déploiement" }]);
    return "retour arrière immédiat (santé)";
  }
  // L'observation démarre maintenant (démarrage confirmé) : on FIGE son échéance ici une fois pour toutes.
  const startedAt = r.now();
  const deadline = new Date(startedAt.getTime() + r.watchMinutes * 60_000);
  if (!improve.setWatching(id, startedAt, deadline)) return "pending";
  r.clearPending(); // démarrage confirmé : la surveillance n'a plus à revenir en arrière
  void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » déployée (${running.slice(0, 7)}). J'observe ${r.watchMinutes} min ; retour arrière automatique en cas de régression, bilan dans ${BILAN_DELAY_DAYS} jours.`, "system", "health");
  return "ok";
}

/**
 * Enregistre la régression AVANT d'agir (statut 'reverting' + signes figés), puis tente le retour arrière.
 * Si le redémarrage coupe Clark, si la santé se rétablit ou si la fenêtre expire entre-temps, la fiche reste
 * 'reverting' : la boucle reprendra le retour arrière (resumeReverting) jusqu'à confirmation. Sous verrou.
 */
async function toRollback(hub: Hub, r: Resolved, id: number, signs: RegressionSign[]): Promise<boolean> {
  const improve = hub.deps.store.improve;
  improve.enterReverting(id, JSON.stringify(signs), r.now());
  const fiche = improve.get(id);
  if (!fiche || fiche.status !== "reverting") return false;
  return rollback(hub, r, fiche, signs);
}

/**
 * Retour arrière AUTOMATIQUE au commit d'avant le déploiement (filet de sécurité, aucun état neuf). La fiche
 * est déjà 'reverting' (intention persistée). N'annonce le retour QUE s'il est vérifié : `git switch` réussi,
 * service redémarré, et HEAD effectivement revenue au commit visé. Sinon, alerte FIDÈLE et fiche LAISSÉE
 * 'reverting' (reprenable) — la boucle retentera. Renvoie true si le retour est confirmé. Sous verrou.
 */
async function rollback(hub: Hub, r: Resolved, fiche: Improvement, signs: RegressionSign[]): Promise<boolean> {
  const improve = hub.deps.store.improve;
  const commit = fiche.deploy_commit;
  const evidence = signs.map((s) => `• ${redactSecrets(s.detail)}`).join("\n");
  if (!commit) {
    void hub.post(OWNER_CHAT, `Auto-amélioration : régression vue sur « ${fiche.title} » mais AUCUN commit de secours n'est connu — je ne peux pas revenir seul. Interviens.\n${evidence}`, "system", "alert");
    return false;
  }
  const close = (): void => {
    r.clearPending();
    improve.finishImprovement(fiche.id, "rate", `Régression après déploiement : ${signs.map((s) => s.code).join(", ")}.`, r.now());
    improve.setDeployPhase(fiche.id, "rollback_done", r.now());
  };

  // Déjà revenu : l'instance en cours tourne DÉJÀ sur le commit de secours (cas d'une reprise après un
  // redémarrage qui a remplacé le processus par la version de secours). Le redémarrage est CONFIRMÉ : on clôt,
  // sans redémarrer de nouveau (sinon chaque reprise relancerait un redémarrage, en boucle).
  const running = r.runningCommit().trim();
  if (running && running === commit) {
    close();
    void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » annulée. Régression après le déploiement, je suis revenu à ${commit.slice(0, 7)} tout seul :\n${evidence}`, "system", "alert");
    return true;
  }
  // L'instance ne tourne NI sur la version en régression (deploy_target) NI sur le commit de secours : une
  // AUTRE version a été installée depuis (Clark a été remplacé entre-temps). On ne « downgrade » pas vers le
  // secours — on clôt la fiche (la régression reste enregistrée) sans toucher au dépôt. C'est ce qui clôt
  // proprement, lors d'un déploiement ultérieur, une fiche 'reverting' laissée ouverte parce que la version de
  // secours (antérieure à cette fonctionnalité) ignorait la reprise : la confirmation survit au remplacement.
  if (running && fiche.deploy_target && running !== fiche.deploy_target) {
    close();
    void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » close. Régression enregistrée après le déploiement, mais Clark tourne déjà sur une autre version (${running.slice(0, 7)}) — je ne touche pas au dépôt :\n${evidence}`, "system", "alert");
    return true;
  }

  // Pas encore revenu : on place le disque sur le commit de secours. L'ORDRE est crucial : le script de
  // redémarrage de secours doit être figé TANT QUE le disque porte encore la version candidate (celle qui gère
  // `--rollback`) — donc AVANT le `git switch`. Après le switch, `scripts/service.sh` du checkout est celui du
  // commit de secours, peut-être ANTÉRIEUR à cette fonctionnalité : le figer là-dessus installerait un script
  // qui ignore `--rollback`. Sur une REPRISE (disque déjà sur le secours), on ne re-fige donc PAS — on garde la
  // copie du premier passage.
  const head = await r.git(["rev-parse", "HEAD"]);
  const onRecovery = head.ok && head.stdout.trim() === commit;
  if (!onRecovery) {
    // Disque encore sur la version candidate : on fige SON service.sh (qui gère `--rollback`), puis on switch.
    if (!r.pinRollbackScript()) {
      void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » — je n'ai pas pu préparer le script de redémarrage de secours avant de revenir en arrière. Je ne touche pas au dépôt et je ne redémarre pas. Interviens.\n${evidence}`, "system", "alert");
      return false; // fiche laissée 'reverting' : rien n'a bougé, reprenable
    }
    const sw = await r.git(["switch", "--detach", commit]);
    const after = await r.git(["rev-parse", "HEAD"]);
    if (!sw.ok || !after.ok || after.stdout.trim() !== commit) {
      void hub.post(OWNER_CHAT, `Auto-amélioration : régression vue sur « ${fiche.title} », mais le retour arrière a ÉCHOUÉ (git switch : ${firstLine(sw.stderr)}). Clark tourne peut-être ENCORE sur la version en régression — interviens.\n${evidence}`, "system", "alert");
      return false; // fiche laissée 'reverting' : reprenable, la boucle retentera
    }
  }

  // Le disque est confirmé sur le commit de secours. DEUX protections AVANT de redémarrer, car le redémarrage
  // qui suit ne doit dépendre ni du service.sh embarqué dans le commit de secours (peut-être ANTÉRIEUR à cette
  // fonctionnalité : il ignorerait `--rollback` et pourrait installer la surveillance), ni du last-good :
  //  (a) on note le commit de secours comme « dernière bonne version » (data/last-good-commit) : même un
  //      service.sh qui « reviendrait au last-good » reviendrait ICI, jamais sur la version en régression ;
  //  (b) le script de secours figé (ci-dessus, ou à un passage antérieur) DOIT être présent : c'est par lui que
  //      passe `restart --rollback`. Absent, on ne redémarre PAS tout seul (on ne retombe pas sur un service.sh
  //      de secours peut-être trop ancien).
  // Si l'une des deux échoue, on NE redémarre PAS (on ne masque pas l'échec) : la fiche reste 'reverting'
  // (reprenable), le disque est déjà sur le secours, on alerte pour une reprise manuelle.
  if (!r.recordGood(commit)) {
    void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » — dépôt remis sur ${commit.slice(0, 7)}, mais je n'ai pas pu le noter comme « dernière bonne version ». Je ne redémarre pas (risque de retour à la version en régression). Interviens.\n${evidence}`, "system", "alert");
    return false;
  }
  if (!r.rollbackScriptReady()) {
    void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » — dépôt remis sur ${commit.slice(0, 7)} et noté bon, mais le script de redémarrage de secours est absent. Je ne redémarre pas tout seul. Interviens.\n${evidence}`, "system", "alert");
    return false;
  }

  void hub.post(OWNER_CHAT, `Auto-amélioration : « ${fiche.title} » annulée. J'ai vu une régression après le déploiement, je reviens à ${commit.slice(0, 7)} (noté comme bonne version) et je redémarre :\n${evidence}`, "system", "alert");

  // Redémarrage de secours, via le script figé. S'il REMPLACE le processus, la suite n'est pas atteinte : la
  // fiche reste 'reverting' (rollback_pending) et sera clôturée à la reprise (running === commit, ou — si la
  // version de secours ignore la reprise — par la garde « tourne déjà sur une autre version » au déploiement
  // suivant). On ne CLÔT ici qu'une fois le redémarrage CONFIRMÉ : l'instance tourne bien sur le commit de
  // secours. On distingue ainsi la remise du disque (faite) de la confirmation du redémarrage (vérifiée).
  const rs = await r.service("restart --rollback");
  if (r.runningCommit().trim() === commit) {
    close();
    return true;
  }
  void hub.post(
    OWNER_CHAT,
    rs.ok
      ? `Auto-amélioration : « ${fiche.title} » — dépôt remis sur ${commit.slice(0, 7)} et noté bon, redémarrage lancé mais pas encore confirmé. Je revérifie au prochain passage ; relance le service à la main si Clark tourne encore sur la version en régression.`
      : `Auto-amélioration : « ${fiche.title} » — dépôt remis sur ${commit.slice(0, 7)} et noté bon, mais le redémarrage n'est pas confirmé (${firstLine(rs.stderr)}). Relance le service à la main si Clark tourne encore sur la version en régression.`,
    "system",
    "alert",
  );
  return false; // fiche laissée 'reverting' : la reprise confirmera (ou clôturera) au prochain passage
}

/** Première ligne d'une sortie d'erreur, expurgée et bornée (jamais de secret dans un message). */
function firstLine(s: string): string {
  return redactSecrets((s || "").split("\n")[0] ?? "").slice(0, 160);
}

/** Le bilan J+3 : résultat rangé dans la fiche et au Calendrier (tâche de journal sur un chat dédié). */
function fileBilan(hub: Hub, fiche: Improvement, outcome: "atteint" | "partiel" | "rate", beforePerDay: number, afterTotal: number, now: Date): void {
  const { journal, store } = hub.deps;
  const label = outcome === "atteint" ? "atteint" : outcome === "partiel" ? "partiellement atteint" : "raté";
  const note = `Signature visée depuis le déploiement : ${afterTotal} occurrence${afterTotal > 1 ? "s" : ""} (rythme d'avant : ${beforePerDay.toFixed(1)}/jour). Résultat : ${label}.`;
  store.improve.finishImprovement(fiche.id, outcome, note, now);
  const t = journal.create(AMELIORE_BILAN_CHAT, AMELIORE_BILAN_LABEL, `Bilan d'auto-amélioration : ${fiche.title}`);
  journal.finish(t, "done", `## ${fiche.title}\n\nRésultat à J+${BILAN_DELAY_DAYS} : **${label}**.\n\n${note}`, 0);
  void hub.post(OWNER_CHAT, `Auto-amélioration : bilan de « ${fiche.title} » — ${label}. ${note}`, "system", "health");
}

/** Une fiche 'launched' dont la PR du groupe est fusionnée passe 'merged' (jamais fusionné par Clark). */
export function detectMerges(hub: Hub, now: Date): void {
  const { store } = hub.deps;
  for (const fiche of store.improve.fiches(["launched"])) {
    if (fiche.group_id == null) continue;
    const group = store.dev.group(fiche.group_id);
    if (!group?.pr_status) continue;
    let pr: PrStatus;
    try {
      pr = JSON.parse(group.pr_status) as PrStatus;
    } catch {
      continue;
    }
    if (pr.state !== "MERGED") continue;
    if (store.improve.setMerged(fiche.id, group.pr_url ?? fiche.pr_url, pr.mergeCommit ?? null, now)) {
      void hub.post(OWNER_CHAT, `Auto-amélioration : la PR de « ${fiche.title} » est fusionnée. Déploie-la quand tu veux (Activité) — je ne déploie jamais tout seul.`, "system", "health");
    }
  }
  // Réactualisation : une fiche 'merged' sans commit de fusion (métadonnée pas encore relevée au moment du
  // merge) le récupère dès que le statut de PR du groupe le fournit. Sans réseau — on relit ce qui est déjà
  // stocké. Tant que le champ manque, le déploiement est refusé ; une fois rempli, le bouton redevient actif.
  for (const fiche of store.improve.fiches(["merged"])) {
    if (fiche.merge_commit || fiche.group_id == null) continue;
    const group = store.dev.group(fiche.group_id);
    if (!group?.pr_status) continue;
    let pr: PrStatus;
    try {
      pr = JSON.parse(group.pr_status) as PrStatus;
    } catch {
      continue;
    }
    if (pr.state === "MERGED" && pr.mergeCommit) store.improve.setMergeCommit(fiche.id, pr.mergeCommit, now);
  }
}

/**
 * Reprend les fiches restées 'deploying' (le restart a pu arrêter Clark avant la finalisation) : on vérifie
 * la version démarrée et la santé, puis on lance l'observation ou on revient en arrière. Sous verrou.
 */
export async function resumeDeploying(hub: Hub, opts: ImproveDeployOptions): Promise<void> {
  const r = resolve(hub, opts);
  for (const fiche of hub.deps.store.improve.fiches(["deploying"])) {
    await withRepoLock(r.root, () => finalizeDeploy(hub, r, fiche.id));
  }
}

/**
 * Reprend les fiches restées 'reverting' : un retour arrière décidé mais interrompu (redémarrage qui a coupé
 * Clark, échec transitoire, fenêtre expirée entre-temps) n'est jamais abandonné. On rejoue le retour arrière à
 * partir des signes figés, jusqu'à confirmation. Une fiche 'reverting' n'est JAMAIS clôturée en bilan 'atteint'.
 */
export async function resumeReverting(hub: Hub, opts: ImproveDeployOptions): Promise<void> {
  const r = resolve(hub, opts);
  for (const fiche of hub.deps.store.improve.fiches(["reverting"])) {
    let signs: RegressionSign[] = [];
    try {
      signs = fiche.revert_signs ? (JSON.parse(fiche.revert_signs) as RegressionSign[]) : [];
    } catch {
      signs = [];
    }
    if (!signs.length) signs = [{ code: "sante-degradee", detail: "régression constatée (détail non relu)" }];
    await withRepoLock(r.root, () => rollback(hub, r, hub.deps.store.improve.get(fiche.id)!, signs));
  }
}

/** Avance les fiches 'watching' : régression (retour arrière) pendant la fenêtre, sinon bilan à J+3. */
export async function advanceWatching(hub: Hub, opts: ImproveDeployOptions, now: Date): Promise<void> {
  const r = resolve(hub, opts);
  const { store } = hub.deps;
  for (const fiche of store.improve.fiches(["watching"])) {
    // L'observation démarre à sa CONFIRMATION (watch_at), pas au clic (deploy_at) : le temps du git/restart
    // n'est pas décompté de la fenêtre. deploy_at ne sert plus que de repli pour d'anciennes fiches.
    const watchAt = parseSqlUtc(fiche.watch_at) ?? parseSqlUtc(fiche.deploy_at);
    if (!watchAt || !fiche.watch_baseline) continue;
    let baseline: RegressionBefore;
    try {
      baseline = JSON.parse(fiche.watch_baseline) as RegressionBefore;
    } catch {
      continue;
    }
    const snap = r.snapshot(now);
    // Récidives DEPUIS le déploiement : somme des jours >= jour du déploiement, moins le figé du déploiement.
    // Pas de soustraction de deux totaux glissants (une occurrence ancienne qui sort de la fenêtre ne peut
    // plus compenser une récidive). Le curseur (baseline.targetFromDeployDay) a été PERSISTÉ au déploiement.
    const current = targetSince(store.improve, fiche.source, fiche.signature, baseline.deployDay);
    const targetSinceDeploy = Math.max(0, current - baseline.targetFromDeployDay);

    // Échéance FIGÉE au démarrage confirmé (watch_deadline) : elle ne dépend plus de watchMinutes et ne bouge
    // pas d'une reprise à l'autre. (Repli watch_at + watchMinutes pour d'anciennes fiches sans échéance figée.)
    const deadline = parseSqlUtc(fiche.watch_deadline) ?? new Date(watchAt.getTime() + r.watchMinutes * 60_000);
    const afterDeadline = now.getTime() > deadline.getTime();
    if (!fiche.watch_closed_at) {
      if (!afterDeadline) {
        // Dans la fenêtre : évaluation complète sur l'état courant.
        const signs = regression(baseline, { ...snap, targetSinceDeploy });
        if (signs.length) {
          await withRepoLock(r.root, () => toRollback(hub, r, fiche.id, signs));
          continue;
        }
        continue; // encore dans la fenêtre, rien à signaler
      }
      // Premier passage APRÈS l'échéance. Avant de clore, on honore les preuves HORODATÉES et attribuables à la
      // fenêtre (survenues ≤ échéance) qu'on ne verrait que maintenant (un tick a pu manquer). On ne retient que
      // ce qui porte un VRAI horodatage comparable à l'échéance : un redémarrage de la surveillance locale daté
      // ≤ échéance. Les récidives de signature, elles, sont comptées AU JOUR (pas d'horodatage sous-journalier) :
      // on NE peut pas dire si une récidive du jour de l'échéance a eu lieu avant ou après 2 h — déclencher un
      // retour arrière là-dessus risquerait d'annuler sur une récidive POSTÉRIEURE à la fenêtre. On ne s'en sert
      // donc plus pour le retour arrière auto passé l'échéance ; elles sont prises en compte par le bilan J+3.
      const wdInWindow =
        !!snap.watchdogMarker &&
        snap.watchdogMarker !== baseline.watchdogMarker &&
        (parseSqlUtc(snap.watchdogMarker)?.getTime() ?? Number.POSITIVE_INFINITY) <= deadline.getTime();
      if (wdInWindow) {
        await withRepoLock(r.root, () => toRollback(hub, r, fiche.id, [{ code: "watchdog", detail: "la surveillance locale a dû redémarrer Clark pendant la fenêtre" }]));
        continue;
      }
      store.improve.setWatchClosed(fiche.id, now); // échéance franchie sans régression dans la fenêtre : close
    }
    // Fenêtre close : on attend J+3 (depuis le début d'observation), puis bilan.
    if (now.getTime() - watchAt.getTime() < BILAN_DELAY_DAYS * 86_400_000) continue;
    const beforeTotal = (() => {
      try {
        return (JSON.parse(fiche.before) as { total: number }).total;
      } catch {
        return 0;
      }
    })();
    const beforePerDay = beforeTotal / IMPROVE_WINDOW_DAYS;
    const afterPerDay = targetSinceDeploy / BILAN_DELAY_DAYS;
    fileBilan(hub, fiche, bilanOutcome(beforePerDay, targetSinceDeploy, afterPerDay), beforePerDay, targetSinceDeploy, now);
  }
}

/**
 * Boucle légère : reprend d'abord une finalisation interrompue par un redémarrage, repère les PR fusionnées
 * (→ bouton « Déployer »), puis fait avancer l'observation et le bilan. Ne déploie rien : le déploiement
 * attend toujours le clic de l'utilisateur. Minuterie .unref().
 */
export function startImproveDeployLoop(hub: Hub, opts: ImproveDeployOptions): () => void {
  const r = resolve(hub, opts);
  let busy = false;
  const tick = async () => {
    if (busy || !hub.deps.store.db.isOpen) return;
    busy = true;
    try {
      const now = r.now();
      await resumeDeploying(hub, opts);
      await resumeReverting(hub, opts); // un retour arrière interrompu par un redémarrage est repris ici
      detectMerges(hub, now);
      await advanceWatching(hub, opts, now);
    } catch (err) {
      console.warn("[clark] auto-amélioration (déploiement) : passage impossible :", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  void tick(); // un premier passage au démarrage : reprend tout de suite une fiche restée 'deploying'.
  const timer = setInterval(() => void tick(), r.everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
