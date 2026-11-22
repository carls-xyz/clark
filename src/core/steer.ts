/**
 * Message de l'utilisateur pendant qu'un agent travaille (idée reprise d'OpenBot, rien de copié) :
 * au lieu d'attendre la fin, il est glissé dans le tour en cours, entre deux actions.
 * Claude : entrée en flux du SDK (priorité « next ») ; Codex : turn/steer de l'App Server.
 */
type Steer = (text: string) => Promise<boolean>;

const live = new Map<number, Steer>();

/** Le moteur d'une tâche en cours dit comment lui glisser un message ; à retirer à la fin du tour. */
export function onSteer(taskId: number, fn: Steer): () => void {
  live.set(taskId, fn);
  return () => {
    if (live.get(taskId) === fn) live.delete(taskId);
  };
}

export const canSteer = (taskId: number) => live.has(taskId);

/** La consigne qui accompagne le message, pour que l'agent ne reparte pas de zéro. */
export function steerNote(text: string): string {
  return `[Message de Charles pendant que tu travailles]
${text}

Si c'est une question, réponds-y d'abord. Si c'est une correction, applique-la à partir de maintenant, sans refaire ce qui est déjà fait. Ne recommence pas la tâche ; arrête-toi seulement s'il te le demande.`;
}

/** Glisse le message dans le tour en cours. false : plus possible (le tour vient de finir). */
export async function steer(taskId: number, text: string): Promise<boolean> {
  const fn = live.get(taskId);
  if (!fn) return false;
  try {
    return await fn(steerNote(text));
  } catch {
    return false;
  }
}
