/**
 * Quota de l'abonnement ChatGPT utilisé par Codex, tel que le donne l'App Server
 * (`account/rateLimits/read`, puis les mises à jour `account/rateLimits/updated`).
 * Clark n'en déduit rien d'autre que ce qui est écrit : pourcentage utilisé, durée
 * de la fenêtre, heure de remise à zéro, et l'indication « limite atteinte ».
 */
export type QuotaWindow = {
  /** « Fenêtre de 5 h », « Fenêtre de 7 jours »… */
  label: string;
  usedPercent: number;
  durationMins: number | null;
  /** Remise à zéro, en millisecondes depuis 1970 ; null si Codex ne la donne pas. */
  resetsAt: number | null;
};

export type Quota = {
  plan: string | null;
  windows: QuotaWindow[];
  /** Codex signale que la limite est atteinte (ou que l'usage n'est plus permis). */
  reached: boolean;
  /** Moment de la dernière lecture, en millisecondes. */
  readAt: number;
};

export const NEAR_LIMIT_PERCENT = 90;

/** Secondes ou millisecondes : Codex donne des horodatages Unix ; on accepte les deux. */
const toMs = (t: number | null | undefined) => (typeof t === "number" && Number.isFinite(t) ? (t > 1e12 ? t : t * 1000) : null);

export function windowLabel(mins: number | null): string {
  if (!mins) return "Fenêtre";
  if (mins < 60) return `Fenêtre de ${mins} min`;
  if (mins < 24 * 60) return `Fenêtre de ${Math.round(mins / 60)} h`;
  const days = Math.round(mins / (24 * 60));
  return `Fenêtre de ${days} jour${days > 1 ? "s" : ""}`;
}

function windowOf(w: any): QuotaWindow | null {
  if (!w || typeof w.usedPercent !== "number") return null;
  const durationMins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
  return { label: windowLabel(durationMins), usedPercent: Math.max(0, Math.min(100, w.usedPercent)), durationMins, resetsAt: toMs(w.resetsAt) };
}

/** Réponse complète de `account/rateLimits/read`. */
export function readQuota(resp: any, now = Date.now()): Quota | null {
  const snap = resp?.rateLimitsByLimitId?.codex ?? resp?.rateLimits;
  if (!snap) return null;
  const windows = [windowOf(snap.primary), windowOf(snap.secondary)].filter((w): w is QuotaWindow => w !== null);
  return {
    plan: snap.planType ?? null,
    windows,
    reached: Boolean(snap.rateLimitReachedType) || resp?.ordinaryUsageAllowed === false,
    readAt: now,
  };
}

/**
 * Mise à jour partielle (`account/rateLimits/updated`) : on fusionne ce qui est donné
 * dans la dernière lecture, sans effacer ce qui manque.
 */
export function mergeQuota(prev: Quota | null, update: any, now = Date.now()): Quota | null {
  const snap = update?.rateLimits;
  if (!snap) return prev;
  const windows = [windowOf(snap.primary) ?? prev?.windows[0] ?? null, windowOf(snap.secondary) ?? prev?.windows[1] ?? null].filter(
    (w): w is QuotaWindow => w !== null,
  );
  return {
    plan: snap.planType ?? prev?.plan ?? null,
    windows,
    // Valeur donnée : elle fait foi. Absente (mise à jour partielle) : on garde la précédente.
    reached: snap.rateLimitReachedType === undefined ? (prev?.reached ?? false) : snap.rateLimitReachedType !== null,
    readAt: now,
  };
}

/** Une remise à zéro annoncée est déjà passée : ces chiffres ne décrivent plus le présent. */
export function isStale(q: Quota | null, now = Date.now()): boolean {
  return Boolean(q?.windows.some((w) => w.resetsAt !== null && w.resetsAt <= now));
}

/** La fenêtre la plus entamée, celle qui bloquera en premier. */
export function tightest(q: Quota | null): QuotaWindow | null {
  if (!q || q.windows.length === 0) return null;
  return q.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
}

export function formatReset(ms: number | null, now = Date.now()): string {
  if (!ms) return "heure de remise à zéro inconnue";
  const d = new Date(ms);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  const sameDay = new Date(now).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) === d.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
  return sameDay ? `à ${time}` : `le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" })} à ${time}`;
}
