import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { paths } from "../config.ts";

/**
 * Connexion à ton compte Google (Gmail + Google Agenda), comme une application de bureau :
 * OAuth avec PKCE et redirection vers 127.0.0.1. Le jeton reste dans data/google/, que le bac
 * à sable de Codex ne peut pas lire ; il est rafraîchi tout seul.
 *
 * Il faut une fois un identifiant OAuth « application de bureau » (GOOGLE_CLIENT_ID et
 * GOOGLE_CLIENT_SECRET dans .env), puis `npm run google:login`.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export const GOOGLE_LOGIN_COMMAND = "npm run google:login";
export const tokenFile = () => process.env.CLARK_GOOGLE_TOKEN_FILE?.trim() || resolve(paths.root, "data/google/token.json");

type Token = { access_token: string; refresh_token: string; expires_at: number; scope: string; email: string | null };
export type GoogleStatus = { configured: boolean; connected: boolean; email: string | null; missingScopes: string[] };

export class GoogleNotConnected extends Error {}

function client() {
  const id = process.env.GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

function readToken(): Token | null {
  try {
    return JSON.parse(readFileSync(tokenFile(), "utf8")) as Token;
  } catch {
    return null;
  }
}

function writeToken(t: Token) {
  const file = tokenFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function googleStatus(): GoogleStatus {
  const t = readToken();
  const granted = new Set((t?.scope ?? "").split(" "));
  return {
    configured: client() !== null,
    connected: Boolean(t?.refresh_token),
    email: t?.email ?? null,
    missingScopes: t ? GOOGLE_SCOPES.filter((s) => !granted.has(s)) : [],
  };
}

export function disconnectGoogle() {
  if (existsSync(tokenFile())) rmSync(tokenFile());
}

/** Message à afficher quand Google n'est pas branché, avec la marche à suivre. */
export function notConnectedText(): string {
  if (!client()) return "Google n'est pas configuré : il manque GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env (voir le README, « Mail et agenda »).";
  return `Google n'est pas connecté. Lance une fois dans un terminal, dans le dossier de Clark : ${GOOGLE_LOGIN_COMMAND}`;
}

// ── Connexion (utilisée par scripts/google-login.ts) ─────────────────────────

const b64url = (b: Buffer) => b.toString("base64url");

export function startLogin(redirectUri: string) {
  const c = client();
  if (!c) throw new GoogleNotConnected(notConnectedText());
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
  }).toString();
  return { url: url.toString(), state, verifier };
}

export async function finishLogin(code: string, verifier: string, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const c = client();
  if (!c) throw new GoogleNotConnected(notConnectedText());
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
  });
  const body = (await r.json()) as any;
  if (!r.ok || !body.refresh_token) throw new Error(`Google a refusé la connexion : ${body.error_description ?? body.error ?? r.status}`);
  const token: Token = { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + body.expires_in * 1000, scope: body.scope ?? "", email: null };
  writeToken(token);
  try {
    const profile = await googleFetch<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile", {}, fetchImpl);
    token.email = profile.emailAddress;
    writeToken({ ...readToken()!, email: profile.emailAddress });
  } catch {
    // l'adresse n'est qu'un affichage
  }
  return token.email;
}

// ── Appels à l'API ──────────────────────────────────────────────────────────

async function accessToken(fetchImpl: typeof fetch): Promise<string> {
  const t = readToken();
  if (!t?.refresh_token) throw new GoogleNotConnected(notConnectedText());
  if (t.expires_at - 60_000 > Date.now()) return t.access_token;
  const c = client();
  if (!c) throw new GoogleNotConnected(notConnectedText());
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: t.refresh_token, grant_type: "refresh_token" }),
  });
  const body = (await r.json()) as any;
  if (!r.ok) {
    if (body.error === "invalid_grant") throw new GoogleNotConnected(`La connexion Google a expiré ou a été retirée. Reconnecte-toi : ${GOOGLE_LOGIN_COMMAND}`);
    throw new Error(`Google : rafraîchissement refusé (${body.error_description ?? body.error ?? r.status})`);
  }
  writeToken({ ...t, access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000, scope: body.scope ?? t.scope });
  return body.access_token;
}

export async function googleFetch<T = any>(url: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const token = await accessToken(fetchImpl);
  const r = await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as any;
    throw new Error(`Google ${r.status} : ${body.error?.message ?? r.statusText}`);
  }
  return (await r.json()) as T;
}
