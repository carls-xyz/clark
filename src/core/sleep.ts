/**
 * Veille de la machine : quand le Mac dort (capot fermé, sur batterie), le processus de Clark est suspendu.
 * Un minuteur qui devrait battre toutes les 15 s voit alors un trou de plusieurs minutes : c'est une veille.
 * Sert à ne pas dire « l'agent est peut-être bloqué » quand c'est la machine qui dormait.
 */

export type SleepWatch = {
  /** Relève l'horloge maintenant (appelé aussi par le minuteur) : un trou trop long est noté comme une veille. */
  tick(now?: number): void;
  /** Temps passé en veille (ms) entre deux instants. */
  sleptBetween(from: number, to: number): number;
  stop(): void;
};

/** Un battement attendu toutes les TICK_MS ; un trou de plus de GAP_MS est une veille. */
export const TICK_MS = 15_000;
export const GAP_MS = 60_000;

export function createSleepWatch(opts: { now?: () => number; timer?: boolean } = {}): SleepWatch {
  const clock = opts.now ?? Date.now;
  let last = clock();
  const sleeps: { from: number; to: number }[] = [];
  const tick = (now = clock()) => {
    if (now - last > GAP_MS) {
      sleeps.push({ from: last, to: now });
      if (sleeps.length > 200) sleeps.shift();
    }
    last = Math.max(last, now);
  };
  const handle = opts.timer === false ? null : setInterval(() => tick(), TICK_MS);
  handle?.unref();
  return {
    tick,
    sleptBetween(from, to) {
      let total = 0;
      for (const s of sleeps) total += Math.max(0, Math.min(to, s.to) - Math.max(from, s.from));
      return total;
    },
    stop: () => {
      if (handle) clearInterval(handle);
    },
  };
}
