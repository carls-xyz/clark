import type { DatabaseSync } from "node:sqlite";
import { ENGINE_ROLES, parseRoleEngines, type Config } from "../config.ts";

/**
 * Les réglages de Clark modifiables dans l'interface (Réglages › Général). Chacun correspond à
 * une variable de .env : la valeur choisie dans l'interface passe devant celle de .env. Aucun
 * secret ici : clés et jetons restent dans .env, que seul l'utilisateur écrit.
 */

export type SettingDef = {
  key: string;
  env: string;
  label: string;
  hint: string;
  section: "Conversations" | "Veille et brief" | "Dev" | "Moteurs" | "Dépense" | "Sécurité" | "Autonomie";
  type: "int" | "number" | "bool" | "hour" | "select" | "roles";
  min?: number;
  max?: number;
  options?: [string, string][];
  /** Valeur par défaut (texte, comme dans .env). */
  fallback: string;
  /** « restart » : pris en compte au prochain démarrage de Clark. */
  apply: "now" | "restart";
};

export const SETTINGS: SettingDef[] = [
  { key: "newConversation", env: "CLARK_NEW_CONVERSATION_HOURS", label: "Nouvelle conversation après", hint: "Heures sans échange : ton message suivant ouvre une nouvelle conversation (l'ancienne reste dans la liste). 0 : jamais.", section: "Conversations", type: "int", min: 0, max: 168, fallback: "4", apply: "now" },
  { key: "heartbeat", env: "CLARK_HEARTBEAT_MINUTES", label: "Tour de veille", hint: "Toutes les N minutes, de 8 h à 21 h. 0 : coupé.", section: "Veille et brief", type: "int", min: 0, max: 1440, fallback: "120", apply: "now" },
  { key: "ideas", env: "CLARK_IDEAS_HOUR", label: "Tour d'idées", hint: "Heure du tour d'idées (0 à 23) : Clark parcourt quelques sites et note des idées de projets. Vide : coupé.", section: "Veille et brief", type: "hour", fallback: "15", apply: "now" },
  { key: "brief", env: "CLARK_BRIEF_HOUR", label: "Brief du matin", hint: "Heure du brief (0 à 23). Vide : pas de brief.", section: "Veille et brief", type: "hour", fallback: "", apply: "now" },
  { key: "devParallel", env: "CLARK_DEV_PARALLEL", label: "Agents de code en même temps", hint: "Au-delà, les autres attendent un agent libre. Le quota s'épuise vite.", section: "Dev", type: "int", min: 1, max: 6, fallback: "2", apply: "now" },
  { key: "stall", env: "CLARK_STALL_MINUTES", label: "Agent silencieux après", hint: "Minutes sans activité avant de te prévenir.", section: "Dev", type: "int", min: 1, max: 240, fallback: "10", apply: "now" },
  { key: "prPoll", env: "CLARK_PR_POLL_MINUTES", label: "Relecture des PR", hint: "Toutes les N minutes : CI, reviews, merge.", section: "Dev", type: "int", min: 1, max: 120, fallback: "3", apply: "restart" },
  {
    key: "engine",
    env: "CLARK_ENGINE",
    label: "Moteur principal",
    hint: "Celui qui répond quand rien d'autre n'est choisi.",
    section: "Moteurs",
    type: "select",
    options: [
      ["", "Automatique (Claude s'il est connecté, sinon Codex)"],
      ["claude", "Claude"],
      ["codex", "Codex"],
    ],
    fallback: "",
    apply: "restart",
  },
  { key: "backup", env: "CLARK_BACKUP_ENGINE", label: "Moteur de secours", hint: "Quota d'un moteur atteint : l'autre prend le relais. Coupé : Claude et Codex ne servent qu'à ce que tu leur confies (binôme, rôles).", section: "Moteurs", type: "bool", fallback: "off", apply: "now" },
  { key: "roles", env: "CLARK_ROLE_ENGINES", label: "Moteur par rôle", hint: "Pour un regard croisé : par exemple Codex rédige, Claude relit.", section: "Moteurs", type: "roles", fallback: "", apply: "now" },
  { key: "usdDay", env: "CLARK_MAX_USD_PER_DAY", label: "Dépense par jour ($)", hint: "Avec une clé API seulement (l'abonnement ne facture pas à l'appel).", section: "Dépense", type: "number", min: 0, max: 1000, fallback: "5", apply: "now" },
  { key: "usdTask", env: "CLARK_MAX_USD_PER_TASK", label: "Dépense par tâche ($)", hint: "Avec une clé API seulement.", section: "Dépense", type: "number", min: 0, max: 200, fallback: "1", apply: "now" },
  // Autonomie : ce que Clark peut décider seul (Réglages › Général › Autonomie). Par défaut, il demande.
  { key: "autoVeille", env: "CLARK_AUTO_VEILLE", label: "Tour de veille", hint: "Ce qu'il remarque pendant sa veille.", section: "Autonomie", type: "select", options: [["propose", "Propose, tu décides"], ["agit", "Agit seul, puis te raconte"]], fallback: "propose", apply: "now" },
  { key: "autoLancer", env: "CLARK_AUTO_LANCER", label: "Équipes et objectifs", hint: "Lancer une équipe ou un objectif de plusieurs tours.", section: "Autonomie", type: "select", options: [["demande", "Te demande"], ["seul", "Lance seul quand c'est utile"]], fallback: "demande", apply: "now" },
  { key: "autoSouvenirs", env: "CLARK_AUTO_SOUVENIRS", label: "Souvenirs", hint: "Retenir un fait nouveau (une correction te sera toujours demandée).", section: "Autonomie", type: "select", options: [["toi", "Tu confirmes"], ["lui", "Clark confirme, source notée"]], fallback: "toi", apply: "now" },
  { key: "autoMax", env: "CLARK_AUTO_MAX", label: "Décisions seul par jour", hint: "Au-delà, il te redemande jusqu'au lendemain.", section: "Autonomie", type: "int", min: 0, max: 50, fallback: "10", apply: "now" },
  { key: "autoResume", env: "CLARK_AUTO_RESUME", label: "Résumé du soir", hint: "Heure du résumé de ce qu'il a décidé seul. Vide : pas de résumé.", section: "Autonomie", type: "hour", fallback: "21", apply: "now" },
  { key: "sandbox", env: "CLARK_SANDBOX", label: "Bac à sable des commandes (Claude)", hint: "Ne le coupe que pour un dépannage : les commandes shell auraient alors accès à tout ton Mac (avec ton accord à chaque fois).", section: "Sécurité", type: "bool", fallback: "on", apply: "now" },
];

export class Settings {
  private readonly db: DatabaseSync;
  /** Ce que .env disait au démarrage : la valeur de repli quand on efface un réglage. */
  private readonly envAtStart = new Map<string, string | undefined>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    for (const d of SETTINGS) this.envAtStart.set(d.env, process.env[d.env]);
  }

  stored(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  /** Au démarrage, avant de lire la config : les réglages de l'interface passent devant .env. */
  applyToEnv() {
    for (const d of SETTINGS) {
      const v = this.stored(d.key);
      if (v !== undefined) process.env[d.env] = v;
    }
  }

  /** La valeur en vigueur, et d'où elle vient. */
  view() {
    return SETTINGS.map((d) => {
      const stored = this.stored(d.key);
      const env = this.envAtStart.get(d.env);
      return {
        ...d,
        value: stored ?? env?.trim() ?? d.fallback,
        source: stored !== undefined ? "interface" : env?.trim() ? ".env" : "défaut",
      };
    });
  }

  /** Vérifie et enregistre ; applique tout de suite ce qui peut l'être. null : retour à .env ou au défaut. */
  set(key: string, raw: unknown, config?: Config): { error: string } | { ok: true; restart: boolean } {
    const d = SETTINGS.find((x) => x.key === key);
    if (!d) return { error: "Réglage inconnu" };
    if (raw === null) {
      this.db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
      const back = this.envAtStart.get(d.env);
      if (back === undefined) delete process.env[d.env];
      else process.env[d.env] = back;
      if (config) applyToConfig(config);
      return { ok: true, restart: d.apply === "restart" };
    }
    const value = String(raw ?? "").trim();
    const bad = validate(d, value);
    if (bad) return { error: bad };
    this.db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(key, value);
    process.env[d.env] = value;
    if (config) applyToConfig(config);
    return { ok: true, restart: d.apply === "restart" };
  }

  all(): Record<string, string> {
    return Object.fromEntries((this.db.prepare("SELECT key, value FROM app_settings").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  }
}

export function validate(d: SettingDef, v: string): string | null {
  switch (d.type) {
    case "int":
    case "number": {
      const n = Number(v);
      if (v === "" || !Number.isFinite(n) || (d.type === "int" && !Number.isInteger(n))) return `${d.label} : un nombre${d.type === "int" ? " entier" : ""}.`;
      if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) return `${d.label} : entre ${d.min} et ${d.max}.`;
      return null;
    }
    case "hour":
      return v === "" || (/^\d{1,2}$/.test(v) && Number(v) <= 23) ? null : `${d.label} : une heure de 0 à 23, ou vide.`;
    case "bool":
      return v === "on" || v === "off" ? null : "on ou off";
    case "select":
      return d.options!.some(([k]) => k === v) ? null : "Choix inconnu";
    case "roles":
      try {
        parseRoleEngines(v);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
  }
}

/** Les réglages lus par l'objet config (budgets, veille, brief, rôles) suivent l'environnement. */
export function applyToConfig(config: Config) {
  const num = (name: string, fallback: number) => {
    const n = Number(process.env[name]?.trim());
    return process.env[name]?.trim() && Number.isFinite(n) ? n : fallback;
  };
  config.heartbeatMinutes = num("CLARK_HEARTBEAT_MINUTES", 120);
  config.maxUsdPerDay = num("CLARK_MAX_USD_PER_DAY", 5);
  config.maxUsdPerTask = num("CLARK_MAX_USD_PER_TASK", 1);
  const brief = process.env.CLARK_BRIEF_HOUR?.trim();
  config.briefHour = brief ? Number(brief) : null;
  config.roleEngines = parseRoleEngines(process.env.CLARK_ROLE_ENGINES);
}

export const ROLE_KEYS = ENGINE_ROLES;
