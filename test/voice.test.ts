import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bot } from "grammy";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { DEFAULT_PERSONALITY, PERSONALITY_LIMIT, readPersonality, savePersonality } from "../src/core/personality.ts";
import { buildSystemPrompt } from "../src/core/prompt.ts";
import { createTelegram, type TelegramVoice } from "../src/gateway/telegram.ts";
import { startWeb, type WebVoice } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";
import { forSpeech, resolveVoice } from "../src/voice/voice.ts";

const dir = mkdtempSync(join(tmpdir(), "clark-voice-test-"));
process.env.CLARK_PERSONALITY_FILE = join(dir, "personnalite.md");

const config = (port = 0): Config => ({
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: port,
  model: "claude-opus-5-5",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
});

function setup(port = 0) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const prompts: string[] = [];
  const execute: typeof executeTask = async (deps, taskId, run) => {
    prompts.push(run.prompt);
    deps.journal.finish(taskId, "done", "Voilà tes mails : rien d'urgent.", 0);
    return { text: "Voilà tes mails : rien d'urgent.", costUsd: 0, status: "done" };
  };
  const hub = createHub({ config: config(port), store, journal, conversation }, { execute });
  return { store, journal, conversation, hub, prompts };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

test("personnalité : texte par défaut, enregistrée dans son fichier, limitée, et placée sous les règles fixes", () => {
  assert.deepEqual(readPersonality(), { text: DEFAULT_PERSONALITY, custom: false });
  assert.deepEqual(savePersonality("- Pince-sans-rire.\r\n- Phrases courtes."), { ok: true });
  assert.deepEqual(readPersonality(), { text: "- Pince-sans-rire.\n- Phrases courtes.", custom: true });
  assert.ok("error" in savePersonality("x".repeat(PERSONALITY_LIMIT + 1)));
  assert.equal(readPersonality().text, "- Pince-sans-rire.\n- Phrases courtes.", "un texte trop long ne remplace rien");

  const { store } = setup();
  const prompt = buildSystemPrompt(store, join(dir, "vide"));
  const rules = prompt.indexOf("Limites :");
  const personality = prompt.indexOf("## Personnalité");
  assert.ok(rules > 0 && personality > rules, "la personnalité vient après les règles");
  assert.match(prompt, /les règles ci-dessus gagnent/);
  assert.match(prompt, /Pince-sans-rire/);

  // Vide : retour au texte par défaut.
  savePersonality("");
  assert.equal(readPersonality().custom, false);
});

test("voix : ce qui se lit (sans markdown ni liens, coupé à une phrase) et le choix de la voix", () => {
  assert.equal(forSpeech("**Studio Pixel** : relance le `20/11`, voir https://exemple.fr/x"), "Studio Pixel : relance le 20/11, voir (lien dans le texte)");
  assert.equal(forSpeech("- un\n- deux"), "un deux");
  const long = forSpeech(`${"Une phrase assez longue pour remplir. ".repeat(60)}`, 300);
  assert.ok(long.length < 340 && long.endsWith("La suite est dans le texte."));
  const voices = ["Eddy (Français (France))", "Thomas (Français (France))", "Flo (Français (Canada))"];
  assert.equal(resolveVoice("Thomas", voices), "Thomas (Français (France))");
  assert.equal(resolveVoice("Flo (Français (Canada))", voices), "Flo (Français (Canada))");
  assert.equal(resolveVoice("Inconnue", ["Eddy (Français (France))"]), "Eddy (Français (France))");
});

test("réglage de la voix : « si vocal » par défaut, mode inconnu refusé", async () => {
  const { store } = setup();
  assert.equal(store.voice.mode(), "voice");
  assert.ok("error" in (await store.voice.set({ mode: "parfois" })));
  assert.deepEqual(await store.voice.set({ mode: "never" }), { ok: true });
  assert.equal(store.voice.mode(), "never");
});

function telegramSetup(voice: Partial<TelegramVoice> = {}) {
  const s = setup();
  const sent: { method: string; payload: any }[] = [];
  const bot = new Bot("123:test", { botInfo: { id: 999, is_bot: true, first_name: "Clark", username: "clark_bot" } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    const result = method === "getFile" ? { file_id: "f", file_unique_id: "u", file_path: "voice/file_1.oga" } : { message_id: sent.length, date: 0, chat: { id: 1, type: "private" } };
    return { ok: true, result } as never;
  });
  const heard: string[] = [];
  const spoken: string[] = [];
  createTelegram(s.hub, {
    token: "123:test",
    ownerId: 1,
    bot,
    voice: {
      status: () => ({ ready: true, canSpeak: true, problem: null }),
      download: async (_path, dest) => writeFileSync(dest, "audio"),
      transcribe: async (file) => {
        heard.push(readFileSync(file, "utf8"));
        return "Regarde mes mails non lus";
      },
      speak: async (text, _voice, _format, dest) => {
        spoken.push(text);
        writeFileSync(dest, "ogg");
        return dest;
      },
      ...voice,
    },
  });
  const owner = { id: 1, is_bot: false, first_name: "Charles" };
  const chat = { id: 1, type: "private" as const, first_name: "Charles" };
  const voiceNote = (id: number, extra: object = {}) =>
    bot.handleUpdate({ update_id: id, message: { message_id: 100 + id, date: 0, chat, from: owner, voice: { file_id: "f", file_unique_id: "u", duration: 4, file_size: 5000 }, ...extra } as never });
  return { ...s, bot, sent, heard, spoken, voiceNote, owner, chat };
}

test("Telegram : un vocal est transcrit, montré, traité comme un message, et la réponse revient aussi en vocal", async () => {
  const t = telegramSetup();
  await t.voiceNote(1);
  await settle();
  assert.deepEqual(t.heard, ["audio"], "le fichier téléchargé est transcrit");
  assert.ok(t.sent.some((s) => s.method === "sendMessage" && s.payload.text === "J'ai compris : « Regarde mes mails non lus »"));
  assert.deepEqual(t.prompts, ["Regarde mes mails non lus"]);
  const mine = t.conversation.recent(OWNER_CHAT);
  assert.equal(mine.find((m) => m.role === "user")?.source, "telegram");
  assert.ok(t.sent.some((s) => s.method === "sendMessage" && s.payload.text === "Voilà tes mails : rien d'urgent."), "la réponse écrite part");
  await settle();
  assert.deepEqual(t.spoken, ["Voilà tes mails : rien d'urgent."]);
  assert.ok(t.sent.some((s) => s.method === "sendVoice"), "puis la réponse en vocal");

  // Un message écrit : en mode « si vocal », pas de vocal en retour.
  await t.bot.handleUpdate({ update_id: 2, message: { message_id: 300, date: 0, chat: t.chat, from: t.owner, text: "Et demain ?" } as never });
  await settle();
  await settle();
  assert.equal(t.sent.filter((s) => s.method === "sendVoice").length, 1);

  // « Toujours » : chaque réponse ; « Jamais » : aucune.
  await t.store.voice.set({ mode: "always" });
  await t.bot.handleUpdate({ update_id: 3, message: { message_id: 301, date: 0, chat: t.chat, from: t.owner, text: "Et après-demain ?" } as never });
  await settle();
  await settle();
  assert.equal(t.sent.filter((s) => s.method === "sendVoice").length, 2);
  await t.store.voice.set({ mode: "never" });
  await t.voiceNote(4);
  await settle();
  await settle();
  assert.equal(t.sent.filter((s) => s.method === "sendVoice").length, 2);
});

test("Telegram : vocal sans transcription prête, trop long, ou illisible → Clark le dit, rien ne part à l'agent", async () => {
  const off = telegramSetup({ status: () => ({ ready: false, canSpeak: false, problem: "whisper.cpp introuvable : brew install whisper-cpp" }) });
  await off.voiceNote(1);
  assert.match(off.sent.at(-1)!.payload.text, /Je ne peux pas encore écouter les vocaux : whisper\.cpp introuvable/);

  const long = telegramSetup();
  await long.bot.handleUpdate({
    update_id: 2,
    message: { message_id: 5, date: 0, chat: long.chat, from: long.owner, voice: { file_id: "f", file_unique_id: "u", duration: 900 } } as never,
  });
  assert.match(long.sent.at(-1)!.payload.text, /trop long/);

  const broken = telegramSetup({
    transcribe: async () => {
      throw new Error("whisper a planté");
    },
  });
  await broken.voiceNote(3);
  assert.match(broken.sent.at(-1)!.payload.text, /pas réussi à transcrire/);

  const silent = telegramSetup({ transcribe: async () => "" });
  await silent.voiceNote(4);
  assert.match(silent.sent.at(-1)!.payload.text, /rien entendu/);
  await settle();
  assert.deepEqual([...off.prompts, ...long.prompts, ...broken.prompts, ...silent.prompts], []);
});

test("Telegram : un vocal en réponse à une question y répond", async () => {
  const t = telegramSetup();
  const qid = t.store.questions.ask({ taskId: 1, question: "Quelle date pour la relance ?" });
  await settle();
  const asked = t.sent.find((s) => s.method === "sendMessage" && /Réponds à ce message/.test(s.payload.text));
  assert.ok(asked, "la question part sur Telegram");
  const messageId = t.sent.indexOf(asked) + 1;
  await t.voiceNote(1, { reply_to_message: { message_id: messageId, date: 0, chat: t.chat, from: { id: 999, is_bot: true, first_name: "Clark" } } });
  await settle();
  assert.ok(t.sent.some((s) => s.method === "sendMessage" && /Réponse envoyée : « Regarde mes mails non lus »/.test(s.payload.text)), JSON.stringify(t.sent.map((s) => [s.method, s.payload.text])));
  assert.equal(t.store.questions.get(qid)!.answer, "Regarde mes mails non lus");
  assert.deepEqual(t.prompts, [], "une réponse n'est pas une nouvelle demande");
  assert.equal(t.store.questions.get(qid)?.answer, "Regarde mes mails non lus");
});

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; body: any; type: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { Host: `localhost:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        const type = String(res.headers["content-type"] ?? "");
        resolve({ status: res.statusCode ?? 0, body: type.startsWith("application/json") ? JSON.parse(data.toString()) : data, type });
      });
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

test("web : dictée transcrite, voix et personnalité réglées, lecture d'un message de Clark seulement", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = setup(port);
  const fake: WebVoice = {
    status: () => ({ ready: true, canSpeak: true, problem: null }),
    transcribe: async (file) => (readFileSync(file).length ? "Prépare la relance de Studio Pixel" : ""),
    speak: async (_text, _voice, _format, dest) => {
      writeFileSync(dest, "m4a");
      return dest;
    },
    voices: async () => ["Thomas (Français (France))", "Flo (Français (France))"],
  };
  const web = await startWeb(s.hub, { port, voice: fake });
  try {
    const origin = `http://localhost:${port}`;
    const audio = { "Content-Type": "audio/webm", Origin: origin };
    assert.equal((await call(port, "/api/voice/transcribe", { method: "POST", headers: { ...audio, Origin: "https://evil.example" }, body: "x" })).status, 403);
    assert.equal((await call(port, "/api/voice/transcribe", { method: "POST", headers: { ...audio, "Content-Type": "text/plain" }, body: "x" })).status, 415);
    const ok = await call(port, "/api/voice/transcribe", { method: "POST", headers: audio, body: Buffer.from("audio") });
    assert.deepEqual(ok.body, { text: "Prépare la relance de Studio Pixel" });
    assert.deepEqual(s.prompts, [], "la dictée remplit le champ, elle n'envoie rien");

    const json = { "Content-Type": "application/json", Origin: origin };
    assert.equal((await call(port, "/api/voice/settings", { method: "POST", headers: json, body: JSON.stringify({ mode: "parfois" }) })).status, 400);
    assert.equal((await call(port, "/api/voice/settings", { method: "POST", headers: json, body: JSON.stringify({ mode: "always" }) })).status, 200);
    assert.equal((await call(port, "/api/personality", { method: "POST", headers: json, body: JSON.stringify({ text: "x".repeat(PERSONALITY_LIMIT + 5) }) })).status, 400);
    assert.equal((await call(port, "/api/personality", { method: "POST", headers: json, body: JSON.stringify({ text: "- Sobre." }) })).status, 200);
    await settle();
    const state = (await call(port, "/api/state")).body;
    assert.equal(state.voice.mode, "always");
    assert.equal(state.voice.voice, "Thomas (Français (France))", "« Thomas » devient la voix de France");
    assert.deepEqual(state.personality, { text: "- Sobre.", custom: true, limit: PERSONALITY_LIMIT });

    const user = s.conversation.add({ chatId: OWNER_CHAT, role: "user", text: "Salut" });
    const clark = s.conversation.add({ chatId: OWNER_CHAT, role: "clark", text: "Salut Charles." });
    const other = s.conversation.add({ chatId: 0, role: "clark", text: "Tour de veille" });
    assert.equal((await call(port, `/api/voice/speech/${user.id}`)).status, 404);
    assert.equal((await call(port, `/api/voice/speech/${other.id}`)).status, 404);
    const speech = await call(port, `/api/voice/speech/${clark.id}`);
    assert.equal(speech.status, 200);
    assert.equal(speech.type, "audio/mp4");
    assert.equal((await call(port, "/api/voice/sample?voix=Inconnue")).status, 400);
    assert.equal((await call(port, `/api/voice/sample?voix=${encodeURIComponent("Flo (Français (France))")}`)).status, 200);
  } finally {
    await web.close();
    savePersonality("");
  }
});
