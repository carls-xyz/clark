import { format } from "node:util";

/**
 * Secrets masqués dans le journal (data/logs/clark.log) et sur la page Santé. Une erreur réseau de
 * Telegram contient l'adresse de l'API, donc le jeton du bot ; une erreur d'API peut citer une clé.
 */
const PATTERNS: [RegExp, string][] = [
  [/\bbot\d{5,}:[A-Za-z0-9_-]{20,}/g, "bot•••"],
  [/\b\d{6,}:AA[A-Za-z0-9_-]{20,}/g, "•••"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-•••"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "sk-•••"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh•••"],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, "ya29.•••"],
  [/([?&](?:access_token|token|key|api_key)=)[^&\s"']+/gi, "$1•••"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, by] of PATTERNS) out = out.replace(re, by);
  return out;
}

let installed = false;
/** Tout ce que Clark écrit dans son journal passe par le masque (console.log/info/warn/error). */
export function installLogRedaction() {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(redactSecrets(format(...args)));
  }
}
