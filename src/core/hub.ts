import { randomUUID } from "node:crypto";
import type { Approver } from "../policy/permissions.ts";
import { askedText, checkAlertText, describeStep, MESSAGE_MARK, planRecovery, resumePrompt, uncertainSteps, type Task } from "../tasks/journal.ts";
import { executeTask, type Deps, type RunResult } from "./agent.ts";
import { cleanTitle, NEW_CONVERSATION_NOTE, newConversationHours, titlePrompt, type Conversation, type Message, type Role } from "./conversation.ts";
import { createTeam, displayName, StaleAttempt, TEAM_LABEL, teamCheckText } from "./team.ts";
import { resumeVerified } from "./recovery.ts";
import { CHARLES_SOURCES } from "./reminders.ts";
import { unseenNotes } from "./unseen.ts";
import { announcesNextStep, continuePrompt, FINISH_CHECK_LIMIT, judgePrompt, NEXT_STEP_LIMIT, parseVerdict } from "./finish-check.ts";
import type { Question } from "./questions.ts";
import type { Post } from "../social/posts.ts";
import type { OutboxMail } from "./outbox.ts";
import { sendMail as gmailSend, type OutgoingMail } from "../google/gmail.ts";
import { googleStatus, type GoogleStatus } from "../google/auth.ts";
import { checkChoice, type Catalog, type EngineChoice } from "../engines/choices.ts";
import { setReadOnlyMcp } from "../policy/permissions.ts";
import { goalOfChat, isGoalChat } from "./goals.ts";
import { devCritiqueOfLabel, devOfLabel, devPlanOfLabel, devReviewOfLabel, isDevChat, moveCritiqueChats } from "../dev/store.ts";
import { platformName } from "../social/platforms.ts";
import type { Initiative } from "./initiatives.ts";
import type { Memory } from "../memory/store.ts";
import { HEARTBEAT_LABEL } from "../scheduler/heartbeat.ts";
import { isIdeaLabel } from "./ideas.ts";
import { formatReset, isStale, NEAR_LIMIT_PERCENT, tightest, type Quota } from "../engines/quota.ts";
import { ENGINE_ROLES, type EngineName, type EngineRole } from "../config.ts";
import { canStop, stopRunning } from "./stops.ts";
import { notifyAllowed, type NotifyKind } from "./notify.ts";
import { AUTOMATION_CHAT_BASE, isAutomationChat } from "../scheduler/automations.ts";

/** Clark n'a qu'un interlocuteur : l'utilisateur. Une seule conversation, quel que soit le canal. */
export const OWNER_CHAT = 1;

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type HubDeps = Deps & { conversation: Conversation };

export type Approval = {
  id: string;
  chatId: number;
  taskId: number;
  tool: string;
  summary: string;
  /** Agent de l'équipe qui demande (Rédacteur…), ou absent pour Clark lui-même. */
  agent?: string;
  createdAt: number;
  expiresAt: number;
};

/**
 * Un canal (Telegram, interface web…) affiche ce que fait Clark. Tout est optionnel :
 * l'interface web lit l'état dans la base et n'a besoin d'aucune de ces méthodes.
 */
export type Channel = {
  name: string;
  /** Réponse de Clark ou note du système. */
  deliver?(m: Message): Promise<void>;
  /** Demande de validation, avec ses boutons. */
  askApproval?(a: Approval): Promise<void>;
  /** Question d'un agent à l'utilisateur, avec ses réponses proposées. */
  askQuestion?(q: Question): Promise<void>;
  /** Brouillon de publication à valider (Réseaux sociaux), avec son aperçu. */
  proposePost?(p: Post): Promise<void>;
  /** Mail que Clark veut envoyer, en entier, avec Envoyer / Refuser. */
  askMail?(m: OutboxMail): Promise<void>;
  /** Proposition du tour de veille, avec Accepter / Refuser. */
  proposeInitiative?(i: Initiative): Promise<void>;
  /** Alerte « à vérifier », avec ses boutons. Renvoie true si elle a été remise. */
  alert?(task: Task, text: string): Promise<boolean>;
  /** Clark est en train de travailler. */
  typing?(chatId: number): void;
};

export type Hub = ReturnType<typeof createHub>;

/** Règles d'autonomie : true = Clark a tranché seul (rien à proposer à l'utilisateur). */
export type AutonomyHooks = {
  initiative?: (i: Initiative) => boolean;
  memory?: (m: Memory) => boolean;
  /** Lancer une proposition acceptée selon son genre (message, équipe, objectif). */
  launch?: (i: Initiative) => void;
};

/** Moteur d'agent en service, tel qu'affiché dans l'interface. */
export type EngineInfo = {
  name: EngineName | "demo";
  model: string;
  /** null = pas encore vérifié. */
  ready: boolean | null;
  account: string | null;
  /** Ce qui bloque, et comment le débloquer. */
  problem: string | null;
};

const short = (text: string, n = 80) => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * Le cœur indépendant du canal : file des tâches, validations, alertes, reprise
 * au démarrage. Telegram et l'interface web ne sont que des portes d'entrée.
 */
export function createHub(
  deps: HubDeps,
  opts: {
    execute?: typeof executeTask;
    /** Relit le quota auprès du moteur principal. Absent : on se fie à la dernière lecture. */
    refreshQuota?: () => Promise<Quota | null>;
    /** Moteurs disponibles, par nom, pour le moteur par rôle. Absent : seul `execute` sert. */
    executors?: Partial<Record<EngineName, typeof executeTask>>;
    /** Envoi réel d'un mail accepté (Gmail). Remplacé par un faux dans la démo et les tests. */
    sendMail?: (m: OutgoingMail) => Promise<unknown>;
    /** État de la connexion Google affiché dans l'interface. */
    googleStatus?: () => GoogleStatus;
    /** Relit auprès des moteurs : connexion, quotas, modèles (bouton « Actualiser »). */
    refreshEngines?: () => Promise<void>;
    /** Juge rapide sans outils (vérification de fin de tâche). Absent : seule la règle « annonce la suite » joue. */
    judge?: (prompt: string) => Promise<string>;
    /** Modèle rapide sans outils pour titrer une conversation. Absent : le titre reste le début de ton premier message. */
    titler?: (prompt: string) => Promise<string>;
  } = {},
) {
  const { store, journal, conversation } = deps;
  // Anciennes critiques du binôme rangées par erreur dans la plage des automatisations.
  const moved = moveCritiqueChats(store.db);
  if (moved) console.log(`[clark] ${moved} fil(s) de critique déplacé(s) hors de la plage des automatisations`);
  const execute = opts.execute ?? executeTask;
  const channels: Channel[] = [];
  const pending = new Map<string, Approval & { settle: (ok: boolean, how: "ok" | "no" | "expired") => void }>();
  const queues = new Map<number, Promise<unknown>>();
  const listeners = new Set<() => void>();
  let engine: EngineInfo = { name: "claude", model: deps.config.model, ready: null, account: null, problem: null };
  // Par moteur : quota, modèles proposés, et état de la connexion (affichés dans « Moteurs »).
  const quotas: Partial<Record<EngineName, Quota | null>> = {};
  const catalogs: Partial<Record<EngineName, { catalog: Catalog | null; error: string | null }>> = {};
  const connections: Partial<Record<EngineName, { ready: boolean | null; account: string | null; problem: string | null }>> = {};

  const changed = () => {
    for (const listener of listeners) listener();
  };
  journal.onChange(changed);
  conversation.onAdd(changed);

  // Questions des agents : posées ici (moteur Claude) ou depuis le serveur MCP de Codex,
  // qui écrit dans la base ; on relit donc la base chaque seconde pour les voir arriver.
  store.questions.onEvent((event, q) => {
    if (event === "asked" && q) {
      const who = q.agent ? `Le ${q.agent}` : "Clark";
      void say(OWNER_CHAT, `${who} te pose une question : « ${short(q.question, 200)} »`, "system", q.task_id, "approval");
      void each((c) => c.askQuestion?.(q), "approval", q.question);
    }
    changed();
  });
  store.automations.onChange(changed);
  store.goals.onChange(changed);
  store.dev.onChange(changed);
  // Une tâche dev travaille dans sa copie du dépôt, y compris quand elle est reprise.
  const cwdOf = (label: string) => {
    const id = devOfLabel(label);
    if (id) return store.dev.get(id)?.worktree;
    // Binôme : le relecteur lit la copie de la tâche (en lecture seule).
    const reviewed = devReviewOfLabel(label);
    if (reviewed) return store.dev.get(reviewed)?.worktree;
    // L'agent de plan d'un groupe, et celui qui critique ce plan, lisent sa propre copie, en lecture seule.
    const group = devPlanOfLabel(label) ?? devCritiqueOfLabel(label);
    return group ? (store.dev.group(group)?.plan_worktree ?? undefined) : undefined;
  };
  // Serveurs MCP : la liste « lecture seule » suit la base, l'interface se met à jour.
  const syncMcp = () => setReadOnlyMcp(store.mcp.enabled().filter((s) => s.trust === "read").map((s) => s.name));
  syncMcp();
  store.mcp.onChange(() => {
    syncMcp();
    changed();
  });
  let autonomy: AutonomyHooks = {};
  // Propositions du tour de veille : dans ton fil et sur les canaux, avec Accepter / Refuser.
  store.initiatives.onEvent((event, i) => {
    // Autonomie : ce que l'utilisateur a permis à Clark de trancher seul ne lui est pas proposé.
    if (event === "proposed" && i && autonomy.initiative?.(i)) return changed();
    if (event === "proposed" && i) {
      void say(OWNER_CHAT, `Clark te propose : « ${short(i.title, 120)} ». ${short(i.why, 200)}`, "system");
      void each((c) => c.proposeInitiative?.(i), "proposals", i.title);
    }
    changed();
  });
  // Idées : la page se met à jour (le tour d'idées s'annonce à la fin, en une fois).
  store.ideas.onEvent(() => changed());
  // Brouillons du module Réseaux sociaux : annoncés dans le fil et poussés sur les canaux.
  store.posts.onEvent((event, p) => {
    if (event === "proposed" && p) {
      void say(OWNER_CHAT, `Contenu ${platformName(p.platform)} à valider : « ${short(p.title, 120)} » (${Math.round(p.duration)} s).`, "system", p.task_id ?? undefined);
      void each((c) => c.proposePost?.(p), "approval", p.title);
    }
    changed();
  });
  // Boîte d'envoi : le mail exact, annoncé dans le fil et poussé sur les canaux.
  store.outbox.onEvent((event, m) => {
    if (event === "queued" && m) {
      void say(OWNER_CHAT, `Clark veut envoyer un mail à ${short(m.to_addr, 120)} : « ${short(m.subject, 120)} ». Rien ne part sans ton accord.`, "system", m.task_id ?? undefined, "approval");
      void each((c) => c.askMail?.(m), "approval", m.subject);
    }
    changed();
  });
  // Questions et points d'étape peuvent venir du serveur de mémoire de Codex (autre processus).
  const questionPoll = setInterval(() => {
    // Base fermée (arrêt, fin d'un test) : le relevé s'arrête au lieu de planter.
    if (!store.db.isOpen) return clearInterval(questionPoll);
    store.questions.sync();
    store.posts.sync();
    store.initiatives.sync();
    store.ideas.sync();
    store.outbox.sync();
    journal.pollCheckpoints();
  }, 1000);
  questionPoll.unref();

  /**
   * Agent silencieux : une tâche qui tourne sans la moindre activité (étape, point d'étape)
   * depuis CLARK_STALL_MINUTES (10 par défaut) est signalée une fois, avec de quoi l'arrêter.
   * Une tâche qui attend ton accord ou ta réponse n'est pas bloquée : elle t'attend.
   */
  const stallMs = () => Math.max(1, Number(process.env.CLARK_STALL_MINUTES) || 10) * 60_000;
  const stalled = new Map<number, number>(); // tâche → depuis quand (ms)
  const checkStalls = () => {
    if (!store.db.isOpen) return clearInterval(stallTimer);
    const waitingOnCharles = new Set([...pending.values()].map((a) => a.taskId).concat(store.questions.pending().map((q) => q.task_id)));
    const now = Date.now();
    let changedAny = false;
    const running = journal.unfinished().filter((t) => t.status === "running");
    for (const id of [...stalled.keys()]) if (!running.some((t) => t.id === id)) (stalled.delete(id), (changedAny = true));
    for (const t of running) {
      const last = journal.lastActivity(t.id);
      const quiet = now - last >= stallMs() && !waitingOnCharles.has(t.id);
      if (quiet && !stalled.has(t.id)) {
        stalled.set(t.id, last);
        changedAny = true;
        const what = isDevChat(t.chat_id) ? `la tâche dev #${devOfLabel(t.label) ?? "?"}` : `« ${short(askedText(t.prompt).replace(/\s+/g, " "), 80)} »`;
        void say(OWNER_CHAT, `L'agent de ${what} ne donne plus signe de vie depuis ${Math.round((now - last) / 60_000)} min. Tu peux l'arrêter dans Activité, ou attendre.`, "system", t.id, "stalled");
      } else if (!quiet && stalled.has(t.id)) {
        stalled.delete(t.id);
        changedAny = true;
      }
    }
    if (changedAny) changed();
  };
  const stallTimer = setInterval(checkStalls, 30_000);
  stallTimer.unref();
  // Une proposition de souvenir s'inscrit dans le fil (et part sur Telegram) ; le choix se fait dans l'interface.
  store.onMemory((event, m) => {
    if (event === "proposed" && m && autonomy.memory?.(m)) return changed();
    if (event === "proposed" && m) {
      const what = m.replaces_id !== null ? `Clark propose de corriger le souvenir #${m.replaces_id} en` : "Clark propose de retenir";
      void say(OWNER_CHAT, `${what} : « ${short(m.content, 200)} ». Source : ${short(m.source ?? "", 160)}. À confirmer, corriger ou ignorer dans l'interface.`, "system", m.source_task_id ?? undefined);
    } else changed();
  });

  /** Envoie à chaque canal qui veut ce genre de notification (Réglages › Notifications, heures calmes). */
  const each = async (fn: (c: Channel) => Promise<unknown> | undefined, kind: NotifyKind = "system", text?: string) => {
    for (const c of channels) {
      if (!notifyAllowed(c.name, kind, text)) continue;
      try {
        await fn(c);
      } catch (err) {
        console.error(`[clark] canal ${c.name} :`, err);
      }
    }
  };

  /** Écrit dans le fil, puis le pousse sur les canaux. */
  const say = async (chatId: number, text: string, role: Exclude<Role, "user"> = "clark", taskId?: number, kind?: NotifyKind, agent?: string | null) => {
    const m = conversation.add({ chatId, role, text, taskId, kind: kind ?? (role === "clark" ? "reply" : "system"), agent: agent ?? null });
    // Ta conversation seulement : les fils des objectifs et du dev restent dans l'interface.
    await each((c) => c.deliver?.(m), (m.kind ?? "system") as NotifyKind, chatId === OWNER_CHAT ? text : undefined);
  };

  /**
   * Alerte « à vérifier ». Marquée remise seulement si un canal qui pousse l'a bien envoyée.
   * Sans canal qui pousse, l'interface web la lit directement dans la base : rien ne se perd.
   */
  const alert = async (task: Task, text: string) => {
    const pushers = channels.filter((c) => c.alert);
    if (pushers.length === 0) {
      journal.markAlerted(task.id);
      return;
    }
    let delivered = false;
    for (const c of pushers) {
      if (await c.alert!(task, text).catch(() => false)) delivered = true;
    }
    if (delivered) journal.markAlerted(task.id);
    else console.error(`[clark] alerte de la tâche ${task.id} non remise (renvoyée au prochain démarrage)`);
  };

  /** Une tâche part en vérification : le texte est gardé avec le statut, puis l'alerte part. */
  const raiseCheck = async (task: Task, text: string) => {
    conversation.add({ chatId: task.chat_id, role: "system", text, taskId: task.id });
    await alert(task, text);
  };

  const approverFor =
    (chatId: number, taskId: number, agent?: string): Approver =>
    ({ tool, summary }) =>
      new Promise<boolean>((resolve) => {
        const id = randomUUID().slice(0, 8);
        const now = Date.now();
        const timer = setTimeout(() => settle(false, "expired"), APPROVAL_TIMEOUT_MS);
        timer.unref(); // n'empêche pas Clark (ou un test) de s'arrêter
        const settle = (ok: boolean, how: "ok" | "no" | "expired") => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(ok);
          const first = summary.split("\n").find((l) => l.trim() && !l.endsWith(":")) ?? summary;
          const verdict = how === "ok" ? "Validé" : how === "no" ? "Refusé" : "Sans réponse après 10 minutes, refusé";
          void say(chatId, `${verdict}${agent ? ` (${agent})` : ""} : ${short(first.trim(), 120)}`, "system", taskId);
        };
        const approval: Approval = { id, chatId, taskId, tool, summary, agent, createdAt: now, expiresAt: now + APPROVAL_TIMEOUT_MS };
        pending.set(id, { ...approval, settle });
        changed();
        void each((c) => c.askApproval?.(approval), "approval", approval.summary.split("\n")[0]);
      });

  /**
   * File par chat, sans bloquer les canaux : une tâche qui attend une validation
   * doit pouvoir recevoir le clic pendant qu'elle attend.
   */
  const schedule = (chatId: number, job: () => Promise<RunResult>, taskId: number) => {
    const previous = queues.get(chatId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const ping = () => channels.forEach((c) => c.typing?.(chatId));
      ping();
      const typing = setInterval(ping, 4000);
      typing.unref(); // n'empêche pas Clark (ou un test) de s'arrêter
      try {
        const result = await job();
        const task = journal.get(taskId);
        // L'agent a dit « rien de neuf » ou « pas abouti » (tâche planifiée) : pas de réponse ordinaire.
        const said = journal.outcome(taskId);
        if (result.status === "needs_check" && task) await raiseCheck(task, result.text);
        else if (said.outcome === "quiet") await say(chatId, result.text, "system", taskId, "quiet");
        else if (said.outcome === "failed") await say(chatId, `Pas abouti : ${said.note ?? "raison non donnée"}.${result.text ? `\n\n${result.text}` : ""}`, "system", taskId);
        // Avis d'un membre du groupe : signé de son nom.
        else await say(chatId, result.text, "clark", taskId, undefined, task?.label.startsWith("avis:") ? task.label.slice(5) : null);
        if (task) await afterTurn(task, result);
        if (task && result.status === "done") void nameConversation(task);
      } catch (err) {
        if (err instanceof StaleAttempt) {
          // Une autre exécution a pris le relais sur cette tâche : celle-ci s'efface sans rien dire.
          console.warn(`[clark] tâche ${taskId} : ${err.message}`);
          return;
        }
        console.error(`[clark] échec de la tâche ${taskId} :`, err);
        await say(chatId, `Ça a planté de mon côté : ${err instanceof Error ? err.message : String(err)}`, "system", taskId);
      } finally {
        clearInterval(typing);
      }
    });
    queues.set(chatId, next.catch(() => {}));
    return next;
  };

  /**
   * Vérification de fin de tâche (src/core/finish-check.ts) : un message de l'utilisateur qui s'est
   * arrêté à mi-chemin repart pour un tour, dans la limite des plafonds.
   */
  const followUps = new Map<number, { root: number; next: number; checks: number }>();
  const afterTurn = async (task: Task, result: RunResult) => {
    // Quota atteint pendant le tour : la même demande repart une fois sur l'autre moteur.
    if (result.status === "failed" && task.label === "chat" && task.parent_id === null && !backupRuns.has(task.id) && task.engine && limited(task.engine as EngineName)) {
      const backup = backupOf(task.engine as EngineName);
      if (backup) {
        void enqueue(task.chat_id, task.prompt, "chat", "secours", {
          engine: backup,
          onCreated: (id) => backupRuns.add(id),
          display: `Quota ${ENGINE_LABEL[task.engine as EngineName]} atteint en cours de route : je reprends ta demande sur ${ENGINE_LABEL[backup]}.`,
        });
        return;
      }
    }
    if (result.status !== "done" || task.label !== "chat" || task.parent_id !== null || task.chat_id !== OWNER_CHAT) return;
    // L'utilisateur a écrit entre-temps : c'est lui qui donne la suite.
    if (journal.unfinished().some((t) => t.chat_id === task.chat_id && t.id !== task.id)) return;
    const chain = followUps.get(task.id) ?? { root: task.id, next: 0, checks: 0 };
    let missing: string[] | null | undefined;
    if (announcesNextStep(result.text) && chain.next < NEXT_STEP_LIMIT) {
      missing = null;
      chain.next++;
    } else if (opts.judge && chain.checks < FINISH_CHECK_LIMIT) {
      const steps = journal.steps(task.id);
      if (!steps.length) return; // simple échange, rien à vérifier
      try {
        const root = journal.get(chain.root) ?? task;
        const v = parseVerdict(await opts.judge(judgePrompt(root.prompt, steps.slice(-10).map((st) => ({ text: describeStep(st), failed: st.status === "error" || st.status === "denied" })), result.text)));
        if (v.verdict !== "continue") return;
        missing = v.missing;
        chain.checks++;
      } catch (err) {
        console.warn("[clark] vérification de fin impossible :", err instanceof Error ? err.message : err);
        return;
      }
    } else return;
    const note = missing ? `Je continue : il manque ${missing.map((m) => `« ${short(m, 80)} »`).join(", ")}.` : "Je continue l'étape annoncée.";
    void enqueue(OWNER_CHAT, continuePrompt(missing), "chat", "suite", {
      display: note,
      ...(task.engine ? { engine: task.engine as EngineName } : {}),
      onCreated: (id) => followUps.set(id, { ...chain }),
    });
  };

  // Moteur de secours (idée reprise d'OpenBot) : quota à jour atteint → l'autre moteur, s'il est connecté.
  const ENGINE_LABEL: Record<EngineName, string> = { claude: "Claude", codex: "Codex", api: "Autres IA" };
  const limited = (name: EngineName) => {
    const q = quotas[name];
    return Boolean(q?.reached) && !isStale(q ?? null);
  };
  // Coupé par défaut (Réglages › Moteurs › Moteur de secours) : Codex sert au binôme, pas de roue de secours.
  const backupOn = () => ["on", "1", "true", "oui"].includes((process.env.CLARK_BACKUP_ENGINE ?? "off").trim().toLowerCase());
  const backupOf = (name: EngineName): EngineName | null =>
    backupOn() ? ((["claude", "codex"] as EngineName[]).find((n) => n !== name && executors[n] && connections[n]?.ready === true && !limited(n)) ?? null) : null;
  const quotaKey = (name: EngineName) => String(quotas[name]?.readAt ?? "");
  const backupNoted: Partial<Record<EngineName, string>> = {};
  const backupRuns = new Set<number>();

  // Moteur par rôle : celui demandé s'il est disponible, sinon le moteur principal.
  // Le moteur principal se change à chaud (sélecteur de modèle) : on le relit à chaque tâche.
  // « execute » reste celui du moteur de départ (les tests et la démo passent le leur).
  const startEngine = deps.config.engine;
  const mainEngine = () => deps.config.engine;
  const executors: Partial<Record<EngineName, typeof executeTask>> = { ...opts.executors, [startEngine]: opts.executors?.[startEngine] ?? execute };
  const engineFor = (role: string) => {
    const wanted = deps.config.roleEngines[role as EngineRole] ?? mainEngine();
    const name = executors[wanted] ? wanted : mainEngine();
    return { name, wanted, execute: executors[name]! };
  };

  // Équipe d'agents : Clark délègue, transmet les résultats, reprend agent par agent.
  const team = createTeam({ deps, execute, approverFor, engineFor, engineByName: (name) => executors[name as EngineName] });
  const runTeam = (task: Task) => schedule(task.chat_id, () => team.run(task.id), task.id);

  /** Nouvelle demande : écrite dans le journal et dans le fil avant tout traitement. */
  /**
   * Un vrai titre pour la conversation, après la première réponse de Clark : 2 à 6 mots trouvés par
   * un modèle rapide, à la place du début de ton premier message. Jamais à la place d'un titre que tu as donné.
   */
  const naming = new Set<number>();
  const nameConversation = async (task: Task) => {
    if (!opts.titler || task.chat_id !== OWNER_CHAT || (task.label !== "chat" && task.label !== TEAM_LABEL)) return;
    const id = conversation.conversationOfTask(task.id);
    if (id === null || naming.has(id) || !conversation.wantsTitle(id)) return;
    const list = conversation.messagesOf(id, 40);
    const first = list.find((m) => m.role === "user");
    const reply = list.find((m) => m.role === "clark");
    if (!first || !reply) return;
    naming.add(id);
    try {
      const title = cleanTitle(await opts.titler(titlePrompt(first.text, reply.text)));
      if (title && conversation.setAutoTitle(id, title)) changed();
    } catch (err) {
      console.warn("[clark] titre de conversation impossible :", err instanceof Error ? err.message : err);
    } finally {
      naming.delete(id);
    }
  };

  const enqueue = (
    chatId: number,
    prompt: string,
    label: string,
    source = "clark",
    /** display : ce que le fil montre à la place de la consigne (la commande tapée, « /relances … »). */
    opts: { onCreated?: (taskId: number) => void; access?: "read" | "write"; display?: string; engine?: EngineName; model?: string | null; effort?: string | null; images?: string[]; parentId?: number } = {},
  ) => {
    // Longue pause (Réglages › Conversations) : ton message ouvre une nouvelle conversation, l'ancienne
    // reste dans la liste avec sa session. Pas pendant qu'une demande tourne encore dans celle-ci.
    if ((label === "chat" || label === TEAM_LABEL) && chatId === OWNER_CHAT && CHARLES_SOURCES.has(source) && opts.parentId === undefined) {
      const hours = newConversationHours();
      const idle = conversation.idleHours(chatId);
      if (hours > 0 && idle !== null && idle >= hours && !journal.unfinished().some((t) => t.chat_id === chatId)) {
        const before = conversation.current(chatId);
        const after = conversation.startNew(chatId, conversation.conversation(before)?.agent ?? null);
        if (after !== before) {
          conversation.saveSession(before, store.getSession(chatId));
          store.clearSession(chatId);
          conversation.add({ chatId, role: "system", text: NEW_CONVERSATION_NOTE });
        }
      }
    }
    // Ce que l'utilisateur a vu s'afficher sans que l'agent l'écrive (rappels, décisions seul, notes…) :
    // donné avec son message, sinon l'agent ne sait pas à quoi il répond (« ton rappel »).
    // (Conversation de Clark seulement : un agent en discussion directe garde sa consigne telle quelle.)
    if ((label === "chat" || label === TEAM_LABEL) && chatId === OWNER_CHAT && CHARLES_SOURCES.has(source) && opts.parentId === undefined && !prompt.startsWith("[Discussion directe")) {
      const shown = unseenNotes(conversation, conversation.current(chatId));
      if (shown) {
        opts = { ...opts, display: opts.display ?? prompt };
        prompt = `${shown}${MESSAGE_MARK}${prompt}`;
      }
    }
    const taskId = journal.create(chatId, label, prompt, opts.parentId);
    journal.setSource(taskId, source);
    // Le moteur est noté dès le départ : une reprise après redémarrage se fait sur le même.
    let engine: EngineName = opts.engine && executors[opts.engine] ? opts.engine : mainEngine();
    // Les autres IA n'ont pas d'outils de code : une tâche de code (et son plan, sa relecture) part sur Claude ou Codex.
    if (engine === "api" && (devOfLabel(label) || devPlanOfLabel(label) || devReviewOfLabel(label) || devCritiqueOfLabel(label))) {
      engine = executors.claude && connections.claude?.ready !== false ? "claude" : "codex";
    }
    // Moteur de secours : quota atteint sur celui-ci, l'autre prend le relais jusqu'à la remise à zéro.
    if (label !== HEARTBEAT_LABEL && limited(engine)) {
      const backup = backupOf(engine);
      if (backup) {
        if (backupNoted[engine] !== quotaKey(engine)) {
          backupNoted[engine] = quotaKey(engine);
          conversation.add({ chatId, role: "system", text: `Quota ${ENGINE_LABEL[engine]} atteint : je passe sur ${ENGINE_LABEL[backup]} jusqu'à la remise à zéro.` });
        }
        engine = backup;
      }
    }
    journal.setEngine(taskId, engine);
    const run = engine === startEngine && !opts.engine ? execute : (executors[engine] ?? execute);
    opts.onCreated?.(taskId);
    // Lancée par une automatisation ou une proposition acceptée : ce n'est pas l'utilisateur qui l'a écrite, on le dit.
    // Une ligne courte : la consigne complète reste dans Réglages › Automatisations.
    if (source.startsWith("automation:")) conversation.add({ chatId, role: "system", text: `Automatisation « ${source.slice(11)} » : c'est parti.`, taskId });
    else if (source.startsWith("initiative:")) conversation.add({ chatId, role: "system", text: `Proposition acceptée « ${source.slice(11)} » : ${short(prompt, 300)}`, taskId });
    else if (isGoalChat(chatId) || isDevChat(chatId)) {
      // Tour d'un objectif : la consigne reste dans le fil de l'objectif, pas dans le tien.
      conversation.add({ chatId, role: "system", text: short(prompt.split("\n")[0], 200), taskId });
    }
    else if (source === "suite" || source === "secours") {
      // Suite automatique (vérification de fin) : une note, pas un message de l'utilisateur.
      conversation.add({ chatId, role: "system", text: opts.display ?? "Je continue.", taskId });
    }
    else if (label === HEARTBEAT_LABEL || label === "brief" || isIdeaLabel(label) || label.startsWith("avis:")) {
      // Tour de veille, brief, tour d'idées, avis d'un membre du groupe : rien dans le fil avant la réponse.
    }
    else if (label === "chat" || label === TEAM_LABEL) conversation.add({ chatId, role: "user", text: opts.display ?? prompt, taskId, source });
    else conversation.add({ chatId, role: "system", text: `Tâche planifiée : ${label}`, taskId });
    if (label === TEAM_LABEL) return launchTeam(chatId, taskId);
    return schedule(
      chatId,
      () =>
        run(deps, taskId, {
          prompt,
          ...(cwdOf(label) ? { cwd: cwdOf(label) } : {}),
          // Une tâche de code : tour long, tests et build possibles dans le bac à sable.
          ...(devOfLabel(label) ? { codeTask: true } : {}),
          // Le tour de veille repart toujours de zéro : il ne reprend pas ta conversation.
          // Le tour de veille et les avis du groupe repartent de zéro : ils ne reprennent pas ta conversation.
          resume: label === HEARTBEAT_LABEL || label === "brief" || isIdeaLabel(label) || opts.parentId !== undefined ? undefined : (store.getSession(chatId) ?? undefined), // lu au moment d'exécuter
          approve: approverFor(chatId, taskId),
          mode: "new",
          ...(opts.access ? { access: opts.access } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.images?.length ? { images: opts.images } : {}),
        }),
      taskId,
    );
  };

  /**
   * Une équipe enchaîne au moins trois tours : on regarde le quota avant de la lancer.
   * Avant de refuser, ou si une remise à zéro annoncée est passée, on relit le quota
   * une fois : un ancien « épuisé » ne doit pas bloquer après la remise à zéro.
   */
  const launchTeam = async (chatId: number, taskId: number) => {
    const main = deps.config.engine;
    const label = main === "codex" ? "Codex" : "Claude";
    let q = quotas[main] ?? null;
    // true : chiffres relus à l'instant auprès de Codex ; false : on n'a que la dernière lecture.
    let rechecked = false;
    if (q && (q.reached || isStale(q)) && opts.refreshQuota) {
      try {
        const fresh = await opts.refreshQuota();
        if (fresh) {
          q = fresh;
          quotas[main] = fresh;
          rechecked = true;
          changed();
        }
      } catch (err) {
        console.warn("[clark] relecture du quota impossible :", err instanceof Error ? err.message : err);
      }
    }
    const stale = isStale(q);
    const tight = tightest(q);
    // Refus seulement sur des chiffres actuels. Remise à zéro passée sans relecture possible : on lance.
    if (q?.reached && !stale) {
      const readAt = q.readAt ? new Date(q.readAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : "?";
      const text = rechecked
        ? `Quota ${label} atteint, je viens de le revérifier : je ne lance pas l'équipe, elle échouerait au premier agent. Remise à zéro ${formatReset(tight?.resetsAt ?? null)}.`
        : `Quota ${label} atteint d'après la dernière lecture (à ${readAt}). Je n'ai pas pu le revérifier : ${label} ne répond pas. Je ne lance pas l'équipe avant la remise à zéro annoncée, ${formatReset(tight?.resetsAt ?? null)}. Tu peux réessayer plus tôt si tu penses que le quota est revenu.`;
      journal.finish(taskId, "failed", text, 0);
      conversation.add({ chatId, role: "clark", text, taskId });
      return;
    }
    conversation.add({ chatId, role: "system", text: "Confié à l'équipe : Clark compose l'équipe pour cette mission.", taskId });
    if (q?.reached && stale) {
      conversation.add({
        chatId,
        role: "system",
        text: "Le dernier quota connu était épuisé, mais sa remise à zéro est passée et je n'ai pas pu le relire. Je lance l'équipe ; si le quota bloque encore, elle s'arrêtera au premier agent.",
        taskId,
      });
    } else if (!stale && tight && tight.usedPercent >= NEAR_LIMIT_PERCENT) {
      conversation.add({
        chatId,
        role: "system",
        text: `Attention, quota ${label} presque épuisé : ${Math.round(tight.usedPercent)} % de la ${tight.label.toLowerCase()} utilisés, remise à zéro ${formatReset(tight.resetsAt)}. L'équipe enchaîne plusieurs tours et risque de s'arrêter en route.`,
        taskId,
      });
    }
    await runTeam(journal.get(taskId)!);
  };

  /** Reprise après redémarrage : même moteur, même modèle et effort (tâche dev), même dossier. */
  const recoveryRun = (task: Task) => {
    const devId = devOfLabel(task.label);
    const dev = devId ? store.dev.get(devId) : undefined;
    const engine = (task.engine ?? dev?.engine ?? null) as EngineName | null;
    const cwd = cwdOf(task.label);
    return {
      run: engine && executors[engine] ? executors[engine]! : execute,
      extra: { ...(cwd ? { cwd } : {}), ...(dev ? { codeTask: true } : {}), ...(dev?.model ? { model: dev.model } : {}), ...(dev?.effort ? { effort: dev.effort } : {}) },
    };
  };

  const resumeTask = (task: Task, prompt: string) => {
    const { run, extra } = recoveryRun(task);
    return schedule(
      task.chat_id,
      () =>
        run(deps, task.id, {
          prompt,
          resume: task.session_id ?? undefined,
          approve: approverFor(task.chat_id, task.id),
          mode: "recovery",
          ...extra,
        }),
      task.id,
    );
  };

  /** Au démarrage : chaque tâche coupée est reprise, relancée ou mise en attente de vérification. */
  /**
   * Équipe coupée : les agents terminés sont gardés. L'agent en cours est repris s'il ne
   * faisait que lire ; s'il écrivait, toute l'équipe attend la décision de l'utilisateur.
   */
  const recoverTeam = async (task: Task) => {
    const children = journal.children(task.id);
    // Avec le parallélisme, plusieurs agents peuvent avoir été coupés en même temps.
    const active = children.filter((c) => c.status === "running" || c.status === "queued");
    const what = `« ${short(askedText(task.prompt))} »`;
    for (const a of active) {
      journal.expireApprovals(a.id);
      const plan = planRecovery(a, journal.steps(a.id));
      if (plan.action === "check") {
        const text = teamCheckText(task, children, a, plan.uncertain);
        journal.finish(task.id, "needs_check", text, 0);
        await raiseCheck(journal.get(task.id)!, text);
        return;
      }
    }
    const kept = [...new Set(children.filter((c) => c.status === "done" && c.label !== "plan").map(displayName))];
    const resumed = active.map(displayName);
    const done = `${kept.length ? ` Déjà fait et conservé : ${kept.join(", ")}.` : ""}${resumed.length ? ` Repris : ${resumed.join(", ")}.` : ""}`;
    await say(task.chat_id, `J'ai été coupé pendant le travail de l'équipe sur ${what}.${done} L'équipe reprend là où elle en était.`, "system", task.id);
    runTeam(task);
  };

  const recover = async () => {
    // Un tour de veille coupé n'est pas repris : le suivant arrivera à son heure.
    for (const t of journal.unfinished()) if (t.label === HEARTBEAT_LABEL) journal.setStatus(t.id, "abandoned");
    // Pareil pour le tour d'idées et les recherches sur une idée : l'idée revient à trier.
    for (const t of journal.unfinished()) if (isIdeaLabel(t.label)) journal.setStatus(t.id, "abandoned");
    for (const i of store.ideas.byStatus("digging")) store.ideas.unstick(i.id);
    // Questions d'avant la coupure : plus personne ne les attend. L'agent repris redemandera.
    store.questions.expireAll();
    // Mails d'avant la coupure : plus personne n'attend la réponse, rien ne part. Un envoi coupé
    // en plein vol est signalé : à vérifier dans « Envoyés » de Gmail, jamais renvoyé seul.
    for (const m of store.outbox.pending()) store.outbox.transition(m.id, "pending", "expired");
    for (const m of store.db.prepare("SELECT id, to_addr FROM outbox WHERE status = 'approved'").all() as { id: number; to_addr: string }[]) {
      store.outbox.transition(m.id, "approved", "failed", "Clark a été coupé pendant l'envoi");
      void say(OWNER_CHAT, `Clark a été coupé pendant l'envoi d'un mail à ${short(m.to_addr, 120)}. Regarde dans « Envoyés » de Gmail s'il est parti ; je ne le renvoie pas seul.`, "system");
    }
    for (const task of journal.unfinished()) {
      if (task.label === TEAM_LABEL) {
        await recoverTeam(task);
        continue;
      }
      const expired = journal.expireApprovals(task.id);
      const plan = planRecovery(task, journal.steps(task.id));
      const what = `« ${short(askedText(task.prompt))} »`;

      if (plan.action === "restart") {
        await say(task.chat_id, `J'ai redémarré avant de commencer ${what}. Je m'y mets.`, "system", task.id);
        const { run, extra } = recoveryRun(task);
        schedule(
          task.chat_id,
          () =>
            run(deps, task.id, {
              prompt: task.prompt,
              resume: task.label === HEARTBEAT_LABEL ? undefined : (store.getSession(task.chat_id) ?? undefined),
              approve: approverFor(task.chat_id, task.id),
              mode: "new",
              ...extra,
            }),
          task.id,
        );
      } else if (plan.action === "resume") {
        const note = expired ? " Une validation était en attente : je te la redemanderai." : "";
        await say(task.chat_id, `J'ai été coupé pendant ${what} (${plan.done.length} étape(s) terminée(s)). Je reprends à la dernière.${note}`, "system", task.id);
        resumeTask(task, resumePrompt(task, plan.done));
      } else {
        const text = checkAlertText(task, plan.uncertain);
        journal.finish(task.id, "needs_check", text, 0);
        await raiseCheck(journal.get(task.id)!, text);
      }
    }

    // Alertes jamais remises lors d'un démarrage précédent (échec d'envoi, arrêt au mauvais moment).
    for (const task of journal.unalerted()) {
      await alert(task, task.result ?? checkAlertText(task, uncertainSteps(journal.steps(task.id))));
    }
  };

  return {
    deps,
    engine: () => engine,
    /** Moteur de chaque rôle : demandé, et réellement utilisé (le principal si le demandé manque). */
    roleEngines(): { role: EngineRole; wanted: EngineName; actual: EngineName; special: boolean }[] {
      return ENGINE_ROLES.map((role) => {
        const e = engineFor(role);
        // « special » : réglé sur un autre moteur que le principal, ou demandé mais indisponible.
        return { role, wanted: e.wanted, actual: e.name, special: e.wanted !== mainEngine() || e.name !== e.wanted };
      });
    },
    engineFor: (role: string) => engineFor(role).name,
    /** Quota du moteur principal (celui qui compte pour les équipes et le tour de veille). */
    quota: () => quotas[deps.config.engine] ?? null,
    quotaOf: (name: EngineName) => quotas[name] ?? null,
    setQuota(q: Quota | null, name: EngineName = deps.config.engine) {
      quotas[name] = q;
      changed();
    },
    /** La limite vient d'être atteinte pendant une tâche (sans chiffres) : on la note jusqu'à la relecture. */
    markLimitReached(name: EngineName, resetsAt: number | null) {
      const prev = quotas[name];
      quotas[name] = prev
        ? { ...prev, reached: true, readAt: Date.now() }
        : { plan: null, windows: resetsAt ? [{ label: "Fenêtre", usedPercent: 100, durationMins: null, resetsAt }] : [], reached: true, readAt: Date.now() };
      changed();
    },

    /** Connexion d'un moteur, telle que vérifiée au démarrage ou à l'actualisation. */
    connection: (name: EngineName) => connections[name] ?? null,
    /** Ce moteur peut-il travailler (présent, et pas signalé déconnecté) ? */
    canRun: (name: EngineName) => Boolean(executors[name]) && connections[name]?.ready !== false,
    setConnection(name: EngineName, c: { ready: boolean | null; account: string | null; problem: string | null }) {
      connections[name] = c;
      changed();
    },
    catalog: (name: EngineName) => catalogs[name] ?? null,
    setCatalog(name: EngineName, catalog: Catalog | null, error: string | null = null) {
      // Un échec de relecture ne fait pas oublier la dernière liste connue.
      catalogs[name] = { catalog: catalog ?? catalogs[name]?.catalog ?? null, error };
      changed();
    },
    choice: (name: EngineName) => store.choices.get(name),
    /**
     * Choix de l'utilisateur dans l'interface, vérifié contre la liste du moteur. Appliqué aux prochaines tâches.
     * reason « model » : seul le modèle change ; l'effort devient le niveau choisi par l'utilisateur si ce modèle
     * le propose, sinon Auto (et le niveau choisi reste en mémoire pour le prochain modèle qui l'a).
     */
    setChoice(name: EngineName, c: EngineChoice, reason: "model" | "effort" = "effort", from = "interface"): string | null {
      const before = store.choices.get(name);
      let next: EngineChoice & { wanted?: string | null } = c;
      if (reason === "model") {
        const m = catalogs[name]?.catalog?.models.find((x) => x.id === c.model);
        const wanted = before.wanted;
        next = { model: c.model, effort: c.model && wanted && m?.efforts.includes(wanted) ? wanted : null, wanted };
      }
      const error = checkChoice(next, catalogs[name]?.catalog ?? null);
      if (error) return error;
      store.choices.set(name, next);
      // Une trace de chaque changement (quoi, d'où) : si l'effort bouge sans qu'on comprenne, on retrouve pourquoi.
      store.audit("engine_choice", reason, { engine: name, from, before, after: store.choices.get(name) });
      changed();
      return null;
    },
    refreshEngines: async () => {
      await opts.refreshEngines?.();
      changed();
    },
    setEngine(info: EngineInfo) {
      engine = info;
      changed();
    },
    /** Les moteurs qui peuvent devenir le principal (présents, et pas signalés déconnectés). */
    availableEngines: () => (Object.keys(executors) as EngineName[]).filter((n) => connections[n]?.ready !== false),
    /**
     * Change le moteur principal, tout de suite : les prochaines tâches partent dessus, celles en cours
     * gardent le leur. Refusé si ce moteur n'est pas là ou pas connecté. Renvoie l'erreur, ou null.
     */
    setMainEngine(name: EngineName): string | null {
      if (!executors[name]) return `${ENGINE_LABEL[name]} n'est pas disponible.`;
      const conn = connections[name];
      if (conn?.ready === false) return `${ENGINE_LABEL[name]} n'est pas connecté.`;
      if (deps.config.engine === name) return null;
      const before = deps.config.engine;
      deps.config.engine = name;
      const choice = store.choices.get(name);
      engine = { name, model: choice.model ?? (name === "claude" ? deps.config.model : name === "codex" ? (deps.config.codexModel ?? "modèle Codex par défaut") : "premier modèle proposé"), ready: conn?.ready ?? null, account: conn?.account ?? null, problem: conn?.problem ?? null };
      store.audit("engine_main", "switch", { before, after: name });
      changed();
      return null;
    },

    addChannel(c: Channel) {
      channels.push(c);
    },
    /** Appelé à chaque changement visible : fil, tâche, étape, validation. */
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enqueue,
    recover,
    say,
    alert,

    /** Demandes d'accord de ta conversation, et celles des objectifs (qui ont leur propre fil). */
    approvals(chatId = OWNER_CHAT): Approval[] {
      return [...pending.values()]
        .filter((a) => a.chatId === chatId || (chatId === OWNER_CHAT && (isGoalChat(a.chatId) || isDevChat(a.chatId) || isAutomationChat(a.chatId))))
        .map(({ settle: _settle, ...a }) =>
          isDevChat(a.chatId) && !a.agent
            ? { ...a, agent: `Tâche dev #${a.chatId - 2000}` }
            : isGoalChat(a.chatId) && !a.agent
              ? { ...a, agent: `Objectif #${goalOfChat(a.chatId)}` }
              : isAutomationChat(a.chatId) && !a.agent
                ? { ...a, agent: `Automatisation « ${store.automations.get(a.chatId - AUTOMATION_CHAT_BASE)?.name ?? "?"} »` }
                : a,
        );
    },

    /** Un changement hors de la base (fichiers de commandes) : l'interface se met à jour. */
    touch: () => changed(),

    /** Les tâches silencieuses (voir checkStalls), pour « À toi ». */
    stalled(): { taskId: number; since: number; stoppable: boolean }[] {
      return [...stalled.entries()].map(([taskId, since]) => ({ taskId, since, stoppable: canStop(taskId) }));
    },
    checkStalls,

    /** Arrêter un agent en plein tour (clic de l'utilisateur). */
    stopTask(taskId: number): "stopped" | "not_running" {
      if (!stopRunning(taskId)) return "not_running";
      stalled.delete(taskId);
      const t = journal.get(taskId);
      void say(t && isDevChat(t.chat_id) ? t.chat_id : OWNER_CHAT, "Agent arrêté à ta demande.", "system", taskId);
      changed();
      return "stopped";
    },

    /** Accord demandé au nom d'une tâche (navigateur) : même bouton, même délai que les autres. */
    approveTask(taskId: number, req: { tool: string; summary: string }): Promise<boolean> {
      const t = journal.get(taskId);
      if (!t) return Promise.resolve(false);
      if (t.parent_id === null) return approverFor(t.chat_id, t.id)(req);
      const parent = journal.get(t.parent_id);
      return approverFor(parent?.chat_id ?? t.chat_id, t.id, displayName(t))(req);
    },

    /** Message de Clark ou note du système, envoyé aux canaux (web, Telegram). */
    post: (chatId: number, text: string, role: "clark" | "system" = "system", kind?: NotifyKind) => say(chatId, text, role, undefined, kind),
    /** Réponse d'un agent de l'équipe, signée de son nom, dans la conversation d'une tâche. */
    postAs: (chatId: number, text: string, agent: string, taskId?: number, kind: NotifyKind = "quiet") => say(chatId, text, "clark", taskId, kind, agent),
    /** Le moteur à utiliser pour un rôle (moteur par rôle, sinon le principal). */
    executorFor: (role: string) => engineFor(role),

    mails: () => store.outbox.pending(),
    google: () => (opts.googleStatus ?? googleStatus)(),

    /**
     * Décision de l'utilisateur sur un mail : Refuser, rien ne part ; Envoyer, Clark l'envoie une
     * seule fois (la transition pending → approved ne réussit qu'une fois, même en double clic).
     */
    async decideMail(id: number, action: "send" | "refuse"): Promise<"sent" | "refused" | "failed" | "already"> {
      if (action === "refuse") {
        if (!store.outbox.transition(id, "pending", "refused")) return "already";
        void say(OWNER_CHAT, `Mail refusé : rien n'est parti.`, "system", store.outbox.get(id)?.task_id ?? undefined);
        return "refused";
      }
      if (!store.outbox.transition(id, "pending", "approved")) return "already";
      const m = store.outbox.get(id)!;
      try {
        await (opts.sendMail ?? gmailSend)({ to: m.to_addr, cc: m.cc, subject: m.subject, body: m.body, threadId: m.thread_id, inReplyTo: m.in_reply_to, references: m.refs });
        store.outbox.transition(id, "approved", "sent");
        void say(OWNER_CHAT, `Mail envoyé à ${short(m.to_addr, 120)} : « ${short(m.subject, 120)} ».`, "system", m.task_id ?? undefined);
        return "sent";
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        store.outbox.transition(id, "approved", "failed", why);
        void say(OWNER_CHAT, `L'envoi du mail à ${short(m.to_addr, 120)} a échoué : ${short(why, 200)}. Rien n'est parti.`, "system", m.task_id ?? undefined);
        return "failed";
      }
    },

    posts: () => store.posts.pending(),
    initiatives: () => store.initiatives.pending(),

    /** Décision de l'utilisateur sur une proposition : acceptée, elle devient une tâche ; refusée, Clark s'en souvient. */
    decideInitiative(id: number, action: "accept" | "decline", reason?: string): "done" | "already" {
      const i = store.initiatives.get(id);
      if (!i || i.status !== "pending") return "already";
      if (action === "decline") {
        if (!store.initiatives.decide(id, "declined", reason)) return "already";
        void say(OWNER_CHAT, `Proposition refusée : « ${short(i.title, 120)} ». Je ne la referai pas.`, "system");
        return "done";
      }
      if (!store.initiatives.decide(id, "accepted")) return "already";
      // Une proposition d'équipe ou d'objectif lance l'équipe ou l'objectif (module d'autonomie).
      if (autonomy.launch) autonomy.launch(i);
      else void enqueue(OWNER_CHAT, i.action, "chat", `initiative:${i.title}`);
      return "done";
    },

    /**
     * Décision de l'utilisateur sur un brouillon : valider (rangé dans « à publier »), jeter, ou
     * faire refaire avec une consigne, qui part comme un nouveau message à Clark.
     */
    decidePost(id: number, action: "approve" | "reject" | "redo", feedback?: string): "done" | "already" | "missing_feedback" {
      const p = store.posts.get(id);
      if (!p || p.status !== "pending") return "already";
      if (action === "approve") {
        if (!store.posts.approve(id)) return "already";
        void say(OWNER_CHAT, `Validé : « ${short(p.title, 120)} » est rangé dans workspace/social/a-publier/, prêt à publier ou programmer dans ${platformName(p.platform)}.`, "system", p.task_id ?? undefined);
        return "done";
      }
      if (action === "reject") {
        if (!store.posts.decide(id, "rejected")) return "already";
        void say(OWNER_CHAT, `Contenu jeté : « ${short(p.title, 120)} ».`, "system", p.task_id ?? undefined);
        return "done";
      }
      const text = feedback?.trim();
      if (!text) return "missing_feedback";
      if (!store.posts.decide(id, "redo", text)) return "already";
      void enqueue(OWNER_CHAT, `Refais le contenu ${platformName(p.platform)} « ${p.title} » (brouillon #${p.id}, mêmes clips) avec cette retouche : ${text}`, "chat", "web");
      return "done";
    },

    questions(): Question[] {
      return store.questions.pending();
    },

    /** Réponse de l'utilisateur à une question d'agent. false si elle n'attend plus de réponse. */
    answerQuestion(id: number, answer: string): boolean {
      const text = answer.trim();
      if (!text) return false;
      const q = store.questions.get(id);
      if (!q || !store.questions.answer(id, text)) return false;
      void say(OWNER_CHAT, `Ta réponse${q.agent ? ` au ${q.agent}` : ""} : « ${short(text, 200)} »`, "system", q.task_id);
      return true;
    },

    /** false si la demande n'est plus en attente (déjà répondue, expirée, ou d'avant un redémarrage). */
    resolveApproval(id: string, ok: boolean): boolean {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.settle(ok, ok ? "ok" : "no");
      return true;
    },

    /** Boutons « Reprendre » / « Abandonner » d'une tâche à vérifier. Ils n'agissent qu'une fois. */
    resolveCheck(taskId: number, action: "resume" | "drop", chatId = OWNER_CHAT): "resumed" | "abandoned" | "already" {
      const task = journal.get(taskId);
      if (!task || task.status !== "needs_check" || task.chat_id !== chatId) return "already";
      if (action === "drop") {
        journal.setStatus(task.id, "abandoned");
        for (const c of journal.children(task.id)) if (c.status !== "done" && c.status !== "failed") journal.setStatus(c.id, "abandoned");
        void say(chatId, `Tâche abandonnée : « ${short(askedText(task.prompt))} ».`, "system", task.id);
        return "abandoned";
      }
      if (task.label === TEAM_LABEL) {
        journal.setStatus(task.id, "running"); // évite un double clic
        void say(chatId, `L'équipe reprend « ${short(askedText(task.prompt))} ». L'agent coupé vérifie d'abord ce qui a déjà été écrit.`, "system", task.id);
        runTeam(task);
        return "resumed";
      }
      journal.setStatus(task.id, "running"); // évite un double clic
      void say(chatId, `Je reprends « ${short(askedText(task.prompt))} » : d'abord une vérification en lecture seule, puis la suite.`, "system", task.id);
      // Vérification en lecture seule imposée par le moteur, puis reprise avec le droit d'écrire.
      schedule(task.chat_id, () => resumeVerified(execute, deps, journal.get(task.id)!, approverFor(task.chat_id, task.id)), task.id);
      return "resumed";
    },

    /**
     * Réponse de l'utilisateur à une proposition de souvenir. Corriger = confirmer avec son texte.
     * "already" si elle n'est plus en attente (double clic, autre onglet).
     */
    resolveMemory(
      id: number,
      action: "confirm" | "correct" | "ignore",
      correction?: { content?: string; expiresAt?: string | null },
    ): "confirmed" | "corrected" | "ignored" | "already" {
      const before = store.get(id);
      if (!before || before.status !== "proposed") return "already";
      if (action === "ignore") {
        if (!store.ignore(id)) return "already";
        void say(OWNER_CHAT, `Souvenir ignoré : « ${short(before.content, 120)} ».`, "system");
        return "ignored";
      }
      if (!store.confirm(id, action === "correct" ? correction : undefined)) return "already";
      const after = store.get(id)!;
      const corrected = after.original_content !== null;
      void say(OWNER_CHAT, `${corrected ? "Souvenir corrigé et confirmé" : "Souvenir confirmé"} : « ${short(after.content, 120)} ».`, "system");
      return corrected ? "corrected" : "confirmed";
    },

    /** Branche les règles d'autonomie (src/core/autonomy.ts). */
    setAutonomy(hooks: AutonomyHooks) {
      autonomy = hooks;
    },
    /** Un souvenir proposé ailleurs (Codex) : Clark peut-il le retenir seul ? */
    autoMemory: (m: Memory) => autonomy.memory?.(m) ?? false,

    newConversation(chatId = OWNER_CHAT, agent: string | null = null) {
      // La session de la conversation qu'on quitte est gardée avec elle : on pourra la reprendre.
      const before = conversation.current(chatId);
      const after = conversation.startNew(chatId, agent);
      if (after === before) {
        // Rien n'y a été écrit par l'utilisateur : elle resert, mais repart quand même d'un fil vierge.
        store.clearSession(chatId);
        changed();
        return Promise.resolve(null);
      }
      conversation.saveSession(before, store.getSession(chatId));
      store.clearSession(chatId);
      return say(chatId, NEW_CONVERSATION_NOTE, "system");
    },

    /**
     * Rouvre une conversation passée : sa session de l'agent revient, Clark reprend le fil.
     * Refusé pendant qu'une demande tourne : sa fin écrirait la session dans la mauvaise conversation.
     */
    /**
     * Ouvre la conversation avec un agent (null : Clark) : la plus récente, ou une neuve.
     * Même règle que pour changer de conversation : pas pendant qu'une demande tourne.
     */
    openAgent(agent: string | null, chatId = OWNER_CHAT): { result: "ok" | "busy"; id: number | null } {
      const latest = conversation.latestWith(chatId, agent);
      const current = conversation.current(chatId);
      if (latest === current) return { result: "ok", id: current };
      if (journal.unfinished().some((t) => t.chat_id === chatId && t.parent_id === null && t.label !== HEARTBEAT_LABEL)) return { result: "busy", id: latest };
      conversation.saveSession(current, store.getSession(chatId));
      if (latest === null) {
        const id = conversation.startNew(chatId, agent);
        store.clearSession(chatId);
        changed();
        return { result: "ok", id };
      }
      const target = conversation.conversation(latest)!;
      conversation.switchTo(chatId, latest);
      if (target.session_id) store.setSession(chatId, target.session_id);
      else store.clearSession(chatId);
      changed();
      return { result: "ok", id: latest };
    },

    markSeen(id: number) {
      conversation.markSeen(id);
      changed();
    },

    /** Renommer, épingler, supprimer une conversation de l'utilisateur (depuis l'interface). */
    editConversation(id: number, action: "rename" | "pin" | "unpin" | "delete", title = "", chatId = OWNER_CHAT): "ok" | "unknown" | "busy" | "invalid" {
      const c = conversation.conversation(id);
      if (!c || c.chat_id !== chatId) return "unknown";
      if (action === "rename") {
        if (!conversation.rename(id, title)) return "invalid";
      } else if (action === "pin" || action === "unpin") conversation.setPinned(id, action === "pin");
      else {
        // Une demande qui tourne dans cette conversation y écrira sa réponse : on attend qu'elle finisse.
        const busy = journal.unfinished().some((t) => t.chat_id === chatId && t.parent_id === null && t.label !== HEARTBEAT_LABEL && conversation.conversationOfTask(t.id) === id);
        if (busy) return "busy";
        if (conversation.current(chatId) === id) {
          // C'était l'ouverte : on retombe sur la dernière conversation avec le même interlocuteur, ou une neuve.
          conversation.saveSession(id, null);
          store.clearSession(chatId);
          conversation.remove(id);
          const next = conversation.latestWith(chatId, c.agent);
          if (next !== null) {
            conversation.switchTo(chatId, next);
            const target = conversation.conversation(next);
            if (target?.session_id) store.setSession(chatId, target.session_id);
          } else conversation.startNew(chatId, c.agent);
        } else conversation.remove(id);
      }
      changed();
      return "ok";
    },

    switchConversation(id: number, chatId = OWNER_CHAT): "ok" | "busy" | "unknown" {
      const before = conversation.current(chatId);
      if (id === before) return "ok";
      const target = conversation.conversation(id);
      if (!target || target.chat_id !== chatId || !conversation.hasContent(id)) return "unknown";
      if (journal.unfinished().some((t) => t.chat_id === chatId && t.parent_id === null && t.label !== HEARTBEAT_LABEL)) return "busy";
      conversation.saveSession(before, store.getSession(chatId));
      conversation.switchTo(chatId, id);
      if (target.session_id) store.setSession(chatId, target.session_id);
      else store.clearSession(chatId);
      changed();
      return "ok";
    },
  };
}
