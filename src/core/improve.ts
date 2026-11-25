import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { countErrors, errorSignature } from "./health.ts";
import { redactSecrets } from "./redact.ts";
import type { AlertState } from "./alerts.ts";
import { OWNER_CHAT } from "./conversation.ts";
import type { Hub } from "./hub.ts";
import type { startDevGroup } from "../dev/groups.ts";

/**
 * Auto-amélioration encadrée de Clark : détecter, puis proposer.
 *
 * On relève en continu quatre sources de friction — erreurs répétées du journal, tâches en échec
 * par type, alertes de santé répétées, agents silencieux — et on range, jour par jour (jour réel à
 * Paris de l'occurrence), un compte par signature (une erreur « normalisée », cf. errorSignature).
 * Quand une même signature revient assez souvent et sur plusieurs jours (règle de RÉCURRENCE), on
 * ouvre une fiche « detected ».
 *
 * Rien de réel n'est stocké sans passer par redactSecrets : jamais de contenu de page, de .env, de clé
 * ni de jeton — seulement une ligne d'erreur courte et expurgée, et des titres tirés de libellés
 * maîtrisés.
 */

/** Type de source d'une friction. Rangé dans la colonne `source` (fait partie de l'identité). */
export type ImproveSourceKind = "error" | "task" | "alert" | "silent";

/** Règle de récurrence : au moins 5 occurrences au total, réparties sur au moins 2 jours, sur 7 jours. */
export const IMPROVE_MIN_OCCURRENCES = 5;
export const IMPROVE_MIN_DAYS = 2;
export const IMPROVE_WINDOW_DAYS = 7;
/** Une fiche mise en sommeil redevient proposable après 3 jours. */
export const IMPROVE_SNOOZE_DAYS = 3;
/**
 * Un raté (fiche 'done', `outcome = 'rate'`) ne se repropose pas tout de suite : la MÊME correction
 * vient d'échouer, la reproposer aussitôt tournerait en rond. On attend 14 jours (comme un 'dismissed'
 * assoupli) ; passé ce délai, si la friction persiste, la détection peut retenter — le problème est
 * peut-être devenu différent entre-temps.
 */
export const IMPROVE_RATE_GUARD_DAYS = 14;

export type FicheStatus = "detected" | "proposed" | "snoozed" | "dismissed" | "launched" | "merged" | "deploying" | "watching" | "reverting" | "done";
export type ImprovementAction = "launch" | "snooze" | "dismiss" | "deploy";

/**
 * Phase FINE du cycle de déploiement, persistée AVANT chaque commande système (en plus du `status`, plus
 * grossier). Elle rend la reprise après coupure précise : on sait exactement où la séquence s'est arrêtée.
 *   deploy_pending → pulled → restarting → watching          (déploiement réussi)
 *   watching → rollback_pending → rollback_done              (régression puis retour arrière)
 *   … → failed                                               (échec/sans effet, revenu à 'merged')
 */
export type DeployPhase = "deploy_pending" | "pulled" | "restarting" | "watching" | "rollback_pending" | "rollback_done" | "failed";
/** Durée par défaut de la fenêtre d'observation serrée (minutes), si aucune échéance figée n'est fournie. */
const WATCH_MINUTES_FALLBACK = 120;
export const IMPROVEMENT_TITLE_PREFIX = "Auto-amélioration :";

/** Mesure « avant » : les occurrences par jour sur la fenêtre, et leur total. */
export type Before = { days: { day: string; count: number }[]; total: number };

/** Un relevé d'une source, déjà attribué à un jour réel (Paris). L'exemple est expurgé au stockage. */
export type DayReading = { day: string; source: ImproveSourceKind; signature: string; count: number; example: string };

/** Les comptes journaliers déjà rangés pour une signature (entrée de `detect`, testable sans horloge). */
export type SignatureHistory = { signature: string; source: ImproveSourceKind; example: string; days: { day: string; count: number }[] };

/** Une signature jugée récurrente, avec sa mesure « avant » et un titre court. */
export type Detection = { signature: string; source: ImproveSourceKind; title: string; example: string; before: Before };

/** Une fiche d'amélioration (ligne de la table `improvements`). Identité : (signature, source). */
export type Improvement = {
  id: number;
  signature: string;
  title: string;
  source: ImproveSourceKind;
  examples: string;
  before: string;
  status: FicheStatus;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  group_id: number | null;
  pr_url: string | null;
  deploy_commit: string | null;
  /** Instant du clic « Déployer » (UTC SQLite) : base du bilan J+3 (l'observation démarre à watch_at). */
  deploy_at: string | null;
  /** Commit ATTENDU après le déploiement (la version qu'on vise, figée avant le redémarrage). */
  deploy_target: string | null;
  /** État « avant » figé au déploiement (JSON RegressionBefore) : sert à comparer pendant l'observation. */
  watch_baseline: string | null;
  /** Instant où l'observation a RÉELLEMENT commencé (confirmation du déploiement sur la nouvelle version). */
  watch_at: string | null;
  /** Instant où la fenêtre serrée a été close proprement (plus de retour arrière automatique après). */
  watch_closed_at: string | null;
  /** Échéance FIGÉE de la fenêtre d'observation (UTC SQLite), posée au démarrage confirmé : ne bouge plus. */
  watch_deadline: string | null;
  /** Phase fine du cycle de déploiement (cf. DeployPhase), écrite avant chaque commande système. */
  deploy_phase: string | null;
  /** Commit de fusion de la PR (oid) : on vérifie au déploiement qu'il est ancêtre de la version visée. */
  merge_commit: string | null;
  /** Signes de régression figés (JSON) avant le retour arrière : rendent le retour reprenable après coupure. */
  revert_signs: string | null;
  outcome: string | null;
  outcome_note: string | null;
  bilan_at: string | null;
};

/** Les quatre sources injectables (vraies dans l'index, fausses dans les tests). Chacune reçoit `now`. */
export type ImproveSources = {
  errors: (now: Date) => DayReading[];
  tasks: (now: Date) => DayReading[];
  alerts: (now: Date) => DayReading[];
  silent: (now: Date) => DayReading[];
};

/** Un jour à Paris (AAAA-MM-JJ). */
const parisDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });

/** AAAA-MM-JJ décalé de n jours (midi UTC : insensible au changement d'heure). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Les jours de la fenêtre se terminant à `now`, du plus ancien au plus récent. */
function windowOf(now: Date, days: number): string[] {
  const today = parisDay(now);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

/** Un instant UTC au format SQLite (« AAAA-MM-JJ HH:MM:SS »). */
const toSqlUtc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** Lit une date SQLite UTC (« AAAA-MM-JJ HH:MM:SS »), ou null. */
function parseSqlUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Nettoie et borne un texte avant stockage (défense en profondeur ; les sources ne fournissent déjà
 * que des libellés maîtrisés). En plus de `redactSecrets` (formats connus), on masque ce qui ressemble
 * à un secret de format inconnu : les affectations NOM=valeur, avec ou SANS espaces autour du `=` (on
 * garde le nom), et les longues chaînes sans espace (> 24 caractères : jetons, blobs, chemins denses).
 * Puis une seule ligne, bornée à 160 caractères.
 */
const clean = (text: string) =>
  redactSecrets(text)
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S+/g, "$1=<masqué>")
    .replace(/\S{25,}/g, "<masqué>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

/** Vocabulaire fixe des catégories d'échec (liste blanche) : seul ce qui en vient entre dans un exemple d'erreur. */
const ERROR_KEYWORDS = ["timeout", "expired", "impossible", "introuvable", "refus", "non envoyé", "non remise", "échec", "erreur", "error", "plant"];

/**
 * Un exemple d'erreur SÛR : jamais la ligne brute du journal (qui peut contenir un secret de format
 * inconnu ou un extrait de page composé de mots courts), seulement les catégories d'échec reconnues,
 * tirées d'une liste blanche. La ligne brute ne sert qu'en mémoire, pour la signature — un condensé
 * non réversible.
 */
function errorExample(line: string): string {
  const low = line.toLowerCase();
  const hits = ERROR_KEYWORDS.filter((k) => low.includes(k));
  return hits.length ? `Erreur récurrente : ${hits.join(", ")}` : "Erreur récurrente dans le journal";
}

/** Libellé d'un échec de tâche, depuis l'ensemble FIXE des statuts (jamais le `label` libre de la tâche). */
function taskExample(status: string): string {
  const kind = status === "needs_check" ? "à vérifier" : status === "abandoned" ? "abandon" : "échec";
  return `Tâche en échec : ${kind}`;
}

/** Catégories d'alerte de santé connues (liste blanche) : un exemple n'en vient que de là, jamais du texte libre. */
const ALERT_CATEGORIES: [RegExp, string][] = [
  [/sauvegarde distante/i, "sauvegarde distante"],
  [/exercice de restauration/i, "exercice de restauration"],
  [/sauvegarde/i, "sauvegarde"],
  [/quota/i, "quota"],
  [/connecté/i, "moteur déconnecté"],
  [/disque|place sur le disque/i, "disque"],
  [/détach/i, "version détachée"],
  [/silencieux/i, "agents silencieux"],
  [/répétée/i, "erreur répétée"],
  [/en échec|échec/i, "tâches en échec"],
  [/attend|en attente/i, "file d'attente"],
  [/ping|injoignable/i, "ping externe"],
];

/**
 * Un exemple d'alerte SÛR : jamais le texte libre de l'alerte (il peut porter un secret court ou un
 * extrait), seulement une catégorie tirée de la liste blanche ci-dessus. Le texte brut ne sert qu'en
 * mémoire, pour la signature (condensé non réversible).
 */
function alertExample(text: string): string {
  const hit = ALERT_CATEGORIES.find(([re]) => re.test(text));
  return hit ? `Alerte de santé : ${hit[1]}` : "Alerte de santé répétée";
}

/**
 * Un titre court, entièrement maîtrisé : un libellé fixe par source, jamais dérivé d'un texte libre
 * (ni ligne d'erreur, ni label de tâche). Le détail reste dans l'exemple, expurgé.
 */
function titleFor(source: ImproveSourceKind): string {
  switch (source) {
    case "task":
      return "Tâches en échec à répétition";
    case "alert":
      return "Alerte de santé répétée";
    case "silent":
      return "Agents silencieux à répétition";
    default:
      return "Erreur récurrente dans le journal";
  }
}

/**
 * La règle de RÉCURRENCE, pure. À partir des comptes journaliers déjà rangés, garde les signatures
 * vues au moins IMPROVE_MIN_OCCURRENCES fois au total ET sur au moins IMPROVE_MIN_DAYS jours distincts,
 * dans la fenêtre des IMPROVE_WINDOW_DAYS jours se terminant à `now`. Renvoie chacune avec sa mesure
 * « avant » (occurrences par jour sur la fenêtre + total) et un titre court maîtrisé.
 */
export function detect(histories: SignatureHistory[], opts: { now: Date }): Detection[] {
  const win = windowOf(opts.now, IMPROVE_WINDOW_DAYS);
  const inWindow = new Set(win);
  const out: Detection[] = [];
  for (const h of histories) {
    const byDay = new Map<string, number>();
    for (const d of h.days) if (inWindow.has(d.day)) byDay.set(d.day, Math.max(byDay.get(d.day) ?? 0, d.count));
    const days = win.map((day) => ({ day, count: byDay.get(day) ?? 0 }));
    const total = days.reduce((s, d) => s + d.count, 0);
    const activeDays = days.filter((d) => d.count > 0).length;
    if (total >= IMPROVE_MIN_OCCURRENCES && activeDays >= IMPROVE_MIN_DAYS) {
      out.push({ signature: h.signature, source: h.source, example: h.example, title: titleFor(h.source), before: { days, total } });
    }
  }
  return out;
}

/** Une fiche en sommeil l'est-elle encore (pas écoulé les 3 jours) ? Helper pour la phase 2. */
export function isSnoozed(fiche: Pick<Improvement, "status" | "decided_at">, now: Date): boolean {
  if (fiche.status !== "snoozed" || !fiche.decided_at) return false;
  const decided = parseSqlUtc(fiche.decided_at);
  if (!decided) return false;
  return now.getTime() - decided.getTime() < IMPROVE_SNOOZE_DAYS * 86_400_000;
}

/** Un raté est-il encore sous garde (le délai des 14 jours depuis le bilan n'est pas écoulé) ? */
export function isRateGuarded(fiche: Pick<Improvement, "status" | "outcome" | "bilan_at">, now: Date): boolean {
  if (fiche.status !== "done" || fiche.outcome !== "rate") return false;
  const at = parseSqlUtc(fiche.bilan_at);
  if (!at) return true; // raté sans date de bilan : on ne retente pas
  return now.getTime() - at.getTime() < IMPROVE_RATE_GUARD_DAYS * 86_400_000;
}

/** Peut-on (re)poser une fiche 'detected' pour cette signature, vu la fiche déjà en base ? */
function canRefresh(fiche: Improvement, now: Date): boolean {
  switch (fiche.status) {
    case "detected":
      return true; // on rafraîchit sa mesure « avant »
    case "snoozed":
      return !isSnoozed(fiche, now); // seulement si le sommeil est écoulé
    case "done":
      // Un raté se retente une fois la garde écoulée ; une réussite (atteint/partiel) ne se repropose pas.
      return fiche.outcome === "rate" && !isRateGuarded(fiche, now);
    default:
      // 'dismissed' (écartée) et tous les états en cours : on n'y touche pas.
      return false;
  }
}

/**
 * Journal des comptes par signature et par jour, et fiches d'amélioration. Même base que le reste ;
 * tables créées à la volée (comme les autres stores). La source fait partie de l'identité d'une
 * signature : une alerte et une erreur au même texte restent distinctes.
 */
export class ImproveStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS improve_signatures (
        day       TEXT NOT NULL,
        source    TEXT NOT NULL DEFAULT 'error',
        signature TEXT NOT NULL,
        count     INTEGER NOT NULL DEFAULT 0,
        example   TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (day, source, signature)
      );
      CREATE TABLE IF NOT EXISTS improvements (
        id            INTEGER PRIMARY KEY,
        signature     TEXT NOT NULL,
        source        TEXT NOT NULL DEFAULT 'error',
        title         TEXT NOT NULL,
        examples      TEXT NOT NULL DEFAULT '[]',
        "before"      TEXT NOT NULL DEFAULT '{}',
        status        TEXT NOT NULL DEFAULT 'detected',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at    TEXT,
        group_id      INTEGER,
        pr_url        TEXT,
        deploy_commit TEXT,
        deploy_at     TEXT,
        deploy_target TEXT,
        watch_baseline TEXT,
        watch_at      TEXT,
        watch_closed_at TEXT,
        watch_deadline TEXT,
        deploy_phase  TEXT,
        merge_commit  TEXT,
        revert_signs  TEXT,
        outcome       TEXT,
        outcome_note  TEXT,
        bilan_at      TEXT,
        UNIQUE (signature, source)
      );
    `);
    // Colonnes ajoutées après coup (bases déjà créées par une version précédente des fiches).
    for (const [col, def] of [["deploy_at", "TEXT"], ["deploy_target", "TEXT"], ["watch_baseline", "TEXT"], ["watch_at", "TEXT"], ["watch_closed_at", "TEXT"], ["watch_deadline", "TEXT"], ["deploy_phase", "TEXT"], ["merge_commit", "TEXT"], ["revert_signs", "TEXT"]] as const) {
      const cols = db.prepare("PRAGMA table_info(improvements)").all() as { name: string }[];
      if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE improvements ADD COLUMN ${col} ${def}`);
    }
  }

  /**
   * Range le compte d'un JOUR réel pour une signature, à MAX(stocké, count) : plusieurs relevés d'un
   * même jour ne s'additionnent pas (idempotent), et les jours passés ne bougent pas. Les sources
   * attribuent elles-mêmes chaque occurrence à son jour (updated_at, at, since, delta pour le journal).
   */
  record(day: string, source: ImproveSourceKind, signature: string, count: number, example: string) {
    this.db
      .prepare(
        `INSERT INTO improve_signatures (day, source, signature, count, example) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, source, signature) DO UPDATE SET
           example = CASE WHEN excluded.count >= improve_signatures.count THEN excluded.example ELSE improve_signatures.example END,
           count   = MAX(improve_signatures.count, excluded.count)`,
      )
      .run(day, source, signature, count, clean(example));
  }

  /**
   * Occurrences d'une signature à partir d'un jour donné (inclus), SANS fenêtre glissante : on somme les
   * jours >= fromDay. Sert à mesurer les récidives DEPUIS le déploiement, à l'abri de la sortie d'anciennes
   * occurrences de la fenêtre de 7 jours (qui fausserait une soustraction de deux totaux glissants).
   */
  countFromDay(source: ImproveSourceKind, signature: string, fromDay: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM improve_signatures WHERE source = ? AND signature = ? AND day >= ?")
      .get(source, signature, fromDay) as { n: number };
    return row.n;
  }

  /** Les occurrences par jour d'une signature (source comprise) sur la fenêtre, et leur total. */
  dailyCounts(source: ImproveSourceKind, signature: string, days = IMPROVE_WINDOW_DAYS, now = new Date()): Before {
    const win = windowOf(now, days);
    const rows = this.db.prepare("SELECT day, count FROM improve_signatures WHERE source = ? AND signature = ?").all(source, signature) as { day: string; count: number }[];
    const byDay = new Map(rows.map((r) => [r.day, r.count]));
    const out = win.map((day) => ({ day, count: byDay.get(day) ?? 0 }));
    return { days: out, total: out.reduce((s, d) => s + d.count, 0) };
  }

  /** Les historiques par (source, signature) depuis `fromDay` (entrée de `detect`). */
  histories(fromDay: string): SignatureHistory[] {
    const rows = this.db
      .prepare("SELECT source, signature, day, count, example FROM improve_signatures WHERE day >= ? ORDER BY source, signature, day")
      .all(fromDay) as { source: ImproveSourceKind; signature: string; day: string; count: number; example: string }[];
    const map = new Map<string, SignatureHistory & { best: number }>();
    for (const r of rows) {
      const key = `${r.source}\u0000${r.signature}`;
      let h = map.get(key);
      if (!h) {
        h = { signature: r.signature, source: r.source, example: r.example, days: [], best: -1 };
        map.set(key, h);
      }
      h.days.push({ day: r.day, count: r.count });
      if (r.count > h.best) ((h.best = r.count), (h.example = r.example));
    }
    return [...map.values()].map(({ best: _best, ...h }) => h);
  }

  fiche(source: ImproveSourceKind, signature: string): Improvement | undefined {
    return this.db.prepare("SELECT * FROM improvements WHERE source = ? AND signature = ?").get(source, signature) as Improvement | undefined;
  }

  fiches(statuses?: FicheStatus[]): Improvement[] {
    if (statuses && statuses.length) {
      const marks = statuses.map(() => "?").join(", ");
      return this.db.prepare(`SELECT * FROM improvements WHERE status IN (${marks}) ORDER BY updated_at DESC`).all(...statuses) as Improvement[];
    }
    return this.db.prepare("SELECT * FROM improvements ORDER BY updated_at DESC").all() as Improvement[];
  }

  get(id: number): Improvement | undefined {
    return this.db.prepare("SELECT * FROM improvements WHERE id = ?").get(id) as Improvement | undefined;
  }

  /** Réserve une proposition et son quota journalier dans la même transaction. */
  propose(now: Date): Improvement | undefined {
    const day = parisDay(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT value FROM app_settings WHERE key = 'improve_proposed_day'").get() as { value: string } | undefined;
      let proposed: Improvement | undefined;
      if (last?.value !== day && !this.fiches(["proposed", "launched", "merged", "deploying", "watching", "reverting"]).length) {
        const candidate = this.fiches(["detected", "snoozed"])
          .filter((f) => !isSnoozed(f, now))
          .sort((a, b) => improvementBefore(b).total - improvementBefore(a).total || a.id - b.id)[0];
        if (candidate) {
          this.setStatus(candidate.source, candidate.signature, "proposed", now);
          this.db.prepare(`INSERT INTO app_settings (key, value) VALUES ('improve_proposed_day', ?)
            ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(day);
          proposed = this.get(candidate.id);
        }
      }
      this.db.exec("COMMIT");
      return proposed;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  decide(id: number, status: "launched" | "snoozed" | "dismissed", now: Date, groupId: number | null = null): boolean {
    const at = toSqlUtc(now);
    return this.db.prepare("UPDATE improvements SET status = ?, decided_at = ?, updated_at = ?, group_id = ? WHERE id = ? AND status = 'proposed'")
      .run(status, at, at, groupId, id).changes === 1;
  }

  /** Crée ou rafraîchit une fiche. Titre et exemples sont expurgés avant d'être stockés (défense). */
  upsertFiche(f: { signature: string; source: ImproveSourceKind; title: string; examples: string[]; before: Before; status?: FicheStatus }) {
    const status = f.status ?? "detected";
    const examples = JSON.stringify((f.examples ?? []).map((e) => clean(e)));
    const before = JSON.stringify(f.before);
    this.db
      .prepare(
        `INSERT INTO improvements (signature, source, title, examples, "before", status) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(signature, source) DO UPDATE SET
           title = excluded.title, examples = excluded.examples,
           "before" = excluded."before", status = excluded.status, updated_at = datetime('now'),
           -- Nouveau cycle de détection : on efface l'ancien parcours (lancement, PR, déploiement, bilan).
           decided_at = NULL, group_id = NULL, pr_url = NULL, deploy_commit = NULL, deploy_at = NULL,
           deploy_target = NULL, watch_baseline = NULL, watch_at = NULL, watch_closed_at = NULL,
           watch_deadline = NULL, deploy_phase = NULL, merge_commit = NULL,
           revert_signs = NULL, outcome = NULL, outcome_note = NULL, bilan_at = NULL`,
      )
      .run(f.signature, f.source, clean(f.title), examples, before, status);
  }

  /** PR du groupe fusionnée : la fiche 'launched' passe 'merged', garde l'URL de la PR et son commit de fusion. */
  setMerged(id: number, prUrl: string | null, mergeCommit: string | null = null, now = new Date()): boolean {
    return this.db
      .prepare("UPDATE improvements SET status = 'merged', pr_url = ?, merge_commit = ?, updated_at = ? WHERE id = ? AND status = 'launched'")
      .run(prUrl, mergeCommit, toSqlUtc(now), id).changes === 1;
  }

  /**
   * Renseigne le commit de fusion d'une fiche 'merged' qui ne l'avait pas encore (métadonnée de PR arrivée
   * après coup). Ne touche qu'une fiche 'merged' au champ vide : on ne réécrit jamais un commit déjà connu.
   */
  setMergeCommit(id: number, mergeCommit: string, now = new Date()): boolean {
    return this.db
      .prepare("UPDATE improvements SET merge_commit = ?, updated_at = ? WHERE id = ? AND status = 'merged' AND merge_commit IS NULL")
      .run(mergeCommit, toSqlUtc(now), id).changes === 1;
  }

  /** Écrit la phase fine du cycle de déploiement (traçabilité + reprise), sans toucher au `status`. */
  setDeployPhase(id: number, phase: DeployPhase, now = new Date()): void {
    this.db.prepare("UPDATE improvements SET deploy_phase = ?, updated_at = ? WHERE id = ?").run(phase, toSqlUtc(now), id);
  }

  /** Sur le clic « Déployer » : fige le commit de SECOURS et l'état « avant », phase 'deploy_pending', passe 'deploying'. */
  setDeploying(id: number, deployCommit: string, baseline: string, now = new Date()): boolean {
    const at = toSqlUtc(now);
    return this.db
      .prepare("UPDATE improvements SET status = 'deploying', deploy_phase = 'deploy_pending', deploy_commit = ?, deploy_at = ?, deploy_target = NULL, watch_baseline = ?, watch_at = NULL, watch_closed_at = NULL, watch_deadline = NULL, updated_at = ? WHERE id = ? AND status = 'merged'")
      .run(deployCommit, at, baseline, at, id).changes === 1;
  }

  /** Cible du déploiement : le commit qu'on vise, figé APRÈS le pull et AVANT le redémarrage (phase 'pulled'). */
  setDeployTarget(id: number, target: string, now = new Date()): boolean {
    return this.db
      .prepare("UPDATE improvements SET deploy_target = ?, deploy_phase = 'pulled', updated_at = ? WHERE id = ? AND status = 'deploying'")
      .run(target, toSqlUtc(now), id).changes === 1;
  }

  /**
   * Le déploiement n'a pas pu se faire AVANT tout redémarrage (switch/pull/cible/ancêtre) : on revient à
   * 'merged', phase 'failed'. Les références de récupération (deploy_commit) sont effacées car rien n'a
   * démarré de neuf et le dépôt a été remis sur la version d'avant.
   */
  backToMerged(id: number, now = new Date()): boolean {
    return this.db
      .prepare("UPDATE improvements SET status = 'merged', deploy_phase = 'failed', deploy_commit = NULL, deploy_at = NULL, deploy_target = NULL, watch_baseline = NULL, watch_at = NULL, watch_closed_at = NULL, watch_deadline = NULL, updated_at = ? WHERE id = ? AND status = 'deploying'")
      .run(toSqlUtc(now), id).changes === 1;
  }

  /**
   * Le redémarrage n'a pas pris effet mais le dépôt a été REMIS (et vérifié) sur le commit de secours : on
   * revient à 'merged', phase 'failed', en GARDANT la référence de récupération (deploy_commit) et le commit
   * de fusion — on ne les efface pas tant qu'on ne repart pas d'un déploiement propre.
   */
  failAfterRestart(id: number, now = new Date()): boolean {
    return this.db
      .prepare("UPDATE improvements SET status = 'merged', deploy_phase = 'failed', deploy_at = NULL, deploy_target = NULL, watch_baseline = NULL, watch_at = NULL, watch_closed_at = NULL, watch_deadline = NULL, updated_at = ? WHERE id = ? AND status = 'deploying'")
      .run(toSqlUtc(now), id).changes === 1;
  }

  /**
   * Déploiement confirmé sur la nouvelle version : DÉBUT RÉEL de l'observation (watch_at), phase 'watching'.
   * L'échéance est FIGÉE ici (watch_deadline) et ne dépend plus de watchMinutes : elle ne bougera pas si la
   * configuration change, ni à une reprise après coupure.
   */
  setWatching(id: number, now = new Date(), deadline?: Date): boolean {
    const at = toSqlUtc(now);
    const end = toSqlUtc(deadline ?? new Date(now.getTime() + WATCH_MINUTES_FALLBACK * 60_000));
    return this.db
      .prepare("UPDATE improvements SET status = 'watching', deploy_phase = 'watching', watch_at = ?, watch_deadline = ?, watch_closed_at = NULL, updated_at = ? WHERE id = ? AND status = 'deploying'")
      .run(at, end, at, id).changes === 1;
  }

  /** La fenêtre serrée s'est close proprement (aucune régression jusqu'à l'échéance) : plus de retour arrière auto. */
  setWatchClosed(id: number, now = new Date()): boolean {
    const at = toSqlUtc(now);
    return this.db
      .prepare("UPDATE improvements SET watch_closed_at = ?, updated_at = ? WHERE id = ? AND status = 'watching' AND watch_closed_at IS NULL")
      .run(at, at, id).changes === 1;
  }

  /**
   * Régression constatée : on PERSISTE l'intention de revenir en arrière (statut 'reverting' + signes figés)
   * AVANT toute commande. Ainsi, si le redémarrage coupe Clark ou si la santé se rétablit, le retour arrière
   * n'est jamais oublié : la boucle le reprend tant que la fiche est 'reverting'. Jamais clôturée 'atteint'.
   */
  enterReverting(id: number, signsJson: string, now = new Date()): boolean {
    const at = toSqlUtc(now);
    return this.db
      .prepare("UPDATE improvements SET status = 'reverting', deploy_phase = 'rollback_pending', revert_signs = ?, updated_at = ? WHERE id = ? AND status IN ('watching', 'deploying')")
      .run(signsJson, at, id).changes === 1;
  }

  /** Close la fiche (retour arrière confirmé ou bilan J+3) : résultat, note et instant du bilan. */
  finishImprovement(id: number, outcome: "atteint" | "partiel" | "rate", note: string, now = new Date()): boolean {
    const at = toSqlUtc(now);
    return this.db
      .prepare("UPDATE improvements SET status = 'done', outcome = ?, outcome_note = ?, bilan_at = ?, updated_at = ? WHERE id = ? AND status IN ('watching', 'deploying', 'reverting')")
      .run(outcome, clean(note), at, at, id).changes === 1;
  }

  /** Change l'état d'une fiche ; pour 'snoozed'/'dismissed', note l'instant de la décision (decided_at). */
  setStatus(source: ImproveSourceKind, signature: string, status: FicheStatus, now = new Date()) {
    const at = toSqlUtc(now);
    if (status === "snoozed" || status === "dismissed") {
      this.db.prepare(`UPDATE improvements SET status = ?, decided_at = ?, updated_at = ? WHERE source = ? AND signature = ?`).run(status, at, at, source, signature);
    } else {
      this.db.prepare(`UPDATE improvements SET status = ?, updated_at = ? WHERE source = ? AND signature = ?`).run(status, at, source, signature);
    }
  }
}

function improvementBefore(fiche: Improvement): Before {
  return JSON.parse(fiche.before) as Before;
}

export function improvementProposal(fiche: Improvement) {
  const [example] = JSON.parse(fiche.examples) as string[];
  const before = improvementBefore(fiche);
  const measurement = `Avant (${before.total} occurrences) : ${before.days.map(({ day, count }) => `${day} : ${count}`).join(" · ")}.`;
  // `status`/`prUrl` servent l'interface : une fiche 'proposed' montre Lancer/Pas maintenant/Ignorer,
  // une fiche 'merged' montre « Déployer » (et un lien vers la PR).
  return { id: fiche.id, title: fiche.title, example, measurement, proposedAt: fiche.updated_at, status: fiche.status, prUrl: fiche.pr_url };
}

export function proposeOne(hub: Hub, now: Date): Improvement | undefined {
  const fiche = hub.deps.store.improve.propose(now);
  if (!fiche) return;
  const { title, example, measurement, id, proposedAt } = improvementProposal(fiche);
  void hub.post(OWNER_CHAT, `${IMPROVEMENT_TITLE_PREFIX} ${title}\n${example ? `${example}\n` : ""}${measurement}`, "system", "health", { id, proposedAt });
  return fiche;
}

export function launchImprovement(hub: Hub, fiche: Improvement, now: Date, start: typeof startDevGroup): ReturnType<typeof startDevGroup> {
  const { store } = hub.deps;
  const project = store.dev.projects().find((p) => p.name === "clark");
  if (!project) return { ok: false, error: "Projet dev « clark » introuvable." } as const;
  const { measurement } = improvementProposal(fiche);
  const examples = (JSON.parse(fiche.examples) as string[]).join("\n");
  const result = start(hub, {
    projectId: project.id,
    binome: true,
    title: `${IMPROVEMENT_TITLE_PREFIX} ${fiche.title}`,
    instruction: `${fiche.title} (source : ${fiche.source}, signature : ${fiche.signature})
Exemples expurgés :
${examples}
${measurement}

Ajoute un TEST qui reproduit le problème et passe après le correctif. Critère : la signature d'erreur ne doit plus réapparaître.
Lis AGENTS.md. Aucun secret dans les fichiers versionnés, les logs ou les messages. Respecte la lecture seule et les accords de Charles. Aucun ajout silencieux de permission. Clark ne modifie jamais ses propres permissions de lui-même.
Garde le pilote automatique désactivé. La PR attend les accords de Charles et le binôme ne la fusionne jamais.`,
  });
  // Les groupes et leurs sous-tâches sont créés avec autopilot = 0 (valeur par défaut du DevStore).
  if (result.ok === true) store.improve.decide(fiche.id, "launched", now, result.id);
  return result;
}

const SENSITIVE_FILES = new Set([
  "src/browser/sensitive.ts",
  "src/browser/service.ts",
  "src/core/agent.ts",
  "src/core/autonomy.ts",
  "src/core/hub.ts",
  "src/core/internal.ts",
  "src/dev/autopilot.ts",
  "src/gateway/access.ts",
  "src/gateway/telegram.ts",
  "src/gateway/web.ts",
  "src/terminal/terminal.ts",
  "src/web/app/03-focus-cartes.js",
  "src/web/app/07-activite-objectifs.js",
  "src/web/app/25-ordinateur.js",
]);

/** Fichiers du contrôle des sites sensibles, des accords ou des permissions. */
export function sensitivePaths(files: string[]): string[] {
  return files.filter((file) =>
    file.startsWith("src/policy/") ||
    SENSITIVE_FILES.has(file) ||
    /(?:^|[/._-])(?:approvals?|accords?|permissions?)(?:$|[/._-])/i.test(file),
  );
}

/** Range dans la base les relevés datés des quatre sources (chacun sur son jour réel). */
export function recordSignatures(store: ImproveStore, sources: ImproveSources, now: Date): void {
  const readings = [...sources.errors(now), ...sources.tasks(now), ...sources.alerts(now), ...sources.silent(now)];
  for (const r of readings) {
    if (!r.signature || r.count <= 0) continue;
    store.record(r.day, r.source, r.signature, r.count, r.example);
  }
}

/**
 * Pour chaque signature récurrente, crée ou rafraîchit une fiche 'detected' — sauf si une fiche est
 * déjà en cours, écartée ('dismissed'), close ('done') ou en sommeil non écoulé ('snoozed').
 * Renvoie les détections appliquées.
 */
export function refreshFiches(store: ImproveStore, now: Date): Detection[] {
  const fromDay = addDays(parisDay(now), -(IMPROVE_WINDOW_DAYS - 1));
  const detections = detect(store.histories(fromDay), { now });
  const applied: Detection[] = [];
  for (const d of detections) {
    const existing = store.fiche(d.source, d.signature);
    if (existing && !canRefresh(existing, now)) continue;
    store.upsertFiche({ signature: d.signature, source: d.source, title: d.title, examples: [d.example], before: d.before, status: "detected" });
    applied.push(d);
  }
  return applied;
}

/**
 * Suit les erreurs du journal sans horodatage par ligne, par POSITION de lecture : on garde l'offset
 * d'octets déjà consommés et, à chaque passage, on ne lit QUE ce qui a été ajouté depuis (lignes
 * complètes, jusqu'au dernier saut de ligne). Chaque ligne d'erreur n'est donc comptée qu'une fois,
 * le jour où elle est lue, et cumulée dans le jour courant (remis à zéro à minuit, à Paris).
 *
 * Une BAISSE du total n'est jamais un redémarrage (on ne relit pas d'anciennes lignes) : des lignes
 * ordinaires qui repoussent de vieilles erreurs hors d'une fenêtre ne recomptent rien. Un vrai
 * redémarrage est signalé par le marqueur « [clark] démarré » (géré par countErrors, qui ne compte
 * qu'à partir du dernier démarrage présent dans le fragment lu), par une taille de fichier qui DIMINUE
 * (troncature en place) ou par un CHANGEMENT d'identité du fichier (`dev`/`ino` : rotation où un
 * nouveau journal, même plus gros, remplace l'ancien) — dans ces cas on repart du début du fichier.
 *
 * Tout se fait en OCTETS : on lit le nombre d'octets réellement renvoyés par `readSync`, on cherche le
 * dernier saut de ligne dans ces octets et on avance le curseur de ce nombre d'octets exact, puis on
 * décode les lignes complètes. Ainsi une limite initiale qui tombe au milieu d'un caractère multioctet
 * ne décale pas le curseur. On lit le fragment complet, pas le top 8 de la page Santé. État gardé pour
 * la durée du processus ; la minuterie tourne en continu.
 */
function makeErrorSource(logFile: string): (now: Date) => DayReading[] {
  const INITIAL_TAIL = 400_000; // au démarrage, on part des derniers 400 ko (pas de tout l'historique)
  let day: string | null = null;
  let attributed = new Map<string, { count: number; example: string }>();
  let offset: number | null = null;
  let fileId: string | null = null;
  // Le début du fichier : un journal remplacé ne commence pas par les mêmes octets. Sur Linux, un fichier
  // supprimé puis recréé reprend souvent le même numéro d'inode : l'identité seule ne suffit pas.
  let head: Buffer | null = null;
  const HEAD_BYTES = 256;
  return (now: Date) => {
    const today = parisDay(now);
    if (day !== null && today !== day) attributed = new Map(); // nouveau jour : on repart de zéro
    day = today;

    let fd: number;
    try {
      fd = openSync(logFile, "r");
    } catch {
      return emitAttributed(today, attributed);
    }
    try {
      const st = fstatSync(fd);
      const size = st.size;
      const id = `${st.dev}:${st.ino}`;
      const start = Buffer.alloc(Math.min(HEAD_BYTES, size));
      const startRead = start.length ? readSync(fd, start, 0, start.length, 0) : 0;
      const nowHead = start.subarray(0, startRead);
      // Même fichier si son début prolonge celui qu'on connaissait (un journal grandit, il ne réécrit pas son début).
      const sameStart = head === null || (nowHead.length >= head.length ? nowHead.subarray(0, head.length).equals(head) : head.subarray(0, nowHead.length).equals(nowHead));
      if (offset === null) offset = Math.max(0, size - INITIAL_TAIL);
      else if (id !== fileId || size < offset || !sameStart) offset = 0; // nouveau fichier (rotation) ou troncature en place
      fileId = id;
      if (head === null || nowHead.length > head.length || !sameStart) head = Buffer.from(nowHead);
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        const bytesRead = readSync(fd, buf, 0, buf.length, offset);
        const read = buf.subarray(0, bytesRead);
        const lastNl = read.lastIndexOf(0x0a); // dernier « \n » dans les octets réellement lus
        if (lastNl >= 0) {
          const completeBytes = read.subarray(0, lastNl + 1); // seulement les lignes terminées
          offset += completeBytes.length; // on avance d'un nombre d'OCTETS consommés, pas de caractères
          for (const e of countErrors(completeBytes.toString("utf8"))) {
            const a = attributed.get(e.signature) ?? { count: 0, example: errorExample(e.text) };
            a.count += e.count;
            attributed.set(e.signature, a);
          }
        }
        // sinon : ligne en cours d'écriture, non terminée — on attend le prochain passage
      }
    } finally {
      closeSync(fd);
    }
    return emitAttributed(today, attributed);
  };
}

/** Les relevés d'erreurs du jour courant, au format DayReading. */
function emitAttributed(day: string, attributed: Map<string, { count: number; example: string }>): DayReading[] {
  return [...attributed].map(([signature, a]) => ({ day, source: "error" as const, signature, count: a.count, example: a.example }));
}

/**
 * Les vraies sources, pour l'index. Erreurs : cumul par session attribué au jour (makeErrorSource).
 * Tâches : échecs groupés par label, datés par `updated_at`. Alertes : historique de « alerts », daté
 * par `at`. Silence : agents silencieux, datés par `since`. Pour les quatre, la signature (identité)
 * est calculée en mémoire à partir du texte brut — un hash non réversible — mais l'exemple PERSISTÉ ne
 * vient que de catégories ou de champs d'une liste blanche (jamais de texte libre : label, texte
 * d'alerte, ligne de journal), et repasse de toute façon par `clean`/`redactSecrets` au stockage.
 */
export function improveSources(opts: {
  db: DatabaseSync;
  logFile: string;
  alerts: () => AlertState;
  stalled: () => { taskId: number; since: number }[];
}): ImproveSources {
  const errors = makeErrorSource(opts.logFile);
  const silent = makeSilentSource(opts.stalled);
  return {
    errors,
    tasks: (now) => {
      const win = new Set(windowOf(now, IMPROVE_WINDOW_DAYS));
      let rows: { label: string; status: string; updated_at: string }[];
      try {
        rows = opts.db
          .prepare(
            `SELECT label, status, updated_at FROM tasks
             WHERE status IN ('failed', 'needs_check', 'abandoned') AND label IS NOT NULL AND label != ''`,
          )
          .all() as { label: string; status: string; updated_at: string }[];
      } catch {
        return []; // table des tâches absente (base de test réduite)
      }
      const agg = new Map<string, DayReading>();
      for (const r of rows) {
        const at = parseSqlUtc(r.updated_at);
        if (!at) continue;
        const day = parisDay(at);
        if (!win.has(day)) continue;
        // Signature calculée en mémoire à partir du label brut (hash non réversible) ; l'exemple
        // persisté, lui, ne vient que du statut (ensemble fixe), jamais du label libre.
        const signature = errorSignature(`tâche en échec : ${r.label}`);
        const key = `${day}\u0000${signature}`;
        const e = agg.get(key) ?? { day, source: "task" as const, signature, count: 0, example: taskExample(r.status) };
        e.count++;
        agg.set(key, e);
      }
      return [...agg.values()];
    },
    alerts: (now) => {
      const win = new Set(windowOf(now, IMPROVE_WINDOW_DAYS));
      const agg = new Map<string, DayReading>();
      for (const ev of opts.alerts().history) {
        if (ev.kind !== "alerte") continue;
        const at = new Date(ev.at);
        if (Number.isNaN(at.getTime())) continue;
        const day = parisDay(at);
        if (!win.has(day)) continue;
        // Signature depuis le texte brut (en mémoire, hash non réversible) ; exemple seulement par catégorie.
        const signature = errorSignature(ev.text);
        const key = `${day}\u0000${signature}`;
        const e = agg.get(key) ?? { day, source: "alert" as const, signature, count: 0, example: alertExample(ev.text) };
        e.count++;
        agg.set(key, e);
      }
      return [...agg.values()];
    },
    silent,
  };
}

/**
 * Suit les agents silencieux par ÉPISODE distinct, pas par instantané. Un tick ne voit que les agents
 * silencieux à cet instant : trois épisodes successifs dans la journée (jamais simultanés) donneraient
 * chacun un relevé à 1, et le MAX n'en garderait qu'un — on raterait la récurrence. On identifie donc
 * chaque épisode par (taskId, since), on cumule le nombre d'épisodes distincts par jour (daté par
 * `since`), et on transmet ce cumul croissant à `record` (que le MAX conserve). État gardé pour la
 * durée du processus ; purgé hors fenêtre pour ne pas croître sans fin.
 */
function makeSilentSource(stalled: () => { taskId: number; since: number }[]): (now: Date) => DayReading[] {
  const signature = errorSignature("agent silencieux");
  const seen = new Set<string>();
  const byDay = new Map<string, number>();
  return (now: Date) => {
    const win = new Set(windowOf(now, IMPROVE_WINDOW_DAYS));
    for (const s of stalled()) {
      const at = new Date(s.since);
      if (Number.isNaN(at.getTime())) continue;
      const day = parisDay(at);
      const key = `${s.taskId}\u0000${s.since}`;
      if (seen.has(key)) continue;
      seen.add(key);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    // Purge des jours sortis de la fenêtre (et des épisodes qu'ils portaient).
    for (const day of [...byDay.keys()]) if (!win.has(day)) byDay.delete(day);
    for (const key of [...seen]) if (!win.has(parisDay(new Date(Number(key.split("\u0000")[1]))))) seen.delete(key);
    return [...byDay].filter(([day]) => win.has(day)).map(([day, count]) => ({ day, source: "silent" as const, signature, count, example: "Agent silencieux" }));
  };
}

/**
 * Boucle légère : à chaque passage, range les relevés datés du moment et rafraîchit les fiches
 * 'detected', puis propose au plus une fiche par jour.
 * Minuterie .unref().
 */
export function startImproveLoop(hub: Hub, sources: ImproveSources, now: () => Date = () => new Date(), everyMs = 5 * 60_000): () => void {
  const store = hub.deps.store.improve;
  const tick = () => {
    try {
      const n = now();
      recordSignatures(store, sources, n);
      refreshFiches(store, n);
      proposeOne(hub, n);
    } catch (err) {
      console.warn("[clark] auto-amélioration : passage impossible :", err instanceof Error ? err.message : err);
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
