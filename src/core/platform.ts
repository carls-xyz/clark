import { existsSync, readFileSync, rmSync } from "node:fs";

/**
 * Ce qui ne marche que sur un Mac. Clark tourne aussi ailleurs (un VPS Linux) : ces morceaux
 * y sont simplement absents, avec une raison claire, au lieu d'échouer au premier usage.
 *
 * - iMessage : lit la base de Messages et envoie par AppleScript ;
 * - la fenêtre de choix de fichier (osascript) ;
 * - garder la machine éveillée (caffeinate) ;
 * - la voix du système (say).
 *
 * Tout le reste (moteurs, mémoire, navigateur, Telegram, Google, dev) ne dépend pas du système.
 */
export type MacOnly = "imessage" | "filePicker" | "keepAwake" | "voice";

export const MAC_ONLY: Record<MacOnly, string> = {
  imessage: "iMessage",
  filePicker: "la fenêtre de choix de fichier",
  keepAwake: "garder la machine éveillée",
  voice: "la voix du système",
};

export const onMac = (platform: NodeJS.Platform = process.platform) => platform === "darwin";

/** Pour l'interface : le système, et ce qui y manque. */
export function platformInfo(platform: NodeJS.Platform = process.platform) {
  const mac = onMac(platform);
  return {
    mac,
    name: mac ? "macOS" : platform === "linux" ? "Linux" : platform,
    missing: mac ? [] : (Object.keys(MAC_ONLY) as MacOnly[]),
  };
}

/** Message d'erreur pour un morceau absent hors Mac. */
export const notOnThisSystem = (what: MacOnly) => `${MAC_ONLY[what].charAt(0).toUpperCase()}${MAC_ONLY[what].slice(1)} : seulement quand Clark tourne sur un Mac.`;

/**
 * Retour à la version précédente (scripts/service.sh) : la nouvelle version ne démarrait pas,
 * le script est revenu à la dernière qui marchait et a laissé une note (data/rollback.txt :
 * version en échec, sa branche, version de secours). Lue une fois au démarrage, puis effacée.
 */
export function takeRollbackNote(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  const [failed, branch, good] = raw.split("\n").map((l) => l.trim());
  if (!failed || !good) return null;
  const s = (c: string) => c.slice(0, 7);
  return `Je tourne sur une version de secours (${s(good)}) : la nouvelle version (${s(failed)}${branch && branch !== failed ? `, branche ${branch}` : ""}) ne démarrait pas, j'y suis revenu tout seul. Le journal dit pourquoi (scripts/service.sh logs). Une fois corrigé : git switch ${branch && branch !== failed ? branch : "main"} && scripts/service.sh restart.`;
}

/**
 * Le shell des commandes (pré-vérifications, tests des projets, Terminal) : CLARK_SHELL, sinon zsh
 * s'il est là (le Mac), sinon bash (un serveur Linux sans zsh). Toujours lancé avec « -lc ».
 */
export function loginShell(exists: (p: string) => boolean = existsSync): string {
  const wanted = process.env.CLARK_SHELL?.trim();
  if (wanted) return wanted;
  return exists("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
}
