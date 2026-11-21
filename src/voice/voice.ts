import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { paths } from "../config.ts";

const run = promisify(execFile);

/**
 * La voix de Clark, entièrement sur le Mac :
 * - tes vocaux sont transcrits par whisper.cpp (rien ne part sur Internet) ;
 * - ses réponses sont lues par une voix macOS (say), puis encodées par ffmpeg.
 */

export const VOICE_MODES = ["never", "voice", "always"] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];
export const DEFAULT_VOICE = "Thomas";
/** Au plus 10 minutes d'audio par vocal. */
const MAX_SECONDS = 600;
/** Une réponse lue s'arrête vers 1 200 caractères (environ 1 min 30) ; le texte complet reste écrit. */
const SPEECH_LIMIT = 1200;
/** Aide whisper sur les mots de Clark (noms propres, outils). */
const VOCABULARY = "Clark, Charles, mails, Gmail, agenda, relances, Telegram, Codex, Claude.";

function firstExisting(envName: string, candidates: string[]): string | null {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  // Le service launchd n'a pas Homebrew dans son PATH : on cherche aux emplacements connus.
  return candidates.find((c) => existsSync(c)) ?? null;
}

export const whisperBin = () => firstExisting("CLARK_WHISPER_BIN", ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]);
export const ffmpegBin = () => firstExisting("CLARK_FFMPEG_BIN", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
export const whisperModel = () => process.env.CLARK_WHISPER_MODEL?.trim() || resolve(paths.root, "data/whisper/ggml-small.bin");
const sayBin = () => (existsSync("/usr/bin/say") ? "/usr/bin/say" : null);

export type VoiceStatus = { ready: boolean; canSpeak: boolean; problem: string | null };

export function voiceStatus(): VoiceStatus {
  const ffmpeg = ffmpegBin();
  const problem = !ffmpeg
    ? "ffmpeg introuvable : brew install ffmpeg"
    : !whisperBin()
      ? "whisper.cpp introuvable : brew install whisper-cpp"
      : !existsSync(whisperModel())
        ? "modèle de transcription absent : voir docs/GUIDE.md, « Personnalité et voix »"
        : null;
  return { ready: !problem, canSpeak: Boolean(ffmpeg && sayBin()), problem };
}

/** Les voix françaises installées sur le Mac (say -v ?). */
let voicesCache: string[] | null = null;
export async function frenchVoices(): Promise<string[]> {
  if (voicesCache) return voicesCache;
  const say = sayBin();
  if (!say) return [];
  const { stdout } = await run(say, ["-v", "?"], { timeout: 10_000 });
  voicesCache = [
    ...new Set(
      stdout
        .split("\n")
        .map((l) => l.match(/^(.+?)\s+(fr_FR|fr_CA|fr_BE|fr_CH)\s+#/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .sort((a, b) => (a[2] === "fr_FR" ? 0 : 1) - (b[2] === "fr_FR" ? 0 : 1))
        .map((m) => m[1].trim()),
    ),
  ];
  return voicesCache;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "clark-voice-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** La voix à utiliser : celle choisie si elle existe, sinon Thomas (France), sinon la première voix française. */
export function resolveVoice(wanted: string, voices: string[]): string {
  if (voices.includes(wanted)) return wanted;
  return voices.find((v) => v === `${wanted} (Français (France))`) ?? voices.find((v) => v.startsWith(DEFAULT_VOICE)) ?? voices[0] ?? DEFAULT_VOICE;
}

/** Transcrit un fichier audio (ogg, webm, m4a…) en texte français. */
export async function transcribe(input: string, vocabulary = ""): Promise<string> {
  const status = voiceStatus();
  if (!status.ready) throw new Error(status.problem ?? "voix indisponible");
  return withTmp(async (dir) => {
    const wav = join(dir, "in.wav");
    await run(ffmpegBin()!, ["-nostdin", "-loglevel", "error", "-y", "-i", input, "-t", String(MAX_SECONDS), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { timeout: 60_000 });
    const out = join(dir, "out");
    await run(whisperBin()!, ["-m", whisperModel(), "-l", "fr", "-f", wav, "-nt", "-np", "-otxt", "-of", out, "--prompt", `${VOCABULARY} ${vocabulary}`.trim().slice(0, 800)], { timeout: 180_000 });
    return readFileSync(`${out}.txt`, "utf8").replace(/\s+/g, " ").trim();
  });
}

/** Ce qui se lit à voix haute : sans markdown, sans adresses web, coupé à une fin de phrase. */
export function forSpeech(text: string, limit = SPEECH_LIMIT): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " (bloc de code, voir le texte) ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "(lien dans le texte)")
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > limit) {
    const cut = t.slice(0, limit);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    t = `${end > limit / 2 ? cut.slice(0, end + 1) : cut} La suite est dans le texte.`;
  }
  return t;
}

/** Lit un texte avec une voix macOS et l'encode : ogg (opus) pour Telegram, m4a (aac) pour le navigateur. */
export async function speak(text: string, voice: string, format: "ogg" | "m4a", dest: string): Promise<string> {
  const say = sayBin();
  const ffmpeg = ffmpegBin();
  if (!say || !ffmpeg) throw new Error("say ou ffmpeg introuvable");
  const voices = await frenchVoices();
  const chosen = resolveVoice(voice, voices);
  const spoken = forSpeech(text);
  if (!spoken) throw new Error("rien à lire");
  return withTmp(async (dir) => {
    const txt = join(dir, "say.txt");
    const aiff = join(dir, "say.aiff");
    writeFileSync(txt, spoken, "utf8");
    await run(say, ["-v", chosen, "-o", aiff, "-f", txt], { timeout: 120_000 });
    const codec = format === "ogg" ? ["-c:a", "libopus", "-b:a", "32k"] : ["-c:a", "aac", "-b:a", "64k"];
    await run(ffmpeg, ["-nostdin", "-loglevel", "error", "-y", "-i", aiff, ...codec, dest], { timeout: 60_000 });
    return dest;
  });
}

/** Réglages de voix (quand répondre en vocal, quelle voix), gardés en base. */
export class VoiceSettings {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS voice_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  private get(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  private put(key: string, value: string) {
    this.db.prepare("INSERT INTO voice_settings (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value").run(key, value);
  }
  mode(): VoiceMode {
    const m = this.get("mode");
    return (VOICE_MODES as readonly string[]).includes(m ?? "") ? (m as VoiceMode) : "voice";
  }
  voice(): string {
    return this.get("voice") ?? DEFAULT_VOICE;
  }
  /** Tes mots à toi (noms, projets) : aident la transcription à les écrire juste. */
  vocabulary(): string {
    return this.get("vocabulary") ?? "";
  }
  async set(p: { mode?: unknown; voice?: unknown; vocabulary?: unknown }): Promise<{ error: string } | { ok: true }> {
    if (p.vocabulary !== undefined) {
      if (typeof p.vocabulary !== "string" || p.vocabulary.length > 600) return { error: "Vocabulaire : 600 caractères au plus" };
      this.put("vocabulary", p.vocabulary.replace(/\s+/g, " ").trim());
    }
    if (p.mode !== undefined) {
      if (!(VOICE_MODES as readonly unknown[]).includes(p.mode)) return { error: "Mode inconnu" };
      this.put("mode", p.mode as string);
    }
    if (p.voice !== undefined) {
      if (typeof p.voice !== "string" || !(await frenchVoices()).includes(p.voice)) return { error: "Voix introuvable sur ce Mac" };
      this.put("voice", p.voice);
    }
    return { ok: true };
  }
}
