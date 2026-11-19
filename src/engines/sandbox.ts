import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../config.ts";

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Bac à sable du moteur Claude (idée reprise de Spettro) : les commandes shell tournent
 * sous Seatbelt (macOS), réglé ici et invisible pour le modèle, comme le profil de Codex :
 * - lecture : ton dossier personnel est fermé, sauf le dossier de travail et la mémoire cœur
 *   de Clark (donc ni .env, ni data/, ni tes autres projets) ;
 * - écriture : ces deux dossiers et le dossier temporaire ;
 * - réseau : aucun.
 * Il échoue fermé : s'il ne peut pas démarrer, la commande ne tourne pas. Le modèle ne peut
 * pas demander à en sortir. La validation par bouton reste en plus.
 * CLARK_SANDBOX=off le coupe (dépannage seulement).
 */
export const sandboxEnabled = () => process.env.CLARK_SANDBOX?.trim().toLowerCase() !== "off";

export function claudeSandbox(): SandboxSettings | undefined {
  if (!sandboxEnabled()) return undefined;
  const open = [real(paths.workspace), real(paths.coreMemory)];
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: [real(homedir())],
      allowRead: open,
      allowWrite: [...open, real(tmpdir())],
    },
    network: { allowedDomains: [] },
  };
}
