import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { paths } from "../config.ts";
import { failMidRun, type Deps, type RunResult, type executeTask } from "../core/agent.ts";
import { buildSystemPrompt } from "../core/prompt.ts";
import { classify, READ_ONLY_REFUSAL, summarize } from "../policy/permissions.ts";
import { Bindings } from "./bindings.ts";
import { mergeQuota, readQuota, type Quota } from "./quota.ts";
import type { ModelChoice } from "./choices.ts";
import { codexMcpConfig } from "../mcp/servers.ts";
import { internalToken } from "../core/internal.ts";
import { onStop, wasStopped } from "../core/stops.ts";
import { onSteer } from "../core/steer.ts";

/** Réponse de `model/list` → les modèles proposés dans l'interface (les modèles cachés exclus). */
export function codexModels(resp: any): ModelChoice[] {
  return (resp?.data ?? [])
    .filter((m: any) => !m.hidden)
    .map((m: any) => ({
      id: m.model ?? m.id,
      name: m.displayName ?? m.model ?? m.id,
      description: m.description ?? "",
      efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort).filter(Boolean),
      defaultEffort: m.defaultReasoningEffort ?? null,
      isDefault: Boolean(m.isDefault),
    }));
}
import { CodexClient, RpcError, spawnCodex, type ServerRequest, type Transport } from "./codex-app-server.ts";

const VERSION = "0.3.0";
const ROOTS = [paths.workspace, paths.coreMemory];
const READ_ACTIONS = new Set(["read", "listFiles", "search"]);

export type EngineStatus = { ready: boolean; account: string | null; problem: string | null };

export const LOGIN_COMMAND = `CODEX_HOME="${paths.codexHome}" codex login`;

const toml = (s: string) => JSON.stringify(s); // une chaîne JSON est une chaîne TOML valide

/**
 * Configuration Codex propre à Clark, réécrite à chaque démarrage. Ta config perso
 * (~/.codex : plugins, computer use, connecteurs, hooks, mémoire Codex) n'est pas chargée :
 * Clark n'a que ses propres outils, dont sa mémoire confirmée.
 */
/**
 * Profils de permissions du bac à sable de Codex (macOS : seatbelt), choisis à chaque tour :
 * - clark      : dossier de travail et mémoire cœur en écriture ;
 * - clark-read : les mêmes en lecture seule (Chercheur, Relecteur, vérification avant reprise).
 * Dans les deux, ton dossier personnel est FERMÉ en dehors de ces deux dossiers : ni le .env
 * de Clark, ni ses données, ni tes autres projets ne sont lisibles par les commandes de Codex.
 * Les outils du système (ffmpeg, node…) restent utilisables.
 */
export const PERMISSION_PROFILES = { write: "clark", read: "clark-read" } as const;

/**
 * Les dépendances des projets dev (node_modules, .venv…) : lisibles par Codex dans ses tâches de
 * code (tests, build), jamais en écriture ; le reste des dépôts d'origine reste fermé (.env…).
 * Lues dans la base au démarrage de Codex : un projet ajouté ensuite attend son redémarrage.
 */
export function projectSharedDirs(db: string): string[] {
  try {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
      const rows = d.prepare("SELECT path FROM projects").all() as { path: string }[];
      return rows.flatMap((r) => ["node_modules", ".venv", "venv"].map((x) => join(r.path, x)).filter((x) => existsSync(x)).map((x) => realpathSync(x)));
    } finally {
      d.close();
    }
  } catch {
    return [];
  }
}

export function permissionProfilesToml(home = homedir(), sharedRead: string[] = []) {
  return `default_permissions = "${PERMISSION_PROFILES.read}"

[permissions.${PERMISSION_PROFILES.write}]
description = "Clark : son dossier en écriture, le reste de ton dossier personnel fermé"
extends = ":workspace"

[permissions.${PERMISSION_PROFILES.write}.filesystem]
${toml(home)} = "deny"
${toml(paths.workspace)} = "write"
${toml(paths.coreMemory)} = "write"
${sharedRead.map((p) => `${toml(p)} = "read"`).join("\n")}

[permissions.${PERMISSION_PROFILES.read}]
description = "Clark en lecture seule : son dossier lisible, rien en écriture, le reste de ton dossier personnel fermé"
extends = ":read-only"

[permissions.${PERMISSION_PROFILES.read}.filesystem]
${toml(home)} = "deny"
${toml(paths.workspace)} = "read"
${toml(paths.coreMemory)} = "read"
`;
}

export function writeCodexConfig(codexHome: string, db: string) {
  mkdirSync(codexHome, { recursive: true });
  const server = resolve(paths.root, "src/memory/mcp-server.ts");
  writeFileSync(
    join(codexHome, "config.toml"),
    `# Géré par Clark : réécrit à chaque démarrage. Ta config perso (~/.codex) n'est pas utilisée ici.
${permissionProfilesToml(homedir(), projectSharedDirs(db))}
[features]
memories = false

[mcp_servers.memory]
command = ${toml(process.execPath)}
args = [${toml(server)}]
startup_timeout_sec = 20
# ask_charles attend la réponse de Charles jusqu'à 30 minutes.
tool_timeout_sec = 1900

[mcp_servers.memory.env]
CLARK_DB = ${toml(db)}
CLARK_INTERNAL_URL = ${toml(`http://127.0.0.1:${process.env.CLARK_WEB_PORT?.trim() || "4310"}`)}
CLARK_INTERNAL_TOKEN = ${toml(internalToken())}
`,
    { mode: 0o600 },
  );
  // Le jeton du navigateur y est écrit : fichier lisible par toi seul.
  chmodSync(join(codexHome, "config.toml"), 0o600);
}

/** `/bin/zsh -lc 'touch a.txt'` → `touch a.txt`, pour afficher la vraie commande. */
export function unwrapShell(command: string): string {
  const m = command.match(/^\S*\/(?:ba|z)?sh -l?c '([\s\S]*)'$/);
  return m ? m[1].replace(/'\\''/g, "'") : command;
}

/** Une commande que Codex a lui-même analysée comme lecture seule (lire, chercher, lister), sans autre action. */
export function readOnlyCommand(item: any): boolean {
  const actions: any[] = item?.type === "commandExecution" ? (item.commandActions ?? []) : [];
  return actions.length > 0 && actions.every((a) => READ_ACTIONS.has(a?.type));
}

/** Ce qu'une étape de Codex devient dans le journal de Clark (même vocabulaire que le moteur Claude). */
export function stepOf(item: any): { tool: string; input: Record<string, unknown> } | null {
  switch (item?.type) {
    case "commandExecution": {
      const command = unwrapShell(String(item.command ?? ""));
      const actions: any[] = item.commandActions ?? [];
      // Une commande qui ne fait que lire (cat, ls, rg…) est une lecture : rejouable après une coupure.
      if (actions.length && actions.every((a) => READ_ACTIONS.has(a.type))) {
        const a = actions[0];
        const tool = a.type === "read" ? "Read" : a.type === "search" ? "Grep" : "Glob";
        return { tool, input: { file_path: a.path ?? undefined, query: a.query ?? undefined, command } };
      }
      return { tool: "Bash", input: { command } };
    }
    case "fileChange": {
      const files = (item.changes ?? []).map((c: any) => String(c.path));
      return { tool: "Edit", input: { file_path: files[0], files } };
    }
    case "mcpToolCall":
      return { tool: `mcp__${item.server}__${item.tool}`, input: (item.arguments ?? {}) as Record<string, unknown> };
    case "webSearch":
      return { tool: "WebSearch", input: { query: item.query ?? item.action?.query ?? "" } };
    case "dynamicToolCall":
      return { tool: String(item.tool), input: (item.arguments ?? {}) as Record<string, unknown> };
    default:
      return null;
  }
}

function outputOf(item: any): string {
  if (item.type === "commandExecution") return item.aggregatedOutput ?? `code de sortie ${item.exitCode ?? "?"}`;
  if (item.type === "fileChange") return (item.changes ?? []).map((c: any) => `${c.kind?.type ?? "?"} ${c.path}`).join("\n");
  if (item.type === "mcpToolCall") {
    if (item.error) return `erreur : ${JSON.stringify(item.error)}`;
    const content = item.result?.content;
    return Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("\n") : JSON.stringify(item.result ?? "");
  }
  return "";
}

/**
 * Moteur Codex : Clark pilote le Codex App Server officiel, connecté au compte ChatGPT
 * de l'utilisateur. Même contrat que le moteur Claude : journal des étapes, validations par
 * bouton, reprise du fil après un redémarrage.
 */
export function createCodexEngine(
  opts: { model?: string | null; codexHome?: string; db?: string; transport?: () => Transport; onQuota?: (q: Quota | null) => void } = {},
) {
  const codexHome = opts.codexHome ?? paths.codexHome;
  const makeTransport = opts.transport ?? (() => spawnCodex({ codexHome }));
  const routes = new Map<string, (req: ServerRequest) => Promise<unknown>>();
  let client: CodexClient | null = null;
  let starting: Promise<CodexClient> | null = null;
  let lastQuota: Quota | null = null;
  const publishQuota = (q: Quota | null) => {
    lastQuota = q;
    opts.onQuota?.(q);
  };

  const connect = async (): Promise<CodexClient> => {
    if (client?.alive) return client;
    starting ??= (async () => {
      if (!opts.transport) writeCodexConfig(codexHome, opts.db ?? paths.db);
      const c = new CodexClient(makeTransport());
      c.onServerRequest(async (req) => {
        const route = routes.get(req.params?.threadId);
        if (!route) throw new RpcError(-32000, "Aucune tâche Clark en cours sur ce fil : refusé.");
        return route(req);
      });
      // Codex prévient quand le quota bouge (à chaque tour) : on fusionne dans la dernière lecture.
      c.onNotification((n) => {
        if (n.method === "account/rateLimits/updated") publishQuota(mergeQuota(lastQuota, n.params));
      });
      await c.initialize(VERSION);
      client = c;
      return c;
    })().finally(() => (starting = null));
    return starting;
  };

  /** Codex est-il lancé et connecté à un compte ? Affiché dans l'interface. */
  const status = async (): Promise<EngineStatus> => {
    try {
      const c = await connect();
      const r = await c.request("account/read", {});
      if (!r?.account) return { ready: false, account: null, problem: "not_logged_in" };
      const a = r.account;
      return { ready: true, account: a.type === "chatgpt" ? `ChatGPT ${a.planType ?? ""}`.trim() : a.type, problem: null };
    } catch (err) {
      return { ready: false, account: null, problem: err instanceof Error ? err.message : String(err) };
    }
  };

  /**
   * Relit le quota auprès de Codex. Échec (Codex injoignable, pas connecté…) : l'erreur
   * remonte, pour que l'appelant sache que les chiffres n'ont pas été revérifiés.
   */
  const quota = async (): Promise<Quota | null> => {
    const c = await connect();
    const q = readQuota(await c.request("account/rateLimits/read", {}));
    if (!q) throw new Error("Codex n'a pas donné de chiffres de quota");
    publishQuota(q);
    return q;
  };

  /** Les modèles que ton compte ChatGPT peut utiliser dans Codex, avec leurs niveaux de raisonnement. */
  const models = async (): Promise<ModelChoice[]> => {
    const c = await connect();
    return codexModels(await c.request("model/list", { limit: 100 }));
  };

  const execute: typeof executeTask = async (deps: Deps, taskId, run): Promise<RunResult> => {
    const { config, store, journal } = deps;
    const task = journal.get(taskId);
    if (!task) throw new Error(`Tâche ${taskId} introuvable`);
    journal.setStatus(taskId, "running");
    const readOnly = run.access === "read";
    journal.setAccess(taskId, readOnly ? "read" : "write"); // lu aussi par le serveur de mémoire

    const stop = (text: string): RunResult => {
      journal.finish(taskId, "failed", text, 0, run.attempt);
      return { text, costUsd: 0, status: "failed" };
    };

    let c: CodexClient;
    try {
      c = await connect();
      const account = await c.request("account/read", {});
      if (!account?.account) return stop(`Je ne suis pas connecté à ChatGPT. Lance cette commande dans un terminal, puis réessaie :\n\n\`${LOGIN_COMMAND}\``);
    } catch (err) {
      return stop(`Impossible de lancer Codex : ${err instanceof Error ? err.message : String(err)}`);
    }

    // Modèle et puissance choisis dans l'interface (sinon .env, sinon le défaut de Codex), lus à chaque tâche.
    const choice = store.choices.get("codex");
    const model = run.model ?? choice.model ?? opts.model ?? null;
    const effort = run.effort ?? choice.effort;
    const threadOpts = {
      cwd: run.cwd ?? paths.workspace,
      // Tâche de code : les commandes dans le bac à sable passent sans bouton (tests, build) ; seule
      // une demande d'en sortir arrive à l'utilisateur. Ailleurs : chaque commande non sûre lui est demandée.
      approvalPolicy: run.codeTask && !readOnly ? "on-request" : "untrusted",
      // Profil du bac à sable : dossier personnel fermé, dossier de Clark en écriture ou en lecture.
      permissions: readOnly ? PERMISSION_PROFILES.read : PERMISSION_PROFILES.write,
      developerInstructions: buildSystemPrompt(store, paths.coreMemory),
      ...(model ? { model } : {}),
    };

    // Clé de liaison du fil : transmise au serveur de mémoire que Codex lance pour ce fil.
    const bindings = new Bindings(store.db);
    // Serveurs MCP ajoutés par l'utilisateur : passés au fil, sans redémarrer Codex.
    const userMcp = codexMcpConfig(store.mcp.enabled());
    const withBinding = (binding: string) => ({ ...threadOpts, config: { ...userMcp, "mcp_servers.memory.env.CLARK_BINDING": binding } });

    // ── Fil de conversation : reprise ou nouveau ─────────────────────────
    let threadId: string | null = null;
    let binding = "";
    let note = "";
    const prior = run.resume?.startsWith("codex:") ? run.resume.slice(6) : null;
    if (run.resume && !prior) {
      if (run.mode === "recovery") return failMidRun(journal, taskId, new Error("cette tâche avait commencé avec le moteur Claude, Codex ne peut pas la reprendre"), run.attempt);
      if (task.parent_id === null) store.clearSession(task.chat_id);
      note = "(Nouvelle conversation : la précédente tournait sur le moteur Claude. Ma mémoire longue est intacte.)\n\n";
    }
    if (prior) {
      try {
        binding = bindings.forThread(prior);
        threadId = (await c.request("thread/resume", { threadId: prior, ...withBinding(binding), excludeTurns: true })).thread.id;
      } catch (err) {
        if (run.mode !== "new" || journal.steps(taskId).length > 0) return failMidRun(journal, taskId, err, run.attempt);
        console.warn("[clark] fil Codex introuvable, nouveau fil :", err instanceof Error ? err.message : err);
        if (task.parent_id === null) store.clearSession(task.chat_id);
        note = "(Je n'ai pas pu rouvrir notre conversation précédente, j'en ai commencé une nouvelle. Ma mémoire longue est intacte.)\n\n";
      }
    }
    try {
      if (!threadId) {
        binding = bindings.forThread(null);
        threadId = (await c.request("thread/start", withBinding(binding))).thread.id as string;
        bindings.attach(binding, threadId);
      }
    } catch (err) {
      return stop(`Codex n'a pas pu ouvrir de conversation : ${err instanceof Error ? err.message : String(err)}`);
    }
    const session = `codex:${threadId}`;
    journal.setSession(taskId, session);
    if (task.parent_id === null) store.setSession(task.chat_id, session); // un agent d'équipe garde son fil pour lui

    // ── Un tour : étapes, validations, réponse ──────────────────────────
    const items = new Map<string, any>();
    let finalText = "";
    let lastText = "";
    let lastError: string | null = null;

    const announce = (item: any) => {
      const step = stepOf(item);
      if (!step) return;
      journal.announceStep({ taskId, toolUseId: item.id, tool: step.tool, input: step.input, tier: classify(step.tool, step.input, ROOTS), attempt: run.attempt });
    };

    const ask = async (itemId: string, tool: string, input: Record<string, unknown>, summary: string) => {
      if (readOnly) {
        // Lecture seule : refusé par Clark sans rien demander à l'utilisateur.
        journal.recordStep({ taskId, toolUseId: itemId, tool, input, tier: "ask", status: "denied", attempt: run.attempt });
        store.audit(tool, "denied-read-only", input);
        return false;
      }
      journal.recordStep({ taskId, toolUseId: itemId, tool, input, tier: "ask", status: "awaiting_approval", attempt: run.attempt });
      store.audit(tool, "ask", input);
      const ok = await run.approve({ tool, summary });
      journal.recordStep({ taskId, toolUseId: itemId, tool, input, tier: "ask", status: ok ? "running" : "denied", attempt: run.attempt });
      store.audit(tool, ok ? "allow" : "deny", input);
      return ok;
    };

    routes.set(threadId, async (req) => {
      const p = req.params ?? {};
      switch (req.method) {
        case "item/commandExecution/requestApproval": {
          const command = unwrapShell(String(p.command ?? items.get(p.itemId)?.command ?? ""));
          // Lecture seule (relecteur, critique de plan, chercheur) : une commande que Codex classe lui-même comme
          // pure lecture (cat, sed -n, rg, ls…) passe. Le bac à sable « clark-read » interdit toute écriture au
          // niveau du système ; sans cela, l'agent ne lisait que le diff, à l'aveugle. Le reste est refusé.
          if (readOnly && readOnlyCommand(items.get(p.itemId))) {
            const step = stepOf(items.get(p.itemId)) ?? { tool: "Bash", input: { command } };
            journal.recordStep({ taskId, toolUseId: p.itemId, tool: step.tool, input: step.input, tier: "workspace", status: "running", attempt: run.attempt });
            store.audit(step.tool, "read-only-command", step.input);
            return { decision: "accept" };
          }
          const where = p.cwd && resolve(p.cwd) !== resolve(paths.workspace) ? `\nDossier : ${p.cwd}` : "";
          const why = p.reason ? `\n\nRaison donnée : ${p.reason}` : "";
          const ok = await ask(p.itemId, "Bash", { command }, `Commande shell :\n${command}${where}${why}`);
          return { decision: ok ? "accept" : "decline" };
        }
        case "item/fileChange/requestApproval": {
          const files: string[] = (items.get(p.itemId)?.changes ?? []).map((ch: any) => String(ch.path));
          const root = p.grantRoot ? `\nAccès en écriture demandé sur : ${p.grantRoot}` : "";
          const why = p.reason ? `\n\nRaison donnée : ${p.reason}` : "";
          const ok = await ask(p.itemId, "Edit", { file_path: files[0], files }, `Modification de fichiers :\n${files.join("\n") || "(fichiers non précisés)"}${root}${why}`);
          return { decision: ok ? "accept" : "decline" };
        }
        case "mcpServer/elicitation/request":
          return { action: "decline", content: null, _meta: null };
        case "item/tool/requestUserInput": {
          // Codex demande l'accord pour un outil MCP (serveur réglé sur « demander ») : on le
          // transmet à l'utilisateur. Seulement « Allow » (cet appel) ou « Cancel » ; jamais
          // « pour la session » ni « toujours », qui contourneraient les demandes suivantes.
          const item = items.get(p.itemId);
          const qs: any[] = p.questions ?? [];
          if (item?.type !== "mcpToolCall" || qs.length !== 1) return { answers: {} };
          const q = qs[0];
          const labels: string[] = (q.options ?? []).map((o: any) => String(o.label));
          const allow = labels.find((l) => l === "Allow");
          const cancel = labels.find((l) => l === "Cancel") ?? labels.find((l) => /^(cancel|decline|deny)/i.test(l));
          const tool = `mcp__${item.server}__${item.tool}`;
          const input = (item.arguments ?? {}) as Record<string, unknown>;
          const ok = allow ? await ask(p.itemId, tool, input, summarize(tool, input)) : false;
          const answer = ok ? allow : cancel;
          return answer ? { answers: { [q.id]: { answers: [answer] } } } : { answers: {} };
        }
        default:
          // Élargissement de permissions, outils dynamiques… : refusé, jamais accordé en silence.
          throw new RpcError(-32000, `Clark refuse cette demande (${req.method}).`);
      }
    });

    let off = () => {};
    const outcome = new Promise<{ status: string; error: string | null }>((done) => {
      off = c.onNotification((n) => {
        if (n.method === "clark/exited") return done({ status: "crashed", error: n.params.reason });
        const p = n.params;
        if (!p || p.threadId !== threadId) return;
        if (n.method === "item/started") {
          items.set(p.item.id, p.item);
          announce(p.item);
        } else if (n.method === "item/completed") {
          const item = p.item;
          items.set(item.id, item);
          if (item.type === "agentMessage") {
            lastText = item.text ?? lastText;
            if (item.phase === "final_answer") finalText = item.text ?? finalText;
            return;
          }
          const step = stepOf(item);
          if (!step) return;
          announce(item); // au cas où le début n'aurait pas été vu
          if (item.status === "declined") {
            journal.recordStep({ taskId, toolUseId: item.id, tool: step.tool, input: step.input, tier: "ask", status: "denied", attempt: run.attempt });
          } else {
            journal.completeStep(item.id, outputOf(item), item.status === "failed");
          }
          if (item.type === "mcpToolCall" && item.server === "memory") store.syncExternal();
        } else if (n.method === "error" && !p.willRetry) {
          lastError = p.error?.message ?? null;
        } else if (n.method === "turn/completed") {
          done({ status: p.turn?.status ?? "failed", error: p.turn?.error?.message ?? lastError });
        }
      });
    });

    let result: { status: string; error: string | null };
    // Pendant ce tour, et seulement pendant ce tour, le fil est lié à cette tâche.
    bindings.setTask(binding, taskId);
    let offStop = () => {};
    try {
      const started = await c.request("turn/start", {
        threadId,
        input: [{ type: "text", text: run.prompt, text_elements: [] }, ...(run.images ?? []).map((path) => ({ type: "localImage", path }))],
        approvalPolicy: run.codeTask && !readOnly ? "on-request" : "untrusted",
        // Profil choisi à chaque tour : un fil peut passer en lecture seule (vérification avant reprise).
        // Pas de réseau, dossier personnel fermé ; les demandes d'élargissement sont refusées plus haut.
        permissions: readOnly ? PERMISSION_PROFILES.read : PERMISSION_PROFILES.write,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      const turnId = started?.turn?.id;
      offStop = onStop(taskId, () => void c.request("turn/interrupt", { threadId, turnId }).catch(() => {}));
      // Message de l'utilisateur pendant le tour : glissé dans le tour en cours (turn/steer).
      const offSteer =
        task.parent_id === null && turnId
          ? onSteer(taskId, async (text) => {
              await c.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] });
              return true;
            })
          : () => {};
      try {
        result = await outcome;
      } finally {
        offSteer();
      }
    } catch (err) {
      offStop();
      off();
      routes.delete(threadId);
      bindings.setTask(binding, null);
      return failMidRun(journal, taskId, err, run.attempt);
    }
    offStop();
    off();
    routes.delete(threadId);
    bindings.setTask(binding, null);

    if (result.status === "crashed") return failMidRun(journal, taskId, new Error(result.error ?? "Codex s'est arrêté"), run.attempt);
    // Le tour a consommé du quota : on relit l'état complet (un échec ici n'est pas grave, on réessaiera).
    quota().catch((err) => console.warn("[clark] quota non relu :", err instanceof Error ? err.message : err));

    store.addSpend(0, task.label); // abonnement : pas de coût à l'appel, mais la trace du jour compte (brief)
    let text: string;
    let status: RunResult["status"];
    if (result.status === "completed") {
      status = "done";
      text = finalText || lastText || "(pas de réponse)";
    } else if (result.status === "interrupted") {
      status = "failed";
      text = wasStopped(taskId) ? "Arrêté à ta demande avant la fin." : "Je me suis arrêté avant la fin. Dis-moi si je continue.";
    } else {
      status = "failed";
      text = `Codex a échoué : ${result.error ?? "raison inconnue"}`;
    }
    text = note + text.trim();
    if (!(run.keepOpen && status === "done")) journal.finish(taskId, status, text, 0, run.attempt);
    return { text, costUsd: 0, status };
  };

  return {
    execute,
    status,
    quota,
    models,
    lastQuota: () => lastQuota,
    close() {
      client?.close();
      // Fermé volontairement : le prochain appel relance un Codex neuf au lieu d'écrire à l'ancien.
      client = null;
    },
  };
}

/**
 * Connexion de Codex avec une clé d'API OpenAI (au lieu du compte ChatGPT) : la clé est donnée à
 * « codex login --with-api-key » par l'entrée standard, jamais en argument (elle ne s'affiche pas
 * dans la liste des processus). Codex la garde dans le dossier de Clark. Renvoie true si c'est fait.
 */
export function loginCodexWithKey(key: string, run: typeof spawnSync = spawnSync): boolean {
  const r = run("codex", ["login", "--with-api-key"], { input: `${key}\n`, env: { ...process.env, CODEX_HOME: paths.codexHome }, timeout: 30_000, encoding: "utf8" });
  return r.status === 0;
}
