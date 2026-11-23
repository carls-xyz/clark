import { installLogRedaction } from "./core/redact.ts";
import { launchAutomation } from "./scheduler/automation-run.ts";
import { startPrWatch } from "./dev/pr.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, paths } from "./config.ts";
import { Conversation } from "./core/conversation.ts";
import { executeTask } from "./core/agent.ts";
import { createHub, OWNER_CHAT } from "./core/hub.ts";
import { createCodexEngine, LOGIN_COMMAND, loginCodexWithKey } from "./engines/codex.ts";
import { checkClaudeAuth, CLAUDE_LOGIN_COMMAND, setClaudeAuth } from "./engines/claude-auth.ts";
import { onClaudeLimit, probeClaude } from "./engines/claude-probe.ts";
import { canRestart, createLogins, RESTART_EXIT_CODE } from "./engines/login.ts";
import { startAutonomy } from "./core/autonomy.ts";
import { startReminders } from "./core/reminders.ts";
import { startDelegations } from "./core/delegation-runner.ts";
import { startBackups } from "./core/backup.ts";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { Terminal } from "./terminal/terminal.ts";
import { vaultPath, VaultSync } from "./obsidian/vault.ts";
import { relatedNotes, setRelatedFinder } from "./obsidian/related.ts";
import { semanticOf, stopEmbedder } from "./memory/semantic.ts";
import { claudeJudge, claudeThink } from "./engines/judge.ts";
import { startMemoryReview } from "./core/memory-review.ts";
import { parisDay, startDailyJournal, writeJournalNow } from "./core/daily-journal.ts";
import { startTopics, topicsOf } from "./obsidian/topics.ts";
import { startWorktreeSweep } from "./dev/cleanup.ts";
import type { Quota } from "./engines/quota.ts";
import { createTelegram } from "./gateway/telegram.ts";
import { ChromeDriver } from "./browser/driver.ts";
import { BrowserService, setBrowser } from "./browser/service.ts";
import { MacMessages } from "./imessage/backend.ts";
import { MessagesService, setMessages } from "./imessage/service.ts";
import { connectIMessage } from "./gateway/imessage.ts";
import { Plugins } from "./plugins/plugins.ts";
import { listSkills, ownCommands } from "./skills/library.ts";
import { PreviewService } from "./dev/preview.ts";
import { startWeb } from "./gateway/web.ts";
import { Store } from "./memory/store.ts";
import { startScheduler } from "./scheduler/cron.ts";
import { startHeartbeat } from "./scheduler/heartbeat.ts";
import { startIdeasTour } from "./scheduler/ideas.ts";
import { startGoals } from "./scheduler/goals.ts";
import { startDev } from "./dev/runner.ts";
import { startDevGroups } from "./dev/groups.ts";
import { TaskJournal } from "./tasks/journal.ts";
import { Settings } from "./core/settings.ts";
import { NotifyStore, setNotifyStore, startAwake, startQuietDigest } from "./core/notify.ts";
import { takeRollbackNote } from "./core/platform.ts";
import { AlertStore, startAlerts } from "./core/alerts.ts";
import { createPinger } from "./core/ping.ts";
import { cachedHealth } from "./core/health.ts";

// Le journal ne garde jamais un secret en clair (jeton Telegram dans une erreur réseau, clé d'API…).
installLogRedaction();

// La base d'abord : les réglages choisis dans l'interface passent devant .env.
const store = new Store(paths.db);
const settings = new Settings(store.db);
settings.applyToEnv();
const config = loadConfig();
mkdirSync(paths.workspace, { recursive: true });

// Accès à Claude : clé API, ou ton abonnement connecté dans le dossier Claude de Clark.
const claude = checkClaudeAuth(config.hasApiKey);
setClaudeAuth(claude);

const journal = new TaskJournal(store.db);
const conversation = new Conversation(store.db);
// Messages rangés avant les règles actuelles (avis du groupe, tour de veille) : remis à leur place.
const repaired = conversation.repairTaskMessages();
if (repaired) console.log(`[clark] conversations : ${repaired} message(s) remis dans la conversation de leur tâche`);
// Le quota arrive par le moteur (lecture, puis mises à jour de Codex) ; le hub le garde pour l'interface.
let onQuota: (q: Quota | null) => void = () => {};
// Codex est toujours proposé : on peut le choisir comme moteur principal à tout moment (sélecteur de modèle).
const codex = createCodexEngine({ model: config.codexModel, onQuota: (q) => onQuota(q) });
let codexStatus = await codex.status();
// Connexion par clé d'API : OPENAI_API_KEY dans .env, Codex pas encore connecté → on le connecte avec la clé.
if (!codexStatus.ready && codexStatus.problem === "not_logged_in" && process.env.OPENAI_API_KEY?.trim()) {
  const done = loginCodexWithKey(process.env.OPENAI_API_KEY.trim());
  console.log(done ? "[clark] Codex connecté avec la clé d'API (OPENAI_API_KEY)" : "[clark] Codex : connexion avec la clé d'API refusée");
  if (done) codexStatus = await codex.status();
}

// Pas de moteur choisi (sélecteur de modèle, ou CLARK_ENGINE) : celui qui est connecté. Les deux le sont :
// Claude, jusqu'à ce que tu en choisisses un autre (le choix est gardé). Aucun : Claude, l'interface propose les deux connexions.
if (config.engineAuto) config.engine = claude.mode !== "none" ? "claude" : codexStatus.ready ? "codex" : "claude";

// Mac de 8 Go : Codex ni connecté ni demandé par un rôle → son processus ne reste pas en mémoire.
// (Il se relancerait tout seul au premier usage.)
if (!codexStatus.ready && config.engine !== "codex" && !Object.values(config.roleEngines).includes("codex")) codex.close();
// Claude n'est disponible qu'avec une clé API ; sinon les rôles qui le demandent prennent le moteur principal.
const executors = { ...(claude.mode !== "none" ? { claude: executeTask } : {}), codex: codex.execute };
/** Claude : modèles proposés et usage du forfait, lus sans envoyer de message. */
const refreshClaude = async (): Promise<Quota | null> => {
  const auth = checkClaudeAuth(config.hasApiKey);
  const account = auth.mode === "api" ? "clé API" : auth.plan ?? (auth.mode === "subscription" ? "abonnement Claude" : null);
  const problem = auth.mode !== "none" ? null : `pas connecté. Lance une fois : ${CLAUDE_LOGIN_COMMAND}`;
  hub.setConnection("claude", { ready: auth.mode !== "none", account, problem });
  try {
    const r = await probeClaude();
    hub.setCatalog("claude", { models: r.models, readAt: Date.now() });
    if (auth.mode === "subscription") hub.setQuota(r.quota, "claude");
    return r.quota;
  } catch (err) {
    hub.setCatalog("claude", null, err instanceof Error ? err.message : String(err));
    throw err;
  }
};
/** Codex : connexion, modèles et quota de ton compte ChatGPT. */
const refreshCodex = async (): Promise<void> => {
  const s = await codex.status();
  hub.setConnection("codex", {
    ready: s.ready,
    account: s.account,
    problem: s.ready ? null : s.problem === "not_logged_in" ? `pas connecté. Lance une fois : ${LOGIN_COMMAND}` : s.problem,
  });
  try {
    hub.setCatalog("codex", { models: await codex.models(), readAt: Date.now() });
  } catch (err) {
    hub.setCatalog("codex", null, err instanceof Error ? err.message : String(err));
  }
  if (s.ready) await codex.quota().catch((err) => console.warn("[clark] quota Codex non relu :", err instanceof Error ? err.message : err));
  // Codex pas connecté et pas utilisé : on ne le garde pas lancé entre deux relectures.
  if (!s.ready && config.engine !== "codex" && !Object.values(config.roleEngines).includes("codex")) codex.close();
};
const refreshEngines = async () => {
  await Promise.all([refreshClaude().catch((err) => console.warn("[clark] Claude non relu :", err instanceof Error ? err.message : err)), refreshCodex()]);
};

const hub = createHub(
  { config, store, journal, conversation },
  {
    execute: config.engine === "codex" ? codex.execute : executeTask,
    executors,
    // Quota du moteur principal du moment (il peut changer à chaud).
    refreshQuota: async () => (config.engine === "codex" ? codex.quota() : claude.mode === "subscription" ? refreshClaude() : null),
    refreshEngines,
    // Vérification de fin de tâche : un petit modèle Claude, si Claude est disponible.
    ...(claude.mode !== "none" ? { judge: claudeJudge, titler: claudeJudge } : {}),
  },
);
onQuota = (q) => hub.setQuota(q, "codex");
// Limite atteinte pendant une tâche Claude : notée tout de suite, puis relue.
onClaudeLimit((info) => {
  if (info.status !== "rejected") return;
  hub.markLimitReached("claude", info.resetsAt ? info.resetsAt * (info.resetsAt > 1e12 ? 1 : 1000) : null);
  void refreshClaude().catch(() => {});
});
// Le navigateur de Clark : un seul, tenu ici, pour les deux moteurs (Codex passe par l'adresse interne).
const browser = new BrowserService({
  driver: new ChromeDriver(),
  approve: (taskId, req) => hub.approveTask(taskId, req),
  taskAlive: (id) => ["queued", "running"].includes(journal.get(id)?.status ?? ""),
  onChange: () => hub.touch(),
});
setBrowser(browser);
// iMessage : tes conversations (lecture, envoi avec accord) et, si CLARK_IMESSAGE_SELF est réglé, un canal pour parler à Clark.
const messages = new MessagesService(new MacMessages(), store.db, { self: process.env.CLARK_IMESSAGE_SELF });
setMessages(messages);
connectIMessage(hub, messages);
const bot = config.telegram ? createTelegram(hub, config.telegram) : null;
let stopScheduler = () => {};

// L'interface démarre avant la reprise : une validation redemandée doit pouvoir s'y afficher.
// Plugins : relus par l'utilisateur avant installation ; leurs commandes, skills et serveurs MCP rejoignent les siens.
const plugins = new Plugins({
  mcp: store.mcp,
  ownCommands: () => ownCommands().map((c) => c.name),
  otherSkills: () => listSkills().filter((s) => s.source !== "plugin").map((s) => s.name),
});
plugins.onChange(() => hub.touch());
// Notifications : où part quoi, heures calmes (résumé à la fin), Mac tenu éveillé pendant le travail.
const notifyStore = new NotifyStore(store.db);
setNotifyStore(notifyStore);
startQuietDigest((text) => void hub.post(OWNER_CHAT, text, "system", "digest"));
startAwake(() => journal.unfinished().some((t) => t.status === "running"));
// Mode design : l'aperçu des copies, sur son propre port (une autre origine que l'interface).
const preview = new PreviewService(hub, { port: Number(process.env.CLARK_PREVIEW_PORT) || 4320, webOrigins: [`http://127.0.0.1:${config.webPort}`, `http://localhost:${config.webPort}`] });
const previewReady = await preview.listen().then(
  () => true,
  (err) => (console.warn("[clark] aperçu (mode design) indisponible :", err instanceof Error ? err.message : err), false),
);
// Connexion d'un moteur par un bouton : la commande officielle, lancée par Clark. Un moteur
// connecté après le démarrage ne sert qu'au redémarrage suivant (moteurs choisis au lancement).
const readyAtStart = { claude: claude.mode !== "none", codex: Boolean(codexStatus?.ready) };
const logins = createLogins({
  onChange: () => hub.touch(),
  onDone: async () => {
    await refreshEngines();
    hub.touch();
  },
});
// Obsidian : la mémoire de Clark en notes liées dans le coffre de l'utilisateur, dans les deux sens.
const vault = vaultPath();
const obsidian = { vault, lastSync: null as string | null, error: null as string | null, notes: 0 };
let vaultSync: VaultSync | null = null;
let syncTimer: NodeJS.Timeout | null = null;
// Recherche par le sens : l'index suit les souvenirs et le coffre (le modèle ne tourne que le temps du calcul).
const semantic = semanticOf(store);
const noteOfMemory = store.db.prepare("SELECT file FROM obsidian_notes WHERE memory_id = ?");
setRelatedFinder((m) =>
  semantic
    .neighbours(m.id)
    .map((id) => (noteOfMemory.get(id) as { file: string } | undefined)?.file)
    .filter((f): f is string => Boolean(f))
    .map((f) => basename(f, ".md")),
);
let semanticRunning = false;
const refreshSemantic = async () => {
  if (semanticRunning) return;
  semanticRunning = true;
  try {
    const changed = await semantic.refresh(vault);
    // De nouveaux vecteurs : les liens « Proche de » des notes peuvent changer.
    if (changed && vaultSync) vaultSync.sync();
  } catch (err) {
    console.error("[clark] recherche par le sens :", err instanceof Error ? err.message : err);
  } finally {
    semanticRunning = false;
  }
};
const syncVault = () => {
  if (!vaultSync) return void refreshSemantic();
  try {
    const r = vaultSync.sync();
    obsidian.lastSync = new Date().toISOString();
    obsidian.error = null;
    obsidian.notes = (store.db.prepare("SELECT count(*) AS n FROM obsidian_notes").get() as { n: number }).n;
    if (r.edited || r.forgotten || r.learned) hub.touch();
    void refreshSemantic();
  } catch (err) {
    obsidian.error = err instanceof Error ? err.message : String(err);
    console.error("[clark] obsidian :", obsidian.error);
  }
};
if (!vault) {
  // Sans coffre, l'index suit quand même les souvenirs (recall par le sens).
  store.onMemory(() => void refreshSemantic());
  setTimeout(() => void refreshSemantic(), 30_000).unref();
}
if (vault) {
  vaultSync = new VaultSync(store, vault, {
    related: (m) => relatedNotes(m),
    topics: (m) => topicsOf(store.db).of(m.id),
    log: (msg) => console.log(`[clark] obsidian : ${msg}`),
  });
  syncVault();
  // Un souvenir change chez Clark : la note suit (regroupé) ; tes changements dans Obsidian : relus toutes les 2 min.
  store.onMemory(() => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncVault, 3000);
    syncTimer.unref();
  });
  setInterval(syncVault, 2 * 60_000).unref();
  console.log(`[clark] obsidian : ${vault}`);
}

// Terminal de l'utilisateur (interface web du Mac) : ses commandes, et celles que Clark propose.
const terminal = new Terminal({ cwd: join(homedir(), "Developer"), onChange: () => hub.touch() });
store.terminal.expireStale(); // celles d'avant le redémarrage : plus personne pour cliquer
const announced = new Set<number>();
const terminalWatch = setInterval(() => {
  for (const r of store.terminal.pending()) {
    if (announced.has(r.id)) continue;
    announced.add(r.id);
    // Une note dans le fil (et sur Telegram, pour prévenir) ; le bouton Lancer n'existe que sur le Mac.
    void hub.post(OWNER_CHAT, `Je propose de lancer dans ton Terminal : ${r.command}\nDossier : ${r.cwd}${r.reason ? `\nPourquoi : ${r.reason}` : ""}\nÀ valider dans Terminal, sur ton Mac.`, "system", "approval");
  }
}, 1000);
terminalWatch.unref();

// Le journal du jour : même consigne pour le bouton de Réglages › Connexions et pour celui du soir.
const JOURNAL_SYSTEM = "Tu écris le journal (du jour ou de la semaine) d'un assistant personnel, en Markdown, uniquement à partir des faits donnés.";
// Défini avant startWeb : le bouton « Écrire le journal du jour » s'en sert.
const journalThink = (p: string) => claudeThink(p, JOURNAL_SYSTEM);

// Santé (page, alertes, ping externe) : un seul relevé partagé, gardé 20 s.
const alertStore = new AlertStore(store.db);
let pinger: ReturnType<typeof createPinger> | null = null;
const health = cachedHealth(hub, {
  root: paths.root,
  logFile: join(paths.root, "data", "logs", "clark.log"),
  backupDir: join(paths.root, "data", "backups"),
  alerts: () => alertStore.get(),
  ping: () => pinger?.status() ?? { configured: false, lastOk: null, failing: false, lastError: null },
});
pinger = createPinger({ level: () => health().level });

const web = await startWeb(hub, {
  health,
  terminal,
  obsidian: {
    status: () => obsidian,
    syncNow: syncVault,
    ...(claude.mode !== "none" ? { writeJournal: () => writeJournalNow(hub, parisDay(new Date()), journalThink, vault) } : {}),
  },
  port: config.webPort,
  browser,
  messages,
  plugins,
  settings,
  notify: notifyStore,
  ...(previewReady ? { preview } : {}),
  engineLogin: { logins, readyAtStart, restart: canRestart() ? () => void shutdown(RESTART_EXIT_CODE) : null },
});

const shutdown = async (code = 0) => {
  console.log("[clark] arrêt…");
  stopScheduler();
  logins.close();
  codex?.close();
  clearInterval(terminalWatch);
  stopJournal();
  stopTopics();
  stopEmbedder();
  terminal.stopAll();
  await browser.close();
  await preview.stop();
  messages.stop();
  await bot?.stop();
  await web.close();
  store.db.close();
  // Code non nul : launchd relance Clark (redémarrage demandé après une connexion).
  process.exit(code);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Moteur : vérifié avant la reprise, pour que l'interface dise tout de suite ce qui bloque.
if (config.engine === "codex") {
  const s = codexStatus;
  const problem = s.ready
    ? null
    : s.problem === "not_logged_in"
      ? `Clark n'est pas encore connecté à ChatGPT. Lance une fois dans un terminal : ${LOGIN_COMMAND}`
      : `Codex ne démarre pas : ${s.problem}`;
  hub.setEngine({ name: "codex", model: config.codexModel ?? "modèle Codex par défaut", ready: s.ready, account: s.account, problem });
  if (s.ready) await codex.quota().catch((err) => console.warn("[clark] quota non lu au démarrage :", err instanceof Error ? err.message : err));
  console.log(s.ready ? `[clark] moteur : Codex (${s.account})` : `[clark] moteur : Codex, ${problem}`);
} else {
  const problem =
    claude.mode !== "none"
      ? null
      : claude.problem === "not_logged_in"
        ? `Clark n'est pas encore connecté à ton compte Claude. Lance une fois dans un terminal : ${CLAUDE_LOGIN_COMMAND}`
        : `Claude Code ne répond pas : ${claude.problem}`;
  const account = claude.mode === "api" ? "clé API" : claude.plan ?? (claude.mode === "subscription" ? "abonnement Claude" : null);
  hub.setEngine({ name: "claude", model: config.model, ready: claude.mode !== "none", account, problem });
  console.log(problem ? `[clark] moteur : Claude, ${problem}` : `[clark] moteur : Claude (${account})`);
  // Codex utilisé pour certains rôles : on lit aussi son quota.
  if (codexStatus.ready) await codex.quota().catch(() => {});
}

// Reprend les tâches coupées avant d'accepter de nouveaux messages.
await refreshEngines();
// Les quotas bougent : relus tous les quarts d'heure (sans message au modèle, rien n'est consommé).
const quotaTimer = setInterval(() => void refreshEngines(), 15 * 60_000);
quotaTimer.unref();

await hub.recover();
// Version de secours : scripts/service.sh est revenu à la dernière version qui démarrait ; on le dit.
// Démarré à… : la surveillance locale (scripts/watchdog.sh) laisse 3 minutes de grâce après un démarrage.
writeFileSync(join(paths.root, "data", "started-at"), String(Math.floor(Date.now() / 1000)));
// Version de secours : scripts/service.sh est revenu à la dernière version qui démarrait. C'est la première
// alerte, et elle est notée comme signalée : la surveillance ne la renverra pas.
const rollback = takeRollbackNote(join(paths.root, "data", "rollback.txt"));
if (rollback) {
  alertStore.markActive("secours", rollback, true);
  void hub.post(OWNER_CHAT, rollback, "system", "alert");
}
// Relancé par la surveillance locale (Clark ne répondait plus) : on le dit.
const watchdogNote = join(paths.root, "data", "watchdog-restart.txt");
if (existsSync(watchdogNote)) {
  const at = readFileSync(watchdogNote, "utf8").trim();
  rmSync(watchdogNote, { force: true });
  void hub.post(OWNER_CHAT, `Je ne répondais plus : la surveillance locale m'a relancé${at ? ` (${new Date(at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })})` : ""}. Le journal dit peut-être pourquoi (scripts/service.sh logs).`, "system", "health");
}
// Alertes de santé (Telegram, selon Réglages › Notifications) et ping externe (CLARK_PING_URL).
const stopAlerts = startAlerts({ store: alertStore, report: () => health(true), post: (text, urgent) => void hub.post(OWNER_CHAT, text, "system", urgent ? "alert" : "health") });
const stopPing = pinger.start();
const stopAutomations = startScheduler({ config, store, enqueue: hub.enqueue, automations: store.automations, launch: (a, slot) => launchAutomation(hub, a, { slot }) });
// Tour de veille : propositions proactives, de jour, quand un moteur est connecté.
const stopHeartbeat = startHeartbeat(hub);
const stopIdeasTour = startIdeasTour(hub);
// Autonomie : ce que l'utilisateur a permis à Clark de décider seul (Réglages › Général › Autonomie).
const stopAutonomy = startAutonomy(hub);
// Rappels créés depuis la conversation (« rappelle-moi demain à 9 h… »).
const stopReminders = startReminders(hub);
// Clark chef d'orchestre : missions confiées aux agents, tâches de code lancées pour lui.
const stopDelegations = startDelegations(hub);
// Sauvegarde de la base chaque nuit à 3 h (data/backups, les 7 dernières).
const stopBackups = startBackups(store.db, join(paths.root, "data", "backups"));
// Relecture de mémoire en arrière-plan (un petit modèle Claude, si Claude est disponible).
// Mémoire de moyen terme : le journal du jour, écrit chaque soir (dans Obsidian s'il y a un coffre).
const stopJournal =
  claude.mode !== "none"
    ? startDailyJournal(hub, journalThink, () => vault)
    : () => {};
// Notes par sujet : les souvenirs regroupés (« Portfolio », « Boîte mail »…), dans « Clark/Sujets ».
const stopTopics =
  claude.mode !== "none"
    ? startTopics(store, (p) => claudeThink(p, "Tu ranges des souvenirs par sujets. Tu réponds uniquement par un bloc JSON."), () => vault, () => vaultSync?.sync())
    : () => {};
const stopReview = claude.mode !== "none" ? startMemoryReview(hub, (p) => claudeThink(p, "Tu relis une conversation pour en tirer des souvenirs durables. Tu réponds uniquement par un bloc JSON.")) : () => {};
startGoals(hub);
startDevGroups(hub);
startDev(hub);
// Copies de tâches dev oubliées : retirées si rien d'irremplaçable dedans.
const stopSweep = startWorktreeSweep(hub);
// Les PR ouvertes sont relues toutes les 3 minutes : CI, reviews, merge.
startPrWatch(hub);
stopScheduler = () => {
  stopAutomations();
  stopHeartbeat();
  stopIdeasTour();
  stopAutonomy();
  stopReminders();
  stopDelegations();
  stopBackups();
  stopReview();
  stopSweep();
  stopAlerts();
  stopPing();
};

console.log(`[clark] démarré — moteur ${hub.engine().name} (${hub.engine().model}), ${store.count()} souvenirs`);
console.log(`[clark] interface : ${web.url}`);
console.log(bot ? "[clark] Telegram : actif" : "[clark] Telegram : non configuré (facultatif)");
for (const r of hub.roleEngines().filter((r) => r.special)) {
  console.log(`[clark] moteur du rôle ${r.role} : ${r.actual}${r.actual !== r.wanted ? ` (demandé : ${r.wanted}, indisponible)` : ""}`);
}

// Les messages envoyés sur Telegram pendant que Clark était éteint sont traités, pas jetés.
if (bot) await bot.start({ drop_pending_updates: false });
