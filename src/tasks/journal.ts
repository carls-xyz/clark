import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { effectOf, type Effect, type Tier } from "../policy/permissions.ts";
import { browserAction, browserStepInput, browserStepOutput, type BrowserStepRow } from "../browser/journal.ts";

export type TaskStatus = "queued" | "running" | "done" | "failed" | "needs_check" | "abandoned";
/** verified : écriture incertaine dont l'effet a été vérifié par une reprise en lecture seule. */
export type StepStatus = "awaiting_approval" | "denied" | "expired" | "running" | "done" | "error" | "verified";

export type Task = {
  id: number;
  chat_id: number;
  label: string;
  prompt: string;
  status: TaskStatus;
  session_id: string | null;
  result: string | null;
  cost_usd: number;
  alerted_at: string | null;
  /** Tâche d'équipe dont celle-ci est une sous-tâche (un agent). NULL = tâche de premier niveau. */
  parent_id: number | null;
  /** Droit de la tâche pendant son exécution en cours : lu par le serveur de mémoire de Codex. */
  access: "read" | "write" | null;
  /** Identifiant de la tentative en cours : un résultat d'une autre tentative est ignoré. */
  attempt: string | null;
  /** Point d'étape : une ligne écrite par l'agent sur son avancement (idée reprise d'Orca). */
  checkpoint: string | null;
  checkpoint_at: string | null;
  /** Moteur qui a exécuté la tâche (claude, codex) : une reprise se fait sur le même. */
  engine: string | null;
  created_at: string;
  updated_at: string;
};

export type Step = {
  id: number;
  task_id: number;
  tool_use_id: string;
  tool: string;
  input: string;
  tier: Tier;
  effect: Effect;
  status: StepStatus;
  output: string | null;
  /** Tentative qui a lancé cette étape. */
  attempt: string | null;
};

/** L'entrée d'une étape, telle qu'elle est gardée (navigateur : adresse réduite, textes masqués). */
const stepInput = (tool: string, input: unknown) => JSON.stringify((browserAction(tool) ? browserStepInput(input) : input) ?? {}).slice(0, 4000);

const OUTPUT_LIMIT = 2000;

/**
 * Journal durable des tâches : chaque demande est écrite avant d'être traitée,
 * chaque appel d'outil (étape) avant et après son exécution. C'est ce qui
 * permet de reprendre après un redémarrage sans rejouer une action à l'aveugle.
 */
export class TaskJournal {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id         INTEGER PRIMARY KEY,
        chat_id    INTEGER NOT NULL,
        label      TEXT NOT NULL,
        prompt     TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','done','failed','needs_check','abandoned')),
        session_id TEXT,
        result     TEXT,
        cost_usd   REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS tasks_open ON tasks(status) WHERE status IN ('queued','running','needs_check');

      CREATE TABLE IF NOT EXISTS steps (
        id          INTEGER PRIMARY KEY,
        task_id     INTEGER NOT NULL REFERENCES tasks(id),
        tool_use_id TEXT NOT NULL UNIQUE,
        tool        TEXT NOT NULL,
        input       TEXT NOT NULL,
        tier        TEXT NOT NULL,
        status      TEXT NOT NULL,
        output      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS steps_task ON steps(task_id, id);
    `);
    // Colonnes ajoutées après la première version : 'write' par défaut, par prudence.
    this.addColumn("steps", "effect", "TEXT NOT NULL DEFAULT 'write'");
    // Date d'envoi réussi de l'alerte « à vérifier ». NULL = à (re)envoyer.
    this.addColumn("tasks", "alerted_at", "TEXT");
    // Équipe d'agents : chaque agent est une sous-tâche, avec son propre journal d'étapes.
    this.addColumn("tasks", "parent_id", "INTEGER");
    this.addColumn("tasks", "access", "TEXT");
    this.addColumn("tasks", "attempt", "TEXT");
    this.addColumn("tasks", "checkpoint", "TEXT");
    this.addColumn("tasks", "checkpoint_at", "TEXT");
    this.addColumn("tasks", "engine", "TEXT");
    this.addColumn("steps", "attempt", "TEXT");
    // D'où vient la demande (web, telegram, automation:<nom>, initiative:<titre>…), pour l'historique.
    this.addColumn("tasks", "source", "TEXT");
    // Fin de tour signalée par l'agent : « quiet » (rien de neuf) ou « failed » (raison dans outcome_note).
    this.addColumn("tasks", "outcome", "TEXT");
    this.addColumn("tasks", "outcome_note", "TEXT");
    this.redactOldBrowserSteps();
  }

  /** Étapes du navigateur écrites avant l'expurgation : la page lue et les valeurs tapées sont retirées. */
  private redactOldBrowserSteps() {
    const rows = this.db
      .prepare("SELECT id, tool, input, output FROM steps WHERE tool LIKE '%browser\\_%' ESCAPE '\\' AND (output LIKE '%(Contenu d''une page web%' OR input LIKE '%\"text\"%' OR input LIKE '%?%' OR input LIKE '%#%')")
      .all() as { id: number; tool: string; input: string; output: string | null }[];
    const update = this.db.prepare("UPDATE steps SET input = ?, output = ? WHERE id = ?");
    for (const r of rows) {
      if (!browserAction(r.tool)) continue;
      let input: unknown = {};
      try {
        input = JSON.parse(r.input);
      } catch {}
      const next = stepInput(r.tool, input);
      const out = r.output === null ? null : browserStepOutput(r.output);
      if (next !== r.input || out !== r.output) update.run(next, out, r.id);
    }
  }

  private addColumn(table: string, column: string, definition: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** Prévient l'interface qu'une tâche ou une étape a changé. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  /** Dernières étapes d'une tâche, pour l'affichage. */
  recentSteps(taskId: number, limit = 8): Step[] {
    return (this.db.prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(taskId, limit) as Step[]).reverse();
  }

  create(chatId: number, label: string, prompt: string, parentId?: number): number {
    const r = this.db
      .prepare("INSERT INTO tasks (chat_id, label, prompt, parent_id) VALUES (?, ?, ?, ?)")
      .run(chatId, label, prompt, parentId ?? null);
    this.changed();
    return Number(r.lastInsertRowid);
  }

  /** La dernière tâche d'une étiquette (le dernier tour d'un objectif). */
  /** La dernière tâche de ce label ; skip = 1 : l'avant-dernière, etc. */
  lastByLabel(label: string, skip = 0): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE label = ? ORDER BY id DESC LIMIT 1 OFFSET ?").get(label, skip) as Task | undefined;
  }

  setSource(id: number, source: string) {
    this.db.prepare("UPDATE tasks SET source = ? WHERE id = ?").run(source, id);
  }

  /** Historique : les tâches de premier niveau, les plus récentes d'abord, avec leur nombre d'agents et d'étapes. */
  history(opts: { limit?: number; before?: number } = {}): (Task & { source: string | null; agents: number; step_count: number })[] {
    return this.db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS agents,
           (SELECT COUNT(*) FROM steps s WHERE s.task_id = t.id OR s.task_id IN (SELECT id FROM tasks c WHERE c.parent_id = t.id)) AS step_count
         FROM tasks t
         WHERE t.parent_id IS NULL AND t.id < ?
         ORDER BY t.id DESC LIMIT ?`,
      )
      .all(opts.before ?? Number.MAX_SAFE_INTEGER, Math.min(opts.limit ?? 40, 100)) as any;
  }

  get(id: number): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  }

  /**
   * Tâches de premier niveau à traiter au démarrage : jamais lancées ou coupées en cours.
   * Les agents d'une équipe sont repris par leur tâche d'équipe, pas un par un.
   */
  /** Ce que l'agent a dit de son tour (outils nothing_new / report_failure). */
  outcome(id: number): { outcome: "quiet" | "failed" | null; note: string | null } {
    const r = this.db.prepare("SELECT outcome, outcome_note FROM tasks WHERE id = ?").get(id) as { outcome: string | null; outcome_note: string | null } | undefined;
    return { outcome: r?.outcome === "quiet" || r?.outcome === "failed" ? r.outcome : null, note: r?.outcome_note ?? null };
  }

  unfinished(): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE status IN ('queued','running') AND parent_id IS NULL ORDER BY id").all() as Task[];
  }

  /** Tâches en attente de vérification, dans l'ordre. */
  awaitingCheck(): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE status = 'needs_check' AND parent_id IS NULL ORDER BY id").all() as Task[];
  }

  /** Celles dont l'alerte n'a jamais été remise (échec d'envoi, arrêt entre les deux). */
  unalerted(): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status = 'needs_check' AND alerted_at IS NULL AND parent_id IS NULL ORDER BY id")
      .all() as Task[];
  }

  /** Date de création (UTC SQLite) de la dernière tâche portant ce label, ou null. */
  lastCreated(label: string): string | null {
    const row = this.db.prepare("SELECT max(created_at) AS at FROM tasks WHERE label = ?").get(label) as { at: string | null };
    return row.at;
  }

  /** Les agents d'une tâche d'équipe, dans l'ordre où ils ont été lancés. */
  children(parentId: number): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY id").all(parentId) as Task[];
  }

  markAlerted(id: number) {
    this.db.prepare("UPDATE tasks SET alerted_at = datetime('now') WHERE id = ?").run(id);
    this.changed();
  }

  // Passer en needs_check remet l'alerte à envoyer : elle n'est marquée qu'après un envoi réussi.
  setStatus(id: number, status: TaskStatus) {
    this.db
      .prepare(
        `UPDATE tasks SET status = ?1, updated_at = datetime('now'),
           alerted_at = CASE WHEN ?1 = 'needs_check' THEN NULL ELSE alerted_at END
         WHERE id = ?2`,
      )
      .run(status, id);
    this.changed();
  }

  /** Signale un changement fait hors du journal (point d'étape écrit par un outil). */
  touch() {
    this.changed();
  }

  /**
   * Repère les points d'étape écrits par un autre processus (serveur de mémoire de Codex) :
   * renvoie true si un point d'étape a changé depuis le dernier appel.
   */
  private lastCheckpoint: string | null = null;
  pollCheckpoints(): boolean {
    // Les points d'étape des tâches en cours, mis bout à bout : la moindre nouvelle ligne change la signature.
    const row = this.db
      .prepare("SELECT group_concat(id || '=' || coalesce(checkpoint, ''), '|') AS sig FROM tasks WHERE status = 'running'")
      .get() as { sig: string | null };
    if (row.sig === this.lastCheckpoint) return false;
    const first = this.lastCheckpoint === null;
    this.lastCheckpoint = row.sig;
    if (!first) this.changed();
    return !first;
  }

  /** Dernière activité d'une tâche (ms) : la tâche elle-même, son point d'étape, ses étapes. */
  lastActivity(id: number): number {
    const r = this.db
      .prepare(
        `SELECT max(t.updated_at, coalesce(t.checkpoint_at, t.updated_at), coalesce((SELECT max(updated_at) FROM steps WHERE task_id = t.id), t.updated_at)) AS at FROM tasks t WHERE t.id = ?`,
      )
      .get(id) as { at: string | null } | undefined;
    return r?.at ? Date.parse(`${r.at.replace(" ", "T")}Z`) : Date.now();
  }

  /** Nouvelle tentative pour cette tâche : son identifiant devient le seul accepté. */
  startAttempt(id: number): string {
    const attempt = randomUUID();
    this.db.prepare("UPDATE tasks SET attempt = ? WHERE id = ?").run(attempt, id);
    return attempt;
  }

  setEngine(id: number, engine: string) {
    this.db.prepare("UPDATE tasks SET engine = ? WHERE id = ?").run(engine, id);
  }

  setAccess(id: number, access: "read" | "write") {
    this.db.prepare("UPDATE tasks SET access = ? WHERE id = ?").run(access, id);
  }

  /** Après un constat concluant en lecture seule, ces écritures ne sont plus « incertaines ». */
  markVerified(findings: { toolUseId: string; note: string }[]) {
    const stmt = this.db.prepare("UPDATE steps SET status = 'verified', output = ?, updated_at = datetime('now') WHERE tool_use_id = ? AND status = 'running'");
    for (const f of findings) stmt.run(`vérifié en lecture seule : ${f.note}`.slice(0, OUTPUT_LIMIT), f.toolUseId);
    this.changed();
  }

  setSession(id: number, sessionId: string) {
    this.db
      .prepare("UPDATE tasks SET session_id = ?, updated_at = datetime('now') WHERE id = ? AND session_id IS NOT ?")
      .run(sessionId, id, sessionId);
  }

  /**
   * Clôt la tâche. Avec `attempt`, seulement si c'est encore la tentative en cours :
   * le résultat tardif d'une ancienne tentative n'écrase jamais celui de la nouvelle.
   * Renvoie false si rien n'a été écrit.
   */
  finish(id: number, status: TaskStatus, result: string, costUsd: number, attempt?: string | null): boolean {
    const ok =
      this.db
        .prepare(
          `UPDATE tasks SET status = ?1, result = ?2, cost_usd = cost_usd + ?3, updated_at = datetime('now'),
             alerted_at = CASE WHEN ?1 = 'needs_check' THEN NULL ELSE alerted_at END
           WHERE id = ?4 AND (?5 IS NULL OR attempt = ?5)`,
        )
        .run(status, result, costUsd, id, attempt ?? null).changes > 0;
    this.changed();
    return ok;
  }

  // ── Étapes ─────────────────────────────────────────────────────────────

  /**
   * Enregistre ou fait avancer une étape. Le SDK peut annoncer l'appel d'outil
   * (message assistant) avant ou après la vérification de permission : on ne
   * recule jamais un statut déjà plus avancé.
   */
  recordStep(s: { taskId: number; toolUseId: string; tool: string; input: unknown; tier: Tier; status: StepStatus; attempt?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO steps (task_id, tool_use_id, tool, input, tier, effect, status, attempt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, coalesce(?8, (SELECT attempt FROM tasks WHERE id = ?1)))
         ON CONFLICT(tool_use_id) DO UPDATE SET
           status = CASE WHEN steps.status IN ('done','error','denied','verified') THEN steps.status ELSE excluded.status END,
           tier = excluded.tier,
           updated_at = datetime('now')`,
      )
      .run(s.taskId, s.toolUseId, s.tool, stepInput(s.tool, s.input), s.tier, effectOf(s.tool), s.status, s.attempt ?? null);
    this.changed();
  }

  /**
   * Annonce de l'outil vue dans le flux. N'écrase jamais une décision de permission.
   * Statut « running » par prudence : si le SDK exécute l'outil sans passer par la
   * vérification de permission, une coupure le classera quand même.
   */
  announceStep(s: { taskId: number; toolUseId: string; tool: string; input: unknown; tier: Tier; attempt?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO steps (task_id, tool_use_id, tool, input, tier, effect, status, attempt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', coalesce(?7, (SELECT attempt FROM tasks WHERE id = ?1)))
         ON CONFLICT(tool_use_id) DO NOTHING`,
      )
      .run(s.taskId, s.toolUseId, s.tool, stepInput(s.tool, s.input), s.tier, effectOf(s.tool), s.attempt ?? null);
    this.changed();
  }

  completeStep(toolUseId: string, output: string, isError: boolean) {
    // Navigateur : la page lue n'est jamais gardée, seulement la note et l'adresse (origine + chemin).
    const tool = (this.db.prepare("SELECT tool FROM steps WHERE tool_use_id = ?").get(toolUseId) as { tool: string } | undefined)?.tool;
    if (tool && browserAction(tool)) output = browserStepOutput(output);
    this.db
      .prepare("UPDATE steps SET status = ?, output = ?, updated_at = datetime('now') WHERE tool_use_id = ?")
      .run(isError ? "error" : "done", output.slice(0, OUTPUT_LIMIT), toolUseId);
    this.changed();
  }

  /** Les dernières étapes du navigateur, toutes tâches confondues (journal du navigateur). */
  browserSteps(limit = 60): BrowserStepRow[] {
    return this.db
      .prepare("SELECT id, task_id, tool, input, status, output, created_at FROM steps WHERE tool LIKE '%browser\\_%' ESCAPE '\\' ORDER BY id DESC LIMIT ?")
      .all(limit) as BrowserStepRow[];
  }

  steps(taskId: number): Step[] {
    return this.db.prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY id").all(taskId) as Step[];
  }

  /** Les validations restées sans réponse ne survivent pas à un redémarrage : elles seront redemandées. */
  expireApprovals(taskId: number): number {
    const n = Number(
      this.db
        .prepare("UPDATE steps SET status = 'expired', updated_at = datetime('now') WHERE task_id = ? AND status = 'awaiting_approval'")
        .run(taskId).changes,
    );
    if (n) this.changed();
    return n;
  }
}

// ── Décision de reprise (pure, testée) ───────────────────────────────────

/** Écriture lancée sans résultat enregistré : son effet est inconnu, quel que soit son niveau de validation. */
export function uncertainSteps(steps: Step[]): Step[] {
  return steps.filter((s) => s.effect !== "read" && s.status === "running");
}

export type RecoveryPlan =
  | { action: "restart" } // jamais commencée : on la lance normalement
  | { action: "resume"; done: Step[] } // seules des lectures ont pu être coupées
  | { action: "check"; uncertain: Step[]; done: Step[] }; // une écriture a peut-être eu lieu : on demande

export function planRecovery(task: Task, steps: Step[]): RecoveryPlan {
  if (task.status === "queued" || (steps.length === 0 && !task.session_id)) return { action: "restart" };

  const done = steps.filter((s) => s.status === "done");
  const uncertain = uncertainSteps(steps);
  if (uncertain.length > 0) return { action: "check", uncertain, done };
  // Seulement des lectures, mais pas de conversation à rouvrir : on recommence, sans aucun risque.
  if (!task.session_id) return { action: "restart" };
  return { action: "resume", done };
}

export function describeStep(s: Step): string {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(s.input);
  } catch {}
  if (s.tool === "Bash") return `commande : ${String(input.command ?? "").slice(0, 300)}`;
  if (s.tool === "mcp__memory__report_progress") return `point d'étape : ${String(input.note ?? "").slice(0, 200)}`;
  if (s.tool === "mcp__memory__ask_charles") return `question à Charles : ${String(input.question ?? "").slice(0, 200)}`;
  if (s.tool === "mcp__memory__send_mail") return `mail à ${String(input.to ?? "").slice(0, 120)}, en attente de ton accord`;
  if (s.tool === "mcp__memory__mail_search") return `recherche dans tes mails : ${String(input.query ?? "").slice(0, 120)}`;
  if (s.tool === "mcp__memory__mail_read") return "lecture d'un mail";
  if (s.tool === "mcp__memory__calendar_events") return "lecture de ton agenda";
  if (s.tool.startsWith("mcp__memory__")) {
    const what = input.content ?? (input.id !== undefined ? `#${input.id}` : "");
    return `mémoire (${s.tool.replace("mcp__memory__", "")}) ${String(what).slice(0, 200)}`;
  }
  const path = input.file_path ?? input.path ?? input.url ?? input.query;
  return path ? `${s.tool} ${String(path).slice(0, 200)}` : s.tool;
}

/**
 * Ce que l'utilisateur a demandé, sans les notes ajoutées devant pour l'agent (« [Affiché à …] …
 * Message de Charles : … ») : c'est ce texte qu'on lui cite, jamais la consigne interne.
 */
export const MESSAGE_MARK = "\n\nMessage de Charles : ";
export function askedText(prompt: string): string {
  const at = prompt.startsWith("[Affiché à ") ? prompt.lastIndexOf(MESSAGE_MARK) : -1;
  return at >= 0 ? prompt.slice(at + MESSAGE_MARK.length) : prompt;
}

/** Texte de l'alerte « à vérifier », affiché avec les boutons Reprendre / Abandonner. */
export function checkAlertText(task: Task, uncertain: Step[]): string {
  const asked = askedText(task.prompt);
  const what = asked.length > 80 ? `${asked.slice(0, 80)}…` : asked;
  const list = uncertain.map((s) => `- ${describeStep(s)}`).join("\n") || "- (la conversation de cette tâche est introuvable)";
  return `J'ai été coupé pendant « ${what} ».\n\nCette écriture a peut-être déjà eu lieu :\n${list}\n\nJe ne la refais pas sans toi. Si tu reprends, je vérifie d'abord son effet.`;
}

export function resumePrompt(task: Task, done: Step[], uncertain: Step[] = []): string {
  const lines = [
    `[Message système de Clark] Le processus a redémarré pendant la tâche n°${task.id}.`,
    `Demande d'origine : « ${task.prompt.slice(0, 1500)} »`,
    done.length
      ? `Étapes déjà terminées (leurs résultats sont dans cette conversation) :\n${done.map((s) => `- ${describeStep(s)}`).join("\n")}`
      : "Aucune étape n'était terminée.",
  ];
  if (uncertain.length) {
    lines.push(
      `Ces écritures ont peut-être déjà eu lieu, sans résultat enregistré :\n${uncertain.map((s) => `- ${describeStep(s)}`).join("\n")}\nVérifie d'abord leur effet par une lecture (fichier, recall) avant de les refaire. Si l'une demandait une validation de Charles, redemande-la.`,
    );
  }
  lines.push(
    "Reprends à partir de la dernière étape terminée, sans refaire ce qui est fait. Toute validation restée sans réponse doit être redemandée.",
  );
  return lines.join("\n\n");
}

// ── Reprise en deux temps d'une écriture incertaine ──────────────────────

/** Temps 1, en lecture seule : constater ce qui a été écrit, sans rien toucher. */
export function verifyPrompt(task: Task, uncertain: Step[]): string {
  return [
    `[Message système de Clark] Le processus a redémarré pendant la tâche n°${task.id}. Vérification en lecture seule.`,
    `Demande d'origine : « ${task.prompt.slice(0, 1500)} »`,
    `Ces écritures ont peut-être déjà eu lieu, sans résultat enregistré :\n${uncertain.map((s, i) => `#${i + 1} ${describeStep(s)}`).join("\n")}`,
    "Pour chacune, vérifie par une lecture (fichier, recherche, recall) si elle a eu lieu, en tout ou en partie. Tu es en lecture seule : n'écris, ne modifie et ne lance rien, toute écriture sera refusée.",
    `Réponds avec exactement une ligne par écriture, sous cette forme :
#1 : FAIT — ce que tu as observé
#2 : PAS FAIT — ce que tu as observé
États possibles : FAIT, PAS FAIT, PARTIEL, INDÉTERMINÉ. Si tu ne peux pas établir l'état avec certitude, écris INDÉTERMINÉ : Charles décidera.`,
  ].join("\n\n");
}

export type WriteState = "fait" | "pas fait" | "partiel" | "indéterminé";

/**
 * Lit le constat de vérification. Une écriture n'est tranchée que par une ligne
 * explicite « #n : FAIT / PAS FAIT / PARTIEL ». Ligne absente, ambiguë ou
 * INDÉTERMINÉ : l'écriture reste incertaine.
 */
export function parseVerification(text: string, count: number): { state: WriteState; detail: string }[] {
  const found = new Map<number, { state: WriteState; detail: string }[]>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^#\s*(\d+)\s*[:\-–—]\s*(PAS\s+FAIT|PARTIEL|FAIT|IND[ÉE]TERMIN[ÉE])\b\s*[—–\-:]?\s*(.*)$/i);
    if (!m) continue;
    const n = Number(m[1]);
    const raw = m[2].toLowerCase().replace(/\s+/g, " ");
    const state: WriteState = raw === "pas fait" ? "pas fait" : raw === "partiel" ? "partiel" : raw === "fait" ? "fait" : "indéterminé";
    found.set(n, [...(found.get(n) ?? []), { state, detail: m[3].trim() }]);
  }
  return Array.from({ length: count }, (_, i) => {
    const lines = found.get(i + 1) ?? [];
    if (lines.length === 0) return { state: "indéterminé" as const, detail: "aucun constat pour cette écriture" };
    // Deux constats contradictoires pour la même écriture : rien n'est tranché.
    if (new Set(lines.map((l) => l.state)).size > 1) return { state: "indéterminé" as const, detail: "constats contradictoires" };
    return lines[0];
  });
}

/** Temps 2, avec le droit d'écrire : reprendre en tenant compte du constat. */
export function continuePrompt(task: Task, done: Step[], findings: { step: Step; state: WriteState; detail: string }[]): string {
  return [
    `[Message système de Clark] Vérification terminée pour la tâche n°${task.id}. Tu peux de nouveau écrire.`,
    `Demande d'origine : « ${task.prompt.slice(0, 1500)} »`,
    done.length ? `Étapes déjà terminées :\n${done.map((s) => `- ${describeStep(s)}`).join("\n")}` : "Aucune étape n'était terminée.",
    `Constat sur les écritures coupées :\n${findings.map((f) => `- ${describeStep(f.step)} : ${f.state.toUpperCase()}${f.detail ? ` (${f.detail})` : ""}`).join("\n")}`,
    "Reprends à partir de là : ne refais pas ce qui est FAIT, termine ce qui est PARTIEL, fais ce qui est PAS FAIT. Si une écriture demandait une validation de Charles, redemande-la.",
  ].join("\n\n");
}
