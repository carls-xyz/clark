import type { DatabaseSync } from "node:sqlite";

/**
 * Côté dev : les projets (tes dépôts git) et les tâches dev (une consigne, une copie du
 * dépôt, un agent). Chaque tâche a sa propre conversation (DEV_CHAT_BASE + id) : une
 * retouche reprend la session de l'agent, avec son contexte.
 */
export const DEV_CHAT_BASE = 2000;
export const devChat = (id: number) => DEV_CHAT_BASE + id;
export const isDevChat = (chatId: number) => chatId >= DEV_CHAT_BASE && chatId < DEV_CHAT_BASE + 1_000_000;
export const DEV_LABEL_PREFIX = "dev:";
export const devOfLabel = (label: string) => (label.startsWith(DEV_LABEL_PREFIX) ? Number(label.slice(DEV_LABEL_PREFIX.length)) || null : null);

/** Fil de l'agent de plan d'un groupe (en dehors des fils de tâches dev). */
export const DEV_GROUP_CHAT_BASE = 3_000_000;
export const devGroupChat = (id: number) => DEV_GROUP_CHAT_BASE + id;
export const DEV_PLAN_PREFIX = "devplan:";
export const devPlanOfLabel = (label: string) => (label.startsWith(DEV_PLAN_PREFIX) ? Number(label.slice(DEV_PLAN_PREFIX.length)) || null : null);

/** Binôme : fil du relecteur d'une tâche, et fil du second moteur qui critique le plan d'un groupe. */
export const DEV_REVIEW_CHAT_BASE = 4_000_000;
export const devReviewChat = (id: number) => DEV_REVIEW_CHAT_BASE + id;
export const DEV_REVIEW_PREFIX = "devrev:";
export const devReviewOfLabel = (label: string) => (label.startsWith(DEV_REVIEW_PREFIX) ? Number(label.slice(DEV_REVIEW_PREFIX.length)) || null : null);
/**
 * 8 000 000 : en dehors des fils des automatisations (5 000 000 + id). Les deux plages
 * se chevauchaient : une automatisation reprenait la session de la critique du même numéro.
 */
export const DEV_CRITIQUE_CHAT_BASE = 8_000_000;
/** Ancienne plage des fils de critique, partagée par erreur avec les automatisations. */
const OLD_CRITIQUE_CHAT_BASE = 5_000_000;

/**
 * Remet les anciennes critiques (5 000 000 + id) dans leur nouvelle plage : leurs tâches et
 * leurs messages suivent. Leur session suit aussi, sauf si une automatisation du même numéro
 * existe : on ne sait plus à qui elle est, elle part (les deux repartent de zéro). Sans effet
 * une fois fait. Renvoie le nombre de fils déplacés.
 */
export function moveCritiqueChats(db: DatabaseSync): number {
  let chats: { chat_id: number }[];
  try {
    chats = db
      .prepare("SELECT DISTINCT chat_id FROM tasks WHERE label LIKE ? AND chat_id >= ? AND chat_id < ?")
      .all(`${DEV_CRITIQUE_PREFIX}%`, OLD_CRITIQUE_CHAT_BASE, OLD_CRITIQUE_CHAT_BASE + 1_000_000) as { chat_id: number }[];
  } catch {
    return 0; // table des tâches absente (base de test réduite)
  }
  const automationExists = (id: number) => {
    try {
      return db.prepare("SELECT 1 FROM automations WHERE id = ?").get(id) !== undefined;
    } catch {
      return false;
    }
  };
  for (const { chat_id: old } of chats) {
    const id = old - OLD_CRITIQUE_CHAT_BASE;
    const next = devCritiqueChat(id);
    db.exec("BEGIN");
    try {
      const tasks = (db.prepare("SELECT id FROM tasks WHERE chat_id = ? AND label LIKE ?").all(old, `${DEV_CRITIQUE_PREFIX}%`) as { id: number }[]).map((t) => t.id);
      for (const t of tasks) {
        db.prepare("UPDATE tasks SET chat_id = ? WHERE id = ?").run(next, t);
        try {
          db.prepare("UPDATE messages SET chat_id = ? WHERE task_id = ? AND chat_id = ?").run(next, t, old);
        } catch {
          // pas de table des messages
        }
      }
      try {
        if (automationExists(id)) db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(old);
        else db.prepare("UPDATE OR REPLACE sessions SET chat_id = ? WHERE chat_id = ?").run(next, old);
      } catch {
        // pas de table des sessions
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return chats.length;
}
export const devCritiqueChat = (id: number) => DEV_CRITIQUE_CHAT_BASE + id;
export const DEV_CRITIQUE_PREFIX = "devcrit:";
export const devCritiqueOfLabel = (label: string) => (label.startsWith(DEV_CRITIQUE_PREFIX) ? Number(label.slice(DEV_CRITIQUE_PREFIX.length)) || null : null);

/**
 * Groupe : une consigne découpée en sous-tâches parallèles, chacune dans sa copie.
 * - planning : l'agent de plan lit le projet.   - running : les sous-tâches travaillent ou attendent la relecture.
 * - integrated : les sous-tâches acceptées sont réunies sur une branche.   - failed / discarded.
 */
export type DevGroupStatus = "planning" | "running" | "integrated" | "failed" | "discarded";
export type DevGroup = {
  id: number;
  project_id: number;
  title: string;
  instruction: string;
  engine: string | null;
  status: DevGroupStatus;
  plan_worktree: string | null;
  branch: string | null;
  commit_sha: string | null;
  pr_url: string | null;
  error: string | null;
  issue_number: number | null;
  issue_url: string | null;
  pr_status: string | null;
  /** « binome » : Claude et Codex (l'un écrit, l'autre relit) ; null : sous-tâches classiques. */
  mode: string | null;
  /** La critique du plan par le second moteur (binôme). */
  plan_note: string | null;
  /** Pilote automatique : sous-tâches acceptées seules, réunion et PR ouvertes par Clark (1). */
  autopilot: number;
  created_at: string;
  updated_at: string;
};

/** Un commentaire de l'utilisateur sur des lignes du diff d'une tâche ; envoyé à l'agent avec les autres, en un lot. */
export type DevComment = {
  id: number;
  task_id: number;
  file: string;
  side: "new" | "old";
  line_start: number;
  line_end: number;
  /** Les lignes commentées, telles qu'elles étaient : de quoi retrouver leur place si le diff bouge. */
  snippet: string;
  body: string;
  status: "open" | "resolved";
  /** Tour où il a été envoyé à l'agent (null : pas encore). */
  sent_round: number | null;
  created_at: string;
};

export type Project = {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_command: string | null;
  /** Réglages du projet : moteur, modèle et effort par défaut de ses tâches. */
  default_engine: string | null;
  default_model: string | null;
  default_effort: string | null;
  /** Commande lancée dans chaque nouvelle copie, avant l'agent (ex. npm ci). */
  setup_command: string | null;
  /** Fichiers ignorés par git (sans secrets) copiés dans chaque nouvelle copie (JSON). */
  copy_paths: string | null;
  /** Aperçu (mode design) : commande d'un serveur de dev ($PORT), sinon les fichiers de la copie. */
  preview_command: string | null;
  /** Page ouverte par l'aperçu (fichier de la copie, ou chemin sur le serveur de dev). */
  preview_path: string | null;
  created_at: string;
};

/**
 * - preparing : copie en cours de création.   - working : l'agent travaille.
 * - review    : changements prêts à relire.    - accepted / discarded : décidé par l'utilisateur.
 * - failed    : la copie ou l'agent a échoué (raison dans error).
 * - waiting   : sous-tâche d'un groupe qui attend d'autres sous-tâches (depends_on) ou une décision.
 */
export type DevStatus = "waiting" | "preparing" | "working" | "review" | "accepted" | "discarded" | "failed";

/** Une décision demandée à l'utilisateur par le plan, avant de lancer certaines sous-tâches. */
export type DevGate = {
  id: number;
  group_id: number;
  question: string;
  options: string[];
  task_ids: number[];
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type DevTask = {
  id: number;
  project_id: number;
  title: string;
  instruction: string;
  engine: string | null;
  branch: string;
  worktree: string;
  base_commit: string | null;
  status: DevStatus;
  error: string | null;
  summary: string | null;
  /** Dernier diff calculé (JSON : fichiers et totaux ; le patch est relu à la demande). */
  diff_stat: string | null;
  commit: string | null;
  tests: string | null;
  rounds: number;
  group_id: number | null;
  pr_url: string | null;
  /** Sous-tâches (ids) dont le travail doit être accepté avant de commencer (JSON). */
  depends_on: string | null;
  /** Modèle et effort choisis pour cette tâche (réessai) ; null : les réglages du moteur. */
  model: string | null;
  effort: string | null;
  attempts: number;
  /** Travaille sur une branche qui existe déjà (celle d'une PR) : ni créée, ni supprimée par Clark. */
  existing_branch: number;
  /** Résolution de conflit : branche fusionnée dans la copie avant le tour, conflits à résoudre. */
  merge_branch: string | null;
  /** Binôme : le moteur qui relit chaque version (l'autre que l'auteur). */
  reviewer: string | null;
  review_rounds: number;
  /** approved (relu et approuvé), disagree (désaccord après le dernier tour), skipped (relecture impossible). */
  review_state: string | null;
  /** L'agent s'est dit bloqué (« BILAN : bloqué — … ») : ce qu'il attend de l'utilisateur. Effacé à la reprise. */
  blocked_on: string | null;
  /** JSON : un élément par tour de relecture { round, reviewer, approve, issues, summary }. */
  review_notes: string | null;
  /** Relances automatiques faites après la limite d'étapes d'un tour (3 au plus par consigne). */
  auto_continues: number;
  /** Corrections automatiques après des tests rouges, avant la relecture de l'utilisateur (2 au plus). */
  test_fixes: number;
  /** Pilote automatique : Clark accepte seul une version prête, aux tests verts (1), ou attend l'utilisateur (0). */
  autopilot: number;
  /** Tâche de suivi d'une PR : « task:5 » ou « group:2 ». Accepter pousse sur la PR. */
  pr_of: string | null;
  /** Issue GitHub d'origine (« Closes #n » dans la PR). */
  issue_number: number | null;
  issue_url: string | null;
  /** Dernier état lu de la PR (JSON). */
  pr_status: string | null;
  /** Préparation de la copie (fichiers copiés, commande du projet) : résultat (JSON). */
  setup_log: string | null;
  /** Tour dont la copie a l'état (« Revenir à ce tour ») ; null : le dernier. */
  at_round: number | null;
  /** À dire à l'agent au début de son prochain tour (retour à un tour précédent). */
  agent_note: string | null;
  /** Comparaison : l'autre version de la même consigne (un autre moteur ou un autre effort). */
  compare_with: number | null;
  /** Tour demandé qui attend une place d'agent (JSON { prompt, images }) : repris après un redémarrage. */
  pending_turn: string | null;
  created_at: string;
  updated_at: string;
};

export class DevStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        path         TEXT NOT NULL UNIQUE,
        base_branch  TEXT NOT NULL,
        test_command TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS dev_tasks (
        id          INTEGER PRIMARY KEY,
        project_id  INTEGER NOT NULL REFERENCES projects(id),
        title       TEXT NOT NULL,
        instruction TEXT NOT NULL,
        engine      TEXT,
        branch      TEXT NOT NULL,
        worktree    TEXT NOT NULL,
        base_commit TEXT,
        status      TEXT NOT NULL DEFAULT 'preparing',
        error       TEXT,
        summary     TEXT,
        diff_stat   TEXT,
        "commit"    TEXT,
        tests       TEXT,
        rounds      INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS dev_groups (
        id            INTEGER PRIMARY KEY,
        project_id    INTEGER NOT NULL REFERENCES projects(id),
        title         TEXT NOT NULL,
        instruction   TEXT NOT NULL,
        engine        TEXT,
        status        TEXT NOT NULL DEFAULT 'planning',
        plan_worktree TEXT,
        branch        TEXT,
        commit_sha    TEXT,
        pr_url        TEXT,
        error         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS dev_gates (
        id          INTEGER PRIMARY KEY,
        group_id    INTEGER NOT NULL REFERENCES dev_groups(id),
        question    TEXT NOT NULL,
        options     TEXT NOT NULL DEFAULT '[]',
        task_ids    TEXT NOT NULL DEFAULT '[]',
        resolution  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS dev_checkpoints (
        task_id    INTEGER NOT NULL,
        round      INTEGER NOT NULL,
        sha        TEXT NOT NULL,
        summary    TEXT,
        diff_stat  TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, round)
      );
      CREATE TABLE IF NOT EXISTS dev_comments (
        id          INTEGER PRIMARY KEY,
        task_id     INTEGER NOT NULL REFERENCES dev_tasks(id),
        file        TEXT NOT NULL,
        side        TEXT NOT NULL DEFAULT 'new' CHECK (side IN ('new','old')),
        line_start  INTEGER NOT NULL,
        line_end    INTEGER NOT NULL,
        snippet     TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
        sent_round  INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    for (const col of ["default_engine", "default_model", "default_effort", "setup_command", "copy_paths", "preview_command", "preview_path"]) {
      const cols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
      if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
    }
    // mode : « binome » (Claude et Codex : l'un écrit, l'autre relit) ; plan_note : la critique du plan.
    for (const [col, def] of [["issue_number", "INTEGER"], ["issue_url", "TEXT"], ["pr_status", "TEXT"], ["mode", "TEXT"], ["plan_note", "TEXT"], ["autopilot", "INTEGER NOT NULL DEFAULT 0"]]) {
      const cols = db.prepare("PRAGMA table_info(dev_groups)").all() as { name: string }[];
      if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE dev_groups ADD COLUMN ${col} ${def}`);
    }
    for (const [col, def] of [
      ["group_id", "INTEGER"],
      ["pr_url", "TEXT"],
      ["depends_on", "TEXT"],
      ["model", "TEXT"],
      ["effort", "TEXT"],
      ["attempts", "INTEGER NOT NULL DEFAULT 1"],
      ["existing_branch", "INTEGER NOT NULL DEFAULT 0"],
      ["pr_of", "TEXT"],
      ["issue_number", "INTEGER"],
      ["issue_url", "TEXT"],
      ["pr_status", "TEXT"],
      ["setup_log", "TEXT"],
      ["at_round", "INTEGER"],
      ["agent_note", "TEXT"],
      ["compare_with", "INTEGER"],
      ["pending_turn", "TEXT"],
      ["merge_branch", "TEXT"],
      // Binôme : le moteur qui relit, les tours de relecture faits, l'état (approved, disagree, skipped), les notes.
      ["reviewer", "TEXT"],
      ["review_rounds", "INTEGER NOT NULL DEFAULT 0"],
      ["review_state", "TEXT"],
      ["review_notes", "TEXT"],
      ["blocked_on", "TEXT"],
      // Tâches longues : relances automatiques après la limite d'étapes, corrections après des tests rouges.
      ["auto_continues", "INTEGER NOT NULL DEFAULT 0"],
      ["test_fixes", "INTEGER NOT NULL DEFAULT 0"],
      // Pilote automatique : accepter seul une version prête et verte (src/dev/autopilot.ts).
      ["autopilot", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      const cols = db.prepare("PRAGMA table_info(dev_tasks)").all() as { name: string }[];
      if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE dev_tasks ADD COLUMN ${col} ${def}`);
    }
    // Tâches bloquées avant la colonne blocked_on : ce qu'attend l'agent est relu dans le message d'erreur.
    db.exec(
      `UPDATE dev_tasks SET blocked_on = substr(error, length('l''agent est bloqué : ') + 1)
       WHERE status = 'failed' AND blocked_on IS NULL AND error LIKE 'l''agent est bloqué : %'`,
    );
  }

  // ── Groupes ──

  createGroup(g: { projectId: number; title: string; instruction: string; engine: string | null; planWorktree: string }): number {
    const r = this.db
      .prepare("INSERT INTO dev_groups (project_id, title, instruction, engine, plan_worktree) VALUES (?, ?, ?, ?, ?)")
      .run(g.projectId, g.title, g.instruction, g.engine, g.planWorktree);
    const id = Number(r.lastInsertRowid);
    this.purgeLeftovers(devGroupChat(id));
    this.changed();
    return id;
  }

  /**
   * Retirer un projet libère les numéros de ses tâches : SQLite peut les redonner. Ce qu'une
   * ancienne tâche du même numéro a laissé (session d'agent, fil, points de reprise) part, sinon
   * la nouvelle reprendrait la conversation de l'ancienne.
   */
  private purgeLeftovers(chatId: number, taskId?: number) {
    for (const [sql, arg] of [
      ["DELETE FROM sessions WHERE chat_id = ?", chatId],
      ["DELETE FROM messages WHERE chat_id = ?", chatId],
      ...(taskId === undefined ? [] : [["DELETE FROM dev_checkpoints WHERE task_id = ?", taskId] as const]),
    ] as const) {
      try {
        this.db.prepare(sql).run(arg);
      } catch {
        // table absente (base de test réduite) : rien à purger
      }
    }
  }

  group(id: number): DevGroup | undefined {
    return this.db.prepare("SELECT * FROM dev_groups WHERE id = ?").get(id) as DevGroup | undefined;
  }

  groups(limit = 20): DevGroup[] {
    return this.db.prepare("SELECT * FROM dev_groups ORDER BY CASE WHEN status IN ('planning','running') THEN 0 ELSE 1 END, id DESC LIMIT ?").all(limit) as DevGroup[];
  }

  groupTasks(groupId: number): DevTask[] {
    return this.db.prepare("SELECT * FROM dev_tasks WHERE group_id = ? ORDER BY id").all(groupId) as DevTask[];
  }

  updateGroup(id: number, fields: Partial<Pick<DevGroup, "status" | "plan_worktree" | "branch" | "commit_sha" | "pr_url" | "error" | "issue_number" | "issue_url" | "pr_status" | "mode" | "plan_note" | "autopilot">>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE dev_groups SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => (fields[k] ?? null) as any), id);
    this.changed();
  }

  // ── Points de reprise (un par tour de l'agent) ──

  addCheckpoint(c: { taskId: number; round: number; sha: string; summary: string | null; diffStat: string | null }) {
    this.db
      .prepare("INSERT INTO dev_checkpoints (task_id, round, sha, summary, diff_stat) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET sha = excluded.sha, summary = excluded.summary, diff_stat = excluded.diff_stat, created_at = datetime('now')")
      .run(c.taskId, c.round, c.sha, c.summary, c.diffStat);
    this.changed();
  }

  checkpoints(taskId: number): { round: number; sha: string; summary: string | null; diff_stat: string | null; created_at: string }[] {
    return this.db.prepare("SELECT round, sha, summary, diff_stat, created_at FROM dev_checkpoints WHERE task_id = ? ORDER BY round").all(taskId) as any[];
  }

  clearCheckpoints(taskId: number) {
    this.db.prepare("DELETE FROM dev_checkpoints WHERE task_id = ?").run(taskId);
    this.changed();
  }

  // ── Commentaires sur le diff ──

  addComment(c: { taskId: number; file: string; side: "new" | "old"; start: number; end: number; snippet: string; body: string }): number {
    const r = this.db
      .prepare("INSERT INTO dev_comments (task_id, file, side, line_start, line_end, snippet, body) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.taskId, c.file, c.side, c.start, c.end, c.snippet, c.body);
    this.changed();
    return Number(r.lastInsertRowid);
  }

  comment(id: number): DevComment | undefined {
    return this.db.prepare("SELECT * FROM dev_comments WHERE id = ?").get(id) as DevComment | undefined;
  }

  comments(taskId: number): DevComment[] {
    return this.db.prepare("SELECT * FROM dev_comments WHERE task_id = ? ORDER BY file, line_start, id").all(taskId) as DevComment[];
  }

  setCommentStatus(id: number, status: "open" | "resolved"): boolean {
    const ok = this.db.prepare("UPDATE dev_comments SET status = ? WHERE id = ?").run(status, id).changes > 0;
    if (ok) this.changed();
    return ok;
  }

  /** Un commentaire pas encore envoyé se retire ; un commentaire envoyé se résout. */
  deleteComment(id: number): boolean {
    const ok = this.db.prepare("DELETE FROM dev_comments WHERE id = ? AND sent_round IS NULL").run(id).changes > 0;
    if (ok) this.changed();
    return ok;
  }

  markCommentsSent(ids: number[], round: number) {
    const st = this.db.prepare("UPDATE dev_comments SET sent_round = ? WHERE id = ?");
    for (const id of ids) st.run(round, id);
    this.changed();
  }

  /** Tour annulé avant de partir : ses commentaires redeviennent à envoyer. */
  unmarkCommentsSent(taskId: number, round: number) {
    this.db.prepare("UPDATE dev_comments SET sent_round = NULL WHERE task_id = ? AND sent_round = ?").run(taskId, round);
    this.changed();
  }

  /** Tâches et groupes qui ont une PR encore à suivre. */
  watchedPrs(): { kind: "task" | "group"; id: number; project_id: number; url: string; status: string | null }[] {
    const tasks = this.db.prepare("SELECT 'task' AS kind, id, project_id, pr_url AS url, pr_status AS status FROM dev_tasks WHERE pr_url IS NOT NULL AND pr_of IS NULL").all() as any[];
    const groups = this.db.prepare("SELECT 'group' AS kind, id, project_id, pr_url AS url, pr_status AS status FROM dev_groups WHERE pr_url IS NOT NULL").all() as any[];
    return [...tasks, ...groups].filter((r) => {
      const st = r.status ? JSON.parse(r.status).state : "OPEN";
      return st !== "MERGED" && st !== "CLOSED";
    });
  }

  /** Les tâches de suivi d'une PR (correction de CI, réponse aux reviews). */
  followUps(prOf: string): DevTask[] {
    return this.db.prepare("SELECT * FROM dev_tasks WHERE pr_of = ? ORDER BY id").all(prOf) as DevTask[];
  }

  // ── Décisions ──

  createGate(g: { groupId: number; question: string; options: string[]; taskIds: number[] }): number {
    const r = this.db.prepare("INSERT INTO dev_gates (group_id, question, options, task_ids) VALUES (?, ?, ?, ?)").run(g.groupId, g.question, JSON.stringify(g.options), JSON.stringify(g.taskIds));
    this.changed();
    return Number(r.lastInsertRowid);
  }

  private gateRow(r: any): DevGate {
    return { ...r, options: JSON.parse(r.options), task_ids: JSON.parse(r.task_ids) };
  }

  gate(id: number): DevGate | undefined {
    const r = this.db.prepare("SELECT * FROM dev_gates WHERE id = ?").get(id);
    return r ? this.gateRow(r) : undefined;
  }

  gates(groupId: number): DevGate[] {
    return (this.db.prepare("SELECT * FROM dev_gates WHERE group_id = ? ORDER BY id").all(groupId) as any[]).map((r) => this.gateRow(r));
  }

  openGates(): DevGate[] {
    return (this.db.prepare("SELECT * FROM dev_gates WHERE resolution IS NULL ORDER BY id").all() as any[]).map((r) => this.gateRow(r));
  }

  /** Une décision ne se prend qu'une fois. */
  resolveGate(id: number, resolution: string): boolean {
    const ok = this.db.prepare("UPDATE dev_gates SET resolution = ?, resolved_at = datetime('now') WHERE id = ? AND resolution IS NULL").run(resolution, id).changes > 0;
    if (ok) this.changed();
    return ok;
  }

  setGroup(taskId: number, groupId: number) {
    this.db.prepare("UPDATE dev_tasks SET group_id = ? WHERE id = ?").run(groupId, taskId);
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  // ── Projets ──

  projects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY name").all() as Project[];
  }

  project(id: number): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
  }

  addProject(p: { name: string; path: string; baseBranch: string; testCommand?: string | null }): number {
    const r = this.db
      .prepare("INSERT INTO projects (name, path, base_branch, test_command) VALUES (?, ?, ?, ?)")
      .run(p.name.trim(), p.path, p.baseBranch, p.testCommand?.trim() || null);
    this.changed();
    return Number(r.lastInsertRowid);
  }

  updateProject(
    id: number,
    p: { baseBranch?: string; testCommand?: string | null; defaultEngine?: string | null; defaultModel?: string | null; defaultEffort?: string | null; setupCommand?: string | null; copyPaths?: string[] | null; previewCommand?: string | null; previewPath?: string | null },
  ) {
    if (p.baseBranch) this.db.prepare("UPDATE projects SET base_branch = ? WHERE id = ?").run(p.baseBranch, id);
    if (p.testCommand !== undefined) this.db.prepare("UPDATE projects SET test_command = ? WHERE id = ?").run(p.testCommand?.trim() || null, id);
    const cols: [string, unknown][] = [
      ["default_engine", p.defaultEngine],
      ["default_model", p.defaultModel],
      ["default_effort", p.defaultEffort],
      ["setup_command", p.setupCommand],
      ["copy_paths", p.copyPaths === undefined ? undefined : p.copyPaths?.length ? JSON.stringify(p.copyPaths) : null],
      ["preview_command", p.previewCommand],
      ["preview_path", p.previewPath],
    ];
    for (const [col, v] of cols) if (v !== undefined) this.db.prepare(`UPDATE projects SET ${col} = ? WHERE id = ?`).run((typeof v === "string" ? v.trim() || null : v) as any, id);
    this.changed();
  }

  /** Un projet avec des tâches encore ouvertes ne se retire pas. */
  removeProject(id: number): "done" | "busy" | "missing" {
    if (!this.project(id)) return "missing";
    const open = this.db.prepare("SELECT COUNT(*) AS n FROM dev_tasks WHERE project_id = ? AND status IN ('waiting','preparing','working','review','failed')").get(id) as { n: number };
    const planning = this.db.prepare("SELECT COUNT(*) AS n FROM dev_groups WHERE project_id = ? AND status = 'planning'").get(id) as { n: number };
    if (open.n > 0 || planning.n > 0) return "busy";
    this.db.prepare("DELETE FROM dev_comments WHERE task_id IN (SELECT id FROM dev_tasks WHERE project_id = ?)").run(id);
    this.db.prepare("DELETE FROM dev_tasks WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM dev_gates WHERE group_id IN (SELECT id FROM dev_groups WHERE project_id = ?)").run(id);
    this.db.prepare("DELETE FROM dev_groups WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    this.changed();
    return "done";
  }

  // ── Tâches dev ──

  create(t: { projectId: number; title: string; instruction: string; engine: string | null; branch: string; worktree: string; status?: DevStatus; dependsOn?: number[] }): number {
    const r = this.db
      .prepare("INSERT INTO dev_tasks (project_id, title, instruction, engine, branch, worktree, status, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.projectId, t.title, t.instruction, t.engine, t.branch, t.worktree, t.status ?? "preparing", t.dependsOn?.length ? JSON.stringify(t.dependsOn) : null);
    const id = Number(r.lastInsertRowid);
    this.purgeLeftovers(devChat(id), id);
    this.changed();
    return id;
  }

  get(id: number): DevTask | undefined {
    return this.db.prepare("SELECT * FROM dev_tasks WHERE id = ?").get(id) as DevTask | undefined;
  }

  /** Tâches seules (hors groupes), les ouvertes d'abord. */
  list(limit = 30): DevTask[] {
    return this.db
      .prepare("SELECT * FROM dev_tasks WHERE group_id IS NULL ORDER BY CASE WHEN status IN ('preparing','working','review') THEN 0 ELSE 1 END, id DESC LIMIT ?")
      .all(limit) as DevTask[];
  }

  open(): DevTask[] {
    return this.db.prepare("SELECT * FROM dev_tasks WHERE status IN ('waiting','preparing','working','review') ORDER BY id").all() as DevTask[];
  }

  update(
    id: number,
    fields: Partial<
      Pick<
        DevTask,
        | "status" | "error" | "summary" | "diff_stat" | "commit" | "tests" | "base_commit" | "rounds" | "pr_url" | "instruction" | "branch" | "worktree"
        | "engine" | "model" | "effort" | "attempts" | "depends_on" | "existing_branch" | "pr_of" | "issue_number" | "issue_url" | "pr_status" | "setup_log" | "at_round" | "agent_note" | "compare_with" | "pending_turn" | "merge_branch"
        | "reviewer" | "review_rounds" | "review_state" | "review_notes" | "auto_continues" | "test_fixes" | "autopilot" | "blocked_on"
      >
    >,
  ) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE dev_tasks SET ${keys.map((k) => `"${k}" = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => (fields[k] ?? null) as any), id);
    this.changed();
  }

  /** Passe d'un état à l'autre seulement depuis l'état attendu : une décision ne compte qu'une fois. */
  transition(id: number, from: DevStatus[], to: DevStatus): boolean {
    const ok =
      this.db
        .prepare(`UPDATE dev_tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`)
        .run(to, id, ...from).changes > 0;
    if (ok) this.changed();
    return ok;
  }
}
