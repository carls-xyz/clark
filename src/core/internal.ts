import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Adresse interne : le serveur MCP de Codex (autre processus) passe par l'interface web locale
 * pour piloter le navigateur, tenu par le processus principal. Un jeton tiré à chaque démarrage
 * prouve que l'appel vient de Clark ; il n'est écrit que dans la config de Codex (fichier 0600).
 */
let token: string | null = null;
export const internalToken = () => (token ??= randomBytes(24).toString("hex"));

export function isInternal(given: string | string[] | undefined): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(internalToken());
  return a.length === b.length && timingSafeEqual(a, b);
}
