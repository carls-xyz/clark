import type { ChildProcess } from "node:child_process";

/**
 * Arrête une commande lancée avec detached: true et tout ce qu'elle a lancé (npm test, ses
 * workers, un serveur) : son groupe de processus entier, pas seulement le shell.
 */
export function killTree(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
