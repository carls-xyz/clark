import type { LoginEngine, Logins } from "../engines/login.ts";
import type { Terminal } from "../terminal/terminal.ts";
import { attachmentContext, pickPath } from "../core/attachments.ts";
import { reviewNotes } from "../dev/binome.ts";

/**
 * Le coffre Obsidian branché à la mémoire : son état pour Réglages › Connexions, « Synchroniser »,
 * et « Écrire le journal du jour » (absent sans moteur Claude).
 */
export type ObsidianLink = {
  status: () => { vault: string | null; lastSync: string | null; error: string | null; notes: number };
  syncNow: () => void;
  writeJournal?: () => Promise<{ day: string } | { empty: true }>;
};
import { JournalError } from "../core/daily-journal.ts";
import { NEW_CONVERSATION_NOTE } from "../core/conversation.ts";
import { CONTACTS, isConversationAgent } from "../core/contacts.ts";
import { canActAlone, decisionsOf, isAutonomous, maxPerDay, parisDayStart, undoDecision } from "../core/autonomy.ts";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { OWNER_CHAT, type Hub } from "../core/hub.ts";
import { optionsOf } from "../core/questions.ts";
import { hashtagsOf } from "../social/posts.ts";
import { PLATFORMS, platformName } from "../social/platforms.ts";
import { heartbeatStatus, runHeartbeatNow } from "../scheduler/heartbeat.ts";
import { nextRunText, scheduleText, type AutomationInput } from "../scheduler/automations.ts";
import { inThread, noteCategory } from "../core/thread.ts";
import { platformInfo } from "../core/platform.ts";
import { cachedHealth, type HealthReport } from "../core/health.ts";
import { paths } from "../config.ts";
import { CATEGORY_LABEL, DECLINE_KINDS, type DeclineKind } from "../core/initiatives.ts";
import { verdictOf } from "../core/initiative-loop.ts";
import { accessRules, refusal, tailscaleInfo } from "./access.ts";
import type { Message } from "../core/conversation.ts";
import { launchAutomation } from "../scheduler/automation-run.ts";
import { TEAM_LABEL } from "../core/team.ts";
import { describeStep, uncertainSteps } from "../tasks/journal.ts";
import { teamView } from "./team-view.ts";
import { HEARTBEAT_LABEL } from "../scheduler/heartbeat.ts";
import { addIdeaFromOwner, decideIdea, ideasHour, ideasTourStatus, runIdeasTourNow, type IdeaAction } from "../scheduler/ideas.ts";
import { IDEA_DIG_LABEL, IDEAS_TOUR_LABEL, SITES_PER_TOUR } from "../core/ideas.ts";
import type { Task } from "../tasks/journal.ts";
import { hasVar, type McpInput } from "../mcp/servers.ts";
import { sandboxEnabled } from "../engines/sandbox.ts";
import { compareDevTask, keepComparedTask, startDevCompare, type CompareSide } from "../dev/compare.ts";
import { designDir, type PreviewService } from "../dev/preview.ts";
import { acceptDevTask, addProject, cancelWaitingTurn, dependsOn, devPatch, discardDevTask, isWaitingSlot, maxParallel, readDesignPick, retouchDevTask, resumeDevTask, unblockDevTask, blockedNeed, retryDevTask, restoreDevRound, runDevTests, sendReviewComments, startDevTask, type DevOutcome, prewarmCopy } from "../dev/runner.ts";
import { discardGroup, integrateGroup, openPullRequest, prDraft, resolveGate, startDevGroup } from "../dev/groups.ts";
import { canStop } from "../core/stops.ts";
import { fixPr, markPrSeen, refreshPr, type PrStatus } from "../dev/pr.ts";
import { issueInstruction, listIssues, readIssue } from "../dev/issues.ts";
import { validateCopyPaths } from "../dev/project-setup.ts";
import { applyImport, exportConfig, planImport } from "../core/config-export.ts";
import { DEV_REVIEW_PREFIX, devOfLabel, devPlanOfLabel } from "../dev/store.ts";
import type { Store } from "../memory/store.ts";
import type { DevTask } from "../dev/store.ts";
import { probeMcp } from "../mcp/probe.ts";
import { controlGoal, createGoal } from "../scheduler/goals.ts";
import { submitRequest } from "../core/submit.ts";
import { deleteCommand, listCommands, listSkills, saveCommand, validateCommand, type CommandMode } from "../skills/library.ts";
import { DEFAULT_MAX_TURNS, MAX_TURNS_LIMIT } from "../core/goals.ts";
import { PERSONALITY_LIMIT, readPersonality, savePersonality } from "../core/personality.ts";
import { frenchVoices, resolveVoice, speak, transcribe, voiceStatus } from "../voice/voice.ts";
import { BROWSER_ACTIONS, BROWSER_WRITES, VISION_ACTIONS, VISION_WRITES, type BrowserAction, type BrowserService, type VisionAction } from "../browser/service.ts";
import { browserJournal } from "../browser/journal.ts";
import { rulesView, TRUST_LIST_ENABLED } from "../browser/sensitive.ts";
import { isInternal } from "../core/internal.ts";
import { READ_ONLY_REFUSAL } from "../policy/permissions.ts";
import type { MessagesService } from "../imessage/service.ts";
import type { Plugins, Review } from "../plugins/plugins.ts";
import type { Settings } from "../core/settings.ts";
import { awakeActive, heldCount, NOTIFY_KINDS, notifyPrefs, type NotifyStore } from "../core/notify.ts";

/** Aperçu d'un message dans la liste : le texte seul, sans la mise en forme markdown. */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/^\s*(#+|[-•>]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Connexion des moteurs par un bouton (absente dans les tests qui ne la fournissent pas). */
export type EngineLogin = { logins: Logins; readyAtStart: Record<LoginEngine, boolean>; restart: (() => void) | null };

/** Ce dont l'interface a besoin pour la voix (remplaçable dans les tests). */
export type WebVoice = {
  status: typeof voiceStatus;
  transcribe: (file: string, vocabulary?: string) => Promise<string>;
  speak: (text: string, voice: string, format: "m4a", dest: string) => Promise<string>;
  voices: () => Promise<string[]>;
};
const realVoice: WebVoice = { status: voiceStatus, transcribe, speak, voices: frenchVoices };
/** Un enregistrement du micro : 10 Mo au plus (bien plus que 10 minutes en opus). */
const AUDIO_LIMIT = 10 * 1024 * 1024;
const AUDIO_TYPES: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-m4a": "m4a" };
const VOICE_SAMPLE = "Salut, c'est Clark. Voilà ma voix.";

export { NEW_CONVERSATION_NOTE };
export function sinceNewConversation<T extends { role: string; text: string }>(list: T[]): T[] {
  const cut = list.findLastIndex((m) => m.role === "system" && m.text === NEW_CONVERSATION_NOTE);
  return cut < 0 ? list : list.slice(cut + 1);
}

/** Ce que la tâche était, en clair : le titre de la tâche dev, l'objectif, ou la demande. */
/** Minuscules, sans accents : « tache » trouve « Tâche ». */
export const foldText = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Chaque mot cherché doit apparaître, dans n'importe quel ordre (un pluriel trouve aussi le singulier). */
export function matchesQuery(text: string, query: string): boolean {
  const hay = foldText(text);
  return foldText(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w) || (w.length > 3 && w.endsWith("s") && hay.includes(w.slice(0, -1))));
}

export function historyTitle(t: Pick<Task, "label" | "prompt"> & { id?: number; source?: string | null }, store?: Store): string {
  if (t.label === HEARTBEAT_LABEL) return "Tour de veille";
  if (t.label === IDEAS_TOUR_LABEL) return "Tour d'idées";
  if (t.label === IDEA_DIG_LABEL) return `Idée à creuser : ${t.prompt.match(/\nTitre : (.*)/)?.[1] ?? ""}`.trim();
  // Une proposition acceptée, une automatisation : leur nom, pas la consigne envoyée à l'agent.
  const src = t.source ?? "";
  if (src.startsWith("initiative:")) return src.slice(11);
  if (src.startsWith("automation:")) return src.slice(11);
  // Une demande de l'utilisateur : ce qu'il a écrit (le fil le garde), pas le contexte ajouté pour l'agent.
  if (store && t.id !== undefined && (t.label === "chat" || t.label === TEAM_LABEL || t.label === "groupe")) {
    const said = store.db.prepare("SELECT text FROM messages WHERE task_id = ? AND role = 'user' ORDER BY id LIMIT 1").get(t.id) as { text: string } | undefined;
    if (said?.text.trim()) return said.text.replace(/\s+/g, " ").trim();
  }
  const asked = t.prompt.match(/\nMessage de Charles : «?\s*([\s\S]+?)\s*»?\s*$/);
  if (asked) return asked[1].replace(/\s+/g, " ").trim();
  if (t.label === "brief") return "Brief du matin";
  if (t.label === "bilan") return "Bilan des propositions";
  const goal = t.prompt.match(/tour (\d+) sur \d+\]\nObjectif de Charles : (.*)/);
  if (goal) return `Tour ${goal[1]} · ${goal[2]}`;
  const dev = devOfLabel(t.label);
  if (dev) {
    const title = store?.dev.get(dev)?.title ?? `tâche #${dev}`;
    const kind = /^Retouche demandée/.test(t.prompt)
      ? "Retouche"
      : /^Charles est revenu/.test(t.prompt)
        ? "Reprise depuis un tour précédent"
        : /^Relecture de Charles/.test(t.prompt)
          ? "Commentaires de relecture"
          : "Première version";
    return `${kind} · ${title}`;
  }
  const plan = devPlanOfLabel(t.label);
  if (plan) return `Plan du groupe · ${store?.dev.group(plan)?.title ?? `#${plan}`}`;
  // Une consigne interne commence par un en-tête entre crochets : on garde la première vraie ligne.
  const lines = t.prompt.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => !/^\[.*\]$/.test(l)) ?? lines[0] ?? "";
  return first.replace(/^\[[^\]]*\]\s*/, "");
}

/** D'où vient une tâche, en clair, pour l'historique. */
export function originOf(t: Pick<Task, "label" | "chat_id"> & { source?: string | null }, store?: Store): string {
  const dev = devOfLabel(t.label);
  if (dev) return `Dev · ${store?.dev.project(store.dev.get(dev)?.project_id ?? 0)?.name ?? "projet"}`;
  if (devPlanOfLabel(t.label)) return "Dev · plan";
  if (t.label === HEARTBEAT_LABEL) return "Tour de veille";
  if (t.label === IDEAS_TOUR_LABEL || t.label === IDEA_DIG_LABEL) return "Idées";
  if (t.label === "brief") return "Brief du matin";
  if (t.label === "bilan") return "Bilan des propositions";
  const src = t.source ?? "";
  if (src.startsWith("automation:")) return `Automatisation « ${src.slice(11)} »`;
  if (src.startsWith("initiative:")) return "Proposition acceptée";
  if (t.label.startsWith("goal:")) return `Objectif #${t.label.slice(5)}`;
  if (src === "telegram") return "Toi, sur Telegram";
  if (src === "imessage") return "Toi, sur iMessage";
  if (src === "cli") return "Toi, dans le terminal";
  if (src === "web") return "Toi";
  if (src === "clark") return "Clark";
  return t.label === "chat" || t.label === TEAM_LABEL ? "Toi" : t.label;
}

const PUBLIC = resolve(import.meta.dirname, "../web");
/**
 * Le script de l'interface : les fichiers de src/web/app/ (00-base.js, 01-conversation.js…) mis
 * bout à bout dans l'ordre de leur nom. Ils partagent la même portée, comme un seul fichier :
 * pas d'étape de compilation, et le découpage ne change rien à ce que fait la page.
 */
export function appScript(): string {
  const dir = resolve(PUBLIC, "app");
  return readdirSync(dir)
    .filter((f) => /^\d{2}-[\w-]+\.js$/.test(f))
    .sort()
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("");
}

const STATIC: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/theme.js": ["theme.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
};
const BODY_LIMIT = 64 * 1024;

/**
 * Les composants accessibles de ui-sdk (Vercel), servis par Clark lui-même : la CSP reste
 * 'self'. Le paquet en fournit une version navigateur autonome, chargée composant par
 * composant. Seuls ses .js et .css, sans sortir de son dossier.
 */
const UI_ROOT = resolve(import.meta.dirname, "../../node_modules/@ui-sdk/web/browser");
function uiFile(path: string): [file: string, type: string] | null {
  const rel = decodeURIComponent(path.slice("/ui/".length));
  if (!/^[\w./-]+\.(js|css)$/.test(rel) || rel.split("/").includes("..")) return null;
  const file = resolve(UI_ROOT, rel);
  if (!file.startsWith(UI_ROOT + "/") || !existsSync(file)) return null;
  return [file, rel.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8"];
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** L'état d'une PR tel que l'interface le montre (commentaires nouveaux comptés). */
const prView = (s: PrStatus) => ({
  state: s.state,
  draft: s.draft,
  number: s.number,
  reviewDecision: s.reviewDecision,
  checks: s.checks,
  comments: s.comments.slice(-20),
  fresh: s.comments.filter((c) => !s.seen.includes(c.id)).length,
  readAt: s.readAt,
  error: s.error,
});

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** Ce que l'interface affiche, reconstruit depuis la base et le hub à chaque changement. */
export function snapshot(hub: Hub, opts: { remote?: unknown; health?: () => HealthReport; demo?: boolean; voice?: WebVoice; voices?: string[]; browser?: BrowserService; messages?: MessagesService; plugins?: Plugins; settings?: Settings; preview?: PreviewService; engineLogin?: EngineLogin; terminal?: Terminal; obsidian?: ObsidianLink } = {}) {
  const { config, store, journal, conversation } = hub.deps;
  const loginView = (name: LoginEngine, ready: boolean | null) => {
    const l = opts.engineLogin?.logins.list().find((x) => x.engine === name);
    if (!l) return null;
    // Connecté et relu : l'encart s'efface (le bloc du moteur suffit).
    if (l.status === "done" && ready) {
      opts.engineLogin!.logins.clear(name);
      return null;
    }
    return { status: l.status, url: l.url, asksCode: l.asksCode, codeSent: l.codeSent, error: l.error };
  };
  const mine = <T extends { chat_id: number }>(list: T[]) => list.filter((t) => t.chat_id === OWNER_CHAT);
  // Une tâche dev telle que l'interface la montre (seule ou dans un groupe).
  const devTaskView = (t: DevTask) => {
    const run = journal.lastByLabel(`dev:${t.id}`);
    return {
      id: t.id,
      project: store.dev.project(t.project_id)?.name ?? "?",
      title: t.title,
      instruction: t.instruction,
      engine: t.engine,
      branch: t.branch,
      status: t.status,
      error: t.error,
      blockedOn: t.status === "failed" && t.blocked_on ? blockedNeed(t.blocked_on) : null,
      summary: t.summary,
      diff: t.diff_stat ? JSON.parse(t.diff_stat) : null,
      commit: t.commit,
      tests: t.tests ? JSON.parse(t.tests) : null,
      rounds: t.rounds,
      pr: t.pr_url,
      at: t.created_at,
      // En attente d'un agent libre (pas plus de maxParallel() à la fois).
      waiting: t.status === "working" && isWaitingSlot(t.id),
      // Ce que l'agent fait en ce moment (dernières étapes), pendant qu'il travaille.
      steps: t.status === "working" && run ? journal.recentSteps(run.id, 5).map((s) => ({ id: s.id, effect: s.effect, status: s.status, text: describeStep(s) })) : [],
      checkpoint: t.status === "working" ? (run?.checkpoint ?? null) : null,
      dependsOn: dependsOn(t),
      setup: t.setup_log ? JSON.parse(t.setup_log) : null,
      // Points de reprise : un par tour ; atRound = le tour dont la copie a l'état (null : le dernier).
      checkpoints: store.dev.checkpoints(t.id).map((c) => ({ round: c.round, summary: c.summary ? c.summary.split("\n").find((l) => l.trim())?.slice(0, 160) ?? "" : "", diff: c.diff_stat ? JSON.parse(c.diff_stat) : null, at: c.created_at })),
      atRound: t.at_round,
      comments: store.dev.comments(t.id).map((c) => ({ id: c.id, file: c.file, side: c.side, start: c.line_start, end: c.line_end, snippet: c.snippet, body: c.body, status: c.status, sent: c.sent_round })),
      issue: t.issue_number ? { number: t.issue_number, url: t.issue_url } : null,
      prOf: t.pr_of,
      onPrBranch: t.existing_branch === 1,
      prStatus: t.pr_status && !t.pr_of ? prView(JSON.parse(t.pr_status)) : null,
      followUps: t.pr_url && !t.pr_of ? store.dev.followUps(`task:${t.id}`).map((f) => ({ id: f.id, title: f.title, status: f.status })) : [],
      attempts: t.attempts ?? 1,
      compareWith: t.compare_with,
      // Binôme : qui relit, combien de tours, où ça en est (et si le relecteur lit en ce moment).
      reviewer: t.reviewer,
      reviewRounds: t.review_rounds,
      reviewState: t.review_state,
      reviewing: Boolean(t.reviewer) && t.status === "working" && journal.unfinished().some((x) => x.label === `${DEV_REVIEW_PREFIX}${t.id}`),
      reviewNotes: reviewNotes(t),
      autopilot: Boolean(t.autopilot) || Boolean(t.group_id && store.dev.group(t.group_id)?.autopilot),
      model: t.model,
      effort: t.effort,
      // Silencieux depuis (ms), si l'agent ne donne plus signe de vie ; et s'il peut être arrêté.
      stalledSince: t.status === "working" && run ? (hub.stalled().find((x) => x.taskId === run.id)?.since ?? null) : null,
      // La machine a dormi depuis la dernière activité de l'agent (minutes) : il reprend à son réveil.
      sleptMinutes: t.status === "working" && run && run.status === "running" ? Math.floor(hub.sleptSinceActivity(run.id) / 60_000) || null : null,
      stoppable: t.status === "working" && (isWaitingSlot(t.id) || (run ? canStop(run.id) : false)),
    };
  };
  return {
    clark: {
      engine: hub.engine(),
      roleEngines: hub.roleEngines(),
      model: hub.engine().model,
      hasApiKey: config.hasApiKey,
      telegram: Boolean(config.telegram),
      demo: Boolean(opts.demo),
      // Démo : un plugin d'exemple à relire, dans un dossier temporaire.
      demoPlugin: opts.demo ? (process.env.CLARK_DEMO_PLUGIN ?? null) : null,
      demoCatalog: opts.demo ? (process.env.CLARK_DEMO_CATALOG ?? null) : null,
    },
    // « Nouvelle conversation » : l'écran repart de zéro (les demandes passées restent dans Activité).
    // La conversation ouverte (sans la note qui l'a commencée), et la liste de toutes pour la barre de gauche.
    conversationId: conversation.current(OWNER_CHAT),
    conversationAgent: conversation.conversation(conversation.current(OWNER_CHAT))?.agent ?? null,
    conversations: conversation.list(OWNER_CHAT, 50).map((c) => ({ ...c, preview: c.preview ? short(plainPreview(c.preview), 120) : null })),
    obsidian: opts.obsidian?.status() ?? { vault: null, lastSync: null, error: null, notes: 0 },
    // Terminal (Mac seulement) : le dossier, s'il tourne, et les commandes que Clark propose.
    terminal: opts.terminal
      ? {
          cwd: opts.terminal.cwd,
          running: opts.terminal.running()?.id ?? null,
          pending: store.terminal.pending().map((r) => ({ id: r.id, taskId: r.task_id, command: r.command, cwd: r.cwd, reason: r.reason, at: r.created_at })),
        }
      : null,
    // Ce que Clark a décidé seul, avec de quoi annuler, et ce qu'il peut encore décider aujourd'hui.
    decisions: decisionsOf(store.db).recent(30),
    autonomy: {
      veille: isAutonomous("veille"),
      lancer: isAutonomous("lancer"),
      souvenir: isAutonomous("souvenir"),
      today: decisionsOf(store.db).since(parisDayStart()).length,
      max: maxPerDay(),
      now: canActAlone(decisionsOf(store.db)),
    },
    // L'équipe comme contacts : chacun avec sa conversation la plus récente.
    contacts: CONTACTS.map((c) => ({ role: c.role, name: c.name, badge: c.badge, mission: c.mission, access: c.access, latest: conversation.latestWith(OWNER_CHAT, c.role) })),
    // Ta conversation : toi, Clark, et les notes de vos échanges. Le reste est dans « notes » (Activité).
    messages: threadMessages(hub, conversation.messagesOf(conversation.current(OWNER_CHAT), 200)).map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      taskId: m.task_id,
      source: m.source,
      kind: m.kind,
      agent: m.agent ?? null,
      at: m.created_at,
    })),
    notes: activityNotes(hub),
    running: mine(journal.unfinished()).map((t) => ({
      id: t.id,
      parentId: t.parent_id,
      label: t.label,
      prompt: short(t.prompt, 160),
      status: t.status,
      checkpoint: t.checkpoint,
      steps: journal.recentSteps(t.id, 6).map((s) => ({ id: s.id, effect: s.effect, status: s.status, text: describeStep(s) })),
      team: t.label === TEAM_LABEL ? teamView(journal, t, hub.engineFor) : null,
    })),
    questions: hub.questions().map((q) => ({ id: q.id, taskId: q.task_id, agent: q.agent, question: q.question, options: optionsOf(q), at: q.created_at })),
    approvals: hub.approvals(OWNER_CHAT).map((a) => ({ id: a.id, taskId: a.taskId, tool: a.tool, summary: a.summary, agent: a.agent ?? null, expiresAt: a.expiresAt })),
    checks: mine(journal.awaitingCheck()).map((t) => ({
      id: t.id,
      prompt: short(historyTitle(t, store), 160),
      at: t.updated_at,
      // Pour une équipe, l'écriture incertaine est celle de l'agent coupé.
      uncertain: (t.label === TEAM_LABEL ? journal.children(t.id).flatMap((c) => uncertainSteps(journal.steps(c.id))) : uncertainSteps(journal.steps(t.id))).map(
        describeStep,
      ),
      team: t.label === TEAM_LABEL ? teamView(journal, t, hub.engineFor) : null,
    })),
    proposals: store.proposals().map((m) => ({
      id: m.id,
      kind: m.kind,
      content: m.content,
      source: m.source,
      at: m.created_at,
      expiresAt: m.expires_at,
      replaces: m.replaces_id !== null ? { id: m.replaces_id, content: m.replaces_content } : null,
      task: m.source_task_id !== null ? short(journal.get(m.source_task_id)?.prompt ?? "", 120) : null,
    })),
    memory: {
      count: store.count(),
      top: store.top(8).map((m) => ({
        id: m.id,
        kind: m.kind,
        content: m.content,
        source: m.source,
        confirmedAt: m.confirmed_at,
        expiresAt: m.expires_at,
        corrected: m.original_content !== null,
      })),
    },
    budget: { spent: store.spentToday(), max: config.maxUsdPerDay, perTask: config.maxUsdPerTask },
    quota: hub.quota(),
    // Moteurs : connexion, quota, modèles proposés et choix en cours, pour chacun.
    engines: (["claude", "codex"] as const)
      .map((name) => {
        const conn = hub.connection(name);
        const cat = hub.catalog(name);
        if (!conn && !cat) return null;
        const choice = hub.choice(name);
        return {
          name,
          main: name === config.engine,
          ready: conn?.ready ?? null,
          account: conn?.account ?? null,
          problem: conn?.problem ?? null,
          quota: hub.quotaOf(name),
          models: cat?.catalog?.models ?? [],
          modelsError: cat?.error ?? null,
          choice,
          // Ce qui tourne si rien n'est choisi : .env, sinon le défaut du moteur.
          fallbackModel: name === "claude" ? config.model : config.codexModel,
          // Connexion par le bouton : où elle en est, et si Clark doit redémarrer pour s'en servir.
          login: loginView(name, conn?.ready ?? null),
          restartNeeded: Boolean(opts.engineLogin && conn?.ready && !opts.engineLogin.readyAtStart[name]),
          canRestart: Boolean(opts.engineLogin?.restart),
        };
      })
      .filter(Boolean),
    // Skills (lus dans skills/ et ~/.claude/skills) et commandes perso (commands/).
    skills: listSkills().map((s) => ({ name: s.name, description: s.description, source: s.source, plugin: s.plugin ?? null })),
    commands: listCommands().map((c) => ({ name: c.name, description: c.description, mode: c.mode, prompt: c.prompt, plugin: c.plugin ?? null })),
    // Objectifs : où en est chacun, et son journal de tours.
    goals: store.goals.list().map((g) => ({
      id: g.id,
      objective: g.objective,
      status: g.status,
      reason: g.reason,
      turns: g.turns,
      maxTurns: g.max_turns,
      summary: g.summary,
      at: g.created_at,
      updated: g.updated_at,
      running: journal.unfinished().some((t) => t.label === `goal:${g.id}`),
      events: store.goals.events(g.id, 20).map((e) => ({ turn: e.turn, kind: e.kind, text: e.text, next: e.next_step, at: e.created_at })),
    })),
    // Serveurs MCP ajoutés : ce qu'ils lancent, les variables attendues (présentes ou non, jamais leur valeur).
    // Côté dev : tes projets, et les tâches dans leurs copies du dépôt.
    dev: {
      projects: store.dev.projects().map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        base: p.base_branch,
        test: p.test_command,
        engine: p.default_engine,
        model: p.default_model,
        effort: p.default_effort,
        setup: p.setup_command,
        copy: p.copy_paths ? JSON.parse(p.copy_paths) : [],
        preview: { command: p.preview_command, path: p.preview_path },
      })),
      parallel: maxParallel(),
      // Mode design : l'aperçu ouvert (une tâche à la fois).
      preview: opts.preview?.state() ?? null,
      groups: store.dev.groups().map((g) => ({
        mode: g.mode,
        planNote: g.plan_note,
        autopilot: Boolean(g.autopilot),
        id: g.id,
        project: store.dev.project(g.project_id)?.name ?? "?",
        title: g.title,
        instruction: g.instruction,
        engine: g.engine,
        status: g.status,
        error: g.error,
        branch: g.branch,
        commit: g.commit_sha,
        pr: g.pr_url,
        at: g.created_at,
        tasks: store.dev.groupTasks(g.id).map(devTaskView),
        issue: g.issue_number ? { number: g.issue_number, url: g.issue_url } : null,
        prStatus: g.pr_status ? prView(JSON.parse(g.pr_status)) : null,
        followUps: g.pr_url ? store.dev.followUps(`group:${g.id}`).map((f) => ({ id: f.id, title: f.title, status: f.status })) : [],
        gates: store.dev.gates(g.id).map((x) => ({ id: x.id, question: x.question, options: x.options, tasks: x.task_ids, resolution: x.resolution })),
      })),
      tasks: store.dev.list().map(devTaskView),
    },
    // Agents silencieux : à arrêter ou à laisser finir (« À toi »).
    stalled: hub.stalled().map((x) => {
      const t = journal.get(x.taskId);
      const dev = t ? devOfLabel(t.label) : null;
      return { taskId: x.taskId, since: x.since, stoppable: x.stoppable, dev, title: dev ? (store.dev.get(dev)?.title ?? "") : short(t?.prompt.replace(/\s+/g, " ") ?? "", 120) };
    }),
    // Décisions demandées par un plan dev.
    gates: store.dev.openGates().map((x) => ({ id: x.id, group: x.group_id, groupTitle: store.dev.group(x.group_id)?.title ?? "", question: x.question, options: x.options, tasks: x.task_ids })),
    // Le navigateur de Clark : où il en est, et sa dernière capture (servie à part).
    // L'état du navigateur inclut le shotId et le journal vision, sans les octets de la capture.
    browser: opts.browser?.state() ?? null,
    // iMessage : accès à la base de Messages, et canal (ta conversation avec toi-même).
    imessage: opts.messages?.status() ?? null,
    // Le système où tourne Clark, et ce qui y manque hors Mac (iMessage, fenêtre de choix…).
    system: platformInfo(),
    // Accès depuis le téléphone (Tailscale) : adresses autorisées, comptes, et ce que Tailscale dit de cette machine.
    remote: opts.remote ?? null,
    // Page Santé : le rapport (gardé 20 s, relu à la demande avec « Actualiser »).
    health: opts.health?.() ?? null,
    // Réglages modifiables (sans secrets), et notifications.
    settings: opts.settings?.view() ?? null,
    notify: { prefs: notifyPrefs(), kinds: NOTIFY_KINDS, awake: awakeActive(), held: heldCount() },
    // Plugins installés (la relecture d'un paquet passe par /api/plugins/review, hors du flux).
    plugins: opts.plugins?.list() ?? null,
    // Personnalité (écrite par l'utilisateur) et voix (transcription locale, voix macOS).
    personality: { ...readPersonality(), limit: PERSONALITY_LIMIT },
    voice: (() => {
      const st = (opts.voice ?? realVoice).status();
      const voices = opts.voices ?? [];
      return { ...st, mode: store.voice.mode(), voice: voices.length ? resolveVoice(store.voice.voice(), voices) : store.voice.voice(), voices, vocabulary: store.voice.vocabulary() };
    })(),
    // Bac à sable des commandes du moteur Claude (celui de Codex est toujours actif).
    sandbox: sandboxEnabled(),
    mcp: store.mcp.list().map((m) => ({
      id: m.id,
      name: m.name,
      transport: m.transport,
      command: m.command,
      args: m.args,
      url: m.url,
      vars: [...m.envVars, ...(m.tokenVar ? [m.tokenVar] : [])].map((v) => ({ name: v, set: hasVar(v), token: v === m.tokenVar })),
      trust: m.trust,
      enabled: m.enabled,
      check: m.check,
    })),
    // Mail et agenda : la connexion Google, et les mails qui attendent ton accord, en entier.
    google: (() => {
      const g = hub.google();
      return { configured: g.configured, connected: g.connected, email: g.email, missingScopes: g.missingScopes.length > 0 };
    })(),
    mails: hub.mails().map((m) => ({ id: m.id, to: m.to_addr, cc: m.cc, subject: m.subject, body: m.body, reply: Boolean(m.thread_id), at: m.created_at })),
    // Tour de veille : ses propositions en attente, et où il en est.
    initiatives: hub.initiatives().map((i) => ({ id: i.id, title: i.title, why: i.why, action: i.action, source: i.source, at: i.created_at, category: i.category, success: i.success })),
    // Boucle d'initiatives : ton avis attendu, le parcours des dernières, et le bilan par catégorie (30 jours).
    initiativeLoop: {
      feedback: store.initiatives.awaitingFeedback().map((i) => ({ id: i.id, title: i.title, success: i.success, outcome: i.outcome, note: i.outcome_note, at: i.outcome_at })),
      recent: store.initiatives.recent(10).map((i) => ({ id: i.id, title: i.title, category: i.category, status: i.status, auto: i.auto === 1, declineKind: i.decline_kind, outcome: i.outcome, note: i.outcome_note, feedback: i.feedback, at: i.created_at, taskId: i.exec_task_id, goalId: i.exec_goal_id })),
      stats: store.initiatives.stats(30).map((c) => ({ ...c, label: CATEGORY_LABEL[c.category], verdict: verdictOf(c) })),
    },
    heartbeat: (() => {
      const s = heartbeatStatus(hub);
      return { minutes: config.heartbeatMinutes, why: s.why, next: s.next };
    })(),
    // Idées : la page Idées (tour d'idées, idées lancées par Charles, recherches de Clark).
    ideas: store.ideas.list().map((i) => ({
      id: i.id,
      title: i.title,
      kind: i.kind,
      pitch: i.pitch,
      why: i.why,
      origin: i.origin,
      sourceUrl: i.source_url,
      sourceLabel: i.source_label,
      status: i.status,
      verdict: i.verdict,
      report: i.report,
      dropReason: i.drop_reason,
      at: i.created_at,
      updated: i.updated_at,
    })),
    ideasTour: (() => {
      const s = ideasTourStatus(hub);
      return { hour: ideasHour(), why: s.why, running: hub.deps.journal.unfinished().some((t) => t.label === IDEAS_TOUR_LABEL), sources: { projet: store.ideas.sources("projet"), design: store.ideas.sources("design") }, next: store.ideas.nextSites(), perTour: SITES_PER_TOUR };
    })(),
    // Réseaux sociaux : brouillons à valider, avec leurs vérifications, et derniers contenus validés.
    posts: hub.posts().map((p) => ({
      id: p.id,
      platform: platformName(p.platform),
      title: p.title,
      caption: p.caption,
      hashtags: hashtagsOf(p),
      duration: p.duration,
      media: `/media/posts/${p.id}`,
      checks: PLATFORMS[p.platform]?.checks(p) ?? [],
    })),
    published: store.posts.approved(5).map((p) => ({
      id: p.id,
      platform: platformName(p.platform),
      title: p.title,
      media: `/media/posts/${p.id}`,
      file: p.export_path,
      at: p.decided_at,
    })),
    // Calendrier des veilles : de quoi afficher le nombre sur l'icône (les comptes rendus se lisent à part).
    calendar: { recent: calendarRecent(hub), automations: store.automations.list().filter((a) => a.thread === "calendar").length, brief: hub.deps.config.briefHour, ideasHour: ideasHour() },
    automations: store.automations.list().map((a) => {
      const last = a.last_task_id ? journal.get(a.last_task_id) : undefined;
      return {
        id: a.id,
        name: a.name,
        prompt: a.prompt,
        team: a.team === 1,
        enabled: a.enabled === 1,
        schedule: scheduleText(a),
        next: nextRunText(a, new Date()),
        last: last ? { taskId: last.id, status: last.status, at: last.created_at } : null,
        kind: a.kind,
        project: a.project_id ? (store.dev.project(a.project_id)?.name ?? "?") : null,
        engine: a.engine,
        model: a.model,
        effort: a.effort,
        precheck: a.precheck,
        thread: a.thread,
        // Les dernières exécutions : lancée (avec l'état de sa tâche), sautée, en échec.
        runs: store.automations.runs(a.id, 6).map((r) => ({
          id: r.id,
          at: r.created_at,
          manual: r.manual === 1,
          status: r.status,
          note: r.note,
          task: r.task_id ? (journal.get(r.task_id)?.status ?? null) : null,
          taskId: r.task_id,
          dev: r.dev_task_id ? { id: r.dev_task_id, status: store.dev.get(r.dev_task_id)?.status ?? null } : null,
        })),
      };
    }),
  };
}

/**
 * Vidéo d'un brouillon, avec la lecture par morceaux (en-tête Range) dont Safari a
 * besoin pour lire et avancer dans une vidéo. Seuls les fichiers des brouillons sont servis.
 */
/** Ce que le calendrier range, en plus des automatisations : le brief du matin et le tour d'idées. */
const CALENDAR_TASKS: Record<string, string> = { brief: "Brief du matin", idees: "Tour d'idées", bilan: "Bilan des propositions" };

/**
 * Un mois du calendrier (« AAAA-MM ») : les exécutions des automatisations rangées dans
 * le calendrier, les briefs du matin et les tours d'idées, avec leur état et leur compte
 * rendu. Les dates sont en UTC : on prend un jour de marge de chaque côté, l'interface
 * range par jour en heure de Paris.
 */
export function calendarMonth(hub: Hub, month: string) {
  const { store, journal } = hub.deps;
  const [y, m] = month.split("-").map(Number);
  const iso = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  const from = iso(new Date(Date.UTC(y, m - 1, 0)));
  const to = iso(new Date(Date.UTC(y, m, 2)));
  const ofTask = (taskId: number | null) => {
    const t = taskId ? journal.get(taskId) : undefined;
    const said = t ? journal.outcome(t.id) : null;
    const quiet = said?.outcome === "quiet";
    return {
      t,
      quiet,
      note: quiet ? "Rien de neuf." : said?.outcome === "failed" ? (said.note ?? "Pas abouti.") : null,
      report: t && !quiet ? (t.result ?? "").trim() || null : null,
    };
  };
  const automations = store.automations.calendarRuns(from, to).map((r) => {
    const x = ofTask(r.task_id);
    return {
      key: `a${r.id}`,
      kind: "automation" as const,
      name: r.name,
      at: r.created_at,
      manual: r.manual === 1,
      // started (en cours ou faite, voir task), skipped (rien de neuf, pré-vérification), failed.
      status: x.quiet ? "skipped" : r.status,
      note: r.note ?? x.note,
      task: x.t ? x.t.status : null,
      taskId: r.task_id,
      report: x.report,
      ideas: [] as { id: number; title: string; kind: string; status: string }[],
    };
  });
  const tasks = (
    store.db
      .prepare(`SELECT id, label, created_at FROM tasks WHERE label IN (${Object.keys(CALENDAR_TASKS).map(() => "?").join(", ")}) AND parent_id IS NULL AND created_at >= ? AND created_at < ?`)
      .all(...Object.keys(CALENDAR_TASKS), from, to) as { id: number; label: string; created_at: string }[]
  ).map((row) => {
    const x = ofTask(row.id);
    // Tour d'idées : les idées qu'il a notées, pour les retrouver dans la page Idées.
    const ideas = row.label === "idees" ? (store.db.prepare("SELECT id, title, kind, status FROM ideas WHERE task_id = ? ORDER BY id").all(row.id) as { id: number; title: string; kind: string; status: string }[]) : [];
    return {
      key: `t${row.id}`,
      kind: row.label === "brief" ? ("brief" as const) : row.label === "bilan" ? ("bilan" as const) : ("ideas" as const),
      name: CALENDAR_TASKS[row.label],
      at: row.created_at,
      manual: false,
      status: x.quiet && !ideas.length ? "skipped" : "started",
      note: x.note,
      task: x.t?.status ?? null,
      taskId: row.id,
      report: x.report,
      ideas,
    };
  });
  const runs = [...automations, ...tasks].sort((a, b) => a.at.localeCompare(b.at));
  return { month, runs };
}

/** Dates des derniers éléments du calendrier, pour le nombre « pas encore vus » sur l'icône. */
export function calendarRecent(hub: Hub, limit = 20): string[] {
  const { store } = hub.deps;
  return (
    store.db
      .prepare(
        `SELECT at FROM (
           SELECT r.created_at AS at FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE a.thread = 'calendar'
           UNION ALL
           SELECT created_at AS at FROM tasks WHERE label IN (${Object.keys(CALENDAR_TASKS).map(() => "?").join(", ")}) AND parent_id IS NULL
         ) ORDER BY at DESC LIMIT ?`,
      )
      .all(...Object.keys(CALENDAR_TASKS), limit) as { at: string }[]
  ).map((r) => r.at);
}

/** La conversation d'une tâche (null si inconnue), lue une fois par tâche. */
function taskChats(hub: Hub) {
  const seen = new Map<number, number | undefined>();
  return (id: number) => {
    if (!seen.has(id)) seen.set(id, hub.deps.journal.get(id)?.chat_id);
    return seen.get(id);
  };
}

/** Les messages qui ont leur place dans ta conversation (voir src/core/thread.ts). */
export function threadMessages(hub: Hub, list: Message[]): Message[] {
  const chatOf = taskChats(hub);
  return list.filter((m) => !(m.role === "system" && m.text === NEW_CONVERSATION_NOTE) && inThread(m, OWNER_CHAT, chatOf));
}

/** Activité › « Ce qui s'est passé » : les dernières notes sorties de ta conversation, rangées par sorte. */
export function activityNotes(hub: Hub, limit = 80) {
  const chatOf = taskChats(hub);
  return hub.deps.conversation
    .recent(OWNER_CHAT, 400)
    .filter((m) => m.role === "system" && m.text !== NEW_CONVERSATION_NOTE && !inThread(m, OWNER_CHAT, chatOf))
    .slice(-limit)
    .reverse()
    .map((m) => ({ id: m.id, text: m.text, kind: m.kind, category: noteCategory(m), taskId: m.task_id, at: m.created_at }));
}

function sendVideo(req: IncomingMessage, res: ServerResponse, post: { media_path: string } | undefined) {
  if (!post || !existsSync(post.media_path)) throw new HttpError(404, "Vidéo introuvable");
  const size = statSync(post.media_path).size;
  const headers = { ...SECURITY_HEADERS, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    res.writeHead(200, { ...headers, "Content-Length": size });
    createReadStream(post.media_path).pipe(res);
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  createReadStream(post.media_path, { start, end }).pipe(res);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "JSON attendu");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Message trop long");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "JSON invalide");
  }
}

/**
 * Interface web locale. Elle n'écoute que sur 127.0.0.1 et refuse :
 * - un en-tête Host étranger (protection contre le DNS rebinding) ;
 * - une écriture venue d'une autre origine (une page web ouverte ailleurs ne peut rien envoyer).
 */
export function startWeb(hub: Hub, opts: { health?: (fresh?: boolean) => HealthReport; port: number; demo?: boolean; voice?: WebVoice; browser?: BrowserService; messages?: MessagesService; plugins?: Plugins; settings?: Settings; notify?: NotifyStore; preview?: PreviewService; engineLogin?: EngineLogin; terminal?: Terminal; obsidian?: ObsidianLink }) {
  // L'aperçu (mode design) s'affiche dans un cadre : seule son origine est permise.
  if (opts.preview) {
    const o = opts.preview.origin;
    SECURITY_HEADERS["Content-Security-Policy"] = SECURITY_HEADERS["Content-Security-Policy"].replace("frame-ancestors 'none'", `frame-src ${o} ${o.replace("127.0.0.1", "localhost")}; frame-ancestors 'none'`);
  }
  const voice = opts.voice ?? realVoice;
  let voices: string[] = [];
  void voice
    .voices()
    .then((v) => {
      voices = v;
      hub.touch();
    })
    .catch(() => {});
  // Adresses acceptées : localhost, plus celles de CLARK_WEB_HOSTS (le téléphone, par Tailscale).
  const access = accessRules(opts.port);
  const origins = access.origins;
  // Une session de l'interface reste soumise aux contrôles d'accès locaux et Tailscale.
  const browserSession = `clark_browser=${randomBytes(24).toString("hex")}`;
  // Tailscale lu une fois (puis à la demande) : pour la carte « Accès depuis le téléphone ».
  let tailscale = tailscaleInfo();
  const streams = new Set<ServerResponse>();
  // La santé : celle de Clark (avec alertes, ping, surveillance), ou un relevé simple (tests, démo).
  const health = opts.health ?? cachedHealth(hub, { root: paths.root, logFile: join(paths.root, "data", "logs", "clark.log"), backupDir: join(paths.root, "data", "backups") });
  const remoteView = () => ({ hosts: access.remote, users: access.users ? [...access.users] : [], port: opts.port, tailscale });
  const view = () => snapshot(hub, { remote: remoteView(), health, demo: opts.demo, voice, voices, browser: opts.browser, messages: opts.messages, plugins: opts.plugins, settings: opts.settings, preview: opts.preview, engineLogin: opts.engineLogin, terminal: opts.terminal, obsidian: opts.obsidian });
  const state = () => JSON.stringify(view());

  // Plusieurs changements rapprochés (une étape, puis son résultat) partent en un seul envoi.
  let pendingPush: NodeJS.Timeout | null = null;
  hub.onChange(() => {
    if (pendingPush || streams.size === 0) return;
    pendingPush = setTimeout(() => {
      pendingPush = null;
      const data = `event: state\ndata: ${state()}\n\n`;
      for (const res of streams) res.write(data);
    }, 80);
  });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const { store, journal } = hub.deps;

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const refused = refusal(req.headers, access);
    if (refused) throw new HttpError(refused.status, refused.message);
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "GET") {
      // L'interface est rangée par zone dans src/web/app/ ; le navigateur reçoit leur assemblage, dans l'ordre.
      if (path === "/app.js") {
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8" });
        res.end(appScript());
        return;
      }
      const file = STATIC[path];
      if (file) {
        const headers = { ...SECURITY_HEADERS, "Content-Type": file[1] };
        if (path === "/") {
          const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
          res.setHeader("Set-Cookie", `${browserSession}; Path=/api/browser; HttpOnly; SameSite=Strict${secure}`);
        }
        res.writeHead(200, headers);
        res.end(readFileSync(resolve(PUBLIC, file[0])));
        return;
      }
      // Une conversation passée, pour la relire avant de la reprendre.
      const past = path.match(/^\/api\/conversations\/(\d+)$/);
      if (past) {
        const c = hub.deps.conversation.conversation(Number(past[1]));
        if (!c || c.chat_id !== OWNER_CHAT || !hub.deps.conversation.hasContent(c.id)) return json(res, 404, { error: "Conversation introuvable" });
        const messages = threadMessages(hub, hub.deps.conversation.messagesOf(c.id, 200))
          .map((m) => ({ id: m.id, role: m.role, text: m.text, taskId: m.task_id, source: m.source, kind: m.kind, agent: m.agent ?? null, at: m.created_at }));
        const title = c.title ?? hub.deps.conversation.list(OWNER_CHAT, 500).find((x) => x.id === c.id)?.title ?? "Conversation";
        return json(res, 200, { id: c.id, title, agent: c.agent, at: c.updated_at, messages });
      }
      if (path.startsWith("/ui/")) {
        const ui = uiFile(path);
        if (!ui) return json(res, 404, { error: "Introuvable" });
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": ui[1], "Cache-Control": "public, max-age=86400" });
        res.end(readFileSync(ui[0]));
        return;
      }
      if (path === "/api/state") return json(res, 200, view());
      // Clark répond : lu par scripts/service.sh après un redémarrage (retour à la version précédente sinon).
      // Accès depuis le téléphone › Vérifier : Tailscale relu.
      if (path === "/api/remote") {
        tailscale = tailscaleInfo();
        hub.touch();
        return json(res, 200, remoteView());
      }
      // Page Santé › Actualiser : le rapport relu tout de suite.
      if (path === "/api/sante") return json(res, 200, health(true));
      // Toujours 200 tant que Clark répond (même si la santé est mauvaise) : le filet de service.sh et la
      // surveillance locale ne relancent Clark que s'il ne répond plus. Niveau et points : du relevé gardé 20 s.
      if (path === "/api/health") {
        const h = (() => {
          try {
            return health();
          } catch {
            return null;
          }
        })();
        return json(res, 200, { ok: true, pid: process.pid, uptime: Math.round(process.uptime()), level: h?.level ?? null, problems: h?.problems.map((p) => p.id) ?? [], version: h?.version.commit ?? null, backup: h?.backup ? { localHoursAgo: h.backup.hoursAgo, remote: h.backup.remote ? { configured: h.backup.remote.configured, at: h.backup.remote.at, ok: h.backup.remote.ok } : null, drill: h.backup.drill ? { at: h.backup.drill.at, ok: h.backup.drill.ok } : null } : null });
      }
      // Calendrier des veilles : les exécutions d'un mois, avec leur compte rendu (lu à la demande, pas dans l'état poussé).
      if (path === "/api/calendar") {
        const month = url.searchParams.get("month") ?? "";
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json(res, 400, { error: "Mois attendu : AAAA-MM" });
        return json(res, 200, calendarMonth(hub, month));
      }
      // La sortie du Terminal, relue pendant qu'il est affiché (hôte vérifié plus haut ; pas de CORS).
      if (path === "/api/terminal") {
        if (!opts.terminal) return json(res, 409, { error: "Terminal indisponible" });
        return json(res, 200, { cwd: opts.terminal.cwd, runs: opts.terminal.list() });
      }
      // Capture d'un élément choisi en mode design.
      const shot = path.match(/^\/api\/dev\/design\/(\d+)\/(\d{10,16}\.jpg)$/);
      if (shot) {
        const file = resolve(designDir(Number(shot[1])), shot[2]);
        if (!existsSync(file)) return json(res, 404, { error: "Introuvable" });
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "image/jpeg" });
        res.end(readFileSync(file));
        return;
      }
      // Historique de l'activité : les tâches passées, par pages de 40.
      if (path === "/api/activity") {
        const item = (t: ReturnType<typeof journal.history>[number]) => ({
          id: t.id,
          origin: originOf(t, store),
          team: t.label === TEAM_LABEL,
          // Un titre lisible, jamais la consigne interne envoyée à l'agent.
          prompt: short(historyTitle(t, store), 200),
          status: t.status,
          engine: t.engine,
          at: t.created_at,
          updated: t.updated_at,
          agents: t.agents,
          steps: t.step_count,
        });
        let before = Number(url.searchParams.get("before")) || undefined;
        const q = (url.searchParams.get("q") ?? "").slice(0, 200);
        if (!q.trim()) {
          const rows = journal.history({ before, limit: 40 });
          return json(res, 200, { tasks: rows.map(item), more: rows.length === 40, cursor: rows.at(-1)?.id ?? null });
        }
        // Filtre : tout l'historique est parcouru (par lots), pas seulement la page affichée.
        const found: ReturnType<typeof item>[] = [];
        let scanned = 0;
        let more = true;
        while (found.length < 40 && scanned < 5000) {
          const rows = journal.history({ before, limit: 100 });
          for (const t of rows) {
            before = t.id;
            const x = item(t);
            if (matchesQuery(`${x.prompt} ${x.origin}`, q)) found.push(x);
            if (found.length === 40) break;
          }
          scanned += rows.length;
          if (found.length < 40 && rows.length < 100) {
            more = false;
            break;
          }
        }
        // cursor : où reprendre « Afficher plus ancien » (le dernier parcouru, pas le dernier trouvé).
        return json(res, 200, { tasks: found, more, cursor: before ?? null });
      }
      const issues = path.match(/^\/api\/dev\/projects\/(\d+)\/issues$/);
      if (issues) {
        const p = store.dev.project(Number(issues[1]));
        if (!p) return json(res, 404, { error: "Projet introuvable" });
        try {
          return json(res, 200, { issues: await listIssues(p, url.searchParams.get("fresh") === "1") });
        } catch (err) {
          const e = err as { stderr?: string; message?: string };
          return json(res, 502, { error: `Issues illisibles : ${(e.stderr?.trim() || e.message || String(err)).split("\n")[0].slice(0, 200)}. Le dépôt est-il sur GitHub, et gh connecté ?` });
        }
      }
      const draft = path.match(/^\/api\/dev\/(tasks|groups)\/(\d+)\/pr$/);
      if (draft) {
        const d = prDraft(hub, draft[1] === "tasks" ? "task" : "group", Number(draft[2]));
        return d ? json(res, 200, d) : json(res, 404, { error: "Pas de PR possible ici." });
      }
      const patch = path.match(/^\/api\/dev\/tasks\/(\d+)\/diff$/);
      if (patch) {
        const text = await devPatch(hub, Number(patch[1])).catch((err) => `Diff indisponible : ${err instanceof Error ? err.message : String(err)}`);
        return text === null ? json(res, 404, { error: "Copie introuvable (tâche décidée ?)" }) : json(res, 200, { patch: text });
      }
      const detail = path.match(/^\/api\/tasks\/(\d+)$/);
      if (detail) {
        const t = journal.get(Number(detail[1]));
        if (!t || t.parent_id !== null) return json(res, 404, { error: "Tâche introuvable" });
        return json(res, 200, {
          id: t.id,
          prompt: short(t.prompt, 2000),
          result: t.result ? short(t.result, 6000) : null,
          status: t.status,
          team: t.label === TEAM_LABEL ? teamView(journal, t, hub.engineFor) : null,
          steps: journal.steps(t.id).slice(-40).map((st) => ({ id: st.id, effect: st.effect, status: st.status, text: describeStep(st) })),
        });
      }
      // Exporter la configuration (sans secrets), en fichier à télécharger.
      if (path === "/api/config/export") {
        const data = exportConfig({ hub, settings: opts.settings ?? null, notify: opts.notify ?? null }, { memory: url.searchParams.get("memory") === "1" });
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="clark-config-${data.exportedAt.slice(0, 10)}.json"` });
        res.end(JSON.stringify(data, null, 2));
        return;
      }
      // Journal du navigateur (étapes des tâches, expurgées) et règles des sites sensibles, avec leur provenance.
      if (path === "/api/browser/journal") {
        const awaiting = new Set(hub.approvals().filter((a) => a.tool === "browser").map((a) => a.taskId));
        return json(res, 200, {
          rules: rulesView(),
          trustList: { enabled: TRUST_LIST_ENABLED },
          entries: browserJournal(journal.browserSteps(60), { awaitingTasks: awaiting, control: opts.browser?.controlEvents() ?? [] }),
        });
      }
      if (path === "/api/browser/screenshot" || path === "/api/browser/vision/screenshot") {
        if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) throw new HttpError(403, "Origine non autorisée");
        const session = req.headers.cookie?.split(/;\s*/).includes(browserSession);
        if (!session && !isInternal(req.headers["x-clark-internal"])) throw new HttpError(403, "Refusé");
        // L'agent (jeton interne) n'a que sa capture vision, jamais la vue distante ni une page sensible.
        const shot = session ? opts.browser?.screenshot() : opts.browser?.visionImage();
        if (!shot) throw new HttpError(404, "Pas de capture");
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "image/jpeg", "Cross-Origin-Resource-Policy": "same-origin" });
        res.end(shot);
        return;
      }
      // Un message de Clark lu à voix haute, ou un essai de voix (Réglages).
      const speech = path.match(/^\/api\/voice\/speech\/(\d+)$/);
      if (speech || path === "/api/voice/sample") {
        if (!voice.status().canSpeak) throw new HttpError(409, "Lecture à voix haute indisponible sur ce Mac");
        let text = VOICE_SAMPLE;
        let who = store.voice.voice();
        if (speech) {
          const m = hub.deps.conversation.get(Number(speech[1]));
          if (!m || m.chat_id !== OWNER_CHAT || m.role !== "clark") throw new HttpError(404, "Message introuvable");
          text = m.text;
        } else {
          const asked = url.searchParams.get("voix") ?? "";
          if (asked) {
            if (!voices.includes(asked)) throw new HttpError(400, "Voix introuvable sur ce Mac");
            who = asked;
          }
        }
        const dir = mkdtempSync(join(tmpdir(), "clark-web-"));
        try {
          const file = await voice.speak(text, who, "m4a", join(dir, "clark.m4a"));
          res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "audio/mp4" });
          res.end(readFileSync(file));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        return;
      }
      const media = path.match(/^\/media\/posts\/(\d+)$/);
      if (media) return sendVideo(req, res, store.posts.get(Number(media[1])));
      if (path === "/api/events") {
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
        res.write(`event: state\ndata: ${state()}\n\n`);
        streams.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          streams.delete(res);
        });
        return;
      }
      throw new HttpError(404, "Introuvable");
    }

    if (req.method !== "POST") throw new HttpError(405, "Méthode non autorisée");

    // Le serveur MCP de Codex (autre processus de Clark) pilote le navigateur par ici, avec le jeton du démarrage.
    if (path === "/internal/browser") {
      if (!isInternal(req.headers["x-clark-internal"])) throw new HttpError(403, "Refusé");
      const body = await readJson(req);
      const taskId = Number(body.taskId);
      const task = Number.isInteger(taskId) ? journal.get(taskId) : undefined;
      if (!task) throw new HttpError(400, "Tâche inconnue");
      const action = body.action as BrowserAction | VisionAction;
      // « scroll » existe dans les deux modes. Les appels browser_* gardent leur comportement.
      const vision = body.vision === true || action === "screenshot" || action === "click_at" || action === "key";
      const actions: readonly string[] = vision ? VISION_ACTIONS : BROWSER_ACTIONS;
      if (!actions.includes(action)) throw new HttpError(400, "Action inconnue");
      const writes = vision ? VISION_WRITES.has(action as VisionAction) : BROWSER_WRITES.has(action as BrowserAction);
      if (writes && task.access === "read") return json(res, 200, { text: READ_ONLY_REFUSAL });
      if (!opts.browser) return json(res, 200, { text: "Le navigateur n'est pas disponible ici." });
      const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
      if (vision) {
        // Le service signale déjà les changements à hub.touch(), qui pousse l'état par SSE.
        const result = await opts.browser.vision(taskId, action as VisionAction, args);
        return json(res, 200, { text: result.text, image: result.shot?.image.toString("base64") });
      }
      return json(res, 200, { text: await opts.browser.act(taskId, action as BrowserAction, args) });
    }

    // Pareil pour iMessage : lire tes conversations, envoyer avec ton accord.
    if (path === "/internal/messages") {
      if (!isInternal(req.headers["x-clark-internal"])) throw new HttpError(403, "Refusé");
      const body = await readJson(req);
      const taskId = Number(body.taskId);
      if (!Number.isInteger(taskId) || !journal.get(taskId)) throw new HttpError(400, "Tâche inconnue");
      const m = opts.messages;
      if (!m) return json(res, 200, { text: "iMessage n'est pas disponible ici." });
      const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
      if (body.action === "recent") return json(res, 200, { text: m.recent(Number(args.hours ?? 48)) });
      if (body.action === "read") return json(res, 200, { text: m.read(String(args.chat ?? ""), Number(args.limit ?? 30)) });
      if (body.action === "send") {
        // Un agent en lecture seule n'envoie rien, même par ce chemin.
        if (journal.get(taskId)?.access === "read") return json(res, 200, { text: READ_ONLY_REFUSAL });
        return json(res, 200, { text: await m.send(taskId, String(args.chat ?? ""), String(args.text ?? "")) });
      }
      throw new HttpError(400, "Action inconnue");
    }

    if (!origins.has(req.headers.origin ?? "")) throw new HttpError(403, "Origine non autorisée");


    // Dictée : l'enregistrement du micro est transcrit sur le Mac, et le texte revient dans le champ.
    if (path === "/api/voice/transcribe") {
      const type = (req.headers["content-type"] ?? "").split(";")[0].trim();
      const ext = AUDIO_TYPES[type];
      if (!ext) throw new HttpError(415, "Audio attendu");
      const status = voice.status();
      if (!status.ready) throw new HttpError(409, status.problem ?? "Transcription indisponible");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > AUDIO_LIMIT) throw new HttpError(413, "Enregistrement trop long");
        chunks.push(chunk);
      }
      if (!size) throw new HttpError(400, "Enregistrement vide");
      const dir = mkdtempSync(join(tmpdir(), "clark-web-"));
      try {
        const file = join(dir, `dictee.${ext}`);
        writeFileSync(file, Buffer.concat(chunks));
        const text = await voice.transcribe(file, store.voice.vocabulary()).catch(() => {
          throw new HttpError(422, "Je n'ai pas réussi à transcrire. Réessaie.");
        });
        return json(res, 200, { text });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // Import de configuration : un fichier plus gros qu'un message (mémoire comprise).
    const body = await readJson(req, path.startsWith("/api/config/import") ? 5 * 1024 * 1024 : BODY_LIMIT);

    // Terminal : seulement depuis cette interface (origine et hôte vérifiés), jamais par Telegram.
    if (path.startsWith("/api/terminal/")) {
      const term = opts.terminal;
      if (!term) throw new HttpError(409, "Terminal indisponible");
      if (path === "/api/terminal/run") {
        const r = term.run(String(body.command ?? ""), { by: "charles", cwd: typeof body.cwd === "string" ? body.cwd : null });
        if (typeof r === "string") throw new HttpError(409, r);
        return json(res, 200, { ok: true, id: r.id });
      }
      if (path === "/api/terminal/stop") {
        if (!term.stop(Number(body.id))) throw new HttpError(409, "Rien à arrêter");
        return json(res, 200, { ok: true });
      }
      if (path === "/api/terminal/clear") {
        term.clear();
        return json(res, 200, { ok: true });
      }
      const decide = path.match(/^\/api\/terminal\/requests\/(\d+)$/);
      if (decide) {
        const id = Number(decide[1]);
        const reqRow = store.terminal.get(id);
        if (!reqRow || reqRow.status !== "pending") throw new HttpError(409, "Demande déjà traitée ou expirée");
        if (body.ok !== true) {
          store.terminal.move(id, "pending", "refused");
          void hub.post(OWNER_CHAT, `Commande refusée : ${short(reqRow.command, 120)}`, "system");
          return json(res, 200, { ok: true });
        }
        if (term.running()) throw new HttpError(409, "Une commande tourne déjà dans le Terminal : attends qu'elle finisse.");
        if (!store.terminal.move(id, "pending", "running")) throw new HttpError(409, "Demande déjà traitée");
        const r = term.run(reqRow.command, {
          by: "clark",
          cwd: reqRow.cwd,
          taskId: reqRow.task_id,
          onEnd: (run) => store.terminal.finish(id, run.status === "done" ? "done" : "failed", run.exitCode, run.output),
        });
        if (typeof r === "string") {
          store.terminal.finish(id, "failed", null, r);
          throw new HttpError(409, r);
        }
        hub.touch();
        return json(res, 200, { ok: true, run: r.id });
      }
      throw new HttpError(404, "Introuvable");
    }

    if (path === "/api/config/import/preview" || path === "/api/config/import") {
      const ctx = { hub, settings: opts.settings ?? null, notify: opts.notify ?? null };
      try {
        if (path.endsWith("/preview")) return json(res, 200, planImport(ctx, body.data));
        return json(res, 200, await applyImport(ctx, body.data, { personality: body.personality === true, memories: body.memories === true }));
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }

    if (path === "/api/personality") {
      if (typeof body.text !== "string") throw new HttpError(400, "Texte attendu");
      const r = savePersonality(body.text);
      if ("error" in r) throw new HttpError(400, r.error);
      hub.touch();
      return json(res, 200, { ok: true });
    }

    if (path.startsWith("/api/plugins")) {
      const plugins = opts.plugins;
      if (!plugins) throw new HttpError(409, "Plugins indisponibles");
      // Pour la relecture : chaque variable demandée, renseignée ou non dans .env (jamais sa valeur).
      const withVars = (r: Review) => ({ ...r, mcp: r.mcp.map((m) => ({ ...m, vars: [...(m.envVars ?? []), ...(m.tokenVar ? [m.tokenVar] : [])].map((v) => ({ name: v, set: hasVar(v) })) })) });
      const fail = (err: unknown): never => {
        throw new HttpError(400, err instanceof Error ? err.message.split("\n")[0].replace(/https:\/\/[^@\s]*@/g, "https://") : String(err));
      };
      if (path === "/api/plugins/review") {
        if (typeof body.source !== "string") throw new HttpError(400, "Adresse attendue");
        const review = await plugins.review(body.source, typeof body.subdir === "string" ? body.subdir : null, undefined, typeof body.ref === "string" ? body.ref : null).catch(fail);
        return json(res, 200, withVars(review));
      }
      if (path === "/api/plugins/install") {
        try {
          return json(res, 200, plugins.install(String(body.token ?? "")));
        } catch (err) {
          fail(err);
        }
      }
      if (path === "/api/plugins/cancel") {
        plugins.cancel(String(body.token ?? ""));
        return json(res, 200, { ok: true });
      }
      const one = path.match(/^\/api\/plugins\/([a-z0-9][a-z0-9-]{0,47})$/);
      if (one) {
        const name = one[1];
        if (body.action === "check") return json(res, 200, withVars(await plugins.checkUpdate(name).catch(fail)));
        const ok =
          body.action === "enable" ? plugins.setEnabled(name, true) : body.action === "disable" ? plugins.setEnabled(name, false) : body.action === "uninstall" ? plugins.uninstall(name) : null;
        if (ok === null) throw new HttpError(400, "Action inconnue");
        if (!ok) throw new HttpError(404, "Plugin introuvable");
        hub.touch();
        return json(res, 200, { ok: true });
      }
      throw new HttpError(404, "Introuvable");
    }

    // Vue distante du navigateur : tu te connectes toi-même à un site (serveur sans écran, ou téléphone).
    // Ce que tu tapes passe au navigateur, sans être gardé ni journalisé.
    if (path === "/api/browser/remote") {
      if (!opts.browser) throw new HttpError(409, "Navigateur indisponible");
      const a = String(body.action ?? "");
      const r =
        a === "start" ? { action: "start" as const, url: typeof body.url === "string" && body.url.trim() ? body.url.trim() : undefined, phone: body.phone === true }
        : a === "stop" ? { action: "stop" as const }
        : a === "goto" ? { action: "goto" as const, url: String(body.url ?? "") }
        : a === "click" ? { action: "click" as const, x: Number(body.x), y: Number(body.y) }
        : a === "type" ? { action: "type" as const, text: String(body.text ?? "") }
        : a === "key" ? { action: "key" as const, key: String(body.key ?? "") }
        : a === "scroll" ? { action: "scroll" as const, direction: body.direction === "up" ? ("up" as const) : ("down" as const) }
        : a === "back" ? { action: "back" as const }
        : null;
      if (!r) throw new HttpError(400, "Action inconnue");
      try {
        await opts.browser.remote(r);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message.split("\n")[0] : String(err));
      }
      return json(res, 200, { ok: true, state: opts.browser.state() });
    }

    if (path === "/api/browser") {
      if (!opts.browser) throw new HttpError(409, "Navigateur indisponible");
      const action = body.action;
      try {
        if (action === "show") await opts.browser.setVisible(true);
        else if (action === "hide") await opts.browser.setVisible(false);
        else if (action === "close") await opts.browser.close();
        else if (action === "forget") await opts.browser.forget();
        else if (action === "leave") await opts.browser.leaveSensitive();
        else throw new HttpError(400, "Action inconnue");
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(500, err instanceof Error ? err.message.split("\n")[0] : String(err));
      }
      return json(res, 200, { ok: true });
    }

    if (path === "/api/settings") {
      if (!opts.settings) throw new HttpError(409, "Réglages indisponibles");
      const key = String(body.key ?? "");
      // Moteur principal : vérifié d'abord (connecté ?), puis appliqué tout de suite.
      if (key === "engine" && (body.value === "claude" || body.value === "codex")) {
        const error = hub.setMainEngine(body.value);
        if (error) throw new HttpError(409, error);
      }
      const r = opts.settings.set(key, body.value === null ? null : body.value, hub.deps.config);
      if ("error" in r) throw new HttpError(400, r.error);
      hub.touch();
      return json(res, 200, r);
    }

    if (path === "/api/notify") {
      if (!opts.notify) throw new HttpError(409, "Réglages indisponibles");
      const r = opts.notify.set(body.prefs);
      if ("error" in r) throw new HttpError(400, r.error);
      hub.touch();
      return json(res, 200, r);
    }

    const login = path.match(/^\/api\/engines\/(claude|codex)\/login$/);
    if (login) {
      const el = opts.engineLogin;
      if (!el) throw new HttpError(409, "Connexion indisponible ici : lance la commande dans un terminal.");
      const engine = login[1] as LoginEngine;
      if (body.action === "start") return json(res, 202, { ok: true, status: el.logins.start(engine).status });
      if (body.action === "cancel") {
        el.logins.cancel(engine);
        return json(res, 200, { ok: true });
      }
      if (body.action === "code") {
        const r = el.logins.sendCode(engine, typeof body.code === "string" ? body.code : "");
        if ("error" in r) throw new HttpError(400, r.error);
        return json(res, 200, r);
      }
      throw new HttpError(400, "Action attendue : start, code ou cancel");
    }

    if (path === "/api/restart") {
      const restart = opts.engineLogin?.restart;
      if (!restart) throw new HttpError(409, "Clark ne tourne pas en service : redémarre-le toi-même.");
      json(res, 202, { ok: true });
      // La réponse part d'abord ; launchd relance Clark quelques secondes après.
      setTimeout(restart, 300);
      return;
    }

    if (path === "/api/voice/settings") {
      const r = await store.voice.set({ mode: body.mode, voice: body.voice, vocabulary: body.vocabulary });
      if ("error" in r) throw new HttpError(400, r.error);
      hub.touch();
      return json(res, 200, { ok: true });
    }

    if (path === "/api/obsidian/sync") {
      if (!opts.obsidian) throw new HttpError(409, "Pas de coffre Obsidian branché");
      opts.obsidian.syncNow();
      hub.touch();
      return json(res, 200, { ok: true, ...opts.obsidian.status() });
    }

    // Le journal du jour, écrit tout de suite (il remplace celui qui existe).
    if (path === "/api/obsidian/journal") {
      if (!opts.obsidian || !opts.obsidian.status().vault) throw new HttpError(409, "Pas de coffre Obsidian branché");
      if (!opts.obsidian.writeJournal) throw new HttpError(409, "Pas de moteur Claude pour écrire le journal");
      let r: { day: string } | { empty: true };
      try {
        r = await opts.obsidian.writeJournal();
      } catch (err) {
        if (err instanceof JournalError) throw new HttpError(err.code === "busy" ? 409 : 502, err.message);
        throw err;
      }
      hub.touch();
      return json(res, 200, "day" in r ? { ok: true, day: r.day } : { ok: true, day: null, empty: true });
    }

    // La fenêtre de choix du Finder, sur ce Mac : un fichier ou un dossier pour Clark (ou un projet).
    if (path === "/api/pick") {
      const kind = body.kind === "folder" ? "folder" : "file";
      try {
        return json(res, 200, { path: await pickPath(kind) });
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : "Fenêtre de choix impossible à ouvrir");
      }
    }

    if (path === "/api/messages") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new HttpError(400, "Message vide");
      // Message, équipe ou objectif ; une commande perso (« /relances … ») prend sa consigne et son mode.
      const mode = body.mode === "goal" || body.mode === "team" ? body.mode : body.team === true ? "team" : "chat";
      // « clark » dans le terminal se signale (« · terminal ») ; il ne peut ni valider ni répondre aux questions.
      // Fichiers et dossiers joints (choisis dans la fenêtre du Mac) : Clark reçoit leur contenu ou leur liste.
      const attached = attachmentContext(body.attachments);
      if ("error" in attached) throw new HttpError(400, attached.error);
      const r = submitRequest(hub, text + attached.prompt, {
        source: body.source === "cli" ? "cli" : "web",
        mode,
        ...(attached.display ? { display: text + attached.display } : {}),
      });
      if ("error" in r) throw new HttpError(400, r.error);
      return json(res, 202, { ok: true, ...r });
    }

    const approval = path.match(/^\/api\/approvals\/([\w-]+)$/);
    if (approval) {
      if (typeof body.ok !== "boolean") throw new HttpError(400, "Réponse attendue : ok vrai ou faux");
      const live = hub.resolveApproval(approval[1], body.ok);
      return json(res, live ? 200 : 409, live ? { ok: true } : { error: "Cette demande a expiré ou a déjà reçu une réponse." });
    }

    if (path === "/api/automations") {
      const input: Partial<AutomationInput> = {
        name: typeof body.name === "string" ? body.name : undefined,
        prompt: typeof body.prompt === "string" ? body.prompt : undefined,
        frequency: body.frequency as AutomationInput["frequency"],
        time: typeof body.time === "string" ? body.time : undefined,
        weekday: typeof body.weekday === "number" ? body.weekday : null,
        team: body.team === true,
        kind: body.kind === "team" || body.kind === "dev" ? body.kind : body.team === true ? "team" : "chat",
        projectId: Number.isInteger(body.projectId) ? (body.projectId as number) : null,
        engine: body.engine === "claude" || body.engine === "codex" ? body.engine : null,
        model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : null,
        effort: typeof body.effort === "string" && body.effort.trim() ? body.effort.trim() : null,
        precheck: typeof body.precheck === "string" && body.precheck.trim() ? body.precheck.trim() : null,
        thread: body.thread === "own" || body.thread === "calendar" ? body.thread : "main",
        enabled: body.enabled !== false,
      };
      if (input.kind === "dev" && !store.dev.project(input.projectId ?? -1)) throw new HttpError(400, "Choisis le projet de la tâche dev");
      if (input.model && input.engine) {
        const known = hub.catalog(input.engine as "claude" | "codex")?.catalog?.models.map((m) => m.id) ?? [];
        if (known.length && !known.includes(input.model)) throw new HttpError(400, "Modèle inconnu pour ce moteur.");
      }
      try {
        const id = store.automations.create(input as AutomationInput);
        return json(res, 201, { ok: true, id });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "Automatisation invalide");
      }
    }

    const automation = path.match(/^\/api\/automations\/(\d+)$/);
    if (automation) {
      const id = Number(automation[1]);
      if (!store.automations.get(id)) throw new HttpError(404, "Automatisation introuvable");
      if (body.action === "enable" || body.action === "disable") store.automations.setEnabled(id, body.action === "enable");
      else if (body.action === "delete") store.automations.remove(id);
      else if (body.action === "thread") {
        if (body.thread !== "main" && body.thread !== "own" && body.thread !== "calendar") throw new HttpError(400, "Fil inconnu");
        try {
          store.automations.setThread(id, body.thread);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : "Impossible");
        }
      } else if (body.action === "run") void launchAutomation(hub, store.automations.get(id)!, { manual: true });
      else throw new HttpError(400, "Action inconnue");
      return json(res, 200, { ok: true });
    }

    const post = path.match(/^\/api\/posts\/(\d+)$/);
    if (post) {
      const action = body.action;
      if (action !== "approve" && action !== "reject" && action !== "redo") throw new HttpError(400, "Action inconnue");
      const feedback = typeof body.feedback === "string" ? body.feedback.slice(0, 1000) : undefined;
      const outcome = hub.decidePost(Number(post[1]), action, feedback);
      if (outcome === "missing_feedback") throw new HttpError(400, "Dis ce qu'il faut retoucher");
      return json(res, outcome === "already" ? 409 : 200, outcome === "already" ? { error: "Ce contenu a déjà été traité." } : { ok: true });
    }

    const initiative = path.match(/^\/api\/initiatives\/(\d+)$/);
    if (initiative) {
      // Ton avis sur une proposition terminée : Utile / Pas utile (dans les 3 jours).
      if (body.action === "feedback") {
        if (body.value !== "utile" && body.value !== "inutile") throw new HttpError(400, "Avis attendu : utile ou inutile");
        if (!store.initiatives.setFeedback(Number(initiative[1]), body.value)) throw new HttpError(409, "Cette proposition n'attend plus d'avis.");
        hub.touch();
        return json(res, 200, { ok: true });
      }
      if (body.action !== "accept" && body.action !== "decline") throw new HttpError(400, "Action inconnue");
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined;
      const kind = (DECLINE_KINDS as readonly string[]).includes(String(body.kind)) ? (body.kind as DeclineKind) : undefined;
      const outcome = hub.decideInitiative(Number(initiative[1]), body.action, reason, kind);
      return json(res, outcome === "already" ? 409 : 200, outcome === "already" ? { error: "Cette proposition a déjà été traitée." } : { ok: true });
    }

    // Serveurs MCP : ajout (puis test aussitôt), test, activation, confiance, suppression.
    if (path === "/api/mcp") {
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const input: McpInput = {
        name: String(body.name ?? ""),
        transport: body.transport === "http" ? "http" : "stdio",
        command: typeof body.command === "string" ? body.command : null,
        args: strs(body.args),
        url: typeof body.url === "string" ? body.url : null,
        envVars: strs(body.envVars),
        tokenVar: typeof body.tokenVar === "string" && body.tokenVar.trim() ? body.tokenVar.trim() : null,
        trust: body.trust === "read" ? "read" : "ask",
      };
      const added = store.mcp.add(input);
      if (!added.ok) return json(res, 400, { error: added.error, field: added.field });
      void probeMcp(store.mcp.get(added.id)!).then((c) => store.mcp.recordCheck(added.id, c));
      return json(res, 201, { ok: true, id: added.id });
    }
    // Commandes perso : création (ou remplacement), suppression.
    if (path === "/api/commands") {
      const c = {
        name: String(body.name ?? "").trim(),
        description: typeof body.description === "string" ? body.description : "",
        mode: (["chat", "team", "goal"].includes(String(body.mode)) ? body.mode : "chat") as CommandMode,
        prompt: typeof body.prompt === "string" ? body.prompt : "",
      };
      const bad = validateCommand(c);
      if (bad) return json(res, 400, bad);
      saveCommand(c);
      hub.touch();
      return json(res, 201, { ok: true });
    }
    const command = path.match(/^\/api\/commands\/([a-z0-9-]+)$/);
    if (command) {
      if (body.action !== "delete") throw new HttpError(400, "Action inconnue");
      if (!deleteCommand(command[1])) return json(res, 404, { error: "Commande introuvable" });
      hub.touch();
      return json(res, 200, { ok: true });
    }

    // ── Côté dev ──
    // Suivi d'une PR : relire, préparer une correction de CI ou une réponse aux reviews, marquer comme lu.
    const prAction = async (kind: "task" | "group", id: number, action: string) => {
      if (action === "pr-seen") {
        markPrSeen(hub, { kind, id });
        return json(res, 200, { ok: true });
      }
      if (action === "pr-refresh") {
        const st = await refreshPr(hub, { kind, id }, { notify: false });
        return st ? json(res, 200, { ok: true }) : json(res, 404, { error: "Pas de PR ici." });
      }
      const r = await fixPr(hub, { kind, id }, action === "pr-ci" ? "ci" : "review");
      if (r === "missing") return json(res, 404, { error: "Pas de PR ici." });
      if ("error" in r) return json(res, 400, r);
      return json(res, 201, r);
    };
    // Moteur, modèle et effort d'un agent (réessai, comparaison) ; null si le modèle n'existe pas pour ce moteur.
    const readSide = (x: any): CompareSide | null => {
      const engine = x?.engine === "claude" || x?.engine === "codex" ? x.engine : null;
      const model = typeof x?.model === "string" && /^[\w.:/-]{0,80}$/.test(x.model) ? x.model : null;
      const effort = typeof x?.effort === "string" && /^[a-z]{0,20}$/.test(x.effort) ? x.effort : null;
      if (model && engine) {
        const known = hub.catalog(engine)?.catalog?.models.map((m) => m.id) ?? [];
        if (known.length && !known.includes(model)) return null;
      }
      return { engine, model, effort };
    };
    const devReply = (r: DevOutcome) =>
      r === "missing" ? json(res, 404, { error: "Introuvable" }) : r === "already" ? json(res, 409, { error: "Déjà fait, ou pas possible maintenant." }) : typeof r === "object" ? json(res, 400, r) : json(res, 200, { ok: true });
    if (path === "/api/dev/projects") {
      const r = await addProject(hub, {
        name: String(body.name ?? ""),
        path: String(body.path ?? ""),
        baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : undefined,
        testCommand: typeof body.testCommand === "string" ? body.testCommand : undefined,
      });
      return r.ok ? json(res, 201, r) : json(res, 400, r);
    }
    const devProject = path.match(/^\/api\/dev\/projects\/(\d+)$/);
    if (devProject) {
      const id = Number(devProject[1]);
      if (body.action === "delete") {
        const r = store.dev.removeProject(id);
        return r === "busy" ? json(res, 409, { error: "Ce projet a des tâches en cours ou à relire." }) : devReply(r);
      }
      if (body.action === "settings") {
        const project = store.dev.project(id);
        if (!project) throw new HttpError(404, "Projet introuvable");
        const engine = body.engine === "claude" || body.engine === "codex" ? body.engine : null;
        const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
        const effort = typeof body.effort === "string" && body.effort.trim() ? body.effort.trim() : null;
        if ((model || effort) && !engine) throw new HttpError(400, "Choisis d'abord le moteur par défaut du projet.");
        if (model && engine) {
          const known = hub.catalog(engine)?.catalog?.models ?? [];
          const m = known.find((x) => x.id === model);
          if (known.length && !m) throw new HttpError(400, "Modèle inconnu pour ce moteur.");
          if (effort && m && m.efforts.length && !m.efforts.includes(effort)) throw new HttpError(400, `${m.name} ne propose pas cet effort.`);
        }
        const setup = typeof body.setupCommand === "string" ? body.setupCommand.trim() : "";
        if (setup.length > 300 || /[\r\n]/.test(setup)) throw new HttpError(400, "Commande de préparation : une ligne, 300 caractères au plus.");
        const test = typeof body.testCommand === "string" ? body.testCommand.trim() : project.test_command ?? "";
        if (test.length > 300 || /[\r\n]/.test(test)) throw new HttpError(400, "Commande de test : une ligne, 300 caractères au plus.");
        const paths = Array.isArray(body.copyPaths) ? body.copyPaths.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
        const bad = await validateCopyPaths(project, paths);
        if (bad) return json(res, 400, { error: bad, field: "copyPaths" });
        const previewCommand = typeof body.previewCommand === "string" ? body.previewCommand.trim() : project.preview_command ?? "";
        if (previewCommand.length > 300 || /[\r\n]/.test(previewCommand)) throw new HttpError(400, "Commande de l'aperçu : une ligne, 300 caractères au plus.");
        if (previewCommand && !previewCommand.includes("$PORT")) return json(res, 400, { error: "La commande de l'aperçu doit utiliser $PORT (le port que Clark lui donne).", field: "previewCommand" });
        const previewPath = typeof body.previewPath === "string" ? body.previewPath.trim().replace(/^\/+/, "") : project.preview_path ?? "";
        if (previewPath.length > 200 || /[\r\n]|(^|\/)\.\.(\/|$)/.test(previewPath)) return json(res, 400, { error: "Page de l'aperçu : un chemin dans le projet.", field: "previewPath" });
        store.dev.updateProject(id, { testCommand: test || null, defaultEngine: engine, defaultModel: model, defaultEffort: effort, setupCommand: setup || null, copyPaths: paths, previewCommand: previewCommand || null, previewPath: previewPath || null });
        return json(res, 200, { ok: true });
      }
      if (body.action === "test-command") {
        const cmd = typeof body.testCommand === "string" ? body.testCommand.trim() : "";
        if (cmd.length > 300 || /[\r\n]/.test(cmd)) throw new HttpError(400, "Une seule ligne, 300 caractères au plus.");
        store.dev.updateProject(id, { testCommand: cmd || null });
        return json(res, 200, { ok: true });
      }
      throw new HttpError(400, "Action inconnue");
    }
    // Copie préparée d'avance pendant que l'utilisateur tape une tâche de code.
    if (path === "/api/dev/prewarm") {
      const r = await prewarmCopy(hub, Number(body.projectId));
      if (r === "missing") throw new HttpError(404, "Projet introuvable");
      return json(res, 200, { ok: true, state: r });
    }

    if (path === "/api/dev/tasks") {
      const engine: "claude" | "codex" | null = body.engine === "claude" || body.engine === "codex" ? body.engine : null;
      let input: { projectId: number; instruction: string; engine: typeof engine; title?: string; issue?: { number: number; url: string } } = {
        projectId: Number(body.projectId),
        instruction: String(body.instruction ?? ""),
        engine,
      };
      // Depuis une issue GitHub : choisie dans la liste, ou « #12 (précisions) » tapé dans le composeur.
      const typed = input.instruction.trim().match(/^#(\d{1,7})\b([\s\S]*)$/);
      const issueNo = Number(body.issue) || (typed ? Number(typed[1]) : 0);
      if (issueNo) {
        const project = store.dev.project(input.projectId);
        if (!project) throw new HttpError(400, "Projet introuvable");
        const issue = await readIssue(project, issueNo).catch((err) => {
          throw new HttpError(400, `Issue #${issueNo} illisible : ${(err as { stderr?: string }).stderr?.trim().split("\n")[0] || (err instanceof Error ? err.message.split("\n")[0] : String(err))}`);
        });
        input = { ...input, instruction: issueInstruction(issue, typed ? typed[2] : String(body.extra ?? "")), title: `#${issue.number} ${issue.title}`, issue: { number: issue.number, url: issue.url } };
      }
      // « Comparer » : la même consigne, deux agents ; « Découper » : un agent de plan, puis plusieurs en parallèle.
      if (Array.isArray(body.compare)) {
        const sides = body.compare.map(readSide);
        if (sides.length !== 2 || sides.some((x: CompareSide | null) => !x)) throw new HttpError(400, "Deux agents à comparer");
        const r = startDevCompare(hub, { ...input, sides: sides as [CompareSide, CompareSide] });
        return r.ok ? json(res, 201, r) : json(res, 400, { ...r, field: "instruction" });
      }
      // « Binôme » : Claude et Codex, l'un écrit, l'autre relit (toujours découpé en sous-tâches).
      const grouped = body.binome === true || body.split === true;
      const r = body.binome === true ? startDevGroup(hub, { ...input, binome: true }) : body.split === true ? startDevGroup(hub, input) : startDevTask(hub, input);
      // Pilote automatique, choisi par l'utilisateur au lancement : noté tout de suite, avant la première version.
      if (r.ok && body.autopilot === true) grouped ? store.dev.updateGroup(r.id, { autopilot: 1 }) : store.dev.update(r.id, { autopilot: 1 });
      return r.ok ? json(res, 201, r) : json(res, 400, { ...r, field: "instruction" });
    }
    const devGroup = path.match(/^\/api\/dev\/groups\/(\d+)$/);
    if (devGroup) {
      const id = Number(devGroup[1]);
      if (body.action === "integrate") return devReply(await integrateGroup(hub, id));
      if (body.action === "discard") return devReply(discardGroup(hub, id));
      if (body.action === "pr") return devReply(await openPullRequest(hub, "group", id, { title: String(body.title ?? ""), body: String(body.body ?? "") }));
      if (["pr-refresh", "pr-ci", "pr-review", "pr-seen"].includes(String(body.action))) return prAction("group", id, String(body.action));
      throw new HttpError(400, "Action inconnue");
    }
    const devTask = path.match(/^\/api\/dev\/tasks\/(\d+)$/);
    if (devTask) {
      const id = Number(devTask[1]);
      if (body.action === "accept") return devReply(await acceptDevTask(hub, id));
      if (body.action === "discard") return devReply(await discardDevTask(hub, id));
      if (body.action === "unblock") return devReply(unblockDevTask(hub, id));
      if (body.action === "resume") return devReply(resumeDevTask(hub, id));
      if (body.action === "retouch") {
        const design = readDesignPick(id, body.design);
        if (design && "error" in design) throw new HttpError(400, design.error);
        return devReply(retouchDevTask(hub, id, String(body.instruction ?? ""), design));
      }
      if (body.action === "preview") {
        if (!opts.preview) throw new HttpError(409, "Aperçu indisponible");
        // Un serveur de dev peut mettre du temps à démarrer : l'état suit dans l'interface.
        const r = await Promise.race([opts.preview.open(id), new Promise<{ pending: true }>((ok) => setTimeout(() => ok({ pending: true }), 1500))]);
        if ("error" in r) throw new HttpError(400, r.error);
        return json(res, 200, { ok: true });
      }
      if (body.action === "preview-close") {
        await opts.preview?.close(id);
        return json(res, 200, { ok: true });
      }
      if (body.action === "design-shot") {
        if (!opts.preview) throw new HttpError(409, "Aperçu indisponible");
        const r = await opts.preview.capture(id, { selector: String(body.selector ?? ""), width: Number(body.width), page: String(body.page ?? "/") });
        if ("error" in r) throw new HttpError(400, r.error);
        return json(res, 200, r);
      }
      if (body.action === "test") return devReply(await runDevTests(hub, id));
      if (body.action === "pr") return devReply(await openPullRequest(hub, "task", id, { title: String(body.title ?? ""), body: String(body.body ?? "") }));
      if (body.action === "comment") {
        const t = store.dev.get(id);
        if (!t) throw new HttpError(404, "Tâche introuvable");
        const files: string[] = t.diff_stat ? JSON.parse(t.diff_stat).files.map((f: { path: string }) => f.path) : [];
        const file = String(body.file ?? "");
        const start = Number(body.start);
        const end = Number(body.end ?? body.start);
        const text = String(body.body ?? "").trim();
        if (!files.includes(file)) throw new HttpError(400, "Fichier absent du diff");
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 500) throw new HttpError(400, "Lignes invalides");
        if (!text || text.length > 4000) throw new HttpError(400, "Écris ton commentaire (4000 caractères au plus)");
        const cid = store.dev.addComment({ taskId: id, file, side: body.side === "old" ? "old" : "new", start, end, snippet: String(body.snippet ?? "").slice(0, 4000), body: text });
        return json(res, 201, { ok: true, id: cid });
      }
      if (body.action === "review") return devReply(sendReviewComments(hub, id));
      if (body.action === "restore") return devReply(await restoreDevRound(hub, id, Number(body.round)));
      if (["pr-refresh", "pr-ci", "pr-review", "pr-seen"].includes(String(body.action))) return prAction("task", id, String(body.action));
      if (body.action === "retry") {
        const side = readSide(body);
        if (!side) throw new HttpError(400, "Modèle inconnu pour ce moteur.");
        return devReply(await retryDevTask(hub, id, side));
      }
      if (body.action === "keep") return devReply(await keepComparedTask(hub, id));
      if (body.action === "compare") {
        const side = readSide(body);
        if (!side) throw new HttpError(400, "Modèle inconnu pour ce moteur.");
        const r = compareDevTask(hub, id, side);
        return r.ok ? json(res, 201, r) : json(res, 400, r);
      }
      if (body.action === "stop") {
        if (cancelWaitingTurn(hub, id)) return json(res, 200, { ok: true });
        const run = journal.lastByLabel(`dev:${id}`);
        if (!run || hub.stopTask(run.id) !== "stopped") throw new HttpError(409, "L'agent ne tourne pas.");
        return json(res, 200, { ok: true });
      }
      throw new HttpError(400, "Action inconnue");
    }
    const devComment = path.match(/^\/api\/dev\/comments\/(\d+)$/);
    if (devComment) {
      const cid = Number(devComment[1]);
      if (!store.dev.comment(cid)) throw new HttpError(404, "Commentaire introuvable");
      const ok = body.action === "resolve" ? store.dev.setCommentStatus(cid, "resolved") : body.action === "reopen" ? store.dev.setCommentStatus(cid, "open") : body.action === "delete" ? store.dev.deleteComment(cid) : null;
      if (ok === null) throw new HttpError(400, "Action inconnue");
      if (!ok) throw new HttpError(409, "Déjà envoyé à l'agent : résous-le plutôt.");
      return json(res, 200, { ok: true });
    }
    const devGate = path.match(/^\/api\/dev\/gates\/(\d+)$/);
    if (devGate) return devReply(resolveGate(hub, Number(devGate[1]), String(body.resolution ?? "")));
    // Arrêter un agent silencieux (n'importe quelle tâche).
    const stopTask = path.match(/^\/api\/tasks\/(\d+)\/stop$/);
    if (stopTask) {
      if (hub.stopTask(Number(stopTask[1])) !== "stopped") throw new HttpError(409, "L'agent ne tourne pas.");
      return json(res, 200, { ok: true });
    }

    if (path === "/api/goals") {
      const objective = typeof body.objective === "string" ? body.objective.trim() : "";
      if (objective.length < 10) throw new HttpError(400, "Décris l'objectif en une phrase au moins");
      if (objective.length > 2000) throw new HttpError(400, "2000 caractères au plus");
      const turns = Number(body.maxTurns) || DEFAULT_MAX_TURNS;
      if (turns < 1 || turns > MAX_TURNS_LIMIT) throw new HttpError(400, `Entre 1 et ${MAX_TURNS_LIMIT} tours`);
      return json(res, 201, { ok: true, id: createGoal(hub, objective, turns, "web") });
    }
    const goal = path.match(/^\/api\/goals\/(\d+)$/);
    if (goal) {
      if (!["pause", "resume", "stop"].includes(String(body.action))) throw new HttpError(400, "Action inconnue");
      const note = typeof body.note === "string" ? body.note.slice(0, 2000) : undefined;
      const r = controlGoal(hub, Number(goal[1]), body.action as "pause" | "resume" | "stop", note);
      if (r === "missing") return json(res, 404, { error: "Objectif introuvable" });
      return json(res, r === "already" ? 409 : 200, r === "already" ? { error: "Déjà fait." } : { ok: true });
    }

    const mcpAction = path.match(/^\/api\/mcp\/(\d+)$/);
    if (mcpAction) {
      const id = Number(mcpAction[1]);
      const server = store.mcp.get(id);
      if (!server) return json(res, 404, { error: "Serveur introuvable" });
      if (body.action === "test") {
        const check = await probeMcp(server);
        store.mcp.recordCheck(id, check);
        return json(res, 200, { ok: check.ok, error: check.error });
      }
      if (body.action === "enable" || body.action === "disable") store.mcp.setEnabled(id, body.action === "enable");
      else if (body.action === "trust-read" || body.action === "trust-ask") store.mcp.setTrust(id, body.action === "trust-read" ? "read" : "ask");
      else if (body.action === "delete") store.mcp.remove(id);
      else throw new HttpError(400, "Action inconnue");
      return json(res, 200, { ok: true });
    }

    // Sélecteur de modèle : n'importe quel modèle d'une IA connectée. Si elle n'est pas le moteur principal,
    // elle le devient tout de suite (sans redémarrer), et le choix est gardé (Réglages › Moteurs).
    if (path === "/api/engines/main") {
      const name = body.engine === "claude" || body.engine === "codex" ? body.engine : null;
      if (!name) throw new HttpError(400, "Moteur inconnu");
      const model = typeof body.model === "string" && body.model ? body.model : null;
      const from = typeof body.from === "string" ? body.from.slice(0, 40) : "interface";
      if (model) {
        const bad = hub.setChoice(name, { model, effort: null }, "model", from);
        if (bad) throw new HttpError(400, bad);
      }
      const error = hub.setMainEngine(name);
      if (error) throw new HttpError(409, error);
      opts.settings?.set("engine", name, hub.deps.config);
      return json(res, 200, { ok: true });
    }

    const engineChoice = path.match(/^\/api\/engines\/(claude|codex)$/);
    if (engineChoice) {
      const model = typeof body.model === "string" && body.model ? body.model : null;
      const effort = typeof body.effort === "string" && body.effort ? body.effort : null;
      const reason = body.reason === "model" ? "model" : "effort";
      const from = typeof body.from === "string" ? body.from.slice(0, 40) : "interface";
      const error = hub.setChoice(engineChoice[1] as "claude" | "codex", { model, effort }, reason, from);
      if (error) throw new HttpError(400, error);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/engines/refresh") {
      await hub.refreshEngines();
      return json(res, 200, { ok: true });
    }

    const mail = path.match(/^\/api\/mails\/(\d+)$/);
    if (mail) {
      if (body.action !== "send" && body.action !== "refuse") throw new HttpError(400, "Action inconnue");
      const outcome = await hub.decideMail(Number(mail[1]), body.action);
      if (outcome === "already") return json(res, 409, { error: "Ce mail a déjà été traité." });
      if (outcome === "failed") return json(res, 502, { error: "L'envoi a échoué : le détail est dans le fil." });
      return json(res, 200, { ok: true, outcome });
    }

    // Idées : en ajouter une (en vrac), lancer le tour, régler les sites, trier.
    if (path === "/api/ideas") {
      const text = typeof body.text === "string" ? body.text.slice(0, 2000) : "";
      const r = addIdeaFromOwner(hub, text, body.dig !== false, body.kind === "design" ? "design" : body.kind === "projet" ? "projet" : undefined);
      return "error" in r ? json(res, r.status, { error: r.error }) : json(res, 200, { ok: true, id: r.id });
    }
    if (path === "/api/ideas/tour") {
      const r = runIdeasTourNow(hub);
      return json(res, r.ok ? 202 : 409, r.ok ? { ok: true } : { error: `Pas de tour maintenant : ${r.why}` });
    }
    if (path === "/api/ideas/sources") {
      const kind = body.kind === "design" ? "design" : "projet";
      const list = Array.isArray(body.sources) ? body.sources.filter((x): x is string => typeof x === "string") : [];
      return json(res, 200, { ok: true, sources: store.ideas.setSources(kind, list) });
    }
    const idea = path.match(/^\/api\/ideas\/(\d+)$/);
    if (idea) {
      const actions: IdeaAction[] = ["dig", "keep", "drop", "start", "reopen", "delete"];
      if (!actions.includes(body.action as IdeaAction)) throw new HttpError(400, "Action inconnue");
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined;
      const r = decideIdea(hub, Number(idea[1]), body.action as IdeaAction, reason);
      return "error" in r ? json(res, r.status, { error: r.error }) : json(res, 200, { ok: true });
    }

    if (path === "/api/heartbeat/run") {
      const r = runHeartbeatNow(hub);
      return json(res, r.ok ? 202 : 409, r.ok ? { ok: true } : { error: `Pas de tour maintenant : ${r.why}.` });
    }

    const question = path.match(/^\/api\/questions\/(\d+)$/);
    if (question) {
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      if (!answer) throw new HttpError(400, "Écris une réponse");
      if (answer.length > 2000) throw new HttpError(400, "Réponse trop longue (2000 caractères au plus)");
      const live = hub.answerQuestion(Number(question[1]), answer);
      return json(res, live ? 200 : 409, live ? { ok: true } : { error: "Cette question n'attend plus de réponse." });
    }

    const check = path.match(/^\/api\/tasks\/(\d+)$/);
    if (check) {
      if (body.action !== "resume" && body.action !== "drop") throw new HttpError(400, "Action inconnue");
      const outcome = hub.resolveCheck(Number(check[1]), body.action);
      return json(res, outcome === "already" ? 409 : 200, outcome === "already" ? { error: "Déjà traité." } : { ok: true, outcome });
    }

    const memory = path.match(/^\/api\/memories\/(\d+)$/);
    if (memory) {
      const action = body.action;
      if (action !== "confirm" && action !== "correct" && action !== "ignore") throw new HttpError(400, "Action inconnue");
      let correction: { content?: string; expiresAt?: string | null } | undefined;
      if (action === "correct") {
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (content.length < 3) throw new HttpError(400, "Le souvenir corrigé doit faire au moins 3 caractères");
        if (content.length > 1000) throw new HttpError(400, "Le souvenir corrigé est trop long (1000 caractères au plus)");
        const expiresAt = body.expiresAt === "" || body.expiresAt === null || body.expiresAt === undefined ? null : body.expiresAt;
        if (expiresAt !== null && (typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)))
          throw new HttpError(400, "Date d'expiration invalide");
        correction = { content, expiresAt };
      }
      const outcome = hub.resolveMemory(Number(memory[1]), action, correction);
      return json(res, outcome === "already" ? 409 : 200, outcome === "already" ? { error: "Cette proposition a déjà été traitée." } : { ok: true, outcome });
    }

    if (path === "/api/conversation/new") {
      const agent = body.agent === undefined || body.agent === null || body.agent === "clark" ? null : body.agent;
      if (agent !== null && !isConversationAgent(agent)) throw new HttpError(400, "Agent inconnu");
      await hub.newConversation(OWNER_CHAT, agent);
      return json(res, 200, { ok: true });
    }

    const agentOpen = path.match(/^\/api\/agents\/([a-z]+)\/open$/);
    if (agentOpen) {
      const role = agentOpen[1] === "clark" ? null : agentOpen[1];
      if (role !== null && !isConversationAgent(role)) throw new HttpError(404, "Agent inconnu");
      const r = hub.openAgent(role);
      // Occupé : on peut quand même relire sa dernière conversation, pas en changer.
      return json(res, r.result === "ok" ? 200 : 409, r.result === "ok" ? { ok: true, id: r.id } : { error: "Clark est en train de répondre : attends qu'il ait fini pour changer de conversation.", id: r.id });
    }

    const undo = path.match(/^\/api\/decisions\/(\d+)\/undo$/);
    if (undo) {
      const r = undoDecision(hub, Number(undo[1]));
      if (!r.ok) throw new HttpError(409, r.why);
      return json(res, 200, r);
    }

    const seen = path.match(/^\/api\/conversations\/(\d+)\/seen$/);
    if (seen) {
      hub.markSeen(Number(seen[1]));
      return json(res, 200, { ok: true });
    }

    const edit = path.match(/^\/api\/conversations\/(\d+)$/);
    if (edit) {
      const action = String(body.action ?? "");
      if (!["rename", "pin", "unpin", "delete"].includes(action)) throw new HttpError(400, "Action inconnue");
      const r = hub.editConversation(Number(edit[1]), action as "rename" | "pin" | "unpin" | "delete", typeof body.title === "string" ? body.title : "");
      if (r === "unknown") throw new HttpError(404, "Conversation introuvable");
      if (r === "invalid") throw new HttpError(400, "Donne un nom (80 caractères au plus).");
      if (r === "busy") throw new HttpError(409, "Clark est en train de répondre dans cette conversation : attends qu'il ait fini pour la supprimer.");
      return json(res, 200, { ok: true });
    }

    const reopen = path.match(/^\/api\/conversations\/(\d+)\/open$/);
    if (reopen) {
      const r = hub.switchConversation(Number(reopen[1]));
      if (r === "unknown") throw new HttpError(404, "Conversation introuvable");
      if (r === "busy") throw new HttpError(409, "Clark est en train de répondre ici : attends qu'il ait fini pour changer de conversation.");
      return json(res, 200, { ok: true });
    }

    throw new HttpError(404, "Introuvable");
  };

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("[clark] erreur de l'interface web :", err);
      if (!res.headersSent) json(res, status, { error: err instanceof HttpError ? err.message : "Erreur interne" });
      else res.end();
    });
  });

  return new Promise<{ url: string; close: () => Promise<void> }>((resolvePromise, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`Le port ${opts.port} est déjà pris : change CLARK_WEB_PORT dans .env.`) : err),
    );
    server.listen(opts.port, "127.0.0.1", () =>
      resolvePromise({
        url: `http://localhost:${opts.port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const res of streams) res.end();
            server.close(() => done());
          }),
      }),
    );
  });
}
