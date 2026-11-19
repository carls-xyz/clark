/**
 * Une action longue (réunion d'un groupe, ouverture d'une PR, tâche de suivi) ne tourne qu'une
 * fois à la fois pour une même cible : un double clic n'en lance pas une seconde en parallèle.
 * busy : ce que renvoie l'appel refusé.
 */
const running = new Set<string>();

export async function once<T, B>(key: string, busy: B, fn: () => Promise<T>): Promise<T | B> {
  if (running.has(key)) return busy;
  running.add(key);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
}
