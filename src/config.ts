import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

function number(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} doit être un nombre (reçu : ${raw})`);
  return n;
}

export const paths = {
  root: ROOT,
  db: resolve(ROOT, "data/clark.db"),
  coreMemory: resolve(ROOT, "memory"),
  workspace: resolve(ROOT, "workspace"),
  /** Dossier de configuration Codex propre à Clark (connexion ChatGPT, fils), séparé de ~/.codex. */
  codexHome: resolve(ROOT, "data/codex-home"),
  /** Dossier Claude Code propre à Clark (connexion à ton abonnement Claude), séparé de ~/.claude. */
  claudeHome: resolve(ROOT, "data/claude-home"),
};

export type EngineName = "claude" | "codex";

/** Rôles auxquels on peut attribuer un moteur : ceux du catalogue, plus le plan et la synthèse de Clark. */
export const ENGINE_ROLES = ["plan", "chercheur", "contenu", "redacteur", "relecteur", "temporaire", "synthese"] as const;
export type EngineRole = (typeof ENGINE_ROLES)[number];

/**
 * Moteur par rôle, pour un regard croisé (par exemple Codex rédige, Claude relit) :
 * CLARK_ROLE_ENGINES="redacteur=codex,relecteur=claude". Les rôles absents prennent le moteur principal.
 */
export function parseRoleEngines(raw: string | undefined): Partial<Record<EngineRole, EngineName>> {
  const out: Partial<Record<EngineRole, EngineName>> = {};
  for (const part of (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [role, engine] = part.split("=").map((x) => x?.trim().toLowerCase());
    if (!(ENGINE_ROLES as readonly string[]).includes(role)) {
      throw new Error(`CLARK_ROLE_ENGINES : rôle inconnu « ${role} » (possibles : ${ENGINE_ROLES.join(", ")})`);
    }
    if (engine !== "claude" && engine !== "codex") throw new Error(`CLARK_ROLE_ENGINES : moteur inconnu « ${engine} » pour ${role} (claude ou codex)`);
    out[role as EngineRole] = engine;
  }
  return out;
}

/** Moteur d'agent : Claude (Agent SDK, clé API) ou Codex (App Server, abonnement ChatGPT). */
function engine(hasApiKey: boolean): EngineName {
  const raw = process.env.CLARK_ENGINE?.trim().toLowerCase();
  // Vide : Claude avec une clé API ; sinon Codex, à moins que le démarrage ne trouve ton compte Claude connecté.
  if (!raw) return hasApiKey ? "claude" : "codex";
  if (raw === "claude" || raw === "codex") return raw;
  throw new Error(`CLARK_ENGINE doit valoir « claude » ou « codex » (reçu : ${raw})`);
}

/** Telegram est facultatif : il faut les deux variables, ou aucune. */
function telegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const owner = process.env.TELEGRAM_OWNER_ID?.trim();
  if (!token && !owner) return null;
  if (!token || !owner) throw new Error("Pour Telegram, renseigne TELEGRAM_BOT_TOKEN et TELEGRAM_OWNER_ID ensemble (ou aucun des deux).");
  const ownerId = Number(owner);
  if (!Number.isInteger(ownerId)) throw new Error("TELEGRAM_OWNER_ID doit être ton id numérique (via @userinfobot).");
  return { token, ownerId };
}

export function loadConfig() {
  const briefHour = process.env.CLARK_BRIEF_HOUR?.trim();
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return {
    telegram: telegram(),
    /** Présence seulement : la valeur reste dans l'environnement, lue par le SDK. */
    hasApiKey,
    engine: engine(hasApiKey),
    /** CLARK_ENGINE vide : le démarrage peut encore choisir Claude si ton compte Claude est connecté. */
    engineAuto: !process.env.CLARK_ENGINE?.trim(),
    roleEngines: parseRoleEngines(process.env.CLARK_ROLE_ENGINES),
    /** Modèle Codex ; vide = celui que Codex choisit par défaut. */
    codexModel: process.env.CLARK_CODEX_MODEL?.trim() || null,
    webPort: number("CLARK_WEB_PORT", 4310),
    /** Tour de veille (heartbeat) toutes les N minutes, de 8 h à 22 h. 0 = coupé. */
    heartbeatMinutes: number("CLARK_HEARTBEAT_MINUTES", 120),
    model: process.env.CLARK_MODEL?.trim() || "claude-opus-5-5",
    maxUsdPerTask: number("CLARK_MAX_USD_PER_TASK", 1),
    maxUsdPerDay: number("CLARK_MAX_USD_PER_DAY", 5),
    briefHour: briefHour ? Number(briefHour) : null,
  };
}

export type Config = ReturnType<typeof loadConfig>;
