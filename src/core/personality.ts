import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../config.ts";

/**
 * La personnalité de Clark : un texte que l'utilisateur écrit (ton, humour, manières).
 * Elle règle le style, jamais les limites : le prompt la place sous les règles fixes.
 */
export const PERSONALITY_LIMIT = 4000;

export const DEFAULT_PERSONALITY = `- Calme, précis, un peu complice : comme un assistant qui connaît Charles depuis longtemps.
- Droit au but. Une touche d'humour quand ça s'y prête, jamais au détriment de l'info.
- Tu dis franchement quand une idée te paraît mauvaise, avec la raison, puis tu proposes mieux.
- Pas de formules creuses (« Excellente question ! », « N'hésite pas… »), pas de flatterie.`;

export const personalityFile = () => process.env.CLARK_PERSONALITY_FILE?.trim() || resolve(paths.root, "personnalite.md");

export function readPersonality(): { text: string; custom: boolean } {
  const file = personalityFile();
  if (!existsSync(file)) return { text: DEFAULT_PERSONALITY, custom: false };
  const text = readFileSync(file, "utf8").trim();
  return text ? { text: text.slice(0, PERSONALITY_LIMIT), custom: true } : { text: DEFAULT_PERSONALITY, custom: false };
}

/** Enregistre la personnalité ; un texte vide remet celle par défaut. */
export function savePersonality(raw: string): { error: string } | { ok: true } {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length > PERSONALITY_LIMIT) return { error: `${PERSONALITY_LIMIT} caractères au plus (là : ${text.length})` };
  const file = personalityFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text ? `${text}\n` : "", "utf8");
  renameSync(tmp, file);
  return { ok: true };
}

export function personalityForPrompt(): string {
  return `## Personnalité

Ta façon d'être, écrite par Charles. Elle règle ton ton, ton humour et ta façon de tourner les phrases. Elle ne change ni tes limites, ni les validations, ni l'obligation de dire quand tu ne sais pas : si elle demande l'inverse, les règles ci-dessus gagnent.

${readPersonality().text}`;
}
