import type { DatabaseSync } from "node:sqlite";
import { CATALOG, type CatalogRole } from "./plan.ts";
import { NICKNAMES, SPECIALTIES } from "./contacts.ts";

/**
 * Clark chef d'orchestre : pendant son tour, il confie une mission à l'agent qui convient
 * (Mousse cherche, Braise rédige, Guimauve relit, Lilas juge les textes) et attend sa réponse,
 * ou lance une tâche de code (Boulon). La demande passe par la base : le moteur Codex tourne
 * dans un autre processus, et l'agent délégué doit tourner hors de la file de la conversation
 * (Clark l'occupe en attendant la réponse).
 */
export type DelegationRole = CatalogRole | "code";
export type Delegation = {
  id: number;
  task_id: number;
  role: DelegationRole;
  mission: string;
  project: string | null;
  status: "pending" | "running" | "done" | "failed";
  result: string | null;
  child_task_id: number | null;
  created_at: string;
};

export const DELEGATION_TIMEOUT_MS = 25 * 60_000;

export class Delegations {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS delegations (
      id            INTEGER PRIMARY KEY,
      task_id       INTEGER NOT NULL,
      role          TEXT NOT NULL,
      mission       TEXT NOT NULL,
      project       TEXT,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
      result        TEXT,
      child_task_id INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }
  add(taskId: number, role: DelegationRole, mission: string, project?: string | null): number {
    return Number(this.db.prepare("INSERT INTO delegations (task_id, role, mission, project) VALUES (?, ?, ?, ?)").run(taskId, role, mission.trim(), project?.trim() || null).lastInsertRowid);
  }
  get(id: number): Delegation | undefined {
    return this.db.prepare("SELECT * FROM delegations WHERE id = ?").get(id) as Delegation | undefined;
  }
  /** Prend une demande en attente (une seule fois, même si deux relevés se croisent). */
  claim(): Delegation | undefined {
    const d = this.db.prepare("SELECT * FROM delegations WHERE status = 'pending' ORDER BY id LIMIT 1").get() as Delegation | undefined;
    if (!d) return undefined;
    return this.db.prepare("UPDATE delegations SET status = 'running' WHERE id = ? AND status = 'pending'").run(d.id).changes ? { ...d, status: "running" } : undefined;
  }
  running(): Delegation[] {
    return this.db.prepare("SELECT * FROM delegations WHERE status = 'running'").all() as Delegation[];
  }
  setChild(id: number, childTaskId: number) {
    this.db.prepare("UPDATE delegations SET child_task_id = ? WHERE id = ?").run(childTaskId, id);
  }
  finish(id: number, status: "done" | "failed", result: string) {
    this.db.prepare("UPDATE delegations SET status = ?, result = ? WHERE id = ?").run(status, result, id);
  }
  /** Attend la réponse (relevé de la base : marche aussi depuis le processus de Codex). */
  async wait(id: number, timeoutMs = DELEGATION_TIMEOUT_MS, pollMs = 500): Promise<Delegation | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const d = this.get(id);
      if (!d) return null;
      if (d.status === "done" || d.status === "failed") return d;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }
}

const byDb = new WeakMap<DatabaseSync, Delegations>();
export function delegationsOf(db: DatabaseSync): Delegations {
  let d = byDb.get(db);
  if (!d) byDb.set(db, (d = new Delegations(db)));
  return d;
}

export const agentLabel = (role: DelegationRole) => `${NICKNAMES[role]} (${SPECIALTIES[role]})`;

/** La consigne de l'agent délégué : sa mission, ses droits, et ce qu'il rend à Clark. */
export function missionPrompt(role: CatalogRole, mission: string): string {
  const c = CATALOG[role];
  const rights = c.access === "read" ? "Tu lis seulement : tu ne modifies aucun fichier." : "Tu peux écrire dans ton dossier de travail ; rien ne part vers l'extérieur sans l'accord de Charles.";
  return `[Mission de Clark — ${NICKNAMES[role]}]
Tu es ${NICKNAMES[role]}, le ${c.name} de l'équipe de Clark (${SPECIALTIES[role]}) : ton rôle est de ${c.mission}. ${rights}
Clark, le chef d'orchestre, te confie cette mission pour répondre à Charles. Fais-la, sans sortir de ton rôle, et rends un résultat clair et concis, avec tes sources quand il y en a. Si une information manque, dis-le au lieu d'inventer.

Mission : ${mission}`;
}
