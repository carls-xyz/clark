import type { DatabaseSync } from "node:sqlite";

/**
 * Automatisations planifiées (idée reprise d'Orca) : une consigne lancée toute seule
 * à heure fixe, par Clark seul ou par l'équipe. Créées et réglées par l'utilisateur dans
 * l'interface ; Clark ne s'en crée pas lui-même.
 *
 * Heures en heure de Paris. Chaque occurrence a une clé (« 2026-11-19T09:00 ») notée
 * avant le lancement : une occurrence ne part jamais deux fois, même après un redémarrage.
 */
export type Frequency = "daily" | "weekdays" | "weekly" | "hourly";

export type Automation = {
  id: number;
  name: string;
  prompt: string;
  frequency: Frequency;
  /** « HH:MM » ; pour « hourly », seules les minutes comptent. */
  time: string;
  /** 1 = lundi … 7 = dimanche, pour « weekly ». */
  weekday: number | null;
  team: number;
  enabled: number;
  last_slot: string | null;
  last_task_id: number | null;
  last_run_at: string | null;
  /** chat : un message ; team : l'équipe ; dev : une tâche dev sur project_id, à relire. */
  kind: AutomationKind;
  project_id: number | null;
  /** Moteur, modèle et effort de cette automatisation (null : ceux des réglages). */
  engine: string | null;
  model: string | null;
  effort: string | null;
  /** Commande de pré-vérification : si elle échoue, l'occurrence est sautée (rien n'est consommé). */
  precheck: string | null;
  /**
   * main : dans ta conversation ; own : dans son propre fil (le résultat t'est annoncé) ;
   * calendar : dans le calendrier, rien dans ta conversation (une veille, un point régulier).
   */
  thread: AutomationThread;
  created_at: string;
};

export type AutomationKind = "chat" | "team" | "dev";
export type AutomationThread = "main" | "own" | "calendar";
export const AUTOMATION_THREADS: AutomationThread[] = ["main", "own", "calendar"];

/** Une exécution : lancée, sautée par la pré-vérification, ou en échec avant de partir. */
export type AutomationRun = {
  id: number;
  automation_id: number;
  slot: string | null;
  manual: number;
  status: "started" | "skipped" | "failed";
  note: string | null;
  task_id: number | null;
  dev_task_id: number | null;
  created_at: string;
};

/** Fil propre d'une automatisation (« own ») : en dehors des fils des objectifs et du dev. */
export const AUTOMATION_CHAT_BASE = 5_000_000;
export const automationChat = (id: number) => AUTOMATION_CHAT_BASE + id;
export const isAutomationChat = (chatId: number) => chatId >= AUTOMATION_CHAT_BASE && chatId < AUTOMATION_CHAT_BASE + 1_000_000;

export const FREQUENCIES: Frequency[] = ["daily", "weekdays", "weekly", "hourly"];
/** Clark était éteint à l'heure prévue : l'occurrence part encore si le retard reste sous ce délai. */
export const CATCH_UP_MINUTES = { daily: 120, weekdays: 120, weekly: 120, hourly: 30 } as const;

const TZ = "Europe/Paris";
const DAY_NAMES = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

/** Date et heure murale à Paris. weekday : 1 = lundi … 7 = dimanche. */
export function parisParts(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), weekday };
}

const pad = (n: number) => String(n).padStart(2, "0");
const parseTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return { h, m };
};

const runsOn = (a: Pick<Automation, "frequency" | "weekday">, weekday: number) =>
  a.frequency === "daily" || a.frequency === "hourly" || (a.frequency === "weekdays" && weekday <= 5) || (a.frequency === "weekly" && weekday === a.weekday);

/**
 * L'occurrence à lancer maintenant, s'il y en a une : son heure est passée de moins
 * de CATCH_UP_MINUTES et elle n'a pas encore été lancée. null sinon.
 */
export function dueSlot(a: Automation, now: Date): string | null {
  if (!a.enabled) return null;
  const p = parisParts(now);
  if (!runsOn(a, p.weekday)) return null;
  const { h, m } = parseTime(a.time);
  const slotHour = a.frequency === "hourly" ? p.hour : h;
  const late = p.hour * 60 + p.minute - (slotHour * 60 + m);
  if (late < 0 || late >= CATCH_UP_MINUTES[a.frequency]) return null;
  const key = `${p.date}T${pad(slotHour)}:${pad(m)}`;
  return a.last_slot === key ? null : key;
}

/** La prochaine occurrence, en clair : « aujourd'hui à 09:00 », « lundi à 09:00 »… */
export function nextRunText(a: Automation, now: Date): string {
  if (!a.enabled) return "coupée";
  if (dueSlot(a, now)) return "maintenant";
  const { h, m } = parseTime(a.time);
  const nowP = parisParts(now);
  const tomorrow = parisParts(new Date(now.getTime() + 24 * 3600_000)).date;
  const step = a.frequency === "hourly" ? 60 : 24 * 60;
  for (let i = 0; i <= 8 * 24 * 60; i += step) {
    const p = parisParts(new Date(now.getTime() + i * 60_000));
    if (!runsOn(a, p.weekday)) continue;
    const slotHour = a.frequency === "hourly" ? p.hour : h;
    // Déjà passée aujourd'hui (lancée, ou trop tard pour la rattraper).
    if (p.date === nowP.date && slotHour * 60 + m <= nowP.hour * 60 + nowP.minute) continue;
    const at = `${pad(slotHour)}:${pad(m)}`;
    if (p.date === nowP.date) return a.frequency === "hourly" ? `à ${at}` : `aujourd'hui à ${at}`;
    if (p.date === tomorrow) return `demain à ${at}`;
    return `${DAY_NAMES[p.weekday]} à ${at}`;
  }
  return "inconnue";
}

export function scheduleText(a: Pick<Automation, "frequency" | "time" | "weekday">): string {
  const { m } = parseTime(a.time);
  switch (a.frequency) {
    case "daily":
      return `Chaque jour à ${a.time}`;
    case "weekdays":
      return `En semaine à ${a.time}`;
    case "weekly":
      return `Chaque ${DAY_NAMES[a.weekday ?? 1]} à ${a.time}`;
    case "hourly":
      return `Chaque heure, à la minute ${pad(m)}`;
  }
}

export type AutomationInput = {
  name: string;
  prompt: string;
  frequency: Frequency;
  time: string;
  weekday?: number | null;
  team?: boolean;
  kind?: AutomationKind;
  projectId?: number | null;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  precheck?: string | null;
  thread?: AutomationThread;
  /** false : créée en pause, pour la tester avec « Lancer maintenant » avant de l'activer. */
  enabled?: boolean;
};

/** Vérifie une automatisation saisie dans l'interface. Renvoie le message d'erreur, ou null. */
export function validateAutomation(i: Partial<AutomationInput>): string | null {
  if (!i.name || i.name.trim().length < 2) return "Donne un nom (2 caractères au moins)";
  if (i.name.trim().length > 80) return "Nom trop long (80 caractères au plus)";
  if (!i.prompt || i.prompt.trim().length < 5) return "Écris la consigne (5 caractères au moins)";
  if (i.prompt.length > 4000) return "Consigne trop longue (4000 caractères au plus)";
  if (!i.frequency || !FREQUENCIES.includes(i.frequency)) return "Choisis une fréquence";
  if (!i.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(i.time)) return "Heure invalide (HH:MM)";
  if (i.frequency === "weekly" && !(Number.isInteger(i.weekday) && (i.weekday as number) >= 1 && (i.weekday as number) <= 7)) return "Choisis le jour de la semaine";
  if (i.kind && !["chat", "team", "dev"].includes(i.kind)) return "Type inconnu";
  if (i.kind === "dev" && !Number.isInteger(i.projectId)) return "Choisis le projet de la tâche dev";
  if (i.engine && !["claude", "codex"].includes(i.engine)) return "Moteur inconnu";
  if ((i.model || i.effort) && !i.engine) return "Choisis d'abord le moteur";
  if (i.precheck && (i.precheck.length > 300 || /[\r\n]/.test(i.precheck))) return "Pré-vérification : une ligne, 300 caractères au plus";
  if (i.thread && !AUTOMATION_THREADS.includes(i.thread)) return "Fil inconnu";
  return null;
}

export class Automations {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        prompt       TEXT NOT NULL,
        frequency    TEXT NOT NULL CHECK (frequency IN ('daily','weekdays','weekly','hourly')),
        time         TEXT NOT NULL,
        weekday      INTEGER,
        team         INTEGER NOT NULL DEFAULT 0,
        enabled      INTEGER NOT NULL DEFAULT 1,
        last_slot    TEXT,
        last_task_id INTEGER,
        last_run_at  TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS automation_runs (
        id            INTEGER PRIMARY KEY,
        automation_id INTEGER NOT NULL,
        slot          TEXT,
        manual        INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL CHECK (status IN ('started','skipped','failed')),
        note          TEXT,
        task_id       INTEGER,
        dev_task_id   INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS automation_runs_by ON automation_runs(automation_id, id);
    `);
    const cols = db.prepare("PRAGMA table_info(automations)").all() as { name: string }[];
    for (const [col, def] of [
      ["kind", "TEXT"],
      ["project_id", "INTEGER"],
      ["engine", "TEXT"],
      ["model", "TEXT"],
      ["effort", "TEXT"],
      ["precheck", "TEXT"],
      ["thread", "TEXT NOT NULL DEFAULT 'main'"],
    ])
      if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE automations ADD COLUMN ${col} ${def}`);
    // Anciennes automatisations : « équipe » cochée devient le type équipe.
    db.exec("UPDATE automations SET kind = CASE WHEN team = 1 THEN 'team' ELSE 'chat' END WHERE kind IS NULL");
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  list(): Automation[] {
    return this.db.prepare("SELECT * FROM automations ORDER BY id").all() as Automation[];
  }

  get(id: number): Automation | undefined {
    return this.db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as Automation | undefined;
  }

  /**
   * Nouvelle automatisation. L'occurrence du moment, si elle tombe dans le délai de
   * rattrapage, est marquée faite : créer une automatisation ne la lance pas aussitôt.
   */
  create(i: AutomationInput, now = new Date()): number {
    const error = validateAutomation(i);
    if (error) throw new Error(error);
    const kind: AutomationKind = i.kind ?? (i.team ? "team" : "chat");
    const r = this.db
      .prepare(
        "INSERT INTO automations (name, prompt, frequency, time, weekday, team, kind, project_id, engine, model, effort, precheck, thread, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        i.name.trim(),
        i.prompt.trim(),
        i.frequency,
        i.time,
        i.frequency === "weekly" ? (i.weekday ?? null) : null,
        kind === "team" ? 1 : 0,
        kind,
        kind === "dev" ? (i.projectId ?? null) : null,
        i.engine || null,
        i.model?.trim() || null,
        i.effort?.trim() || null,
        i.precheck?.trim() || null,
        kind === "dev" ? "main" : (i.thread ?? "main"),
        i.enabled === false ? 0 : 1,
      );
    const id = Number(r.lastInsertRowid);
    const slot = dueSlot(this.get(id)!, now);
    if (slot) this.db.prepare("UPDATE automations SET last_slot = ? WHERE id = ?").run(slot, id);
    this.changed();
    return id;
  }

  setEnabled(id: number, enabled: boolean, now = new Date()): boolean {
    const ok = this.db.prepare("UPDATE automations SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes > 0;
    // Réactivée : l'occurrence en cours de rattrapage ne part pas d'un coup.
    if (ok && enabled) {
      const slot = dueSlot(this.get(id)!, now);
      if (slot) this.db.prepare("UPDATE automations SET last_slot = ? WHERE id = ?").run(slot, id);
    }
    if (ok) this.changed();
    return ok;
  }

  /** Où arrive le résultat : ta conversation, son propre fil, ou le calendrier. Pas pour une tâche dev. */
  setThread(id: number, thread: AutomationThread): boolean {
    if (!AUTOMATION_THREADS.includes(thread)) throw new Error("Fil inconnu");
    const a = this.get(id);
    if (!a) return false;
    if (a.kind === "dev") throw new Error("Une tâche dev se relit dans Dev, pas dans le calendrier");
    this.db.prepare("UPDATE automations SET thread = ? WHERE id = ?").run(thread, id);
    this.changed();
    return true;
  }

  remove(id: number): boolean {
    const ok = this.db.prepare("DELETE FROM automations WHERE id = ?").run(id).changes > 0;
    if (ok) this.db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
    if (ok) this.changed();
    return ok;
  }

  /** Noté AVANT le lancement : si Clark s'arrête juste après, l'occurrence ne repart pas. */
  claimSlot(id: number, slot: string): boolean {
    const ok =
      this.db.prepare("UPDATE automations SET last_slot = ?, last_run_at = datetime('now') WHERE id = ? AND (last_slot IS NULL OR last_slot != ?)").run(slot, id, slot)
        .changes > 0;
    if (ok) this.changed();
    return ok;
  }

  // ── Exécutions ──

  startRun(automationId: number, slot: string | null, manual: boolean): number {
    const r = this.db.prepare("INSERT INTO automation_runs (automation_id, slot, manual, status) VALUES (?, ?, ?, 'started')").run(automationId, slot, manual ? 1 : 0);
    this.changed();
    return Number(r.lastInsertRowid);
  }

  updateRun(id: number, fields: Partial<Pick<AutomationRun, "status" | "note" | "task_id" | "dev_task_id">>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE automation_runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => (fields[k] ?? null) as any), id);
    this.changed();
  }

  runs(automationId: number, limit = 10): AutomationRun[] {
    return this.db.prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?").all(automationId, limit) as AutomationRun[];
  }

  /**
   * Exécutions des automatisations rangées dans le calendrier, entre deux dates (UTC,
   * « AAAA-MM-JJ HH:MM:SS »), les plus anciennes d'abord. Les exécutions faites avant le
   * passage au calendrier en font partie : le calendrier montre tout l'historique.
   */
  calendarRuns(from: string, to: string): (AutomationRun & { name: string })[] {
    return this.db
      .prepare(
        "SELECT r.*, a.name AS name FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE a.thread = 'calendar' AND r.created_at >= ? AND r.created_at < ? ORDER BY r.id",
      )
      .all(from, to) as (AutomationRun & { name: string })[];
  }

  /** Dernières exécutions du calendrier (ids), pour le nombre sur l'icône. */
  recentCalendarRuns(limit = 20): number[] {
    return (this.db.prepare("SELECT r.id FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE a.thread = 'calendar' ORDER BY r.id DESC LIMIT ?").all(limit) as { id: number }[]).map(
      (r) => r.id,
    );
  }

  recordTask(id: number, taskId: number) {
    this.db.prepare("UPDATE automations SET last_task_id = ?, last_run_at = datetime('now') WHERE id = ?").run(taskId, id);
    this.changed();
  }
}
