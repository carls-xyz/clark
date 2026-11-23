/**
 * Surveillance externe : toutes les 5 minutes, Clark appelle CLARK_PING_URL (par exemple un check de
 * healthchecks.io). Si les appels s'arrêtent (Clark mort ou figé, serveur coupé, réseau tombé), c'est
 * ce service qui te prévient, par son propre canal : le seul moyen d'être alerté quand Clark ne peut
 * plus rien dire lui-même. Rien n'est envoyé : ni texte, ni niveau, juste l'appel.
 * Avec CLARK_PING_FAIL_ON_BAD=1 (désactivé par défaut), un niveau « À régler » appelle <url>/fail.
 */
export const PING_EVERY_MS = 5 * 60_000;

export type PingStatus = { configured: boolean; lastOk: number | null; failing: boolean; lastError: string | null };

export function pingUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.CLARK_PING_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? raw.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export const failOnBad = (env: NodeJS.ProcessEnv = process.env) => ["1", "on", "true", "oui"].includes((env.CLARK_PING_FAIL_ON_BAD ?? "").trim().toLowerCase());

export function createPinger(opts: { level: () => "ok" | "warn" | "bad"; fetcher?: typeof fetch; env?: NodeJS.ProcessEnv; log?: (line: string) => void; now?: () => number }) {
  const fetcher = opts.fetcher ?? fetch;
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = opts.now ?? Date.now;
  const status: PingStatus = { configured: Boolean(pingUrl(env)), lastOk: null, failing: false, lastError: null };

  /** Un appel. Une ligne au journal au premier échec d'une série, puis au retour : jamais à chaque appel. */
  async function ping(): Promise<void> {
    const url = pingUrl(env);
    status.configured = Boolean(url);
    if (!url) return;
    const target = failOnBad(env) && opts.level() === "bad" ? `${url}/fail` : url;
    try {
      const res = await fetcher(target, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`réponse ${res.status}`);
      if (status.failing) log("[clark] ping externe : de nouveau joignable");
      status.failing = false;
      status.lastError = null;
      status.lastOk = now();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (!status.failing) log(`[clark] ping externe impossible : ${why}`);
      status.failing = true;
      status.lastError = why;
    }
  }

  function start(): () => void {
    const first = setTimeout(() => void ping(), 30_000);
    const timer = setInterval(() => void ping(), PING_EVERY_MS);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  return { ping, start, status: () => ({ ...status }) };
}
