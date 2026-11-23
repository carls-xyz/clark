import type { DatabaseSync } from "node:sqlite";
import type { Initiative } from "./initiatives.ts";
import type { Memory } from "../memory/store.ts";
import { OWNER_CHAT, type Hub } from "./hub.ts";
import { TEAM_LABEL } from "./team.ts";
import { controlGoal, createGoal } from "../scheduler/goals.ts";
import { parisParts } from "../scheduler/automations.ts";

/**
 * Autonomie de Clark : ce qu'il peut décider seul, réglé par l'utilisateur type d'action par type
 * d'action (Réglages › Général › Autonomie). Par défaut, il demande.
 *
 * Quand il agit seul, il le note dans un journal (« j'ai fait X parce que Y »), le dit dans le
 * fil, et l'utilisateur peut annuler. Garde-fous fixes, quel que soit le réglage :
 *  - pas la nuit (22 h – 8 h), et pas plus de N décisions seul par jour ;
 *  - tout ce qui sort (mail, message, formulaire, publication) passe toujours par son accord,
 *    l'argent, les mots de passe et les suppressions définitives restent interdits ;
 *  - une correction de souvenir lui est toujours demandée.
 */
export type AutoKind = "veille" | "lancer" | "souvenir";

const SETTING: Record<AutoKind, [env: string, value: string]> = {
  veille: ["CLARK_AUTO_VEILLE", "agit"],
  lancer: ["CLARK_AUTO_LANCER", "seul"],
  souvenir: ["CLARK_AUTO_SOUVENIRS", "lui"],
};

export const isAutonomous = (kind: AutoKind) => process.env[SETTING[kind][0]]?.trim() === SETTING[kind][1];
export const QUIET_HOURS = { from: 22, to: 8 } as const;

const intEnv = (name: string, fallback: number) => {
  const v = process.env[name]?.trim();
  const n = Number(v);
  return v && Number.isInteger(n) ? n : fallback;
};
export const maxPerDay = () => intEnv("CLARK_AUTO_MAX", 10);
export const summaryHour = (): number | null => {
  const v = process.env.CLARK_AUTO_RESUME;
  if (v === undefined) return 21;
  return v.trim() === "" ? null : Number(v);
};

export type Decision = {
  id: number;
  kind: AutoKind;
  title: string;
  reason: string;
  /** Ce qui a été lancé ou retenu : « task », « goal » ou « memory », et son numéro. */
  ref_type: "task" | "goal" | "memory" | null;
  ref_id: number | null;
  status: "done" | "undone";
  undo_note: string | null;
  created_at: string;
  undone_at: string | null;
};

export class Decisions {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id         INTEGER PRIMARY KEY,
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL,
        reason     TEXT NOT NULL,
        ref_type   TEXT,
        ref_id     INTEGER,
        status     TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','undone')),
        undo_note  TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        undone_at  TEXT
      );
      CREATE TABLE IF NOT EXISTS autonomy_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  add(d: { kind: AutoKind; title: string; reason: string; refType?: Decision["ref_type"]; refId?: number | null }): number {
    const r = this.db
      .prepare("INSERT INTO decisions (kind, title, reason, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)")
      .run(d.kind, d.title.trim(), d.reason.trim(), d.refType ?? null, d.refId ?? null);
    return Number(r.lastInsertRowid);
  }

  setRef(id: number, refType: Decision["ref_type"], refId: number) {
    this.db.prepare("UPDATE decisions SET ref_type = ?, ref_id = ? WHERE id = ?").run(refType, refId, id);
  }

  get(id: number): Decision | undefined {
    return this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Decision | undefined;
  }

  recent(limit = 30): Decision[] {
    return this.db.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?").all(limit) as Decision[];
  }

  /** Décisions prises depuis une date (UTC, format SQLite). */
  since(at: string): Decision[] {
    return this.db.prepare("SELECT * FROM decisions WHERE created_at >= ? ORDER BY id").all(at) as Decision[];
  }

  markUndone(id: number, note: string): boolean {
    return this.db.prepare("UPDATE decisions SET status = 'undone', undo_note = ?, undone_at = datetime('now') WHERE id = ? AND status = 'done'").run(note, id).changes > 0;
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM autonomy_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO autonomy_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

const byDb = new WeakMap<DatabaseSync, Decisions>();
export function decisionsOf(db: DatabaseSync): Decisions {
  let d = byDb.get(db);
  if (!d) byDb.set(db, (d = new Decisions(db)));
  return d;
}

/** Début du jour à Paris, en UTC au format SQLite. */
export function parisDayStart(now = new Date()): string {
  const p = parisParts(now);
  const [y, m, d] = p.date.split("-").map(Number);
  // Décalage Paris/UTC à cet instant (à la minute près), appliqué à minuit, heure de Paris.
  const offset = Math.round((Date.UTC(y, m - 1, d, p.hour, p.minute) - now.getTime()) / 60_000) * 60_000;
  const start = new Date(Date.UTC(y, m - 1, d) - offset);
  return start.toISOString().slice(0, 19).replace("T", " ");
}

/** Clark peut-il décider seul maintenant ? Sinon, pourquoi (il redemande alors à l'utilisateur). */
export function canActAlone(decisions: Decisions, now = new Date()): { ok: true } | { ok: false; why: string } {
  const hour = parisParts(now).hour;
  if (hour >= QUIET_HOURS.from || hour < QUIET_HOURS.to) return { ok: false, why: "la nuit, je te demande" };
  const max = maxPerDay();
  const today = decisions.since(parisDayStart(now)).length;
  if (today >= max) return { ok: false, why: `j'ai déjà décidé seul ${today} fois aujourd'hui (plafond ${max})` };
  return { ok: true };
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Une proposition acceptée (par l'utilisateur ou par Clark) : ce qu'elle lance. */
export function launchInitiative(hub: Hub, i: Initiative, onLaunched?: (ref: { type: "task" | "goal"; id: number }) => void) {
  const source = `initiative:${i.title}`;
  // La proposition garde ce qu'elle a lancé : c'est ce qui sera mesuré (critère de réussite, ton avis).
  const launched = (ref: { type: "task" | "goal"; id: number }) => {
    hub.deps.store.initiatives.linkExecution(i.id, ref);
    onLaunched?.(ref);
  };
  if (i.mode === "goal") {
    const id = createGoal(hub, i.action, undefined, "clark");
    launched({ type: "goal", id });
    return;
  }
  void hub.enqueue(OWNER_CHAT, i.action, i.mode === "team" ? TEAM_LABEL : "chat", source, { onCreated: (taskId) => launched({ type: "task", id: taskId }) });
}

/**
 * Branche l'autonomie sur Clark : les propositions et souvenirs que l'utilisateur lui a permis de
 * trancher seul le sont, dans les limites ; le reste suit le chemin habituel (accord de l'utilisateur).
 */
export function startAutonomy(hub: Hub, now: () => Date = () => new Date()): () => void {
  const { store } = hub.deps;
  const decisions = decisionsOf(store.db);

  hub.setAutonomy({
    launch: (i) => launchInitiative(hub, i),
    initiative: (i) => {
      const kind: AutoKind = i.mode === "chat" ? "veille" : "lancer";
      if (!isAutonomous(kind)) return false;
      const can = canActAlone(decisions, now());
      if (!can.ok) {
        void hub.post(OWNER_CHAT, `Je pourrais lancer « ${short(i.title, 100)} » seul, mais ${can.why} : je te le propose.`, "system");
        return false;
      }
      if (!store.initiatives.decide(i.id, "accepted", undefined, undefined, true)) return false;
      const id = decisions.add({ kind, title: i.title, reason: i.why });
      launchInitiative(hub, i, (ref) => decisions.setRef(id, ref.type, ref.id));
      const what = i.mode === "team" ? "J'ai lancé une équipe" : i.mode === "goal" ? "J'ai lancé un objectif" : "J'ai décidé seul";
      void hub.post(OWNER_CHAT, `${what} : « ${short(i.title, 120)} ». Pourquoi : ${short(i.why, 240)} Tu peux l'annuler dans Activité.`, "system", "proposals");
      return true;
    },
    memory: (m) => {
      // Une correction touche un fait déjà confirmé : toujours demandée à l'utilisateur.
      if (m.replaces_id !== null || !isAutonomous("souvenir")) return false;
      if (!canActAlone(decisions, now()).ok) return false;
      if (!store.confirm(m.id)) return false;
      decisions.add({ kind: "souvenir", title: short(m.content, 200), reason: `Source : ${m.source ?? "inconnue"}`, refType: "memory", refId: m.id });
      void hub.post(OWNER_CHAT, `J'ai retenu : « ${short(m.content, 200)} ». Source : ${short(m.source ?? "", 160)}. Tu peux l'annuler dans Activité.`, "system");
      return true;
    },
  });

  // Souvenirs proposés depuis le serveur de mémoire de Codex (autre processus) : vus ici au passage.
  const seen = new Set<number>();
  const poll = setInterval(() => {
    if (!isAutonomous("souvenir")) return;
    for (const p of store.proposals()) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (p.source_task_id === null) continue;
      if (hub.autoMemory(p as unknown as Memory)) hub.touch();
    }
  }, 20_000);
  poll.unref();

  // Résumé du soir : ce que Clark a décidé seul aujourd'hui.
  const evening = setInterval(() => {
    const at = now();
    const hour = summaryHour();
    if (hour === null || parisParts(at).hour !== hour) return;
    const day = parisDayStart(at);
    if (decisions.meta("summary_day") === day) return;
    decisions.setMeta("summary_day", day);
    const list = decisions.since(day);
    if (!list.length) return;
    const lines = list.map((d) => `- ${d.status === "undone" ? "(annulé) " : ""}${d.title}`).join("\n");
    void hub.post(OWNER_CHAT, `Ce que j'ai décidé seul aujourd'hui (${list.length}) :\n${lines}\n\nTout est dans Activité, avec de quoi annuler.`, "system", "proposals");
  }, 60_000);
  evening.unref();

  return () => {
    clearInterval(poll);
    clearInterval(evening);
  };
}

/** Annuler une décision de Clark : arrêter ce qu'il a lancé, ou oublier ce qu'il a retenu. */
export function undoDecision(hub: Hub, id: number): { ok: true; note: string } | { ok: false; why: string } {
  const { store, journal } = hub.deps;
  const decisions = decisionsOf(store.db);
  const d = decisions.get(id);
  if (!d) return { ok: false, why: "Décision introuvable" };
  if (d.status === "undone") return { ok: false, why: "Déjà annulée" };
  let note: string;
  if (d.ref_type === "memory" && d.ref_id !== null) {
    if (!store.forget(d.ref_id)) return { ok: false, why: "Ce souvenir n'existe plus" };
    note = "souvenir oublié";
  } else if (d.ref_type === "goal" && d.ref_id !== null) {
    const r = controlGoal(hub, d.ref_id, "stop");
    if (r === "missing") return { ok: false, why: "Objectif introuvable" };
    note = r === "done" ? "objectif arrêté" : "objectif déjà terminé";
  } else if (d.ref_type === "task" && d.ref_id !== null) {
    const t = journal.get(d.ref_id);
    if (!t) return { ok: false, why: "Tâche introuvable" };
    if (!["queued", "running"].includes(t.status)) return { ok: false, why: "Trop tard : c'est déjà fait. Rien n'est parti à l'extérieur sans ton accord." };
    if (hub.stopTask(t.id) !== "stopped") return { ok: false, why: "Il démarre à l'instant : réessaie dans quelques secondes." };
    note = "arrêté en cours de route";
  } else return { ok: false, why: "Rien à annuler" };
  decisions.markUndone(id, note);
  // Une proposition lancée seule puis annulée par toi : comptée comme ratée dans le bilan.
  if (d.ref_type === "task" || d.ref_type === "goal") {
    const i = d.ref_id !== null ? store.initiatives.byExecution({ type: d.ref_type, id: d.ref_id }) : undefined;
    if (i) store.initiatives.setOutcome(i.id, "rate", `annulée par toi (${note})`);
  }
  void hub.post(OWNER_CHAT, `Annulé : « ${short(d.title, 120)} » (${note}).`, "system");
  hub.touch();
  return { ok: true, note };
}
