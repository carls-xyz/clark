import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { onMac } from "./platform.ts";
import type { DatabaseSync } from "node:sqlite";

/**
 * Notifications : quoi part sur quel canal, les heures calmes, et garder le Mac éveillé.
 * Tout reste dans la conversation et dans l'interface : seuls les envois (Telegram, iMessage,
 * notifications du navigateur) sont réglés ici.
 */

export const NOTIFY_KINDS = [
  ["reply", "Réponses de Clark"],
  ["approval", "Accords, questions, mails et vidéos à valider"],
  ["dev", "Tâches dev : prêtes, arrêtées, décisions"],
  ["pr", "Pull requests : CI, reviews, merge"],
  ["stalled", "Agents silencieux"],
  ["proposals", "Propositions du tour de veille"],
  ["system", "Autres notes (souvenirs proposés, automatisations…)"],
  ["health", "Santé de Clark : alertes (moteur déconnecté, disque, version de secours…)"],
] as const;
/** « alert » : une alerte de santé urgente, envoyée comme « health » mais qui peut passer pendant les heures calmes. */
export type NotifyKind = (typeof NOTIFY_KINDS)[number][0] | "digest" | "quiet" | "alert";
export const NOTIFY_CHANNELS = ["telegram", "imessage", "browser"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];
export type AwakeMode = "agent" | "always" | "never";

export type NotifyPrefs = {
  routes: Record<string, Record<NotifyChannel, boolean>>;
  /** approvals / alerts : les accords, les alertes urgentes de santé passent quand même pendant les heures calmes. */
  quiet: { on: boolean; from: string; to: string; approvals: boolean; alerts: boolean };
  awake: AwakeMode;
};

/** Par défaut : comme avant (tout sur Telegram ; réponses et accords sur iMessage et le navigateur). */
export function defaultPrefs(): NotifyPrefs {
  const routes: NotifyPrefs["routes"] = {};
  for (const [k] of NOTIFY_KINDS) routes[k] = { telegram: true, imessage: k === "reply" || k === "approval", browser: k === "reply" || k === "approval" || k === "health" };
  return { routes, quiet: { on: false, from: "23:00", to: "08:00", approvals: true, alerts: true }, awake: "agent" };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function checkPrefs(raw: unknown): { error: string } | { prefs: NotifyPrefs } {
  const base = defaultPrefs();
  const p = raw as Partial<NotifyPrefs> | null;
  if (!p || typeof p !== "object") return { error: "Réglages illisibles" };
  for (const [k] of NOTIFY_KINDS)
    for (const c of NOTIFY_CHANNELS) {
      const v = p.routes?.[k]?.[c];
      if (v !== undefined) base.routes[k][c] = v === true;
    }
  if (p.quiet) {
    if (p.quiet.from !== undefined && !HHMM.test(p.quiet.from)) return { error: "Début des heures calmes : HH:MM" };
    if (p.quiet.to !== undefined && !HHMM.test(p.quiet.to)) return { error: "Fin des heures calmes : HH:MM" };
    base.quiet = { on: p.quiet.on === true, from: p.quiet.from ?? base.quiet.from, to: p.quiet.to ?? base.quiet.to, approvals: p.quiet.approvals !== false, alerts: p.quiet.alerts !== false };
  }
  if (p.awake !== undefined) {
    if (!["agent", "always", "never"].includes(p.awake)) return { error: "Mode inconnu" };
    base.awake = p.awake;
  }
  return { prefs: base };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Heures calmes, heure de Paris ; une plage qui passe minuit (23:00 → 08:00) marche. */
export function inQuiet(prefs: NotifyPrefs, now = new Date()): boolean {
  if (!prefs.quiet.on) return false;
  const [h, m] = now.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number);
  const t = h * 60 + m;
  const a = minutes(prefs.quiet.from);
  const b = minutes(prefs.quiet.to);
  return a === b ? false : a < b ? t >= a && t < b : t >= a || t < b;
}

let store: NotifyStore | null = null;
/** Ce qui n'est pas parti pendant les heures calmes, résumé à la fin. */
const held: { kind: string; text: string }[] = [];

export class NotifyStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  }
  get(): NotifyPrefs {
    const r = this.db.prepare("SELECT value FROM app_settings WHERE key = 'notify'").get() as { value: string } | undefined;
    if (!r) return defaultPrefs();
    const c = checkPrefs(JSON.parse(r.value));
    return "prefs" in c ? c.prefs : defaultPrefs();
  }
  set(raw: unknown): { error: string } | { ok: true } {
    const c = checkPrefs(raw);
    if ("error" in c) return c;
    this.db.prepare("INSERT INTO app_settings (key, value) VALUES ('notify', ?) ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(JSON.stringify(c.prefs));
    return { ok: true };
  }
}

export const setNotifyStore = (s: NotifyStore | null) => void (store = s);
export const notifyPrefs = (): NotifyPrefs => store?.get() ?? defaultPrefs();

/**
 * Ce canal reçoit-il ce genre de notification maintenant ? Sans réglages (tests), oui.
 * Un canal hors liste (un autre outil branché sur le hub) reçoit tout.
 */
export function notifyAllowed(channel: string, kind: NotifyKind, text?: string, now = new Date()): boolean {
  // Tour planifié sans rien de neuf : rangé dans le fil, jamais poussé.
  if (kind === "quiet") return false;
  if (!store || kind === "digest") return true;
  if (!(NOTIFY_CHANNELS as readonly string[]).includes(channel)) return true;
  const prefs = store.get();
  // Une alerte urgente suit les canaux réglés pour « Santé de Clark ».
  const route = kind === "alert" ? "health" : kind;
  if (!prefs.routes[route]?.[channel as NotifyChannel]) return false;
  const passes = (kind === "approval" && prefs.quiet.approvals) || (kind === "alert" && prefs.quiet.alerts);
  if (inQuiet(prefs, now) && !passes) {
    if (text !== undefined && channel === firstRoutedChannel(prefs, route)) held.push({ kind: route, text });
    return false;
  }
  return true;
}

/** Un seul canal tient le compte de ce qui a été retenu (sinon chaque note compterait deux fois). */
const firstRoutedChannel = (prefs: NotifyPrefs, kind: string) => NOTIFY_CHANNELS.find((c) => c !== "browser" && prefs.routes[kind]?.[c]);

/** À la fin des heures calmes : un seul message qui résume ce qui n'est pas parti. */
export function startQuietDigest(post: (text: string) => void): () => void {
  let wasQuiet = store ? inQuiet(store.get()) : false;
  const timer = setInterval(() => {
    if (!store) return;
    const quiet = inQuiet(store.get());
    if (wasQuiet && !quiet && held.length) {
      const lines = held.splice(0).map((h) => `- ${h.text.replace(/\s+/g, " ").slice(0, 140)}`);
      post(`Pendant tes heures calmes (${lines.length}) :\n${lines.slice(0, 15).join("\n")}${lines.length > 15 ? `\n- et ${lines.length - 15} autres, dans l'interface` : ""}`);
    }
    wasQuiet = quiet;
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export const heldCount = () => held.length;

/**
 * Garder le Mac éveillé (caffeinate) : pendant qu'un agent travaille, toujours, ou jamais.
 * Sans ça, la mise en veille arrête Clark en pleine tâche.
 */
export function startAwake(isBusy: () => boolean): () => void {
  const bin = "/usr/bin/caffeinate";
  let child: ChildProcess | null = null;
  const tick = () => {
    // Hors Mac (un VPS), rien à faire : un serveur ne se met pas en veille.
    if (!onMac() || !existsSync(bin)) return;
    const mode = notifyPrefs().awake;
    const want = mode === "always" || (mode === "agent" && isBusy());
    if (want && !child) {
      child = spawn(bin, ["-i", "-s"], { stdio: "ignore" });
      child.on("exit", () => (child = null));
    } else if (!want && child) {
      child.kill();
      child = null;
    }
    awakeOn = Boolean(child);
  };
  const timer = setInterval(tick, 15_000);
  timer.unref();
  tick();
  const stop = () => {
    clearInterval(timer);
    child?.kill();
    child = null;
  };
  process.once("exit", stop);
  return stop;
}

let awakeOn = false;
/** Le Mac est-il tenu éveillé en ce moment ? */
export const awakeActive = () => awakeOn;
