import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { query, type EffortLevel, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { reportClaudeLimit } from "../engines/claude-probe.ts";
import { claudeMcpConfig } from "../mcp/servers.ts";
import { claudeSandbox, sharedReadPaths } from "../engines/sandbox.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { Store } from "../memory/store.ts";
import { memoryServer } from "../memory/tools.ts";
import { classify, createPolicy, type Access, type Approver } from "../policy/permissions.ts";
import { describeStep, uncertainSteps, type TaskJournal, type TaskStatus } from "../tasks/journal.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { onStop, wasStopped } from "./stops.ts";
import { onSteer } from "./steer.ts";
import { CLAUDE_LOGIN_COMMAND, claudeAuth, claudeEnv } from "../engines/claude-auth.ts";

export type RunResult = { text: string; costUsd: number; status: TaskStatus };

export type Deps = { config: Config; store: Store; journal: TaskJournal };

export type RunOptions = {
  prompt: string;
  resume: string | undefined;
  approve: Approver;
  mode: "new" | "recovery";
  /** « read » : toute écriture est refusée par le moteur. Par défaut : « write ». */
  access?: Access;
  /** Ne pas clore la tâche en cas de succès : une autre étape suit (vérification avant reprise). */
  keepOpen?: boolean;
  /** Tentative à laquelle appartient cette exécution (voir journal.startAttempt). */
  attempt?: string;
  /** Dossier de travail de cette tâche : la copie du dépôt pour une tâche dev. Par défaut, workspace. */
  cwd?: string;
  /** Modèle et effort pour ce tour seulement (réessai d'une tâche dev) ; sinon les réglages du moteur. */
  model?: string | null;
  effort?: string | null;
  /** Images jointes à la consigne (chemins absolus) : la capture d'un élément choisi en mode design. */
  images?: string[];
  /**
   * Tâche de code (dans une copie du dépôt) : plus d'étapes par tour, les dépendances du projet
   * lisibles dans le bac à sable, et le shell sans bouton (confiné : pas de réseau, écriture dans
   * la copie seulement) pour que l'agent lance lui-même tests et build.
   */
  codeTask?: boolean;
};

/** Étapes par tour : une conversation reste courte, une tâche de code peut être longue. */
export const MAX_TURNS = 40;
export const CODE_MAX_TURNS = 150;

const ROOTS = [paths.workspace, paths.coreMemory];

const IMAGE_TYPES: Record<string, "image/jpeg" | "image/png" | "image/webp" | "image/gif"> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

/** Le premier message : la consigne, avec ses images s'il y en a. */
function firstMessage(prompt: string, images: string[] = []): SDKUserMessage {
  if (!images.length) return { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
  const blocks: any[] = [{ type: "text", text: prompt }];
  for (const file of images) {
    const type = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!type || !existsSync(file)) continue;
    blocks.push({ type: "image", source: { type: "base64", media_type: type, data: readFileSync(file).toString("base64") } });
  }
  return { type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null };
}

/**
 * Entrée en flux : la consigne, puis les messages que l'utilisateur glisse pendant le tour
 * (priorité « next » : lus entre deux actions). Fermée dès la réponse finale.
 */
function inputChannel(first: SDKUserMessage) {
  const queue: SDKUserMessage[] = [first];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* stream(): AsyncIterable<SDKUserMessage> {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }
  }
  return {
    stream: stream(),
    push(text: string): boolean {
      if (closed) return false;
      queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, priority: "next" });
      wake?.();
      return true;
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

/** La reprise de la session a échoué avant le moindre échange : rien n'a été exécuté. */
class ResumeFailed extends Error {}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "[contenu non textuel]")).join("\n");
  }
  return "";
}

/**
 * Exécute une tâche du journal.
 * - mode "new"      : une demande fraîche. Si la conversation précédente ne peut pas être
 *                     rouverte et que rien n'a encore tourné, on en ouvre une nouvelle.
 * - mode "recovery" : reprise après redémarrage. Jamais de repli vers une session neuve :
 *                     ce serait rejouer la tâche depuis le début.
 */
export async function executeTask(
  deps: Deps,
  taskId: number,
  opts: RunOptions,
): Promise<RunResult> {
  const { config, store, journal } = deps;
  const task = journal.get(taskId);
  if (!task) throw new Error(`Tâche ${taskId} introuvable`);

  // Accès à Claude : clé API, ou ton abonnement Claude connecté par le flux officiel.
  const subscription = !config.hasApiKey && claudeAuth().mode === "subscription";
  if (!config.hasApiKey && !subscription) {
    const text = `Il me manque un accès à Claude. Connecte ton compte Claude une fois, dans un terminal :

\`${CLAUDE_LOGIN_COMMAND}\`

puis redémarre-moi. (Ou ajoute ANTHROPIC_API_KEY dans .env pour passer par l'API.)`;
    journal.finish(taskId, "failed", text, 0, opts.attempt);
    return { text, costUsd: 0, status: "failed" };
  }

  // Avec l'abonnement, pas de facture à l'appel : les plafonds en dollars ne s'appliquent pas.
  const remaining = subscription ? Infinity : config.maxUsdPerDay - store.spentToday();
  if (remaining <= 0.01) {
    const text = `Budget du jour atteint (${config.maxUsdPerDay} $). Je reprends demain, ou monte CLARK_MAX_USD_PER_DAY.`;
    journal.finish(taskId, "failed", text, 0, opts.attempt);
    return { text, costUsd: 0, status: "failed" };
  }
  journal.setStatus(taskId, "running");
  journal.setAccess(taskId, opts.access ?? "write");

  const attempt = async (resume: string | undefined, modelOverride?: string): Promise<RunResult> => {
    let text = "";
    let costUsd = 0;
    let status: TaskStatus = "failed";
    let sessionSeen = false;

    const claudeChoice = store.choices.get("claude");
    const sandbox = claudeSandbox(opts.codeTask && opts.cwd ? sharedReadPaths(opts.cwd) : []);
    const abort = new AbortController();
    const offStop = onStop(taskId, () => abort.abort());
    const effort = opts.effort ?? claudeChoice.effort;
    const input = inputChannel(firstMessage(opts.prompt, opts.images));
    // Seule la tâche de premier niveau reçoit les messages de l'utilisateur (pas un agent d'équipe).
    const offSteer = task.parent_id === null ? onSteer(taskId, async (text) => input.push(text)) : () => {};
    try {
      const run = query({
        prompt: input.stream,
        options: {
          // Modèle et puissance choisis dans l'interface, sinon CLARK_MODEL ; lus à chaque tâche.
          model: modelOverride ?? opts.model ?? claudeChoice.model ?? config.model,
          ...(effort ? { effort: effort as EffortLevel } : {}),
          abortController: abort,
          systemPrompt: buildSystemPrompt(store, paths.coreMemory),
          cwd: opts.cwd ?? paths.workspace,
          additionalDirectories: [paths.coreMemory],
          settingSources: [], // isolé : n'hérite pas de ta config Claude Code perso
          strictMcpConfig: true, // seulement les serveurs MCP de Clark, jamais ceux de ton compte claude.ai
          tools: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Bash", "TodoWrite"],
          // Mémoire de Clark, puis les serveurs MCP ajoutés par l'utilisateur (lus à chaque tâche).
          mcpServers: {
            ...claudeMcpConfig(store.mcp.enabled()),
            memory: memoryServer(store, { taskId, readOnly: opts.access === "read", onProgress: () => journal.touch() }),
          },
          canUseTool: createPolicy({ store, journal, taskId, roots: ROOTS, approve: opts.approve, access: opts.access, attempt: opts.attempt, autoBash: Boolean(opts.codeTask && sandbox) }),
          ...(subscription ? {} : { maxBudgetUsd: Math.min(config.maxUsdPerTask, remaining) }),
          // Dossier Claude propre à Clark : sa connexion, ses sessions, rien de ta config perso.
          env: claudeEnv(),
          // Commandes shell confinées (Seatbelt) : dossier de travail seulement, pas de réseau.
          ...(sandbox ? { sandbox } : {}),
          maxTurns: opts.codeTask ? CODE_MAX_TURNS : MAX_TURNS,
          resume,
        },
      });

      for await (const msg of run) {
        if (!sessionSeen && "session_id" in msg && typeof msg.session_id === "string" && msg.session_id) {
          // Écrit dès le début : une coupure au milieu pourra reprendre cette session.
          sessionSeen = true;
          journal.setSession(taskId, msg.session_id);
          if (task.parent_id === null) store.setSession(task.chat_id, msg.session_id); // un agent d'équipe garde sa session pour lui
        }

        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type !== "tool_use") continue;
            const input = (block.input ?? {}) as Record<string, unknown>;
            journal.announceStep({ taskId, toolUseId: block.id, tool: block.name, input, tier: classify(block.name, input, ROOTS), attempt: opts.attempt });
          }
        } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type !== "tool_result") continue;
            journal.completeStep(block.tool_use_id, toolResultText(block.content), block.is_error === true);
          }
        } else if (msg.type === "rate_limit_event") {
          reportClaudeLimit(msg.rate_limit_info);
        } else if (msg.type === "result") {
          // Réponse finale : plus de message à glisser, le flux se ferme et le tour se termine.
          offSteer();
          input.close();
          // Abonnement : le coût affiché par le SDK est indicatif, rien n'est facturé à l'appel.
          costUsd = subscription ? 0 : (msg.total_cost_usd ?? 0);
          if (msg.subtype === "success" && !msg.is_error) {
            status = "done";
            text = msg.result;
          } else if (msg.subtype === "success") {
            text = `Erreur de l'API : ${msg.result}`;
          } else {
            text = stopReason(msg.subtype);
          }
        }
      }
    } catch (err) {
      if (wasStopped(taskId)) throw new Error("arrêté par Charles");
      if (!sessionSeen && resume && opts.mode === "new" && journal.steps(taskId).length === 0) {
        throw new ResumeFailed(err instanceof Error ? err.message : String(err));
      }
      throw err;
    } finally {
      offStop();
      offSteer();
      input.close();
    }

    store.addSpend(costUsd, task.label);
    text = text.trim() || "(pas de réponse)";
    if (!(opts.keepOpen && status === "done")) journal.finish(taskId, status, text, costUsd, opts.attempt);
    return { text, costUsd, status };
  };

  let retried1m = false;
  try {
    return await attempt(opts.resume);
  } catch (err) {
    if (err instanceof ResumeFailed) {
      // Rien n'a tourné : ouvrir une conversation neuve ne rejoue aucune action.
      console.warn("[clark] reprise de la conversation impossible, nouvelle session :", err.message);
      if (task.parent_id === null) store.clearSession(task.chat_id);
      const r = await attempt(undefined);
      return { ...r, text: `(Je n'ai pas pu rouvrir notre conversation précédente, j'en ai commencé une nouvelle. Ma mémoire longue est intacte.)\n\n${r.text}` };
    }
    // « Usage credits required for 1M context » : erreur intermittente de l'abonnement. Si rien n'a
    // été écrit, on relance une fois sur une session neuve (la mémoire longue reste).
    if (/usage credits required for 1m context/i.test(String(err instanceof Error ? err.message : err)) && !retried1m && uncertainSteps(journal.steps(taskId)).length === 0) {
      retried1m = true;
      if (task.parent_id === null) store.clearSession(task.chat_id);
      console.warn(`[clark] tâche ${taskId} : erreur « 1M context », relance sur une session neuve`);
      try {
        journal.setStatus(taskId, "running");
        // Vu sur Sonnet 4.6 avec un abonnement : la relance part sur le modèle par défaut (Opus).
        const used = opts.model ?? store.choices.get("claude").model ?? config.model;
        const fallback = /sonnet/i.test(used) && !/sonnet/i.test(config.model) ? config.model : undefined;
        if (fallback) console.warn(`[clark] tâche ${taskId} : relance sur ${fallback} au lieu de ${used}`);
        return await attempt(undefined, fallback);
      } catch (again) {
        return failMidRun(journal, taskId, again, opts.attempt);
      }
    }
    return failMidRun(journal, taskId, err, opts.attempt);
  }
}

/** Erreur en cours de route : on ne relance rien automatiquement. */
export function failMidRun(journal: TaskJournal, taskId: number, err: unknown, attempt?: string): RunResult {
  const raw = err instanceof Error ? err.message : String(err);
  // Erreur de l'abonnement Claude, en clair plutôt que le message brut de l'API.
  const reason = /usage credits required for 1m context/i.test(raw)
    ? "la conversation est devenue trop longue pour ton abonnement Claude (le mode « 1M » demande des crédits payants) ; je repars d'un fil résumé"
    : raw;
  console.error(`[clark] tâche ${taskId} interrompue :`, err);
  const uncertain = uncertainSteps(journal.steps(taskId));
  if (uncertain.length) {
    const text = `Je me suis arrêté sur une erreur (${reason}).\n\nCette écriture a peut-être déjà eu lieu :\n${uncertain.map((s) => `- ${describeStep(s)}`).join("\n")}\n\nJe ne la refais pas sans toi. Si tu reprends, je vérifie d'abord son effet.`;
    journal.finish(taskId, "needs_check", text, 0, attempt);
    return { text, costUsd: 0, status: "needs_check" };
  }
  const text = `Je me suis arrêté sur une erreur (${reason}). Aucune écriture n'était en cours : tu peux renvoyer ta demande.`;
  journal.finish(taskId, "failed", text, 0, attempt);
  return { text, costUsd: 0, status: "failed" };
}

function stopReason(subtype: string): string {
  switch (subtype) {
    case "error_max_budget_usd":
      return "J'ai atteint le plafond de dépense pour cette tâche. Dis-moi si je continue.";
    case "error_max_turns":
      return "J'ai atteint le nombre maximum d'étapes pour cette tâche. Dis-moi si je continue.";
    default:
      return `Je me suis arrêté avant la fin (${subtype}).`;
  }
}
