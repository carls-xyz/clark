import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { paths } from "../config.ts";

/**
 * Accès de Clark à Claude, sans clé API : ton propre abonnement Claude (Pro, Max…),
 * connecté par le flux officiel d'Anthropic (`claude auth login`), dans un dossier
 * Claude propre à Clark (data/claude-home), séparé de ton ~/.claude.
 *
 * Ce que permet Anthropic (code.claude.com/docs/en/legal-and-compliance) : l'usage
 * ordinaire et individuel de Claude Code et de l'Agent SDK avec un abonnement. Clark ne
 * lit, ne copie et ne stocke jamais d'identifiant : c'est Claude Code qui s'en charge.
 */
export const CLAUDE_LOGIN_COMMAND = `CLAUDE_CONFIG_DIR="${paths.claudeHome}" claude auth login`;

export type ClaudeAuth = {
  mode: "api" | "subscription" | "none";
  /** « Claude Max »… si Claude Code le donne. */
  plan: string | null;
  problem: string | null;
};

/** Environnement de Claude Code pour Clark : son propre dossier de configuration. */
export function claudeEnv(): Record<string, string | undefined> {
  mkdirSync(paths.claudeHome, { recursive: true });
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: paths.claudeHome,
    CLAUDE_AGENT_SDK_CLIENT_APP: "clark/0.4",
    // Pas de contexte d'un million de jetons : avec un abonnement, il exige des crédits payants
    // (« Usage credits required for 1M context »). Claude Code résume la conversation à la place.
    // CLARK_CLAUDE_1M=on pour le garder (crédits activés sur claude.ai).
    ...(process.env.CLARK_CLAUDE_1M?.trim() === "on" ? {} : { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }),
    // Pas les connecteurs de ton compte claude.ai (Gmail, Canva, WordPress…) : des centaines
    // d'outils qui remplissaient la mémoire de travail de chaque tâche. Clark a les siens.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
}

/**
 * Comment Clark accède à Claude. Avec une clé API, elle sert. Sinon, on demande à
 * Claude Code s'il est connecté dans le dossier de Clark (sans jamais afficher de jeton).
 */
export function checkClaudeAuth(hasApiKey: boolean, run: typeof execFileSync = execFileSync): ClaudeAuth {
  if (hasApiKey) return { mode: "api", plan: null, problem: null };
  let out: string;
  try {
    out = String(run("claude", ["auth", "status", "--json"], { env: claudeEnv(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch (err) {
    // Pas connecté : Claude Code répond quand même en JSON, mais avec un code d'erreur.
    const stdout = (err as { stdout?: unknown }).stdout;
    if (!stdout) return { mode: "none", plan: null, problem: `Claude Code introuvable ou injoignable (${err instanceof Error ? err.message.split("\n")[0] : String(err)})` };
    out = String(stdout);
  }
  try {
    const s = JSON.parse(out);
    if (s.loggedIn) {
      const plan = typeof s.subscriptionType === "string" ? `Claude ${s.subscriptionType.charAt(0).toUpperCase()}${s.subscriptionType.slice(1)}` : null;
      return { mode: "subscription", plan, problem: null };
    }
    return { mode: "none", plan: null, problem: "not_logged_in" };
  } catch {
    return { mode: "none", plan: null, problem: "réponse illisible de Claude Code" };
  }
}

/** État relevé au démarrage de Clark (la vérification lance un processus : on ne la refait pas à chaque tâche). */
let current: ClaudeAuth = { mode: "none", plan: null, problem: "not_checked" };
export const setClaudeAuth = (a: ClaudeAuth) => void (current = a);
export const claudeAuth = () => current;
