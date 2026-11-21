import { resolve, sep } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../memory/store.ts";
import type { TaskJournal } from "../tasks/journal.ts";

/** Demande à Charles (bouton dans l'interface web ou sur Telegram). Résout true s'il valide, false sinon ou au délai dépassé. */
export type Approver = (request: { tool: string; summary: string }) => Promise<boolean>;

/**
 * Trois niveaux :
 *  - auto      : mémoire, lecture et recherche web. Rejouable sans risque.
 *  - workspace : fichiers, seulement dans les dossiers de Clark. Rejouable.
 *  - ask       : tout le reste (shell, fichiers ailleurs, futurs envois). Effet possible : validation.
 */
export type Tier = "auto" | "workspace" | "ask";

const AUTO = new Set(["WebSearch", "WebFetch", "TodoWrite"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);

/**
 * L'effet d'un outil est indépendant de son niveau de validation : écrire dans le
 * workspace ou en mémoire passe sans bouton, mais reste une écriture. Après une
 * coupure, une écriture sans résultat enregistré doit être vérifiée, pas rejouée.
 * Tout outil inconnu est considéré comme une écriture.
 */
export type Effect = "read" | "write";
// Poser une question à Charles ou noter son avancement ne change rien au monde : ce sont des
// lectures (rejouables, permises en lecture seule).
const READ_ONLY = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "mcp__memory__recall",
  "mcp__memory__ask_charles",
  "mcp__memory__report_progress",
  // Une proposition n'agit sur rien : c'est Charles qui décide de la lancer.
  "mcp__memory__propose_initiative",
  // Un compte rendu d'objectif ne change rien au monde.
  "mcp__memory__report_goal",
  "mcp__memory__use_skill",
  // Lire ses mails et son agenda ne change rien ; envoyer (send_mail) est une écriture.
  "mcp__memory__mail_search",
  "mcp__memory__mail_read",
  "mcp__memory__calendar_events",
  // Lire le web dans le navigateur ne change rien ; cliquer, écrire, choisir sont des écritures
  // (et le navigateur demande l'accord de Charles pour ce qui engage).
  "mcp__memory__browser_open",
  "mcp__memory__browser_read",
  "mcp__memory__browser_scroll",
  "mcp__memory__browser_back",
  // Lire ses iMessages ne change rien ; envoyer (send_imessage) est une écriture.
  "mcp__memory__messages_recent",
  "mcp__memory__messages_read",
  // Chercher et lire dans le coffre Obsidian ne change rien ; y écrire (vault_write) est une écriture.
  "mcp__memory__vault_search",
  "mcp__memory__vault_read",
]);

/**
 * Serveurs MCP ajoutés par Charles et déclarés « en lecture seule » : leurs outils passent
 * sans demander et restent permis aux agents en lecture seule. Les autres sont des écritures
 * qui demandent son accord à chaque appel. Tenu à jour par le hub depuis la base.
 */
let readOnlyMcp = new Set<string>();
export function setReadOnlyMcp(names: string[]) {
  readOnlyMcp = new Set(names);
}
/** « mcp__notion__search » → « notion » (null si ce n'est pas un outil MCP). */
export const mcpServerOf = (toolName: string) => (toolName.startsWith("mcp__") ? (toolName.split("__")[1] ?? null) : null);
const trustedMcpTool = (toolName: string) => {
  const server = mcpServerOf(toolName);
  return server !== null && server !== "memory" && readOnlyMcp.has(server);
};

export function effectOf(toolName: string): Effect {
  return READ_ONLY.has(toolName) || trustedMcpTool(toolName) ? "read" : "write";
}

export function isInside(path: string, roots: string[]): boolean {
  const abs = resolve(path);
  return roots.some((root) => abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep));
}

function targetPath(input: Record<string, unknown>): string | null {
  const p = input.file_path ?? input.path ?? input.notebook_path;
  return typeof p === "string" ? p : null;
}

export function classify(toolName: string, input: Record<string, unknown>, roots: string[]): Tier {
  if (toolName.startsWith("mcp__memory__") || AUTO.has(toolName) || trustedMcpTool(toolName)) return "auto";
  if (FILE_TOOLS.has(toolName)) {
    const path = targetPath(input);
    // Glob/Grep sans chemin opèrent dans le cwd, qui est le workspace.
    return path === null || isInside(path, roots) ? "workspace" : "ask";
  }
  return "ask";
}

export function summarize(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") return `Commande shell :\n${String(input.command ?? "")}`;
  const server = mcpServerOf(toolName);
  if (server && server !== "memory") {
    return `Outil « ${toolName.split("__").slice(2).join("__")} » du serveur MCP ${server} :\n${JSON.stringify(input, null, 2).slice(0, 1500)}`;
  }
  const path = targetPath(input);
  if (path) return `${toolName} sur ${path}`;
  return `${toolName} ${JSON.stringify(input).slice(0, 500)}`;
}

/**
 * Droit d'une tâche. « read » : aucune écriture, quel que soit le niveau de l'outil
 * (fichier, shell, mémoire). Appliqué par le code, pas par la consigne : c'est le cas
 * du Chercheur, du Relecteur, et de toute reprise qui vérifie une écriture incertaine.
 */
export type Access = "read" | "write";

export const READ_ONLY_REFUSAL =
  "Refusé : cet agent est en lecture seule. Il peut lire et chercher, pas écrire, modifier ni lancer de commande.";

export function createPolicy(opts: {
  store: Store;
  journal: TaskJournal;
  taskId: number;
  roots: string[];
  approve: Approver;
  access?: Access;
  attempt?: string;
}): CanUseTool {
  const { store, journal, taskId, roots, approve } = opts;
  const access = opts.access ?? "write";

  return async (toolName, input, { toolUseID }) => {
    const tier = classify(toolName, input, roots);
    const step = { taskId, toolUseId: toolUseID, tool: toolName, input, tier, attempt: opts.attempt };

    if (access === "read" && effectOf(toolName) === "write") {
      journal.recordStep({ ...step, status: "denied" });
      store.audit(toolName, "denied-read-only", input);
      return { behavior: "deny", message: READ_ONLY_REFUSAL };
    }

    if (tier !== "ask") {
      journal.recordStep({ ...step, status: "running" });
      store.audit(toolName, tier, input);
      return { behavior: "allow", updatedInput: input };
    }

    // Écrit avant de demander : si Clark redémarre ici, la validation sera redemandée.
    journal.recordStep({ ...step, status: "awaiting_approval" });
    const ok = await approve({ tool: toolName, summary: summarize(toolName, input) });
    // « running » sur une étape à effet = effet inconnu tant que le résultat n'est pas écrit.
    journal.recordStep({ ...step, status: ok ? "running" : "denied" });
    store.audit(toolName, ok ? "approved" : "denied", input);
    return ok
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Charles a refusé (ou n'a pas répondu à temps). Propose une autre approche ou demande-lui." };
  };
}
