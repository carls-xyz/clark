import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { paths } from "../config.ts";
import { isInside } from "../policy/permissions.ts";

const run = promisify(execFile);

/**
 * Montage d'une vidéo verticale (TikTok, Reels, Shorts) à partir de tes clips :
 * chaque clip est recadré en 1080×1920, coupé, mis bout à bout, et les textes
 * d'écran sont incrustés à leurs moments. Tout se fait sur le Mac, avec ffmpeg :
 * aucun service extérieur. Le son des clips est retiré : la musique s'ajoute dans
 * l'application de la plateforme, avec ses titres sous licence.
 */
export type Clip = { path: string; start?: number; end?: number };
export type ScreenText = { text: string; start: number; end: number };
export type VideoSpec = { clips: Clip[]; texts?: ScreenText[]; output: string };

export const MAX_CLIPS = 12;
export const MAX_SECONDS = 180;

const SWIFT_SOURCE = resolve(paths.root, "src/social/text-card.swift");
const TEXT_BIN = resolve(paths.root, "data/bin/clark-text");

/** L'outil qui dessine les textes : compilé une fois depuis text-card.swift (macOS). */
async function textRenderer(): Promise<string> {
  if (existsSync(TEXT_BIN) && statSync(TEXT_BIN).mtimeMs >= statSync(SWIFT_SOURCE).mtimeMs) return TEXT_BIN;
  mkdirSync(resolve(TEXT_BIN, ".."), { recursive: true });
  await run("swiftc", ["-O", SWIFT_SOURCE, "-o", TEXT_BIN], { timeout: 180_000 });
  return TEXT_BIN;
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`durée illisible : ${file}`);
  return d;
}

/** Vérifie la demande : fichiers dans le dossier de Clark, existants, durées cohérentes. */
export async function checkSpec(spec: VideoSpec, roots = [paths.workspace]): Promise<{ clips: Required<Clip>[]; duration: number }> {
  if (!spec.clips.length) throw new Error("aucun clip");
  if (spec.clips.length > MAX_CLIPS) throw new Error(`${MAX_CLIPS} clips au plus`);
  if (!isInside(spec.output, roots)) throw new Error("la vidéo doit être écrite dans le dossier de Clark");
  const clips: Required<Clip>[] = [];
  for (const c of spec.clips) {
    const path = resolve(roots[0], c.path);
    if (!isInside(path, roots)) throw new Error(`clip hors du dossier de Clark : ${c.path}`);
    if (!existsSync(path)) throw new Error(`clip introuvable : ${c.path}`);
    const full = await probeDuration(path);
    const start = Math.max(0, c.start ?? 0);
    const end = Math.min(full, c.end ?? full);
    if (end - start < 0.3) throw new Error(`clip trop court après coupe : ${c.path}`);
    clips.push({ path, start, end });
  }
  const duration = clips.reduce((t, c) => t + (c.end - c.start), 0);
  if (duration > MAX_SECONDS) throw new Error(`vidéo trop longue (${Math.round(duration)} s, ${MAX_SECONDS} s au plus)`);
  for (const t of spec.texts ?? []) {
    if (!t.text.trim()) throw new Error("texte d'écran vide");
    if (t.start < 0 || t.end <= t.start || t.start >= duration) throw new Error(`moment de texte invalide (${t.start}–${t.end} s)`);
  }
  return { clips, duration };
}

export async function renderVertical(
  spec: VideoSpec,
  opts: { width?: number; height?: number; roots?: string[] } = {},
): Promise<{ path: string; duration: number; width: number; height: number }> {
  const width = opts.width ?? 1080;
  const height = opts.height ?? 1920;
  const { clips, duration } = await checkSpec(spec, opts.roots);
  const texts = spec.texts ?? [];
  const work = mkdtempSync(join(tmpdir(), "clark-video-"));
  try {
    // Les textes d'écran, dessinés en images transparentes de la taille de la vidéo.
    const cards: string[] = [];
    if (texts.length) {
      const bin = await textRenderer();
      for (const [i, t] of texts.entries()) {
        const file = join(work, `texte-${i}.png`);
        await run(bin, [file, String(width), String(height), String(Math.round(width / 17)), t.text.trim()]);
        cards.push(file);
      }
    }

    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    for (const c of clips) args.push("-ss", c.start.toFixed(3), "-to", c.end.toFixed(3), "-i", c.path);
    for (const card of cards) args.push("-loop", "1", "-i", card);

    // Chaque clip recadré pour remplir le format vertical, puis tous mis bout à bout.
    const filters = clips.map(
      (_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setsar=1,format=yuv420p[v${i}]`,
    );
    filters.push(`${clips.map((_, i) => `[v${i}]`).join("")}concat=n=${clips.length}:v=1:a=0[base]`);
    let last = "base";
    texts.forEach((t, i) => {
      const input = clips.length + i;
      const out = `t${i}`;
      filters.push(`[${last}][${input}:v]overlay=0:0:enable='between(t,${t.start},${Math.min(t.end, duration)})':shortest=1[${out}]`);
      last = out;
    });

    mkdirSync(resolve(spec.output, ".."), { recursive: true });
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      `[${last}]`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-t",
      duration.toFixed(3),
      spec.output,
    );
    await run("ffmpeg", args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { path: spec.output, duration: await probeDuration(spec.output), width, height };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
