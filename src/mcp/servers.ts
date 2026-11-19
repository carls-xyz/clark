import type { DatabaseSync } from "node:sqlite";

/**
 * Serveurs MCP ajoutés par Charles dans Plugins (Notion, Drive…). Donnés aux deux moteurs.
 *
 * Aucun secret n'est rangé ici : seulement les NOMS de variables d'environnement (lues
 * dans .env, que Charles remplit lui-même). Les valeurs ne passent ni par l'interface ni
 * par la base.
 *
 * Confiance :
 *  - « ask »  : chaque appel d'outil demande l'accord de Charles (par défaut) ; refusé en lecture seule.
 *  - « read » : Charles déclare que ses outils ne font que lire : sans demander, permis en lecture seule.
 */
export type McpTrust = "ask" | "read";
export type McpTransport = "stdio" | "http";

export type McpServer = {
  id: number;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  envVars: string[];
  /** HTTP : variable qui contient le jeton (envoyé en « Authorization: Bearer »). */
  tokenVar: string | null;
  trust: McpTrust;
  enabled: boolean;
  check: McpCheck | null;
  /** Plugin qui l'a apporté (null : ajouté à la main). */
  plugin: string | null;
};

export type McpCheck = { ok: boolean; at: number; tools: { name: string; description: string }[]; error: string | null };

export type McpInput = {
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  envVars?: string[];
  tokenVar?: string | null;
  trust?: McpTrust;
};

/** Noms réservés : le serveur interne de Clark. */
const RESERVED = new Set(["memory", "clark"]);
const NAME = /^[a-z][a-z0-9_-]{1,31}$/;
const VAR = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Vérifie un serveur avant de l'enregistrer. Renvoie l'erreur lisible et le champ concerné, ou null. */
export function validateMcp(input: McpInput, taken: string[] = []): { field: string; error: string } | null {
  const name = (input.name ?? "").trim();
  if (!NAME.test(name)) return { field: "name", error: "Nom : 2 à 32 caractères, minuscules, chiffres, - ou _, en commençant par une lettre." };
  if (RESERVED.has(name)) return { field: "name", error: `« ${name} » est réservé à Clark.` };
  if (taken.includes(name)) return { field: "name", error: `Un serveur s'appelle déjà « ${name} ».` };
  if (input.transport === "stdio") {
    const cmd = (input.command ?? "").trim();
    if (!cmd || /[\r\n]/.test(cmd)) return { field: "command", error: "Indique la commande qui lance le serveur (ex. npx)." };
    if ((input.args ?? []).some((a) => typeof a !== "string" || /[\r\n]/.test(a) || a.length > 500)) return { field: "args", error: "Un argument par ligne, 500 caractères au plus." };
    if ((input.args ?? []).length > 30) return { field: "args", error: "30 arguments au plus." };
  } else if (input.transport === "http") {
    let u: URL;
    try {
      u = new URL((input.url ?? "").trim());
    } catch {
      return { field: "url", error: "Adresse invalide (ex. https://exemple.com/mcp)." };
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
      return { field: "url", error: "L'adresse doit être en https (http seulement pour ce Mac)." };
    if (u.username || u.password) return { field: "url", error: "Pas d'identifiants dans l'adresse : mets le jeton dans .env et indique le nom de la variable." };
    if (input.tokenVar && !VAR.test(input.tokenVar)) return { field: "tokenVar", error: "Nom de variable invalide (ex. NOTION_TOKEN)." };
  } else {
    return { field: "transport", error: "Type inconnu." };
  }
  for (const v of input.envVars ?? []) if (!VAR.test(v)) return { field: "envVars", error: `Nom de variable invalide : ${v} (majuscules, chiffres et _).` };
  if (input.trust && input.trust !== "ask" && input.trust !== "read") return { field: "trust", error: "Confiance inconnue." };
  return null;
}

/** Une variable est-elle renseignée dans l'environnement de Clark ? (jamais sa valeur) */
export const hasVar = (name: string) => Boolean(process.env[name]?.trim());

export class McpServers {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        transport  TEXT NOT NULL CHECK (transport IN ('stdio','http')),
        command    TEXT,
        args       TEXT NOT NULL DEFAULT '[]',
        url        TEXT,
        env_vars   TEXT NOT NULL DEFAULT '[]',
        token_var  TEXT,
        trust      TEXT NOT NULL DEFAULT 'ask' CHECK (trust IN ('ask','read')),
        enabled    INTEGER NOT NULL DEFAULT 1,
        last_check TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const cols = db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "plugin")) db.exec("ALTER TABLE mcp_servers ADD COLUMN plugin TEXT");
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  private row(r: any): McpServer {
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: JSON.parse(r.args),
      url: r.url,
      envVars: JSON.parse(r.env_vars),
      tokenVar: r.token_var,
      trust: r.trust,
      enabled: r.enabled === 1,
      check: r.last_check ? JSON.parse(r.last_check) : null,
      plugin: r.plugin ?? null,
    };
  }

  list(): McpServer[] {
    return (this.db.prepare("SELECT * FROM mcp_servers ORDER BY id").all() as any[]).map((r) => this.row(r));
  }

  enabled(): McpServer[] {
    return this.list().filter((s) => s.enabled);
  }

  get(id: number): McpServer | undefined {
    const r = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
    return r ? this.row(r) : undefined;
  }

  add(input: McpInput, plugin: string | null = null): { ok: true; id: number } | { ok: false; field: string; error: string } {
    const bad = validateMcp(input, this.list().map((s) => s.name));
    if (bad) return { ok: false, ...bad };
    const stdio = input.transport === "stdio";
    const r = this.db
      .prepare("INSERT INTO mcp_servers (name, transport, command, args, url, env_vars, token_var, trust, plugin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        input.name.trim(),
        input.transport,
        stdio ? input.command!.trim() : null,
        JSON.stringify(stdio ? (input.args ?? []).map((a) => a.trim()).filter(Boolean) : []),
        stdio ? null : input.url!.trim(),
        JSON.stringify([...new Set(input.envVars ?? [])]),
        stdio ? null : input.tokenVar?.trim() || null,
        input.trust ?? "ask",
        plugin,
      );
    this.changed();
    return { ok: true, id: Number(r.lastInsertRowid) };
  }

  /** Les serveurs apportés par un plugin : retirés avec lui, activés ou coupés avec lui. */
  removePlugin(plugin: string) {
    this.db.prepare("DELETE FROM mcp_servers WHERE plugin = ?").run(plugin);
    this.changed();
  }

  setPluginEnabled(plugin: string, enabled: boolean) {
    this.db.prepare("UPDATE mcp_servers SET enabled = ? WHERE plugin = ?").run(enabled ? 1 : 0, plugin);
    this.changed();
  }

  setEnabled(id: number, enabled: boolean): boolean {
    const ok = this.db.prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes > 0;
    if (ok) this.changed();
    return ok;
  }

  setTrust(id: number, trust: McpTrust): boolean {
    const ok = this.db.prepare("UPDATE mcp_servers SET trust = ? WHERE id = ?").run(trust, id).changes > 0;
    if (ok) this.changed();
    return ok;
  }

  remove(id: number): boolean {
    const ok = this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes > 0;
    if (ok) this.changed();
    return ok;
  }

  recordCheck(id: number, check: McpCheck) {
    this.db.prepare("UPDATE mcp_servers SET last_check = ? WHERE id = ?").run(JSON.stringify(check), id);
    this.changed();
  }
}

/** Les variables passées au serveur : seulement celles qu'il a déclarées, plus de quoi se lancer. */
export function serverEnv(s: McpServer): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL"]) if (process.env[k]) env[k] = process.env[k]!;
  for (const v of s.envVars) if (process.env[v]) env[v] = process.env[v]!;
  return env;
}

/** Configuration pour le moteur Claude (options.mcpServers). */
export function claudeMcpConfig(servers: McpServer[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const s of servers) {
    if (s.transport === "stdio") out[s.name] = { type: "stdio", command: s.command!, args: s.args, env: serverEnv(s) };
    else {
      const token = s.tokenVar ? process.env[s.tokenVar]?.trim() : undefined;
      out[s.name] = { type: "http", url: s.url!, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
    }
  }
  return out;
}

/**
 * Configuration pour Codex, en surcharges par fil (aucun redémarrage de Codex). Les secrets
 * passent par leur nom (env_vars, bearer_token_env_var), lus par Codex dans son environnement.
 * « ask » : Codex demande l'accord à chaque appel, Clark le transmet à Charles.
 */
export function codexMcpConfig(servers: McpServer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    const k = `mcp_servers.${s.name}`;
    if (s.transport === "stdio") {
      out[`${k}.command`] = s.command;
      out[`${k}.args`] = s.args;
      if (s.envVars.length) out[`${k}.env_vars`] = s.envVars;
    } else {
      out[`${k}.url`] = s.url;
      if (s.tokenVar) out[`${k}.bearer_token_env_var`] = s.tokenVar;
    }
    out[`${k}.default_tools_approval_mode`] = s.trust === "read" ? "approve" : "prompt";
    out[`${k}.startup_timeout_sec`] = 30;
  }
  return out;
}
