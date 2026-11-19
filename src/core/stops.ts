/**
 * Arrêter un agent en plein tour, sur le clic de Charles : chaque moteur inscrit ici de quoi
 * interrompre la tâche qu'il fait tourner (Claude : abandon de la requête ; Codex : turn/interrupt).
 */
const stops = new Map<number, () => void>();
const stopped = new Set<number>();

export function onStop(taskId: number, fn: () => void): () => void {
  stops.set(taskId, fn);
  return () => {
    if (stops.get(taskId) === fn) stops.delete(taskId);
  };
}

export const canStop = (taskId: number) => stops.has(taskId);
/** La tâche a-t-elle été arrêtée par Charles ? (pour dire pourquoi elle s'est terminée) */
export const wasStopped = (taskId: number) => stopped.has(taskId);

export function stopRunning(taskId: number): boolean {
  const fn = stops.get(taskId);
  if (!fn) return false;
  stopped.add(taskId);
  stops.delete(taskId);
  fn();
  return true;
}
