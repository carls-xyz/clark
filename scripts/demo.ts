// Démo de l'interface, sans clé API : un faux agent et des données fictives.
// Rien n'est lu, écrit ni envoyé pour de vrai. La base de démo (data/demo.db) survit
// à un redémarrage, pour tester la reprise et la mémoire.
// Lancer : npm run demo — repartir de zéro : npm run demo -- --reset
import { launchAutomation } from "../src/scheduler/automation-run.ts";
import { startPrWatch } from "../src/dev/pr.ts";
import { execFileSync, spawn } from "node:child_process";
import { createLogins } from "../src/engines/login.ts";
import { startAutonomy } from "../src/core/autonomy.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { addProject, startDev } from "../src/dev/runner.ts";

// Démo : les copies des tâches dev vont dans un dossier temporaire, pas dans le vrai workspace.
process.env.CLARK_DEV_DIR ??= join(tmpdir(), "clark-demo-worktrees");
// La démo ne touche pas à ta vraie personnalité.
process.env.CLARK_PERSONALITY_FILE ??= join(tmpdir(), "clark-demo-personnalite.md");
// Ni ton profil de navigateur : celui de la démo est jetable.
process.env.CLARK_BROWSER_PROFILE ??= join(tmpdir(), "clark-demo-browser");
// Ni tes plugins : ceux de la démo vivent à part.
process.env.CLARK_PLUGINS_DIR ??= join(tmpdir(), "clark-demo-plugins");
// Ni ton coffre Obsidian : la démo écrit dans un coffre jetable.
process.env.CLARK_OBSIDIAN_VAULT ??= join(tmpdir(), "clark-demo-vault");
mkdirSync(process.env.CLARK_OBSIDIAN_VAULT, { recursive: true });
// Démo : un faux GitHub (aucun appel réseau), et des PR relues toutes les minutes.
process.env.CLARK_GH_BIN ??= join(paths.root, "scripts/fake-gh.mjs");
process.env.FAKE_GH_STATE ??= join(tmpdir(), "clark-demo-gh.json");
process.env.FAKE_GH_ORIGIN ??= join(tmpdir(), "clark-demo-origin.git");
process.env.CLARK_PR_POLL_MINUTES ??= "1";
// Démo : un agent silencieux est signalé au bout d'une minute (10 en vrai).
process.env.CLARK_STALL_MINUTES ??= "1";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { startGoals } from "../src/scheduler/goals.ts";
import { PreviewService } from "../src/dev/preview.ts";
import { startWeb } from "../src/gateway/web.ts";
import { startScheduler } from "../src/scheduler/cron.ts";
import { Store } from "../src/memory/store.ts";
import { formatMemories, memoryTools, type GoogleApi } from "../src/memory/tools.ts";
import type { MailFull } from "../src/google/gmail.ts";
import { classify } from "../src/policy/permissions.ts";
import { TaskJournal } from "../src/tasks/journal.ts";
import { createServer } from "node:http";
import { ChromeDriver } from "../src/browser/driver.ts";
import { BrowserService, setBrowser } from "../src/browser/service.ts";
import { MemoryMessages } from "../src/imessage/memory-backend.ts";
import { onStop } from "../src/core/stops.ts";
import { Settings } from "../src/core/settings.ts";
import { NotifyStore, setNotifyStore, startQuietDigest } from "../src/core/notify.ts";
import { MessagesService, setMessages } from "../src/imessage/service.ts";
import { connectIMessage } from "../src/gateway/imessage.ts";
import { Plugins } from "../src/plugins/plugins.ts";
import { listSkills, ownCommands } from "../src/skills/library.ts";

const port = Number(process.env.CLARK_WEB_PORT || 4311);
const DEMO_LOGIN = process.env.CLARK_DEMO_LOGIN === "1";
const DEMO_SITE_PORT = port + 2;
// CLARK_DEMO_DB : une deuxième démo à côté de la première, sans partager sa base.
const dbPath = process.env.CLARK_DEMO_DB || join(paths.root, "data/demo.db");
if (process.argv.includes("--reset")) for (const f of ["", "-wal", "-shm"]) rmSync(dbPath + f, { force: true });
const fresh = !existsSync(dbPath);
const store = new Store(dbPath);
const journal = new TaskJournal(store.db);
const conversation = new Conversation(store.db);
const config: Config = {
  telegram: null,
  hasApiKey: false,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 240,
  roleEngines: {},
  webPort: port,
  model: "claude-opus-5-5",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOTS = ["/workspace"];

const DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

/**
 * Faux agent. Selon le message :
 * - « mes relances se font le lundi » : il propose un souvenir (ou une correction) ;
 * - « quel jour pour mes relances ? » : il cherche dans les souvenirs confirmés et cite la source ;
 * - « commande » : il demande une validation ;
 * - sinon : il lit les notes de candidature.
 */
const fakeExecute: typeof executeTask = async (deps, taskId, opts) => {
  const { journal } = deps;
  journal.setStatus(taskId, "running");
  let n = 0;
  const step = async (tool: string, input: Record<string, unknown>, output: string) => {
    const id = `demo-${taskId}-${n++}`;
    journal.announceStep({ taskId, toolUseId: id, tool, input, tier: classify(tool, input, ROOTS) });
    await sleep(900);
    journal.completeStep(id, output, false);
  };

  // Côté dev, plan : deux sous-tâches sur des fichiers différents.
  if (opts.prompt.startsWith("[Plan dev")) {
    await step("Glob", { path: opts.cwd }, "index.html, style.css");
    const text = JSON.stringify({
      tasks: [
        { title: "Contraste du texte secondaire", instruction: "Fonce la couleur du texte secondaire (.muted) dans style.css pour un contraste AA.", files: ["style.css"], after: [] },
        { title: "Titre de section", instruction: "Ajoute un titre de section « Contact » dans index.html, sous les projets.", files: ["index.html"], after: [] },
        { title: "Lien vers la section", instruction: "Ajoute dans le menu de index.html un lien vers le nouveau titre de section.", files: ["index.html"], after: [2] },
      ],
      decisions: [{ question: "Le lien du menu : « Contact » ou « Me contacter » ?", options: ["Contact", "Me contacter"], tasks: [3] }],
    });
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" as const };
  }

  // Côté dev : le faux agent modifie vraiment des fichiers dans sa copie du dépôt.
  if (opts.prompt.startsWith("[Tâche dev #") || /^(Charles est revenu à l'état[^\n]*\n\n)?(Retouche demandée par Charles pour la tâche dev|Relecture de Charles pour la tâche dev)/.test(opts.prompt))
    return fakeDevTurn(deps, taskId, opts, step);

  // Mode objectif : un tour qui avance, puis un tour qui conclut (ou bloque sur une question).
  if (opts.prompt.startsWith("[Objectif de Clark #")) return fakeGoalTurn(deps, taskId, opts.prompt, step);

  // Tour de veille : Clark cherche dans sa mémoire et fait deux propositions.
  if (opts.prompt.startsWith("[Tour de veille de Clark]")) return fakeHeartbeat(deps, taskId, step);
  // Tour d'idées et recherche sur une idée : le navigateur, puis des idées notées ou un avis.
  if (opts.prompt.startsWith("[Tour d'idées]")) return fakeIdeasTour(deps, taskId, step);
  if (/^\[Idée #\d+ à creuser\]/.test(opts.prompt)) return fakeIdeaDig(deps, taskId, opts.prompt, step);

  // Réseaux sociaux : une vidéo de démo produit, montée pour de vrai avec ffmpeg.
  if (/vid[ée]o|tiktok/i.test(opts.prompt) && !opts.prompt.includes("[Équipe de Clark")) return fakeVideo(deps, taskId, opts.prompt, step);

  // Équipe composée par Clark (plan, spécialistes, synthèse) : reconnue à ses repères.
  if (/\[Équipe de Clark — (Plan|Synthèse)\]|Livrable attendu :/.test(opts.prompt)) return fakePlanned(deps, taskId, opts, step);

  // Discussion directe avec un agent de l'équipe : il répond en son nom.
  const direct = opts.prompt.match(/^\[Discussion directe — ([^\]]+)\]/);
  if (direct) {
    const who = direct[1];
    await step(who === "Rédacteur" ? "Write" : "Read", who === "Rédacteur" ? { file_path: "/workspace/brouillon.md" } : { file_path: "/workspace/candidatures/note-1-studio-pixel.md" }, "ok");
    const replies: Record<string, string> = {
      Chercheur: "Ici le Chercheur. J'ai relu tes notes : Studio Pixel attend ta relance le 20 novembre, la date Banque du Nord reste à confirmer (25 ou 26). Source : candidatures/note-1 et note-2.",
      "Rédacteur": "Ici le Rédacteur. J'ai écrit un premier jet dans brouillon.md : trois relances courtes, un ton direct. Dis-moi si tu veux plus formel.",
      Relecteur: "Ici le Relecteur. Je n'ai rien à relire pour l'instant. Envoie-moi un texte, ou demande au Rédacteur de m'en passer un.",
      "Spécialiste Contenu": "Ici le Spécialiste Contenu. Ta page À propos est claire, mais trop longue : je couperais le deuxième paragraphe.",
    };
    const text = `${replies[who] ?? `Ici le ${who}.`} (Données fictives de la démo.)`;
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" as const };
  }

  // Équipe : le rôle est reconnu à son repère, même dans une consigne de reprise.
  const role = (["Chercheur", "Rédacteur", "Relecteur"] as const).find((r) => opts.prompt.includes(`[Équipe de Clark — ${r}]`));
  if (role) return fakeTeamAgent(deps, taskId, opts.prompt, role, step, opts.keepOpen === true);

  const prompt = opts.prompt.startsWith("[Message système") ? "" : opts.prompt;
  if (/\bmails?\b/i.test(prompt)) return fakeMail(deps, taskId, step);
  if (/\b(site|navigue|formulaire|navigateur)\b/i.test(prompt)) return fakeBrowse(deps, taskId);
  if (/\b(imessages?|sms|textos?|messages?)\b/i.test(prompt)) return fakeIMessage(deps, taskId);
  const day = DAYS.find((d) => new RegExp(`\\b${d}\\b`, "i").test(prompt));

  if (/relance/i.test(prompt) && /\?/.test(prompt)) {
    const found = deps.store.recall("relances", 3).filter((m) => /se font/.test(m.content));
    await step("mcp__memory__recall", { query: "relances jour" }, found.length ? formatMemories(found) : "Aucun souvenir confirmé trouvé.");
    const m = found[0];
    const text = m
      ? `Tes relances se font **${m.content.replace(/^Mes relances se font /, "")}**.\n\nD'où je le tiens : ${m.source ?? "provenance inconnue"}${m.original_content ? `. Tu avais corrigé ma proposition (« ${m.original_content} »)` : ""}${m.confirmed_at ? `, confirmé le ${m.confirmed_at.slice(0, 10)}` : ""}.`
      : "Je n'ai rien de confirmé sur le jour de tes relances. Si une proposition attend, elle n'est pas encore utilisée.";
    journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  }

  if (/relance/i.test(prompt) && day) {
    const content = `Mes relances se font le ${day}`;
    const source = `Charles, conversation du ${new Date().toISOString().slice(0, 10)} : « ${prompt.slice(0, 120)} »`;
    const current = deps.store.recall("relances", 3).find((m) => /^Mes relances se font/.test(m.content));
    const id = `demo-${taskId}-${n++}`;
    const input = current ? { id: current.id, content, source } : { kind: "preference", content, source };
    const tool = current ? "mcp__memory__propose_correction" : "mcp__memory__propose_memory";
    journal.announceStep({ taskId, toolUseId: id, tool, input, tier: "auto" });
    await sleep(600);
    const r = deps.store.propose({ kind: "preference", content, source, sourceTaskId: taskId, replacesId: current?.id });
    journal.completeStep(id, r.outcome, false);
    const text =
      r.outcome === "already_confirmed"
        ? "C'est déjà ce que j'ai en mémoire."
        : current
          ? `Je propose de corriger ce que j'ai (« ${current.content} »). D'ici ta confirmation, je garde l'ancienne version.`
          : "Je te propose de retenir ça. Tant que tu ne l'as pas confirmé, je ne m'en sers pas.";
    journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  }

  await step("mcp__memory__recall", { query: "candidatures relances" }, "2 souvenirs");
  if (/\bcommande\b/i.test(opts.prompt) && !opts.prompt.startsWith("[Message système")) {
    const ok = await opts.approve({ tool: "Bash", summary: "Commande shell :\nsleep 30 && date > ~/Desktop/clark-test.txt" });
    const text = ok ? "C'est lancé (démo : rien n'a réellement tourné)." : "D'accord, je ne lance rien.";
    journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  }
  for (const note of ["note-1-studio-pixel.md", "note-2-banque-nord.md", "note-3-agence-onde.md"]) {
    await step("Read", { file_path: `/workspace/candidatures/${note}` }, "…");
  }
  const text = `Point sur tes 3 candidatures (données fictives de la recette) :

- **Studio Pixel** : entretien passé le 12, pas de nouvelles. Relance le 20 novembre.
- **Banque du Nord** : entretien le 25 ou le 26 novembre, tes notes se contredisent. À confirmer avec \`rh@banquedunord.example\` avant de relancer.
- **Agence Onde** : dossier à envoyer avant le 30 novembre, il manque le portfolio.

Je propose de commencer par la Banque du Nord : c'est la seule date incertaine.`;
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" };
};

/**
 * Faux agent vidéo : trois clips de test (mires colorées générées par ffmpeg, à la place
 * de tes vrais clips), puis le vrai outil prepare_social_post : montage, textes, brouillon.
 */
/** Faux Gmail de la démo : deux mails fictifs, et aucun envoi réel. */
const DEMO_MAILS: MailFull[] = [
  {
    id: "demo1", threadId: "t1", from: "Léa Martin <lea@fournisseur-coussin.example>", to: "toi@example.com", cc: "", subject: "Votre demande de devis",
    date: "Wed, 18 Nov 2026 16:02:00 +0100", snippet: "Bonjour, merci pour votre demande. Pour 200 pièces…", unread: true, messageId: "<devis-1@fournisseur.example>", references: "",
    body: "Bonjour,\n\nMerci pour votre demande. Pour 200 pièces, le prix unitaire est de 11,40 € HT, livraison sous 3 semaines.\nPouvez-vous me confirmer la couleur souhaitée (gris ou beige) ?\n\nBien à vous,\nLéa", attachments: ["devis-coussin.pdf"],
  },
  {
    id: "demo2", threadId: "t2", from: "IIM <noreply@iim.example>", to: "toi@example.com", cc: "", subject: "Rendu Java Club : rappel",
    date: "Thu, 19 Nov 2026 08:10:00 +0100", snippet: "Rappel : le rendu du projet Java Club est attendu le 28 novembre.", unread: true, messageId: "<r@iim.example>", references: "",
    body: "Rappel : le rendu du projet Java Club est attendu le 28 novembre à 23 h 59.", attachments: [],
  },
];
const demoGoogle: GoogleApi = {
  connected: () => true,
  search: async () => DEMO_MAILS,
  read: async (id) => DEMO_MAILS.find((m) => m.id === id) ?? DEMO_MAILS[0],
  events: async () => [],
};

async function fakeMail(
  deps: Parameters<typeof executeTask>[0],
  taskId: number,
  step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>,
) {
  const { journal } = deps;
  const tools = memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null, google: demoGoogle });
  await step("mcp__memory__mail_search", { query: "is:unread newer_than:2d" }, await tools.mail_search.run({ query: "is:unread newer_than:2d" }));
  await step("mcp__memory__mail_read", { id: "demo1" }, await tools.mail_read.run({ id: "demo1" }));
  const id = `demo-${taskId}-mail`;
  const input = { to: "lea@fournisseur-coussin.example", reply_to_id: "demo1" };
  journal.announceStep({ taskId, toolUseId: id, tool: "mcp__memory__send_mail", input, tier: "auto" });
  const result = await tools.send_mail.run({
    to: "Léa Martin <lea@fournisseur-coussin.example>",
    reply_to_id: "demo1",
    body: "Bonjour Léa,\n\nMerci pour le devis. Ce sera le gris, pour 200 pièces.\nPouvez-vous m'envoyer la facture pro forma ?\n\nBonne journée,\nCharles",
  });
  journal.completeStep(id, result, false);
  const text = `Deux mails non lus : le devis du fournisseur (11,40 € HT la pièce, il attend ta couleur) et un rappel du rendu Java Club le 28 novembre.\n\n${result}`;
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

/** Navigateur : le faux agent pilote le vrai Chrome (profil jetable) sur un site fictif local. */
async function fakeBrowse(deps: Parameters<typeof executeTask>[0], taskId: number) {
  const { journal } = deps;
  const tools = memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null });
  let n = 0;
  const call = async (tool: string, input: Record<string, unknown>, run: () => Promise<string>) => {
    const id = `demo-${taskId}-b${n++}`;
    journal.announceStep({ taskId, toolUseId: id, tool: `mcp__memory__${tool}`, input, tier: "auto" });
    const out = await run();
    journal.completeStep(id, out, false);
    await sleep(700);
    return out;
  };
  const refOf = (page: string, name: string) => page.split("\n").find((l) => /^e\d+ · /.test(l) && l.includes(name))?.split(" · ")[0] ?? "e0";
  const url = `http://127.0.0.1:${DEMO_SITE_PORT}/`;
  let page = await call("browser_open", { url }, () => tools.browser_open.run({ url }));
  if (/n'est pas disponible|introuvable/.test(page)) {
    journal.finish(taskId, "done", page, 0);
    return { text: page, costUsd: 0, status: "done" as const };
  }
  page = await call("browser_type", { ref: refOf(page, "Nom"), text: "Charles" }, () => tools.browser_type.run({ ref: refOf(page, "Nom"), text: "Charles" }));
  const message = "Bonjour, je suis toujours intéressé par l'alternance chez vous. Avez-vous des nouvelles de ma candidature ?";
  page = await call("browser_type", { ref: refOf(page, "Ton message"), text: message }, () => tools.browser_type.run({ ref: refOf(page, "Ton message"), text: message }));
  // Une tentative de mot de passe, pour montrer le refus.
  const refused = await call("browser_type", { ref: refOf(page, "Mot de passe"), text: "••••" }, () => tools.browser_type.run({ ref: refOf(page, "Mot de passe"), text: "demo" }));
  page = await call("browser_click", { ref: refOf(page, "Envoyer") }, () => tools.browser_click.run({ ref: refOf(page, "Envoyer") }));
  const sent = /Merci/.test(page);
  const text = sent
    ? `C'est envoyé sur le formulaire de Studio Pixel (site fictif de la démo), après ton accord. Le mot de passe de l'espace candidat, je l'ai laissé : ${refused.split(":")[0].trim().toLowerCase()}.`
    : `Je n'ai rien envoyé : ${page.split("\n")[0]}`;
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

/** iMessage : le faux agent lit des conversations fictives et prépare une réponse, envoyée seulement avec ton accord. */
async function fakeIMessage(deps: Parameters<typeof executeTask>[0], taskId: number) {
  const { journal } = deps;
  const tools = memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null });
  let n = 0;
  const call = async (tool: string, input: Record<string, unknown>, run: () => Promise<string>) => {
    const id = `demo-${taskId}-m${n++}`;
    journal.announceStep({ taskId, toolUseId: id, tool: `mcp__memory__${tool}`, input, tier: "auto" });
    const out = await run();
    journal.completeStep(id, out, false);
    await sleep(700);
    return out;
  };
  await call("messages_recent", { hours: 48 }, () => tools.messages_recent.run({ hours: 48 }));
  await call("messages_read", { chat: "c1" }, () => tools.messages_read.run({ chat: "c1" }));
  const reply = "Bonjour Julie, merci ! Jeudi 14 h me va très bien. À jeudi, Charles";
  const sent = await call("send_imessage", { chat: "c1", text: reply }, () => tools.send_imessage.run({ chat: "c1", text: reply }));
  const text = `Deux conversations récentes : Julie (Studio Pixel) te propose un entretien jeudi à 14 h, et ta mère demande si tu rentres dimanche.\n\n${sent}`;
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

async function fakeDevTurn(
  deps: Parameters<typeof executeTask>[0],
  taskId: number,
  opts: Parameters<typeof executeTask>[2],
  step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>,
) {
  const cwd = opts.cwd!;
  const retouch = /^(Charles est revenu à l'état[^\n]*\n\n)?Retouche/.test(opts.prompt);
  // Démo d'un agent silencieux : « lent » dans la consigne, il ne fait plus rien jusqu'à ce qu'on l'arrête.
  if (/\blent\b/i.test(opts.prompt)) {
    await step("Read", { file_path: join(cwd, "index.html") }, readFileSync(join(cwd, "index.html"), "utf8"));
    await new Promise<void>((resolve) => {
      const off = onStop(taskId, () => resolve());
      setTimeout(() => (off(), resolve()), 30 * 60_000).unref();
    });
    const text = "Arrêté à ta demande avant la fin.";
    deps.journal.finish(taskId, "failed", text, 0);
    return { text, costUsd: 0, status: "failed" as const };
  }
  if (/La CI de la PR #\d+ échoue|Traite les commentaires de review/.test(opts.prompt) || /Issue GitHub #/.test(opts.prompt)) {
    const issue = opts.prompt.match(/Issue GitHub #(\d+)/)?.[1];
    if (issue === "12") {
      await step("Edit", { file_path: join(cwd, "index.html") }, "Modifié.");
      writeFileSync(join(cwd, "index.html"), readFileSync(join(cwd, "index.html"), "utf8").replace("</main>", "</main>\n<footer class=\"muted\">charles@exemple.fr</footer>"));
      const text = "Pied de page ajouté dans index.html, avec l'adresse, en texte secondaire (.muted).";
      deps.journal.finish(taskId, "done", text, 0);
      return { text, costUsd: 0, status: "done" as const };
    }
    await step("Read", { file_path: join(cwd, "style.css") }, readFileSync(join(cwd, "style.css"), "utf8"));
    await step("Edit", { file_path: join(cwd, "style.css") }, "Modifié.");
    writeFileSync(join(cwd, "style.css"), ":root {\n  /* Texte secondaire : 7:1 sur blanc (AA et AAA). */\n  --muted: #595959;\n}\n\n.muted {\n  color: var(--muted);\n}\n");
    const text = "La couleur passe par une variable --muted (stylelint ne veut pas de couleur en dur), avec un commentaire qui dit pourquoi cette valeur.";
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" as const };
  }
  if (/Relecture de Charles pour la tâche dev/.test(opts.prompt)) {
    await step("Read", { file_path: join(cwd, "style.css") }, readFileSync(join(cwd, "style.css"), "utf8"));
    await step("Edit", { file_path: join(cwd, "style.css") }, "Modifié.");
    writeFileSync(join(cwd, "style.css"), readFileSync(join(cwd, "style.css"), "utf8").replace(/color: (#[0-9a-f]{6});/, "color: $1; /* contraste 7:1 sur blanc */"));
    const n = (opts.prompt.match(/^\d+\. /gm) ?? []).length;
    const text = `${n} commentaire${n > 1 ? "s" : ""} traité${n > 1 ? "s" : ""} :\n1. Commentaire ajouté dans style.css pour expliquer la couleur.`;
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" as const };
  }
  if (/lien vers le nouveau titre/i.test(opts.prompt)) {
    const label = opts.prompt.match(/Décision de Charles — .* : (.+)$/m)?.[1]?.trim() ?? "Contact";
    await step("Read", { file_path: join(cwd, "index.html") }, readFileSync(join(cwd, "index.html"), "utf8"));
    await step("Edit", { file_path: join(cwd, "index.html") }, "Modifié.");
    writeFileSync(join(cwd, "index.html"), readFileSync(join(cwd, "index.html"), "utf8").replace("<main>", `<nav><a href="#contact">${label}</a></nav>\n<main>`));
    const text = `J'ai ajouté le lien « ${label} » dans le menu, vers le titre de section (déjà présent dans ma copie).`;
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" as const };
  }
  if (/index\.html/.test(opts.prompt) && /titre de section/i.test(opts.prompt)) {
    await step("Read", { file_path: join(cwd, "index.html") }, readFileSync(join(cwd, "index.html"), "utf8"));
    await step("Edit", { file_path: join(cwd, "index.html") }, "Modifié.");
    writeFileSync(join(cwd, "index.html"), readFileSync(join(cwd, "index.html"), "utf8").replace("</main>", "  <h2>Contact</h2>\n</main>"));
    const text = "J'ai ajouté le titre « Contact » dans index.html, à la fin de main.";
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" as const };
  }
  await step("Read", { file_path: join(cwd, "style.css") }, readFileSync(join(cwd, "style.css"), "utf8"));
  const css = readFileSync(join(cwd, "style.css"), "utf8").replace(/color: #[0-9a-f]{6};/, `color: ${retouch ? "#4a4a4a" : "#595959"};`);
  await step("Edit", { file_path: join(cwd, "style.css") }, "Modifié.");
  writeFileSync(join(cwd, "style.css"), css);
  if (!retouch) {
    await step("Write", { file_path: join(cwd, "CONTRASTE.md") }, "Écrit.");
    writeFileSync(join(cwd, "CONTRASTE.md"), "# Contraste\n\nLe texte secondaire passe de #9a9a9a à #595959 : ratio 7,0:1 sur blanc (AA et AAA).\n");
  }
  const text = retouch
    ? "Retouche faite : texte secondaire encore plus foncé (#4a4a4a), dans style.css."
    : "J'ai foncé le texte secondaire dans style.css (#9a9a9a → #595959, contraste 7:1) et noté le pourquoi dans CONTRASTE.md. À vérifier : le rendu des liens survolés.";
  deps.journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

async function fakeGoalTurn(
  deps: Parameters<typeof executeTask>[0],
  taskId: number,
  prompt: string,
  step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>,
) {
  const { journal } = deps;
  const turn = Number(prompt.match(/tour (\d+) sur/)?.[1] ?? 1);
  const asks = /question/i.test(prompt) && !prompt.includes("- Charles :");
  await step("mcp__memory__recall", { query: "candidatures relances" }, "3 candidatures : Studio Pixel, Banque du Nord, Agence Onde.");
  await step("Write", { file_path: `workspace/objectif/tour-${turn}.md` }, "Écrit.");
  const tools = memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null });
  const id = `demo-${taskId}-goal`;
  journal.announceStep({ taskId, toolUseId: id, tool: "mcp__memory__report_goal", input: {}, tier: "auto" });
  const r =
    turn === 1
      ? tools.report_goal.run({ status: "progress", summary: "Brouillons de relance écrits pour Studio Pixel et l'Agence Onde (workspace/objectif/tour-1.md).", next_step: "Préparer la relance de la Banque du Nord" })
      : asks
        ? tools.report_goal.run({ status: "blocked", summary: "Pour la Banque du Nord, l'entretien est-il le 25 ou le 26 novembre ? Tes notes se contredisent." })
        : tools.report_goal.run({ status: "done", summary: "Les trois relances sont prêtes dans workspace/objectif/ : Studio Pixel et Agence Onde au tour 1, Banque du Nord au tour 2 (date du 26 confirmée par toi). Rien n'a été envoyé." });
  journal.completeStep(id, r, false);
  const text = turn === 1 ? "Tour 1 fait : deux relances sur trois." : asks ? "J'ai besoin de toi pour la Banque du Nord." : "Objectif atteint : les trois relances sont prêtes.";
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

async function fakeHeartbeat(
  deps: Parameters<typeof executeTask>[0],
  taskId: number,
  step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>,
) {
  const { journal } = deps;
  await step("mcp__memory__recall", { query: "échéance relance" }, "Devis coussin de grossesse demandé au fournisseur le 7 octobre, sans réponse.");
  await step("mcp__memory__recall", { query: "rendez-vous entretien" }, "Rendu du projet Java Club prévu fin novembre.");
  const tools = memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null });
  const ideas = [
    {
      title: "Relancer le fournisseur du coussin",
      why: "Le devis demandé le 7 octobre n'a pas de réponse, et c'est la première étape avant de calculer la marge.",
      action: "Rédige un brouillon de relance courte pour le fournisseur du coussin de grossesse, sans l'envoyer.",
      source: "souvenir : devis demandé le 7 octobre",
    },
    {
      title: "Préparer le rendu Java Club",
      why: "Le rendu est prévu fin novembre : une liste de ce qui reste évite la course la veille.",
      action: "Fais la liste de ce qui reste à faire pour le rendu Java Club, d'après le dépôt et mes notes.",
      source: "souvenir : rendu prévu fin novembre",
    },
  ];
  const outcomes: string[] = [];
  for (const [i, idea] of ideas.entries()) {
    const id = `demo-${taskId}-ini-${i}`;
    journal.announceStep({ taskId, toolUseId: id, tool: "mcp__memory__propose_initiative", input: { title: idea.title }, tier: "auto" });
    const r = await tools.propose_initiative.run(idea);
    journal.completeStep(id, r, false);
    outcomes.push(r);
  }
  const text = `Tour de veille fini. ${outcomes.join(" ")}`;
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

async function fakeIdeasTour(deps: Parameters<typeof executeTask>[0], taskId: number, step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>) {
  const { journal } = deps;
  await step("mcp__memory__recall", { query: "projets stack" }, "Clark (TypeScript, Node), portfolio Next.js, boutique Shopify.");
  await step("mcp__memory__browser_open", { url: "https://news.ycombinator.com/show" }, "Show HN : 30 projets.");
  await step("mcp__memory__browser_scroll", { direction: "down" }, "Suite de la liste.");
  await step("mcp__memory__browser_open", { url: "https://github.com/trending?since=daily" }, "GitHub Trending : 25 dépôts.");
  await step("mcp__memory__browser_open", { url: "https://www.siteinspire.com/" }, "Siteinspire : 40 sites.");
  const tools = memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null });
  const ideas = [
    {
      title: "Clark joignable depuis le téléphone via Tailscale",
      pitch: "Faire tourner Clark sur un petit VPS et l'ouvrir au téléphone par Tailscale, sans rien exposer sur Internet.",
      why: "Clark s'arrête quand le Mac dort ; plusieurs projets Show HN font pareil avec un serveur à 5 € par mois.",
      source_url: "https://news.ycombinator.com/show",
      source_label: "Show HN",
    },
    {
      title: "Résumé du matin de tes PR GitHub",
      pitch: "Chaque matin, une carte avec les PR ouvertes de tes dépôts : CI, reviews en attente, conflits.",
      why: "Tu fusionnes toi-même chaque PR de Clark : savoir lesquelles sont prêtes t'évite d'aller voir.",
      source_url: "https://github.com/trending?since=daily",
      source_label: "GitHub Trending",
    },
    {
      kind: "design" as const,
      title: "Liste de projets en tableau, façon index éditorial",
      pitch: "Une seule colonne de lignes : année, nom, rôle, en typo mono serrée ; l'aperçu de l'image n'apparaît qu'à l'ouverture de la ligne. Très lisible, rien de décoratif.",
      why: "La page projets de ton portfolio : elle remplacerait la grille de cartes.",
      source_url: "https://www.siteinspire.com/",
      source_label: "Siteinspire",
    },
  ];
  const lines: string[] = [];
  for (const [i, idea] of ideas.entries()) {
    const id = `demo-${taskId}-idea-${i}`;
    journal.announceStep({ taskId, toolUseId: id, tool: "mcp__memory__note_idea", input: { title: idea.title }, tier: "auto" });
    const r = tools.note_idea.run(idea);
    journal.completeStep(id, r, false);
    lines.push(`- ${idea.title}`);
  }
  const text = lines.join("\n");
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

async function fakeIdeaDig(deps: Parameters<typeof executeTask>[0], taskId: number, prompt: string, step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>) {
  const id = Number(prompt.match(/\[Idée #(\d+)/)?.[1]);
  const title = prompt.match(/\nTitre : (.*)/)?.[1] ?? "l'idée";
  await step("WebSearch", { query: title }, "Deux projets proches, aucun en français ni branché sur un agent perso.");
  await step("mcp__memory__recall", { query: "projets en cours" }, "Clark, portfolio, boutique Shopify.");
  const tools = memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null });
  const report = [
    "## Ce que c'est",
    `${title}, en version simple et branchée sur Clark.`,
    "",
    "## Ce qui existe",
    "- Deux projets proches sur GitHub, en anglais, sans mémoire ni validation par bouton.",
    "",
    "## Pour toi",
    "Ça s'ajoute à Clark sans nouveau dépôt, avec ta stack (TypeScript, Node, SQLite).",
    "",
    "## Effort",
    "Une à deux soirées.",
    "",
    "## Premier pas",
    "Une tâche de code sur Clark : le module et sa page, sans interface d'abord.",
    "",
    "## Risques",
    "- Le quota du moteur si ça tourne trop souvent.",
  ].join("\n");
  journal.announceStep({ taskId, toolUseId: `demo-${taskId}-report`, tool: "mcp__memory__idea_report", input: { id }, tier: "auto" });
  const r = tools.idea_report.run({ id, verdict: "go", report });
  journal.completeStep(`demo-${taskId}-report`, r, false);
  const text = "À faire : petit, utile tout de suite, et ça s'ajoute à Clark.";
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

async function fakeVideo(
  deps: Parameters<typeof executeTask>[0],
  taskId: number,
  prompt: string,
  step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>,
) {
  const { journal } = deps;
  const dir = join(paths.workspace, "demo-clips");
  mkdirSync(dir, { recursive: true });
  for (const [i, hue] of [0, 120, 240].entries()) {
    const file = join(dir, `produit-${i + 1}.mp4`);
    if (!existsSync(file)) {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4", "-vf", `hue=h=${hue}`, file]);
    }
  }
  await step("Glob", { path: "demo-clips" }, "produit-1.mp4, produit-2.mp4, produit-3.mp4");
  const redo = prompt.startsWith("Refais le contenu");
  const id = `demo-${taskId}-video`;
  const input = { platform: "tiktok", title: "Coussin de grossesse : démo", clips: 3 };
  journal.announceStep({ taskId, toolUseId: id, tool: "mcp__memory__prepare_social_post", input, tier: "auto" });
  const tools = memoryTools(deps.store, { taskId: () => taskId, writeRefusal: () => null });
  const result = await tools.prepare_social_post.run({
    platform: "tiktok",
    title: redo ? "Coussin de grossesse : démo (v2)" : "Coussin de grossesse : démo",
    clips: [{ path: "demo-clips/produit-1.mp4" }, { path: "demo-clips/produit-2.mp4", start: 0.5, end: 3.5 }, { path: "demo-clips/produit-3.mp4" }],
    texts: redo
      ? [
          { text: "Mal au dos la nuit ?", start: 0, end: 3 },
          { text: "Il se cale en 10 secondes", start: 3, end: 7 },
          { text: "Housse lavable", start: 7, end: 11 },
        ]
      : [
          { text: "Enceinte et mal au dos la nuit ? Voici ce qui change tout", start: 0, end: 4 },
          { text: "Il se cale en 10 secondes", start: 4, end: 7 },
          { text: "Housse lavable", start: 7, end: 11 },
        ],
    caption: "Le coussin qui soutient le dos et le ventre, de la grossesse à l'allaitement. (Démo : clips et produit fictifs.)",
    hashtags: ["grossesse", "coussindegrossesse", "maman", "sommeil"],
  });
  journal.completeStep(id, result, false);
  const ok = /^Brouillon #\d+ prêt/.test(result);
  const text = ok
    ? `Vidéo prête${redo ? ", avec ta retouche" : ""} : 11 secondes, trois plans, trois textes à l'écran. Regarde l'aperçu, puis valide, demande une retouche ou jette-la.`
    : `Je n'ai pas pu monter la vidéo : ${result}`;
  journal.finish(taskId, "done", text, 0);
  return { text, costUsd: 0, status: "done" as const };
}

const PORTFOLIO_PLAN = JSON.stringify({
  steps: [
    { key: "a11y", role: "temporaire", name: "Spécialiste Accessibilité", mission: "Auditer contrastes, navigation au clavier et textes alternatifs du portfolio", deliverable: "Problèmes d'accessibilité, par gravité", dependsOn: [] },
    { key: "contenu", role: "contenu", mission: "Relire les textes du portfolio : clarté, ton, longueur", deliverable: "Textes à reprendre, avec une proposition", dependsOn: [] },
    { key: "revue", role: "relecteur", mission: "Croiser les deux rapports et prioriser les corrections", deliverable: "Corrections priorisées", dependsOn: ["a11y", "contenu"] },
  ],
});

/**
 * Faux plan d'équipe, pour la recette de la revue de portfolio. Les deux analyses durent
 * 4 et 12 secondes : le temps de couper Clark quand un seul rapport est prêt.
 */
async function fakePlanned(
  deps: Parameters<typeof executeTask>[0],
  taskId: number,
  opts: Parameters<typeof executeTask>[2],
  step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>,
) {
  const { journal } = deps;
  const p = opts.prompt;
  const finish = (text: string) => {
    if (!opts.keepOpen) journal.finish(taskId, "done", text, 0, opts.attempt);
    return { text, costUsd: 0, status: "done" as const };
  };
  // Point d'étape, comme l'outil report_progress d'un vrai agent.
  const progress = async (note: string) => {
    const id = `demo-${taskId}-p-${Date.now()}`;
    journal.announceStep({ taskId, toolUseId: id, tool: "mcp__memory__report_progress", input: { note }, tier: "auto", attempt: opts.attempt });
    deps.store.db.prepare("UPDATE tasks SET checkpoint = ?, checkpoint_at = datetime('now') WHERE id = ?").run(note, taskId);
    journal.completeStep(id, "Point d'étape noté.", false);
  };
  const slowRead = async (file: string, seconds: number) => {
    const id = `demo-${taskId}-${Date.now()}`;
    journal.announceStep({ taskId, toolUseId: id, tool: "Read", input: { file_path: file }, tier: "ask", attempt: opts.attempt });
    await sleep(seconds * 1000);
    journal.completeStep(id, "…", false);
  };
  if (p.includes("[Équipe de Clark — Plan]")) {
    await step("Glob", { path: "/portfolio" }, "…");
    return finish(/portfolio/i.test(p) ? "```json\n" + PORTFOLIO_PLAN + "\n```" : '{"standard": true}');
  }
  if (p.includes("[Équipe de Clark — Spécialiste Accessibilité]")) {
    await progress("Je commence par les contrastes (globals.css)");
    await slowRead("/portfolio/app/globals.css", 2);
    await progress("Contraste trop faible sur Projets ; je passe au clavier et aux images");
    await slowRead("/portfolio/components/Globe.tsx", 2);
    return finish(`- **Bloquant** : contraste du texte gris sur fond sombre de 3,1:1 sur la page Projets (source : app/globals.css, --gris-bleu).
- **Moyen** : le bouton du globe n'a pas de nom accessible (source : components/Globe.tsx).
- **Faible** : deux images sans texte alternatif (source : app/projets/page.tsx).`);
  }
  if (p.includes("[Équipe de Clark — Spécialiste Contenu]")) {
    await progress("Lecture de la page d'accueil et de la page À propos");
    await slowRead("/portfolio/app/a-propos/page.tsx", 6);
    await progress("À propos : 900 mots, trop long ; reste les fiches projet");
    await slowRead("/portfolio/app/projets/page.tsx", 6);
    return finish(`- La page À propos fait 900 mots : la ramener à 250, en gardant le parcours IIM et deux projets.
- Le titre d'accueil ne dit pas ce que tu fais : proposer « Développeur web, je conçois des interfaces claires ».
- Les fiches projet n'indiquent pas ton rôle exact (source : app/projets/page.tsx).`);
  }
  if (p.includes("[Équipe de Clark — Relecteur]")) {
    await step("Read", { file_path: "/portfolio/app/projets/page.tsx" }, "…");
    return finish(`1. Contraste de la page Projets (bloquant, signalé par Accessibilité).
2. Titre d'accueil (fort impact, signalé par Contenu).
3. Rôle exact dans les fiches projet : les deux rapports pointent la même page, à corriger ensemble.
4. Nom accessible du globe, puis textes alternatifs.`);
  }
  // Synthèse de Clark
  return finish(`**Ce que l'équipe a trouvé**
- Un problème bloquant : le contraste de la page Projets (Accessibilité).
- Le titre d'accueil et la page À propos ne disent pas assez vite ce que tu fais (Contenu).
- La page Projets cumule les deux sujets : à reprendre en une seule passe (Relecteur).

**À trancher par toi**
- Raccourcir la page À propos à 250 mots, ou la garder longue et ajouter un résumé en tête ?
- Garder le gris actuel en l'assombrissant, ou changer de couleur de texte secondaire ?

(Données fictives de la démo.)`);
}

/**
 * Faux agents d'équipe, pour les trois scénarios de la recette :
 * - parcours normal : la v1 affirme le 26 novembre, le Relecteur le refuse, la v2 laisse la date à confirmer ;
 * - « strict » dans la demande : le Relecteur refuse toujours, Clark s'arrête après 2 relectures ;
 * - le Rédacteur met 8 secondes à écrire son brouillon : le temps de couper Clark (Ctrl+C) pour tester la reprise.
 */
async function fakeTeamAgent(
  deps: Parameters<typeof executeTask>[0],
  taskId: number,
  prompt: string,
  role: "Chercheur" | "Rédacteur" | "Relecteur",
  step: (tool: string, input: Record<string, unknown>, output: string) => Promise<void>,
  keepOpen: boolean,
) {
  const { journal } = deps;
  const strict = /strict/i.test(prompt);
  // Comme les vrais moteurs : une étape « keepOpen » (vérification avant reprise) ne clôt pas la tâche.
  const finish = (text: string) => {
    if (!keepOpen) journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" as const };
  };

  // Reprise après coupure, temps 1 : vérification en lecture seule, aucune écriture.
  if (prompt.includes("Vérification en lecture seule")) {
    const file = prompt.match(/\/workspace\/equipe\/\d+\/brouillon-v\d+\.md/)?.[0] ?? "/workspace/equipe/brouillon.md";
    await step("Read", { file_path: file }, "fichier absent");
    return finish(`#1 : PAS FAIT — ${file.split("/").pop()} absent, l'écriture a été coupée.`);
  }

  if (role === "Chercheur") {
    for (const note of ["note-1-studio-pixel.md", "note-2-banque-nord.md", "note-3-agence-onde.md"]) {
      await step("Read", { file_path: `/workspace/candidatures/${note}` }, "…");
    }
    return finish(`Faits rassemblés (notes fictives de la recette) :
- Studio Pixel : entretien passé le 12 novembre, pas de nouvelles depuis. (source : note-1-studio-pixel.md)
- Banque du Nord : entretien le 25 novembre selon l'en-tête de la note, le 26 novembre selon le corps. Contradiction non tranchée. (source : note-2-banque-nord.md)
- Agence Onde : dossier à envoyer avant le 30 novembre, portfolio manquant. (source : note-3-agence-onde.md)`);
  }

  if (role === "Rédacteur") {
    const second = prompt.includes("Le Relecteur a demandé des corrections");
    // « question » dans la demande : le Rédacteur demande le ton à l'utilisateur avant d'écrire.
    let tone = "";
    if (/question/i.test(prompt) && !second) {
      const qid = `demo-${taskId}-ask`;
      const input = { question: "Quel ton pour les relances ?", options: ["Formel, vouvoiement", "Détendu, tutoiement"] };
      journal.announceStep({ taskId, toolUseId: qid, tool: "mcp__memory__ask_charles", input, tier: "auto" });
      const id = deps.store.questions.ask({ taskId, agent: "Rédacteur", question: input.question, options: input.options });
      const answer = await deps.store.questions.wait(id);
      journal.completeStep(qid, answer ?? "pas de réponse", false);
      tone = answer ? ` (ton : ${answer.toLowerCase()})` : " (sans réponse sur le ton : formel par défaut)";
    }
    const file = prompt.match(/equipe\/\d+\/brouillon-v\d+\.md/)?.[0] ?? "equipe/brouillon.md";
    // Écriture lente : c'est le moment de couper Clark pour le scénario 2.
    const id = `demo-${taskId}-write-${Date.now()}`;
    journal.announceStep({ taskId, toolUseId: id, tool: "Write", input: { file_path: `/workspace/${file}` }, tier: "workspace" });
    await sleep(8000);
    journal.completeStep(id, "écrit", false);
    const banque = second ? "ton entretien du 25 ou du 26 novembre (date à confirmer avec la RH)" : "ton entretien du 26 novembre";
    return finish(`Relances${tone} :

- **Studio Pixel** (envoi le 20 novembre) : « Bonjour, je reviens vers vous après notre entretien du 12 novembre. Je reste très intéressé par l'alternance… »
- **Banque du Nord** (après l'entretien) : « Merci pour ${banque}… »
- **Agence Onde** (avant le 30 novembre) : « Je vous envoie mon dossier complet, portfolio compris… »`);
  }

  // Relecteur
  await step("Read", { file_path: "/workspace/candidatures/note-2-banque-nord.md" }, "…");
  if (strict) {
    return finish(`Relecture stricte.
VERDICT : À CORRIGER
- Le ton reste trop formel pour Studio Pixel.
- Chaque relance devrait indiquer sa date d'envoi précise.`);
  }
  const draft = prompt.split("Brouillon à relire :")[1] ?? "";
  if (/à confirmer/.test(draft)) {
    return finish(`Les faits du brouillon correspondent aux notes.
VERDICT : OK
- Entretien Banque du Nord : le 25 ou le 26 novembre selon la note, à confirmer avec la RH avant d'envoyer.`);
  }
  return finish(`VERDICT : À CORRIGER
- L'entretien Banque du Nord est daté du 25 ou du 26 novembre selon la note : le brouillon affirme le 26. Laisse la date à confirmer.`);
}

const hub = createHub({ config, store, journal, conversation }, {
  execute: fakeExecute,
  // Démo : rien ne part vraiment.
  sendMail: async () => ({ id: "demo" }),
  googleStatus: () => ({ configured: true, connected: true, email: "demo@example.com", missingScopes: [] }),
});

// Données fictives de départ, au premier lancement seulement.
if (fresh) {
  // Souvenir d'avant la mémoire confirmée : sans source, « provenance inconnue ».
  store.remember({ kind: "project", content: "Recherche d'alternance en développement web, rentrée 2027", importance: 5 });
  store.remember({
    kind: "event",
    content: "Agence Onde : dossier à envoyer avant le 30 novembre",
    importance: 4,
    source: "fichier candidatures/note-3-agence-onde.md",
    expiresAt: "2026-11-30",
  });
  store.addSpend(0.42, "chat");
  conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Tu peux me rappeler où j'en suis avec l'Agence Onde ?", source: "web" });
  conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "Il te reste jusqu'au **30 novembre** pour envoyer le dossier. D'après ta note, il manque le portfolio." });
  const cut = journal.create(OWNER_CHAT, "chat", "Écris le brouillon de relance pour Studio Pixel dans relances.md");
  journal.setStatus(cut, "running");
  journal.setSession(cut, "demo");
  journal.announceStep({ taskId: cut, toolUseId: "demo-cut", tool: "Write", input: { file_path: "/workspace/relances.md" }, tier: "workspace" });
}

hub.setEngine({ name: "demo", model: "faux agent", ready: true, account: null, problem: null });
// Moteurs fictifs, pour voir le bloc « Moteurs » : quotas, modèles et niveaux de puissance.
// CLARK_DEMO_QUOTA=95 npm run demo : quota Codex presque épuisé.
{
  const levels = ["low", "medium", "high", "xhigh", "max"];
  // CLARK_DEMO_LOGIN=1 : moteurs pas connectés, pour essayer le bouton « Connecter » (fausse commande).
  hub.setConnection("claude", DEMO_LOGIN ? { ready: false, account: null, problem: "pas connecté. Lance une fois : claude auth login" } : { ready: true, account: "abonnement Claude (démo)", problem: null });
  hub.setCatalog("claude", {
    readAt: Date.now(),
    models: [
      { id: "opus", name: "Opus", description: "le plus capable (démo)", efforts: levels, defaultEffort: null },
      { id: "sonnet", name: "Sonnet", description: "rapide et solide (démo)", efforts: levels, defaultEffort: null },
      { id: "haiku", name: "Haiku", description: "le plus rapide (démo)", efforts: [], defaultEffort: null },
    ],
  });
  hub.setConnection("codex", DEMO_LOGIN ? { ready: false, account: null, problem: "pas connecté. Lance une fois : codex login" } : { ready: true, account: "ChatGPT plus", problem: null });
  hub.setCatalog("codex", {
    readAt: Date.now(),
    models: [
      { id: "codex-demo", name: "Modèle Codex A (démo)", description: "", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true },
      { id: "codex-demo-mini", name: "Modèle Codex B (démo)", description: "", efforts: ["low", "medium"], defaultEffort: "low" },
    ],
  });
  hub.setQuota(
    {
      plan: "max",
      windows: [
        { label: "Fenêtre de 5 h", usedPercent: 12, durationMins: 300, resetsAt: Date.now() + 3 * 3600_000 },
        { label: "Fenêtre de 7 jours", usedPercent: 44, durationMins: 10080, resetsAt: Date.now() + 4 * 86400_000 },
      ],
      reached: false,
      readAt: Date.now(),
    },
    "claude",
  );
}
{
  const used = Number(process.env.CLARK_DEMO_QUOTA ?? 38);
  const now = Date.now();
  hub.setQuota({
    plan: "plus",
    windows: [
      { label: "Fenêtre de 5 h", usedPercent: used, durationMins: 300, resetsAt: now + 2 * 3600_000 },
      { label: "Fenêtre de 7 jours", usedPercent: 61, durationMins: 10080, resetsAt: now + 3 * 86400_000 },
    ],
    reached: used >= 100,
    readAt: now,
  }, "codex");
}
// Un site fictif, servi en local, pour que le faux agent ait quelque chose à remplir.
const DEMO_SITE = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Studio Pixel — Contact</title>
<style>body{font:16px/1.5 system-ui;margin:40px auto;max-width:560px;color:#1d1d1f}label{display:block;margin:12px 0 4px}input,textarea{width:100%;padding:8px;font:inherit;border:1px solid #ccc;border-radius:6px}button{margin-top:16px;padding:8px 16px;font:inherit;border:0;border-radius:6px;background:#1d1d1f;color:#fff}</style>
<h1>Studio Pixel</h1><p>Agence web à Lyon. Une question sur une candidature ? Écris-nous.</p>
<form action="/merci" method="get"><label for="n">Nom</label><input id="n" name="nom"><label for="m">Ton message</label><textarea id="m" name="message" rows="4"></textarea>
<label for="p">Mot de passe de l'espace candidat</label><input id="p" type="password" name="pw"><button>Envoyer</button></form></html>`;
const siteServer = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url?.startsWith("/merci") ? `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Merci</title><h1>Merci, message reçu</h1><p>L'équipe de Studio Pixel te répond sous 48 h.</p></html>` : DEMO_SITE);
}).listen(DEMO_SITE_PORT, "127.0.0.1");
siteServer.unref();
const browser = new BrowserService({
  driver: new ChromeDriver(),
  approve: (taskId, req) => hub.approveTask(taskId, req),
  taskAlive: (id) => ["queued", "running"].includes(journal.get(id)?.status ?? ""),
  onChange: () => hub.touch(),
});
setBrowser(browser);
// iMessage fictif : deux conversations, et ta conversation avec toi-même comme canal (aucun vrai message).
const demoMessages = new MemoryMessages();
demoMessages.contacts.set("612345678", "Julie Moreau");
demoMessages.contacts.set("698765432", "Maman");
demoMessages.addChat({ id: 1, ident: "+33612345678", name: null, group: false, participants: ["+33612345678"] });
demoMessages.addChat({ id: 2, ident: "+33698765432", name: null, group: false, participants: ["+33698765432"] });
demoMessages.addChat({ id: 9, ident: "+33600000000", name: null, group: false, participants: ["+33600000000"] });
demoMessages.push(1, "Bonjour Charles, c'est Julie de Studio Pixel. On pourrait faire l'entretien jeudi à 14 h ?", false, "+33612345678", Date.now() - 3 * 3600_000);
demoMessages.push(2, "Tu rentres dimanche ? Dis-moi pour le train", false, "+33698765432", Date.now() - 5 * 3600_000);
const imessage = new MessagesService(demoMessages, store.db, { self: "+33600000000" });
setMessages(imessage);
connectIMessage(hub, imessage);
// Un plugin d'exemple (format Claude Code), à installer depuis Réglages › Plugins.
const demoPlugin = join(tmpdir(), "clark-demo-plugin-candidatures");
rmSync(demoPlugin, { recursive: true, force: true });
mkdirSync(join(demoPlugin, ".claude-plugin"), { recursive: true });
mkdirSync(join(demoPlugin, "commands"), { recursive: true });
mkdirSync(join(demoPlugin, "skills/lettre-de-motivation/scripts"), { recursive: true });
mkdirSync(join(demoPlugin, "hooks"), { recursive: true });
writeFileSync(join(demoPlugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "candidatures", version: "1.2.0", description: "Suivi des candidatures : relances, lettres de motivation, tableau des entretiens.", author: { name: "Exemple" } }, null, 2));
writeFileSync(join(demoPlugin, "commands/relance.md"), `---\ndescription: Relance une candidature restée sans réponse\n---\n\nPrépare une relance courte et polie pour la candidature $ARGUMENTS, d'après mes notes. Ne l'envoie pas : montre-la-moi.\n`);
writeFileSync(join(demoPlugin, "commands/entretiens.md"), `---\ndescription: Liste mes entretiens à venir\n---\n\nListe mes entretiens des 14 prochains jours (agenda et notes), avec ce qu'il me reste à préparer.\n`);
writeFileSync(join(demoPlugin, "skills/lettre-de-motivation/SKILL.md"), `---\nname: lettre-de-motivation\ndescription: Écrire une lettre de motivation courte pour une alternance en développement web\n---\n\n1. Relis l'annonce et mes notes sur l'entreprise.\n2. Trois paragraphes : pourquoi eux, ce que j'apporte, la suite.\n3. Pas de formule creuse ; une preuve par affirmation.\n`);
writeFileSync(join(demoPlugin, "skills/lettre-de-motivation/scripts/compter-mots.sh"), "#!/bin/sh\nwc -w \"$1\"\n");
writeFileSync(join(demoPlugin, "hooks/hooks.json"), JSON.stringify({ hooks: { PostToolUse: [] } }));
writeFileSync(join(demoPlugin, ".mcp.json"), JSON.stringify({ mcpServers: { "job-board": { command: "npx", args: ["-y", "job-board-mcp@1.0.0"], env: { JOB_BOARD_TOKEN: "\${JOB_BOARD_TOKEN}" } } } }, null, 2));
process.env.CLARK_DEMO_PLUGIN = demoPlugin;
// Un catalogue d'exemple (marketplace.json) dans un dossier : la liste et sa recherche se testent sans réseau.
const demoCatalog = join(tmpdir(), "clark-demo-catalogue");
rmSync(demoCatalog, { recursive: true, force: true });
mkdirSync(join(demoCatalog, ".claude-plugin"), { recursive: true });
cpSync(demoPlugin, join(demoCatalog, "plugins/candidatures"), { recursive: true });
mkdirSync(join(demoCatalog, "plugins/fiches-de-revision/.claude-plugin"), { recursive: true });
mkdirSync(join(demoCatalog, "plugins/fiches-de-revision/commands"), { recursive: true });
writeFileSync(join(demoCatalog, "plugins/fiches-de-revision/.claude-plugin/plugin.json"), JSON.stringify({ name: "fiches-de-revision", version: "0.3.0", description: "Fiches de révision et quiz à partir de tes notes de cours." }));
writeFileSync(join(demoCatalog, "plugins/fiches-de-revision/commands/fiche.md"), "---\ndescription: Fiche de révision d'un cours\n---\n\nFais une fiche de révision d'une page à partir de mes notes sur $ARGUMENTS.\n");
const demoEntries = [
  { name: "candidatures", description: "Suivi des candidatures : relances, lettres de motivation, tableau des entretiens.", source: "./plugins/candidatures" },
  { name: "fiches-de-revision", description: "Fiches de révision et quiz à partir de tes notes de cours.", source: "./plugins/fiches-de-revision" },
  { name: "commit-commands", description: "Commandes git : commit, push et pull request en une étape.", source: { source: "git-subdir", url: "https://github.com/exemple/plugins.git", path: "plugins/commit-commands" } },
  { name: "revue-de-code", description: "Révision de code avant fusion : sécurité, accessibilité, tests manquants.", source: { source: "github", repo: "exemple/revue-de-code" } },
  { name: "deploiement-vercel", description: "Déploiement sur Vercel et lecture des journaux de build.", source: { source: "github", repo: "exemple/deploiement-vercel" } },
  { name: "outil-npm", description: "S'installe avec npm : pas pris en charge par Clark.", source: { source: "npm", package: "outil-npm" } },
  ...Array.from({ length: 44 }, (_, i) => ({
    name: `outil-${String(i + 1).padStart(2, "0")}`,
    description: ["Préparation d'entretien et questions fréquentes.", "Gestion des tâches et des échéances.", "Résumé de réunions et comptes rendus.", "Écriture de messages LinkedIn."][i % 4],
    source: { source: "github", repo: `exemple/outil-${i + 1}` },
  })),
];
writeFileSync(join(demoCatalog, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "catalogue-demo", owner: { name: "Exemple" }, plugins: demoEntries }, null, 2));
process.env.CLARK_DEMO_CATALOG = demoCatalog;

// Plugins : relus par l'utilisateur avant installation ; leurs commandes, skills et serveurs MCP rejoignent les siens.
const plugins = new Plugins({
  mcp: store.mcp,
  ownCommands: () => ownCommands().map((c) => c.name),
  otherSkills: () => listSkills().filter((s) => s.source !== "plugin").map((s) => s.name),
});
plugins.onChange(() => hub.touch());
// Réglages et notifications, comme en vrai (dans la base de démo).
const demoSettings = new Settings(store.db);
const notifyStore = new NotifyStore(store.db);
setNotifyStore(notifyStore);
startQuietDigest((text) => void hub.post(OWNER_CHAT, text, "system", "digest"));
// Mode design : l'aperçu des copies, sur son propre port (une autre origine que l'interface).
const preview = new PreviewService(hub, { port: Number(process.env.CLARK_PREVIEW_PORT) || 4321, webOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`] });
const previewReady = await preview.listen().then(
  () => true,
  (err) => (console.warn("[clark] aperçu (mode design) indisponible :", err instanceof Error ? err.message : err), false),
);
// Autonomie : mêmes règles qu'en vrai (Réglages › Général › Autonomie).
startAutonomy(hub);

// Fausse connexion : un petit programme qui imite la commande (lien, code à coller pour Claude).
const demoLogins = createLogins({
  onChange: () => hub.touch(),
  onDone: (engine) => hub.setConnection(engine, { ready: true, account: engine === "claude" ? "abonnement Claude (démo)" : "ChatGPT plus", problem: null }),
  spawn: (engine) =>
    spawn(
      process.execPath,
      [
        "-e",
        engine === "claude"
          ? `process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?demo=1\\nPaste code here if prompted > ");process.stdin.once("data",(d)=>process.exit(String(d).trim()==="refus"?1:0));`
          : `console.log("Starting local login server on http://localhost:1455.\\nIf your browser did not open, navigate to this URL to authenticate:\\n\\nhttps://auth.openai.com/oauth/authorize?demo=1");setTimeout(()=>process.exit(0),4000);`,
      ],
      { stdio: "pipe" },
    ),
});
const web = await startWeb(hub, {
  port,
  demo: true,
  browser,
  messages: imessage,
  plugins,
  settings: demoSettings,
  notify: notifyStore,
  ...(previewReady ? { preview } : {}),
  engineLogin: { logins: demoLogins, readyAtStart: { claude: !DEMO_LOGIN, codex: !DEMO_LOGIN }, restart: null },
});
await hub.recover();
// Les automatisations tournent aussi dans la démo (avec le faux agent).
const stopScheduler = startScheduler({ config, store, enqueue: hub.enqueue, automations: store.automations, launch: (a, slot) => launchAutomation(hub, a, { slot }) });
startGoals(hub);
startDev(hub);
// Les PR ouvertes sont relues toutes les 3 minutes : CI, reviews, merge.
startPrWatch(hub);

// Un petit site de démo, dans un vrai dépôt git temporaire, enregistré comme projet.
if (!store.dev.projects().some((p) => p.name === "site-demo")) {
  const repo = join(tmpdir(), "clark-demo-site");
  if (!existsSync(join(repo, ".git"))) {
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "index.html"), "<!doctype html>\n<link rel=\"stylesheet\" href=\"style.css\">\n<main>\n  <h1>Portfolio (démo)</h1>\n  <p class=\"muted\">Projets récents</p>\n</main>\n");
    writeFileSync(join(repo, "style.css"), ".muted {\n  color: #9a9a9a;\n}\n");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    g("init", "-q", "-b", "main");
    g("add", ".");
    g("-c", "user.name=Démo", "-c", "user.email=demo@example.com", "commit", "-q", "-m", "Site de démo");
  }

  void addProject(hub, { name: "site-demo", path: repo, testCommand: "grep -q '<main' index.html && ! grep -q '#9a9a9a' style.css" });
}
// Un faux GitHub : un dépôt nu local pour « origin », et un faux gh (PR, CI, reviews, issues).
{
  const repo = join(tmpdir(), "clark-demo-site");
  const origin = join(tmpdir(), "clark-demo-origin.git");
  if (existsSync(join(repo, ".git"))) {
    if (!existsSync(origin)) execFileSync("git", ["init", "-q", "--bare", origin]);
    const remotes = execFileSync("git", ["remote"], { cwd: repo, encoding: "utf8" }).split("\n");
    if (!remotes.includes("origin")) execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo, stdio: "ignore" });
  }
}
console.log(`[clark] démo : ${web.url}  (faux agent, base data/demo.db, Ctrl+C pour arrêter, --reset pour repartir de zéro)`);

const stop = async () => {
  stopScheduler();
  await web.close();
  store.db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
