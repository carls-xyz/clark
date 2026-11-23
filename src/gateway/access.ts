import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Qui peut ouvrir l'interface. Elle n'écoute que sur 127.0.0.1 ; pour y accéder depuis le téléphone,
 * Tailscale la publie sur ton réseau privé (« tailscale serve »), en HTTPS, pour tes appareils seulement.
 *
 * - CLARK_WEB_HOSTS : les adresses par lesquelles on arrive en plus de localhost, séparées par des
 *   virgules (ex. « mac.tail1234.ts.net »). Sans elles, une page ouverte depuis le téléphone ne peut
 *   rien envoyer (son origine n'est pas reconnue).
 * - CLARK_TAILSCALE_USERS : facultatif, les comptes Tailscale autorisés (ex. « toi@gmail.com »). Une
 *   requête venue par Tailscale sans l'un de ces comptes est refusée, même depuis un appareil du réseau.
 *
 * Jamais « tailscale funnel » : il publierait l'interface sur Internet.
 */
export type Access = {
  hosts: Set<string>;
  origins: Set<string>;
  remote: string[];
  users: Set<string> | null;
};

const clean = (h: string) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

export function accessRules(port: number, env: NodeJS.ProcessEnv = process.env): Access {
  const local = [`127.0.0.1:${port}`, `localhost:${port}`];
  const remote = (env.CLARK_WEB_HOSTS ?? "").split(",").map(clean).filter(Boolean);
  const users = (env.CLARK_TAILSCALE_USERS ?? "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  return {
    hosts: new Set([...local, ...remote]),
    // Le téléphone arrive en HTTPS (tailscale serve) ; une adresse avec port peut aussi être en HTTP.
    origins: new Set([...local.map((h) => `http://${h}`), ...remote.map((h) => `https://${h}`), ...remote.filter((h) => h.includes(":")).map((h) => `http://${h}`)]),
    remote,
    users: users.length ? new Set(users) : null,
  };
}

/** La requête vient-elle d'ailleurs que de ce Mac (relayée par Tailscale) ? */
export function cameFromAfar(h: IncomingHttpHeaders, a: Access): boolean {
  if (h["tailscale-user-login"] || h["x-forwarded-for"]) return true;
  const host = clean(String(h["x-forwarded-host"] ?? h.host ?? ""));
  if (a.remote.includes(host)) return true;
  const origin = h.origin ? clean(String(h.origin)) : "";
  return Boolean(origin && a.remote.includes(origin));
}

/**
 * Refus, ou null. L'hôte doit être connu (protection contre le DNS rebinding) ; venue d'ailleurs, et si
 * une liste de comptes est donnée, la requête doit porter l'un d'eux (en-tête ajouté par Tailscale).
 */
export function refusal(h: IncomingHttpHeaders, a: Access): { status: number; message: string } | null {
  if (!a.hosts.has(String(h.host ?? "").toLowerCase())) return { status: 421, message: "Hôte non autorisé" };
  if (a.users && cameFromAfar(h, a)) {
    const who = String(h["tailscale-user-login"] ?? "").toLowerCase();
    if (!who || !a.users.has(who)) return { status: 403, message: "Compte Tailscale non autorisé" };
  }
  return null;
}

/** Tailscale sur cette machine : son adresse sur le réseau privé (pour la carte de l'interface), ou null. */
export function tailscaleInfo(run: typeof execFileSync = execFileSync): { dnsName: string | null; online: boolean } | null {
  const bins = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];
  const bin = bins.find((b) => existsSync(b));
  if (!bin) return null;
  try {
    const out = JSON.parse(String(run(bin, ["status", "--json"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }))) as { Self?: { DNSName?: string; Online?: boolean } };
    return { dnsName: out.Self?.DNSName?.replace(/\.$/, "") || null, online: Boolean(out.Self?.Online) };
  } catch {
    return { dnsName: null, online: false };
  }
}
