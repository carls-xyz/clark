import type { DatabaseSync } from "node:sqlite";
import type { HealthReport, Problem } from "./health.ts";

/**
 * Alertes de santé : chaque minute, les points de la page Santé qui méritent une alerte (moteur principal
 * déconnecté, version de secours, disque, erreur très répétée…) sont comparés à ceux déjà signalés.
 *
 * - Un point doit être vu deux relevés de suite avant d'alerter (un moteur qui se reconnecte en 30 s : rien).
 * - Une seule alerte par point tant qu'il dure ; quand il a disparu deux relevés de suite : « revenu à la normale ».
 * - Plusieurs nouveaux points : un seul message.
 * - L'état est gardé dans la base : un redémarrage ne renvoie pas ce qui a déjà été signalé.
 * - Urgent (passe pendant les heures calmes si tu l'as permis) : moteur principal, version de secours, disque plein.
 */
export const CONFIRM = 2;
export const HISTORY = 10;

export type ActiveAlert = { id: string; text: string; urgent: boolean; since: number };
export type AlertEvent = { at: number; kind: "alerte" | "levée"; text: string };
export type AlertState = {
  /** Vus mais pas encore confirmés : combien de relevés de suite. */
  seen: Record<string, number>;
  /** Signalés, et toujours là. */
  active: Record<string, ActiveAlert>;
  /** Signalés, absents depuis combien de relevés de suite. */
  gone: Record<string, number>;
  history: AlertEvent[];
};

export const emptyState = (): AlertState => ({ seen: {}, active: {}, gone: {}, history: [] });

export type AlertStep = { state: AlertState; raised: ActiveAlert[]; cleared: ActiveAlert[] };

/** Un relevé : ce qui doit être signalé maintenant, et ce qui est revenu à la normale. Fonction pure. */
export function stepAlerts(prev: AlertState, problems: Pick<Problem, "id" | "text" | "alert">[], now: number): AlertStep {
  const state: AlertState = { seen: {}, active: { ...prev.active }, gone: {}, history: [...prev.history] };
  const current = new Map(problems.filter((p) => p.alert).map((p) => [p.id, p]));
  const raised: ActiveAlert[] = [];
  const cleared: ActiveAlert[] = [];

  for (const [id, p] of current) {
    const known = state.active[id];
    if (known) {
      // Toujours là : le texte suit (le nombre d'erreurs, les Go libres), l'urgence peut monter, pas d'alerte.
      state.active[id] = { ...known, text: p.text, urgent: known.urgent || p.alert === "urgent" };
      continue;
    }
    const n = (prev.seen[id] ?? 0) + 1;
    if (n >= CONFIRM) {
      const a = { id, text: p.text, urgent: p.alert === "urgent", since: now };
      state.active[id] = a;
      raised.push(a);
      state.history.push({ at: now, kind: "alerte", text: p.text });
    } else state.seen[id] = n;
  }

  for (const [id, a] of Object.entries(prev.active)) {
    if (current.has(id)) continue;
    const n = (prev.gone[id] ?? 0) + 1;
    if (n >= CONFIRM) {
      delete state.active[id];
      cleared.push(a);
      state.history.push({ at: now, kind: "levée", text: a.text });
    } else state.gone[id] = n;
  }
  state.history = state.history.slice(-HISTORY);
  return { state, raised, cleared };
}

/** Le message d'un relevé (un seul, même pour plusieurs points), ou null. */
export function alertMessage(step: Pick<AlertStep, "raised" | "cleared">): { text: string; urgent: boolean } | null {
  const parts: string[] = [];
  if (step.raised.length) parts.push(`Santé de Clark, à régler :\n${step.raised.map((a) => `- ${a.text}`).join("\n")}`);
  if (step.cleared.length) parts.push(`Revenu à la normale :\n${step.cleared.map((a) => `- ${a.text}`).join("\n")}`);
  if (!parts.length) return null;
  return { text: `${parts.join("\n\n")}\n\nDétail : page Santé.`, urgent: step.raised.some((a) => a.urgent) };
}

/** Gardé dans app_settings (clé « alerts »). */
export class AlertStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  }
  get(): AlertState {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'alerts'").get() as { value: string } | undefined;
    try {
      return row ? { ...emptyState(), ...(JSON.parse(row.value) as AlertState) } : emptyState();
    } catch {
      return emptyState();
    }
  }
  set(s: AlertState) {
    this.db.prepare("INSERT INTO app_settings (key, value) VALUES ('alerts', ?) ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(JSON.stringify(s));
  }
  /** Signalé d'office (la version de secours, annoncée au démarrage) : le relevé suivant ne le renverra pas. */
  markActive(id: string, text: string, urgent: boolean, now = Date.now()) {
    const s = this.get();
    if (s.active[id]) return;
    s.active[id] = { id, text, urgent, since: now };
    s.history = [...s.history, { at: now, kind: "alerte" as const, text }].slice(-HISTORY);
    this.set(s);
  }
}

export const alertsEnabled = (env: NodeJS.ProcessEnv = process.env) => (env.CLARK_ALERTS ?? "on").trim().toLowerCase() !== "off";

/**
 * La surveillance : un relevé par minute (rapport de santé relu, sans cache). post envoie le message
 * (type « alert » s'il y a de l'urgent, sinon « health ») ; une ligne au journal par alerte, jamais par relevé.
 */
export function startAlerts(opts: { store: AlertStore; report: () => HealthReport; post: (text: string, urgent: boolean) => void; everyMs?: number; now?: () => number }): () => void {
  const now = opts.now ?? Date.now;
  const tick = () => {
    if (!alertsEnabled()) return;
    let problems: Problem[];
    try {
      problems = opts.report().problems;
    } catch (err) {
      console.warn("[clark] alertes : relevé de santé impossible :", err instanceof Error ? err.message : err);
      return;
    }
    const step = stepAlerts(opts.store.get(), problems, now());
    opts.store.set(step.state);
    for (const a of step.raised) console.log(`[clark] alerte${a.urgent ? " urgente" : ""} : ${a.text}`);
    for (const a of step.cleared) console.log(`[clark] alerte levée : ${a.text}`);
    const msg = alertMessage(step);
    if (msg) opts.post(msg.text, msg.urgent);
  };
  const timer = setInterval(tick, opts.everyMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
