import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { paths } from "../config.ts";
import type { McpInput, McpServers } from "../mcp/servers.ts";
import { validateMcp } from "../mcp/servers.ts";
import { frontmatter } from "../skills/library.ts";
import { pluginsDir, readIndex, writeIndex, type InstalledPlugin } from "./index-file.ts";

export { enabledPluginParts, pluginsDir, readIndex, type InstalledPlugin } from "./index-file.ts";

const run = promisify(execFile);

/**
 * Plugins : un paquet de commandes, de skills et de serveurs MCP, au format des plugins
 * Claude Code (.claude-plugin/plugin.json, commands/, skills/, .mcp.json), installé depuis
 * une adresse git (https) ou un dossier de ton Mac.
 *
 * Rien n'est installé sans relecture : Clark récupère le paquet à part, montre tout ce qu'il
 * apporte (consignes, méthodes, programmes lancés), et l'utilisateur décide. Les crochets (hooks)
 * et les agents des plugins Claude Code ne sont pas repris : ils exécuteraient du code ou
 * changeraient les règles sans passer par Clark.
 */

const stagingDir = () => join(pluginsDir(), ".staging");

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const RESERVED_COMMANDS = ["nouveau", "start", "taches", "equipe", "memoire", "budget", "objectif"];
const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const SCRIPT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|exe|bin|command|applescript|scpt)$/i;
const REVIEW_TTL_MS = 60 * 60 * 1000;

export type ReviewCommand = {
  file: string;
  name: string;
  renamed: boolean;
  description: string;
  mode: string;
  prompt: string;
  /** « !`git status` » : Claude Code les lance avant d'envoyer la consigne ; Clark non. */
  shell: string[];
  /** allowed-tools du plugin : ignoré, les règles de Clark s'appliquent. */
  allowedTools: string | null;
};
/** Un plugin listé par un catalogue (marketplace.json), à relire en un clic. */
export type CatalogEntry = { name: string; description: string; source: string; subdir: string | null; ref: string | null; supported: boolean; why: string | null };
export type ReviewSkill = { dir: string; name: string; description: string; text: string; files: { path: string; script: boolean }[]; hidden: boolean };
export type ReviewMcp = McpInput & { original: string; problems: string[]; fixed: string[] };
export type Review = {
  token: string;
  name: string;
  version: string | null;
  description: string;
  author: string | null;
  source: string;
  subdir: string | null;
  commit: string;
  commands: ReviewCommand[];
  skills: ReviewSkill[];
  mcp: ReviewMcp[];
  ignored: { what: string; why: string }[];
  warnings: string[];
  /** Bloquant : rien ne s'installe tant qu'il en reste. */
  errors: string[];
  /** Mise à jour : ce qui change depuis la version installée. */
  update: { from: string; changes: { path: string; kind: "ajouté" | "modifié" | "supprimé" }[] } | null;
  /** Fichiers du paquet que Clark n'utilise pas (copiés, jamais lancés). */
  otherFiles: { path: string; script: boolean }[];
  /** Le paquet est un catalogue : ses plugins. */
  catalog: CatalogEntry[] | null;
  /** Branche ou étiquette demandée (catalogue) ; null : la branche par défaut. */
  ref: string | null;
};

// ── Récupérer un paquet ──

/** Adresse git en https (sans identifiants) ou dossier absolu de ce Mac. */
export function checkSource(raw: string): { kind: "git" | "local"; value: string } | { error: string } {
  const s = raw.trim();
  if (!s) return { error: "Indique une adresse git (https://…) ou un dossier de ton Mac." };
  if (isAbsolute(s)) return existsSync(s) && statSync(s).isDirectory() ? { kind: "local", value: s } : { error: "Ce dossier n'existe pas." };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "Adresse invalide : https://github.com/… ou un dossier absolu (/Users/…)." };
  }
  if (u.protocol !== "https:") return { error: "Seules les adresses https sont acceptées." };
  if (u.username || u.password) return { error: "Pas d'identifiants dans l'adresse." };
  return { kind: "git", value: u.href.replace(/\/$/, "") };
}

export function checkSubdir(raw: string | null | undefined): string | null | { error: string } {
  const s = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!s) return null;
  if (s.split("/").some((p) => !p || p === "." || p === "..") || !/^[\w./-]+$/.test(s)) return { error: "Sous-dossier invalide (ex. plugins/mon-plugin)." };
  return s;
}

async function git(args: string[], cwd?: string) {
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", ...args], {
    cwd,
    timeout: 90_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Copie sans .git ni liens symboliques (un lien pourrait pointer hors du paquet). */
function copyTree(from: string, to: string) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (rel.split(sep).includes(".git")) return false;
      return !lstatSync(src).isSymbolicLink();
    },
  });
}

function treeStats(dir: string): { files: string[]; bytes: number; links: number } {
  const files: string[] = [];
  let bytes = 0;
  let links = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === ".git") continue;
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) links++;
      else if (st.isDirectory()) walk(p);
      else {
        files.push(relative(dir, p));
        bytes += st.size;
      }
      if (files.length > MAX_FILES) return;
    }
  };
  walk(dir);
  return { files, bytes, links };
}

const hashTree = (dir: string) => {
  const h = createHash("sha256");
  for (const f of treeStats(dir).files.sort()) h.update(f).update(readFileSync(join(dir, f)));
  return `local-${h.digest("hex").slice(0, 12)}`;
};

/** Récupère le paquet dans un dossier à part (jamais exécuté) : le dossier du plugin et son commit. */
async function fetchPackage(source: string, subdir: string | null, ref: string | null = null): Promise<{ root: string; dir: string; commit: string }> {
  const src = checkSource(source);
  if ("error" in src) throw new Error(src.error);
  mkdirSync(stagingDir(), { recursive: true });
  const root = join(stagingDir(), randomUUID());
  let commit: string;
  if (src.kind === "git" || existsSync(join(src.value, ".git"))) {
    await git(["clone", "--depth", "1", "--no-recurse-submodules", "--quiet", ...(ref ? ["--branch", ref] : []), src.value, root]);
    commit = await git(["rev-parse", "HEAD"], root);
  } else {
    copyTree(src.value, root);
    commit = "";
  }
  const dir = subdir ? join(root, subdir) : root;
  if (!dir.startsWith(root) || !existsSync(dir) || !statSync(dir).isDirectory()) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`Sous-dossier « ${subdir} » introuvable dans ce paquet.`);
  }
  if (!commit) commit = hashTree(dir);
  return { root, dir, commit };
}

// ── Lire un paquet (sans rien exécuter) ──

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** « ${NOTION_TOKEN} » → NOTION_TOKEN ; une valeur en clair → null. */
const varOf = (v: unknown) => (typeof v === "string" ? (v.trim().match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/)?.[1] ?? null) : null);

/** Les plugins d'un catalogue (marketplace.json), avec de quoi les relire. */
export function catalogOf(market: any, source: string, subdir: string | null): CatalogEntry[] {
  const list = Array.isArray(market?.plugins) ? market.plugins : [];
  return list.slice(0, 1000).flatMap((p: any): CatalogEntry[] => {
    const name = String(p?.name ?? "").slice(0, 80);
    if (!name) return [];
    const description = String(p?.description ?? "").replace(/\s+/g, " ").slice(0, 200);
    const s = p.source;
    if (typeof s === "string" && s.startsWith("./")) {
      const sub = [subdir, s.slice(2).replace(/\/+$/, "")].filter(Boolean).join("/");
      return [{ name, description, source, subdir: sub || null, ref: null, supported: true, why: null }];
    }
    if (s && typeof s === "object" && (s.source === "git-subdir" || s.source === "url" || s.source === "github") && (s.url || s.repo)) {
      const url = s.url ?? `https://github.com/${s.repo}`;
      const ok = !("error" in checkSource(String(url)));
      return [{ name, description, source: String(url).replace(/\.git$/, ""), subdir: s.path ? String(s.path) : null, ref: s.ref ? String(s.ref) : null, supported: ok, why: ok ? null : "adresse non https" }];
    }
    return [{ name, description, source, subdir: null, ref: null, supported: false, why: "s'installe en lançant une commande : pas pris en charge" }];
  });
}

/** Ce qu'apporte un paquet, tel que l'utilisateur le relit. `taken` : noms déjà pris ailleurs. */
export function inspectPackage(
  dir: string,
  ctx: { source: string; subdir: string | null; commit: string; installedRoot: string; commandsTaken: string[]; skillsTaken: string[]; mcpTaken: string[] },
): Omit<Review, "token" | "update" | "ref"> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ignored: { what: string; why: string }[] = [];
  const stats = treeStats(dir);
  if (stats.files.length > MAX_FILES) errors.push(`Paquet trop gros : plus de ${MAX_FILES} fichiers.`);
  if (stats.bytes > MAX_BYTES) errors.push("Paquet trop gros : plus de 20 Mo.");
  if (stats.links) warnings.push(`${stats.links} lien${stats.links > 1 ? "s" : ""} symbolique${stats.links > 1 ? "s" : ""} ignoré${stats.links > 1 ? "s" : ""} (ils pourraient pointer hors du paquet).`);

  const manifest = readJson(join(dir, ".claude-plugin/plugin.json"));
  const market = manifest ? null : readJson(join(dir, ".claude-plugin/marketplace.json"));
  const catalog = market ? catalogOf(market, ctx.source, ctx.subdir) : null;
  if (catalog) errors.push(catalog.length ? `C'est un catalogue de ${catalog.length} plugins, pas un plugin : choisis-en un dans la liste.` : "C'est un catalogue de plugins, mais il est vide.");
  else if (!manifest) errors.push("Manifeste .claude-plugin/plugin.json absent ou illisible.");
  const name = String(manifest?.name ?? "").trim().toLowerCase();
  if (manifest && !NAME.test(name)) errors.push(`Nom de plugin invalide : « ${manifest?.name} » (minuscules, chiffres et -).`);

  // Commandes : commands/*.md (un niveau).
  const commands: ReviewCommand[] = [];
  const cdir = join(dir, "commands");
  const used = new Set(ctx.commandsTaken);
  if (existsSync(cdir)) {
    for (const f of readdirSync(cdir).sort()) {
      const file = join(cdir, f);
      if (!f.endsWith(".md") || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) continue;
      const base = f.slice(0, -3).toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const { meta, body } = frontmatter(readFileSync(file, "utf8"));
      const shell = [...body.matchAll(/!`([^`\n]+)`/g)].map((m) => m[1]).slice(0, 10);
      let finalName = base;
      if (used.has(finalName) || RESERVED_COMMANDS.includes(finalName)) finalName = `${name}-${base}`.slice(0, 48);
      if (!NAME.test(finalName) || used.has(finalName)) {
        warnings.push(`Commande ${f} ignorée : nom déjà pris ou invalide.`);
        continue;
      }
      used.add(finalName);
      commands.push({
        file: `commands/${f}`,
        name: finalName,
        renamed: finalName !== base,
        description: (meta.description ?? "").trim().slice(0, 300),
        mode: meta.mode === "team" || meta.mode === "goal" ? meta.mode : "chat",
        prompt: body.trim().slice(0, 20_000),
        shell,
        allowedTools: meta["allowed-tools"]?.trim() || null,
      });
    }
  }

  // Skills : skills/<nom>/SKILL.md.
  const skills: ReviewSkill[] = [];
  const sdir = join(dir, "skills");
  if (existsSync(sdir)) {
    for (const e of readdirSync(sdir).sort()) {
      const skillDir = join(sdir, e);
      const file = join(skillDir, "SKILL.md");
      if (lstatSync(skillDir).isSymbolicLink() || !lstatSync(skillDir).isDirectory() || !existsSync(file) || lstatSync(file).isSymbolicLink()) continue;
      const text = readFileSync(file, "utf8");
      const { meta } = frontmatter(text.slice(0, 8000));
      const skillName = (meta.name || e).trim();
      const files = treeStats(skillDir)
        .files.filter((f) => f !== "SKILL.md")
        .map((f) => ({ path: f, script: SCRIPT.test(f) }));
      skills.push({
        dir: `skills/${e}`,
        name: skillName,
        description: (meta.description ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
        text: text.slice(0, 30_000),
        files,
        hidden: ctx.skillsTaken.includes(skillName),
      });
    }
  }
  for (const s of skills.filter((s) => s.hidden)) warnings.push(`Skill « ${s.name} » : un skill du même nom existe déjà, celui-ci restera caché.`);

  // Serveurs MCP : .mcp.json (format Claude Code).
  const mcp: ReviewMcp[] = [];
  const mcpJson = readJson(join(dir, ".mcp.json"));
  const servers = (mcpJson?.mcpServers ?? mcpJson ?? {}) as Record<string, any>;
  if (existsSync(join(dir, ".mcp.json")) && !mcpJson) errors.push(".mcp.json illisible.");
  const mcpUsed = new Set(ctx.mcpTaken);
  for (const [original, def] of Object.entries(mcpJson ? servers : {})) {
    if (!def || typeof def !== "object") continue;
    const problems: string[] = [];
    const fixed: string[] = [];
    let serverName = original.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!/^[a-z]/.test(serverName)) serverName = `p-${serverName}`;
    // Nom trop court, déjà pris ou réservé : préfixé du nom du plugin.
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(serverName) || mcpUsed.has(serverName) || serverName === "memory" || serverName === "clark") serverName = `${name}-${serverName}`.slice(0, 32);
    mcpUsed.add(serverName);
    const sub = (v: string) => v.replaceAll("${CLAUDE_PLUGIN_ROOT}", ctx.installedRoot);
    const envVars: string[] = [];
    for (const [k, v] of Object.entries(def.env ?? {})) {
      const ref = varOf(v);
      if (ref) envVars.push(ref);
      else if (k === v || v === "") envVars.push(k);
      else {
        envVars.push(k);
        fixed.push(`${k} : valeur écrite en clair dans le plugin, ignorée. Mets ${k} dans .env.`);
      }
    }
    let input: McpInput;
    if (def.type === "http" || def.type === "sse" || def.url) {
      const auth = typeof def.headers?.Authorization === "string" ? def.headers.Authorization : "";
      const tokenVar = auth.match(/^Bearer\s+\$\{([A-Z_][A-Z0-9_]*)\}$/)?.[1] ?? null;
      if (auth && !tokenVar) fixed.push("En-tête Authorization en clair ignoré : indique le jeton dans .env.");
      for (const h of Object.keys(def.headers ?? {})) if (h !== "Authorization") fixed.push(`En-tête ${h} ignoré.`);
      input = { name: serverName, transport: "http", url: String(def.url ?? ""), tokenVar, envVars, trust: "ask" };
    } else {
      input = { name: serverName, transport: "stdio", command: sub(String(def.command ?? "")), args: (Array.isArray(def.args) ? def.args : []).map((a: unknown) => sub(String(a))), envVars, trust: "ask" };
    }
    const bad = validateMcp(input, []);
    if (bad) problems.push(bad.error);
    mcp.push({ ...input, original, problems, fixed });
  }
  for (const m of mcp.filter((m) => m.problems.length)) errors.push(`Serveur MCP « ${m.original} » : ${m.problems.join(" ")}`);

  // Ce que Clark ne reprend pas des plugins Claude Code.
  if (existsSync(join(dir, "hooks")) || manifest?.hooks) ignored.push({ what: "Crochets (hooks)", why: "ils lanceraient du code à chaque action, hors des accords de Clark" });
  if (ignored.length && (commands.length || skills.length))
    warnings.push("Ce plugin a des crochets non repris : ses commandes ou skills qui en dépendent peuvent ne pas marcher comme dans Claude Code.");
  if (existsSync(join(dir, "agents")) || manifest?.agents) ignored.push({ what: "Agents", why: "les spécialistes de Clark ont leurs propres règles ; les instructions d'agents ne sont pas reprises" });
  if (existsSync(join(dir, "output-styles"))) ignored.push({ what: "Styles de réponse", why: "la façon de répondre se règle dans Personnalité" });
  if (existsSync(join(dir, ".lsp.json")) || manifest?.lspServers) ignored.push({ what: "Serveurs de langage (LSP)", why: "pas utilisés par Clark" });

  const usedPaths = /^(commands|skills|hooks|agents|output-styles|\.claude-plugin)\/|^(\.mcp\.json|\.lsp\.json|\.gitignore|readme[^/]*|license[^/]*|changelog[^/]*)$/i;
  const otherFiles = stats.files
    .filter((f) => !usedPaths.test(f.split(sep).join("/")))
    .sort()
    .map((f) => ({ path: f, script: SCRIPT.test(f) }));
  if (manifest && !commands.length && !skills.length && !mcp.length) errors.push("Ce plugin n'apporte ni commande, ni skill, ni serveur MCP que Clark sait utiliser.");

  return {
    name,
    version: typeof manifest?.version === "string" ? manifest.version.slice(0, 40) : null,
    description: String(manifest?.description ?? "").slice(0, 500),
    author: typeof manifest?.author === "string" ? manifest.author.slice(0, 120) : typeof manifest?.author?.name === "string" ? manifest.author.name.slice(0, 120) : null,
    source: ctx.source,
    subdir: ctx.subdir,
    commit: ctx.commit,
    commands,
    otherFiles,
    catalog,
    skills,
    mcp,
    ignored,
    warnings,
    errors,
  };
}

function diffTrees(oldDir: string, newDir: string): { path: string; kind: "ajouté" | "modifié" | "supprimé" }[] {
  const a = new Set(existsSync(oldDir) ? treeStats(oldDir).files : []);
  const b = new Set(treeStats(newDir).files);
  const out: { path: string; kind: "ajouté" | "modifié" | "supprimé" }[] = [];
  for (const f of b) {
    if (!a.has(f)) out.push({ path: f, kind: "ajouté" });
    else if (!readFileSync(join(oldDir, f)).equals(readFileSync(join(newDir, f)))) out.push({ path: f, kind: "modifié" });
  }
  for (const f of a) if (!b.has(f)) out.push({ path: f, kind: "supprimé" });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

// ── Le gestionnaire ──

type Pending = { review: Review; root: string; dir: string; at: number };

export class Plugins {
  private readonly mcp: McpServers;
  private readonly ownCommands: () => string[];
  private readonly otherSkills: () => string[];
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();

  constructor(opts: { mcp: McpServers; ownCommands: () => string[]; otherSkills: () => string[] }) {
    this.mcp = opts.mcp;
    this.ownCommands = opts.ownCommands;
    this.otherSkills = opts.otherSkills;
    // Des relectures abandonnées d'un démarrage précédent : on fait le ménage.
    rmSync(stagingDir(), { recursive: true, force: true });
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    for (const l of this.listeners) l();
  }

  list(): InstalledPlugin[] {
    return readIndex();
  }

  private forget(token: string) {
    const p = this.pending.get(token);
    if (p) rmSync(p.root, { recursive: true, force: true });
    this.pending.delete(token);
  }

  private sweep() {
    for (const [token, p] of this.pending) if (Date.now() - p.at > REVIEW_TTL_MS) this.forget(token);
  }

  /** Récupère un paquet et prépare sa relecture. Rien n'est installé. */
  async review(source: string, subdirRaw?: string | null, updating?: string, refRaw?: string | null): Promise<Review> {
    const ref = refRaw?.trim() || null;
    if (ref && (!/^[\w./-]{1,100}$/.test(ref) || ref.startsWith("-"))) throw new Error("Version (ref) invalide.");
    this.sweep();
    const subdir = checkSubdir(subdirRaw);
    if (subdir && typeof subdir === "object") throw new Error(subdir.error);
    const { root, dir, commit } = await fetchPackage(source, subdir, ref);
    try {
      const installed = readIndex();
      const other = installed.filter((p) => p.name !== updating);
      const mine = installed.find((p) => p.name === updating);
      const manifestName = String(readJson(join(dir, ".claude-plugin/plugin.json"))?.name ?? "").trim().toLowerCase();
      // Les chemins ${CLAUDE_PLUGIN_ROOT} pointent vers le dossier où il sera installé.
      const review: Review = {
        ...inspectPackage(dir, {
          source: source.trim(),
          subdir,
          commit,
          installedRoot: join(pluginsDir(), NAME.test(manifestName) ? manifestName : "_"),
          commandsTaken: [...this.ownCommands(), ...other.flatMap((p) => p.commands.map((c) => c.name))],
          skillsTaken: this.otherSkills(),
          mcpTaken: this.mcp.list().filter((s) => !updating || s.plugin !== updating).map((s) => s.name),
        }),
        token: randomUUID(),
        update: null,
        ref,
      };
      if (updating) {
        if (review.name !== updating) review.errors.push(`Ce paquet s'appelle « ${review.name} », pas « ${updating} ».`);
        review.update = { from: mine?.commit ?? "", changes: diffTrees(join(pluginsDir(), updating), dir) };
      } else if (installed.some((p) => p.name === review.name)) {
        review.errors.push(`Un plugin « ${review.name} » est déjà installé : utilise « Vérifier une mise à jour ».`);
      }
      this.pending.set(review.token, { review, root, dir, at: Date.now() });
      return review;
    } catch (err) {
      rmSync(root, { recursive: true, force: true });
      throw err;
    }
  }

  cancel(token: string) {
    this.forget(token);
  }

  /** Installe (ou met à jour) exactement ce que l'utilisateur a relu. */
  install(token: string): InstalledPlugin {
    const p = this.pending.get(token);
    if (!p) throw new Error("Relecture expirée : recommence.");
    const r = p.review;
    if (r.errors.length) throw new Error(r.errors[0]);
    const target = join(pluginsDir(), r.name);
    const fresh = `${target}.new`;
    rmSync(fresh, { recursive: true, force: true });
    copyTree(p.dir, fresh);
    const old = `${target}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(target)) renameSync(target, old);
    renameSync(fresh, target);
    rmSync(old, { recursive: true, force: true });
    this.forget(token);

    const list = readIndex();
    const prev = list.find((x) => x.name === r.name);
    const now = new Date().toISOString();
    const entry: InstalledPlugin = {
      name: r.name,
      version: r.version,
      description: r.description,
      source: r.source,
      subdir: r.subdir,
      ref: r.ref,
      commit: r.commit,
      enabled: prev?.enabled ?? true,
      installedAt: prev?.installedAt ?? now,
      updatedAt: now,
      commands: r.commands.map((c) => ({ file: c.file, name: c.name })),
      skills: r.skills.map((s) => s.name),
      mcp: r.mcp.map((m) => m.name),
    };
    writeIndex([...list.filter((x) => x.name !== r.name), entry].sort((a, b) => a.name.localeCompare(b.name)));

    this.mcp.removePlugin(r.name);
    for (const m of r.mcp) {
      const { original: _o, problems: _p, fixed: _f, ...input } = m;
      this.mcp.add(input, r.name);
    }
    if (!entry.enabled) this.mcp.setPluginEnabled(r.name, false);
    this.changed();
    return entry;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const list = readIndex();
    const p = list.find((x) => x.name === name);
    if (!p) return false;
    p.enabled = enabled;
    writeIndex(list);
    this.mcp.setPluginEnabled(name, enabled);
    this.changed();
    return true;
  }

  uninstall(name: string): boolean {
    const list = readIndex();
    if (!list.some((x) => x.name === name) || !NAME.test(name)) return false;
    writeIndex(list.filter((x) => x.name !== name));
    rmSync(join(pluginsDir(), name), { recursive: true, force: true });
    this.mcp.removePlugin(name);
    this.changed();
    return true;
  }

  /** Relit la source d'un plugin installé : sa nouvelle version, et ce qui change. */
  checkUpdate(name: string): Promise<Review> {
    const p = readIndex().find((x) => x.name === name);
    if (!p) return Promise.reject(new Error("Plugin introuvable."));
    return this.review(p.source, p.subdir, name, p.ref ?? null);
  }
}
