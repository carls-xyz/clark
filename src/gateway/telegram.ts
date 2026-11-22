import { Bot, InlineKeyboard, InputFile } from "grammy";
import { platformName } from "../social/platforms.ts";
import { hashtagsOf } from "../social/posts.ts";
import { OWNER_CHAT, type Hub } from "../core/hub.ts";
import { TEAM_LABEL } from "../core/team.ts";
import { createGoal } from "../scheduler/goals.ts";
import { submitRequest } from "../core/submit.ts";
import { expandCommand } from "../skills/library.ts";
import { DEFAULT_MAX_TURNS } from "../core/goals.ts";
import { optionsOf } from "../core/questions.ts";
import { checkAlertText, uncertainSteps } from "../tasks/journal.ts";
import { teamView } from "./team-view.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { speak, transcribe, voiceStatus } from "../voice/voice.ts";

/** Ce dont le canal a besoin pour la voix (remplaçable dans les tests). */
export type TelegramVoice = {
  status: () => { ready: boolean; canSpeak: boolean; problem: string | null };
  transcribe: (file: string, vocabulary?: string) => Promise<string>;
  speak: (text: string, voice: string, format: "ogg", dest: string) => Promise<string>;
  /** Télécharge un fichier Telegram (file_path) vers dest. */
  download: (filePath: string, dest: string) => Promise<void>;
};

/** Un vocal Telegram fait au plus 20 Mo (limite de l'API des bots) ; on s'arrête à 10 minutes. */
const VOICE_MAX_BYTES = 20 * 1024 * 1024;
const VOICE_MAX_SECONDS = 600;

const TELEGRAM_LIMIT = 4000;

export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

const checkKeyboard = (taskId: number) =>
  new InlineKeyboard().text("Reprendre (vérifier d'abord)", `task:resume:${taskId}`).text("Abandonner", `task:drop:${taskId}`);

const statusText: Record<string, string> = {
  waiting: "en attente",
  queued: "en file d'attente",
  running: "en cours",
  done: "terminé",
  needs_check: "à vérifier",
  failed: "échec",
  abandoned: "abandonné",
};

/**
 * Canal Telegram : pratique depuis le téléphone, et il pousse les notifications.
 * Il partage la conversation de l'interface web (même fil, mêmes tâches).
 */
export function createTelegram(hub: Hub, opts: { token: string; ownerId: number; bot?: Bot; voice?: TelegramVoice }) {
  const { store, journal, config } = hub.deps;
  const bot = opts.bot ?? new Bot(opts.token);
  const chat = opts.ownerId; // en privé, l'id du chat est celui de l'utilisateur
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_question_messages (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    )
  `);
  // Message Telegram d'un brouillon vidéo : y répondre demande une retouche.
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_post_messages (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    )
  `);
  const savePostMessage = store.db.prepare("INSERT INTO telegram_post_messages VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET post_id = excluded.post_id");
  const findPostMessage = store.db.prepare("SELECT post_id FROM telegram_post_messages WHERE chat_id = ? AND message_id = ?");
  const saveQuestionMessage = store.db.prepare("INSERT INTO telegram_question_messages VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET question_id = excluded.question_id");
  const findQuestionMessage = store.db.prepare("SELECT question_id FROM telegram_question_messages WHERE chat_id = ? AND message_id = ?");

  const send = async (text: string) => {
    for (const part of splitMessage(text)) await bot.api.sendMessage(chat, part);
  };

  const voice: TelegramVoice = opts.voice ?? {
    status: voiceStatus,
    transcribe,
    speak,
    download: async (filePath, dest) => {
      const res = await fetch(`https://api.telegram.org/file/bot${opts.token}/${filePath}`);
      if (!res.ok) throw new Error(`téléchargement du vocal : ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    },
  };
  // Tâches lancées par un vocal : en mode « si vocal », leur réponse part aussi en vocal.
  const voiceTasks = new Set<number>();
  const wantsVoice = (m: { role: string; task_id: number | null }) => {
    if (m.role !== "clark") return false;
    const mode = store.voice.mode();
    return mode === "always" || (mode === "voice" && m.task_id !== null && voiceTasks.has(m.task_id));
  };
  const sendSpoken = async (text: string) => {
    if (!voice.status().canSpeak) return;
    const dir = mkdtempSync(join(tmpdir(), "clark-tg-"));
    try {
      const file = await voice.speak(text, store.voice.voice(), "ogg", join(dir, "clark.ogg"));
      await bot.api.sendVoice(chat, new InputFile(file));
    } catch (err) {
      console.error("[clark] réponse vocale non envoyée :", err);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const sendAlert = async (taskId: number, text: string): Promise<boolean> => {
    try {
      await bot.api.sendMessage(chat, text.slice(0, TELEGRAM_LIMIT), { reply_markup: checkKeyboard(taskId) });
      return true;
    } catch (err) {
      console.error(`[clark] alerte de la tâche ${taskId} non envoyée sur Telegram :`, err);
      return false;
    }
  };

  hub.addChannel({
    name: "telegram",
    // Les messages de l'utilisateur ne lui sont pas renvoyés ; le reste du fil, si.
    // Seule ta conversation part sur Telegram (pas le tour de veille, qui a la sienne).
    deliver: async (m) => {
      if (m.role === "user" || m.chat_id !== OWNER_CHAT) return;
      await send(m.text);
      // Le texte d'abord (il arrive tout de suite), le vocal ensuite, sans retenir le fil.
      if (wantsVoice(m)) void sendSpoken(m.text);
    },
    proposeInitiative: async (i) => {
      const keyboard = new InlineKeyboard().text("Accepter", `ini:ok:${i.id}`).text("Refuser", `ini:no:${i.id}`);
      await bot.api.sendMessage(chat, `Clark te propose : ${i.title}\n\n${i.why}${i.source ? `\n(source : ${i.source})` : ""}`, { reply_markup: keyboard });
    },
    askMail: async (m) => {
      const head = `Clark veut envoyer ce mail :\n\nÀ : ${m.to_addr}${m.cc ? `\nCc : ${m.cc}` : ""}\nObjet : ${m.subject}\n\n`;
      // Tu valides le texte exact : s'il ne tient pas dans un message, l'envoi se valide dans l'interface.
      const fits = head.length + m.body.length <= 3800;
      const keyboard = new InlineKeyboard();
      if (fits) keyboard.text("Envoyer", `ml:ok:${m.id}`);
      keyboard.text("Refuser", `ml:no:${m.id}`);
      const text = fits ? head + m.body : `${head}${m.body.slice(0, 1500)}\n[…]\n\nTexte trop long pour Telegram : lis-le en entier et envoie-le depuis l'interface web.`;
      await bot.api.sendMessage(chat, text, { reply_markup: keyboard });
    },
    askApproval: async (a) => {
      const keyboard = new InlineKeyboard().text("Valider", `ok:${a.id}`).text("Refuser", `no:${a.id}`);
      await bot.api.sendMessage(chat, `Je peux ?\n\n${a.summary.slice(0, 3500)}`, { reply_markup: keyboard });
    },
    alert: (task, text) => sendAlert(task.id, text),
    askQuestion: async (q) => {
      const options = optionsOf(q);
      const keyboard = new InlineKeyboard();
      options.forEach((o, i) => keyboard.text(o.slice(0, 60), `qa:${q.id}:${i}`).row());
      const hint = options.length ? "Choisis une option ou réponds à ce message." : "Réponds à ce message.";
      const message = await bot.api.sendMessage(chat, `${q.agent ?? "Clark"} te pose une question :\n\n${q.question}\n\n${hint}`, {
        reply_markup: options.length ? keyboard : { force_reply: true, input_field_placeholder: "Ta réponse" },
      });
      saveQuestionMessage.run(chat, message.message_id, q.id);
    },
    proposePost: async (p) => {
      const tags = hashtagsOf(p).map((h) => `#${h}`).join(" ");
      const caption = `${platformName(p.platform)} à valider : ${p.title}\n\n${p.caption}${tags ? `\n${tags}` : ""}\n\nPour une retouche, réponds à ce message.`;
      const keyboard = new InlineKeyboard().text("Valider", `sp:ok:${p.id}`).text("Jeter", `sp:no:${p.id}`);
      const message = await bot.api.sendVideo(chat, new InputFile(p.media_path), { caption: caption.slice(0, 1000), reply_markup: keyboard, supports_streaming: true });
      savePostMessage.run(chat, message.message_id, p.id);
    },
    typing: () => void bot.api.sendChatAction(chat, "typing").catch(() => {}),
  });

  // Clark ne parle qu'à son propriétaire. Tout le reste est ignoré sans réponse.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== opts.ownerId || ctx.chat?.type !== "private" || ctx.chat.id !== chat) return;
    await next();
  });

  bot.on("message:text", async (ctx, next) => {
    const original = ctx.message.reply_to_message;
    // Une commande (/taches…) reste une commande, même envoyée en réponse à une question.
    if (ctx.message.text.trim().startsWith("/")) return next();
    if (original?.from?.id !== ctx.me.id) return next();
    // Réponse à une vidéo à valider : c'est une demande de retouche.
    const postLink = findPostMessage.get(chat, original.message_id) as { post_id: number } | undefined;
    if (postLink) {
      const outcome = hub.decidePost(Number(postLink.post_id), "redo", ctx.message.text);
      if (outcome === "already") await ctx.reply("Ce contenu a déjà été traité.");
      return;
    }
    const link = findQuestionMessage.get(chat, original.message_id);
    if (!link) return next();
    const answer = ctx.message.text.trim();
    if (!answer) {
      await ctx.reply("Écris une réponse à la question.");
    } else if (!hub.answerQuestion(Number(link.question_id), answer)) {
      await ctx.reply("Cette question n'attend plus de réponse.");
    }
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      "Salut, c'est Clark. Écris-moi normalement, ou envoie-moi un vocal.\n\n/nouveau : nouvelle conversation\n/memoire : ce que je retiens\n/budget : dépense du jour\n/taches : avancement et tâches à vérifier\n/equipe : confier une demande à l'équipe\n/objectif : donner un objectif que je poursuis sur plusieurs tours",
    ),
  );

  // Renvoie chaque tâche à vérifier avec ses boutons : un filet si une alerte s'est perdue.
  bot.command("taches", async (ctx) => {
    const open = journal.awaitingCheck().filter((t) => t.chat_id === OWNER_CHAT);
    const running = journal.unfinished().filter((t) => t.chat_id === OWNER_CHAT);
    if (!open.length && !running.length) {
      await ctx.reply("Rien à vérifier, aucune tâche en cours.");
      return;
    }
    for (const task of open) {
      const ok = await sendAlert(task.id, task.result ?? checkAlertText(task, uncertainSteps(journal.steps(task.id))));
      if (ok) journal.markAlerted(task.id);
    }
    for (const task of running) {
      const title = task.label === "brief" ? "Brief du matin" : task.prompt.replace(/\s+/g, " ").trim();
      const heading = `#${task.id} · ${statusText[task.status]} · ${title.slice(0, 160)}${title.length > 160 ? "…" : ""}`;
      if (task.label !== TEAM_LABEL || task.status === "queued") {
        await send([heading, task.checkpoint].filter(Boolean).join("\n"));
        continue;
      }
      const team = teamView(journal, task);
      const lines = team.agents.map((agent) => {
        const detail = agent.checkpoint ?? agent.detail ?? agent.after;
        return `• ${agent.name} · ${statusText[agent.status]}${detail ? ` — ${detail}` : ""}`;
      });
      await send([heading, team.plan, ...lines].join("\n"));
    }
  });

  bot.command("nouveau", () => hub.newConversation());

  // /objectif <but> : Clark enchaîne les tours jusqu'à l'atteindre ; le suivi arrive ici.
  bot.command("objectif", async (ctx) => {
    const text = ctx.match?.toString().trim() ?? "";
    if (text.length < 10) return void (await ctx.reply("Écris l'objectif après la commande, par exemple : /objectif Préparer les relances de toutes mes candidatures"));
    const id = createGoal(hub, text, DEFAULT_MAX_TURNS, "telegram");
    await ctx.reply(`Objectif #${id} lancé. Je te préviens quand il est atteint ou si j'ai besoin de toi.`);
  });

  // « /equipe ta demande » : Chercheur, Rédacteur puis Relecteur.
  bot.command("equipe", (ctx) => {
    const text = ctx.match?.trim();
    if (!text) return ctx.reply("Écris ta demande après la commande : /equipe prépare mes relances de candidature");
    void hub.enqueue(OWNER_CHAT, text, TEAM_LABEL, "telegram");
  });

  bot.command("memoire", (ctx) => {
    const lines = store
      .top(8)
      .map((m) => `#${m.id} ${m.content}`)
      .join("\n");
    return ctx.reply(`${store.count()} souvenirs.\n\n${lines || "Rien encore."}`);
  });

  bot.command("budget", (ctx) => ctx.reply(`Dépensé aujourd'hui : ${store.spentToday().toFixed(2)} $ sur ${config.maxUsdPerDay} $.`));

  bot.callbackQuery(/^(ok|no):(.+)$/, async (ctx) => {
    const [, verdict, id] = ctx.match;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    // Le « Validé » / « Refusé » arrive par le fil, sur tous les canaux.
    const live = hub.resolveApproval(id, verdict === "ok");
    await ctx.answerCallbackQuery({ text: live ? (verdict === "ok" ? "Validé" : "Refusé") : "Demande expirée." });
  });

  bot.callbackQuery(/^qa:(\d+):(\d+)$/, async (ctx) => {
    const [, id, index] = ctx.match;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const q = store.questions.get(Number(id));
    const option = q ? optionsOf(q)[Number(index)] : undefined;
    const live = option !== undefined && hub.answerQuestion(Number(id), option);
    await ctx.answerCallbackQuery({ text: live ? "Réponse envoyée" : "Cette question n'attend plus de réponse." });
  });

  bot.callbackQuery(/^ml:(ok|no):(\d+)$/, async (ctx) => {
    const [, verdict, id] = ctx.match;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const outcome = await hub.decideMail(Number(id), verdict === "ok" ? "send" : "refuse");
    const text = { sent: "Envoyé", refused: "Refusé : rien n'est parti", failed: "Échec de l'envoi (détail dans le fil)", already: "Déjà traité." }[outcome];
    await ctx.answerCallbackQuery({ text });
  });

  bot.callbackQuery(/^ini:(ok|no):(\d+)$/, async (ctx) => {
    const [, verdict, id] = ctx.match;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const outcome = hub.decideInitiative(Number(id), verdict === "ok" ? "accept" : "decline");
    await ctx.answerCallbackQuery({ text: outcome === "done" ? (verdict === "ok" ? "Accepté : je m'y mets" : "Refusé") : "Déjà traité." });
  });

  bot.callbackQuery(/^sp:(ok|no):(\d+)$/, async (ctx) => {
    const [, verdict, id] = ctx.match;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const outcome = hub.decidePost(Number(id), verdict === "ok" ? "approve" : "reject");
    await ctx.answerCallbackQuery({ text: outcome === "done" ? (verdict === "ok" ? "Validé" : "Jeté") : "Déjà traité." });
  });

  // Boutons durables : l'id de tâche suffit, ils marchent même après un redémarrage.
  bot.callbackQuery(/^task:(resume|drop):(\d+)$/, async (ctx) => {
    const [, action, rawId] = ctx.match;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const outcome = hub.resolveCheck(Number(rawId), action as "resume" | "drop");
    await ctx.answerCallbackQuery({ text: outcome === "already" ? "Déjà traité." : outcome === "abandoned" ? "Abandonnée" : "Je reprends" });
  });

  // Un vocal : transcrit sur le Mac (whisper.cpp), puis traité comme un message écrit.
  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const media = ctx.message.voice ?? ctx.message.audio;
    if (!media) return;
    const status = voice.status();
    if (!status.ready) return void (await ctx.reply(`Je ne peux pas encore écouter les vocaux : ${status.problem}.`));
    if ((media.file_size ?? 0) > VOICE_MAX_BYTES || (media.duration ?? 0) > VOICE_MAX_SECONDS) {
      return void (await ctx.reply("Ce vocal est trop long pour moi (10 minutes au plus)."));
    }
    void bot.api.sendChatAction(chat, "typing").catch(() => {});
    const dir = mkdtempSync(join(tmpdir(), "clark-tg-"));
    let text = "";
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("fichier sans chemin");
      const dest = join(dir, "vocal");
      await voice.download(file.file_path, dest);
      text = await voice.transcribe(dest, store.voice.vocabulary());
    } catch (err) {
      console.error("[clark] vocal non transcrit :", err);
      return void (await ctx.reply("Je n'ai pas réussi à transcrire ce vocal. Réessaie, ou écris-le."));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (!text) return void (await ctx.reply("Je n'ai rien entendu dans ce vocal."));

    // Un vocal en réponse à une question ou à une vidéo compte comme une réponse écrite.
    const original = ctx.message.reply_to_message;
    if (original?.from?.id === ctx.me.id) {
      const postLink = findPostMessage.get(chat, original.message_id) as { post_id: number } | undefined;
      if (postLink) {
        const outcome = hub.decidePost(Number(postLink.post_id), "redo", text);
        await ctx.reply(outcome === "already" ? "Ce contenu a déjà été traité." : `Retouche demandée : « ${text} »`);
        return;
      }
      const link = findQuestionMessage.get(chat, original.message_id);
      if (link) {
        const ok = hub.answerQuestion(Number(link.question_id), text);
        await ctx.reply(ok ? `Réponse envoyée : « ${text} »` : "Cette question n'attend plus de réponse.");
        return;
      }
    }
    // Tu vois ce que j'ai compris : si la transcription se trompe, tu le sais tout de suite.
    await ctx.reply(`J'ai compris : « ${text} »`);
    const r = submitRequest(hub, text, { source: "telegram", onCreated: (id) => voiceTasks.add(id) });
    if ("error" in r) await ctx.reply(r.error);
    else if (r.kind === "goal") await ctx.reply("Objectif lancé. Je te préviens quand il est atteint ou si j'ai besoin de toi.");
  });

  bot.on("message:text", async (ctx) => {
    // « /relances Studio Pixel » : une commande perso ; une commande inconnue n'est pas envoyée à Clark.
    const text = ctx.message.text;
    if (text.trim().startsWith("/") && !expandCommand(text)) return void (await ctx.reply("Commande inconnue. Tes commandes perso sont dans Réglages ; /start liste celles de Clark."));
    const r = submitRequest(hub, text, { source: "telegram" });
    if ("error" in r) await ctx.reply(r.error);
    else if (r.kind === "goal") await ctx.reply("Objectif lancé. Je te préviens quand il est atteint ou si j'ai besoin de toi.");
  });

  bot.catch((err) => console.error("[clark] erreur Telegram :", err.error));

  return bot;
}
