import { existsSync } from "node:fs";
import type { Hub } from "./hub.ts";
import { notifyPrefs, type NotifyStore } from "./notify.ts";
import { PERSONALITY_LIMIT, readPersonality, savePersonality } from "./personality.ts";
import { SETTINGS, type Settings } from "./settings.ts";
import { ownCommands, saveCommand, validateCommand, type CommandMode } from "../skills/library.ts";
import { validateAutomation, type AutomationInput } from "../scheduler/automations.ts";
import { validateMcp, type McpInput } from "../mcp/servers.ts";
import { readIndex } from "../plugins/index-file.ts";
import { addProject } from "../dev/runner.ts";
import { checkCopyPath } from "../dev/project-setup.ts";

/**
 * La configuration de Clark dans un fichier : pour la garder, ou la retrouver sur une autre
 * machine (le VPS). Jamais de secret : ni clés, ni jetons, ni connexions (Google, Telegram,
 * moteurs) ; pour les serveurs MCP, seulement les noms de variables. Les plugins ne sont pas
 * réinstallés d'office : chacun se relit avant.
 */

export const CONFIG_FORMAT = "clark-config";

/** Une commande importée : une ligne, 300 caractères au plus (les règles des réglages), sinon rien. */
const oneLine = (x: unknown) => (typeof x === "string" && x.trim() && x.length <= 300 && !/[\r\n]/.test(x) ? x.trim() : null);

type Ctx = { hub: Hub; settings: Settings | null; notify: NotifyStore | null };

export function exportConfig(ctx: Ctx, opts: { memory?: boolean } = {}) {
  const { store } = ctx.hub.deps;
  return {
    format: CONFIG_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: ctx.settings?.all() ?? {},
    notify: notifyPrefs(),
    personality: readPersonality(),
    voice: { mode: store.voice.mode(), voice: store.voice.voice() },
    engines: { claude: store.choices.get("claude"), codex: store.choices.get("codex") },
    commands: ownCommands().map((c) => ({ name: c.name, description: c.description, mode: c.mode, prompt: c.prompt })),
    automations: store.automations.list().map((a) => ({
      name: a.name,
      prompt: a.prompt,
      frequency: a.frequency,
      time: a.time,
      weekday: a.weekday,
      team: a.team === 1,
      enabled: a.enabled === 1,
      kind: a.kind,
      // Le projet par son nom : son numéro change d'une machine à l'autre.
      project: a.project_id ? (store.dev.project(a.project_id)?.name ?? null) : null,
      engine: a.engine,
      model: a.model,
      effort: a.effort,
      precheck: a.precheck,
      thread: a.thread,
    })),
    mcp: store.mcp
      .list()
      .filter((m) => !m.plugin)
      .map((m) => ({ name: m.name, transport: m.transport, command: m.command, args: m.args, url: m.url, envVars: m.envVars, tokenVar: m.tokenVar, trust: m.trust, enabled: m.enabled })),
    plugins: readIndex().map((p) => ({ name: p.name, source: p.source, subdir: p.subdir, ref: p.ref ?? null, enabled: p.enabled })),
    projects: store.dev.projects().map((p) => ({
      name: p.name,
      path: p.path,
      base: p.base_branch,
      test: p.test_command,
      engine: p.default_engine,
      model: p.default_model,
      effort: p.default_effort,
      setup: p.setup_command,
      copy: p.copy_paths ? (JSON.parse(p.copy_paths) as string[]) : [],
      previewCommand: p.preview_command,
      previewPath: p.preview_path,
    })),
    ...(opts.memory
      ? {
          memories: (store.db.prepare("SELECT kind, content, tags, importance, source, expires_at FROM memories WHERE archived = 0 AND status = 'confirmed' ORDER BY id").all() as any[]).map((m) => ({
            kind: m.kind,
            content: m.content,
            tags: m.tags ? String(m.tags).split(",").filter(Boolean) : [],
            importance: m.importance,
            source: m.source,
            expiresAt: m.expires_at,
          })),
        }
      : {}),
  };
}

export type ExportedConfig = ReturnType<typeof exportConfig>;

type Item = { name: string; status: "nouveau" | "existe déjà" | "invalide" | "chemin introuvable" | "à relire" | "remplacé"; note?: string };
export type ImportPlan = {
  exportedAt: string;
  settings: Item[];
  notify: boolean;
  personality: { differs: boolean; custom: boolean };
  commands: Item[];
  automations: Item[];
  mcp: Item[];
  projects: Item[];
  plugins: (Item & { source: string; subdir: string | null; ref: string | null })[];
  memories: { total: number; fresh: number } | null;
};

function parse(raw: unknown): ExportedConfig {
  const d = raw as Partial<ExportedConfig> | null;
  if (!d || typeof d !== "object" || d.format !== CONFIG_FORMAT) throw new Error("Ce fichier n'est pas une configuration de Clark.");
  if (d.version !== 1) throw new Error(`Version de configuration inconnue (${String(d.version)}).`);
  return d as ExportedConfig;
}

const arr = <T>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);

/** Ce que l'import ferait, sans rien changer. */
export function planImport(ctx: Ctx, raw: unknown): ImportPlan {
  const d = parse(raw);
  const { store } = ctx.hub.deps;
  const own = new Set(ownCommands().map((c) => c.name));
  const autos = new Set(store.automations.list().map((a) => a.name));
  const mcpNames = store.mcp.list().map((m) => m.name);
  const projectNames = new Set(store.dev.projects().map((p) => p.name));
  const projectPaths = new Set(store.dev.projects().map((p) => p.path));
  const installed = new Set(readIndex().map((p) => p.name));
  const current = ctx.settings?.all() ?? {};
  const known = new Set(SETTINGS.map((s) => s.key));
  let memories: ImportPlan["memories"] = null;
  if (Array.isArray((d as any).memories)) {
    const list = (d as any).memories as { content: string }[];
    const has = store.db.prepare("SELECT 1 FROM memories WHERE archived = 0 AND status = 'confirmed' AND lower(content) = lower(?)");
    memories = { total: list.length, fresh: list.filter((m) => typeof m?.content === "string" && !has.get(m.content)).length };
  }
  return {
    exportedAt: String(d.exportedAt ?? ""),
    settings: Object.entries(d.settings ?? {})
      .filter(([k]) => known.has(k))
      .map(([k, v]) => ({ name: SETTINGS.find((s) => s.key === k)!.label, status: current[k] === v ? "existe déjà" : current[k] !== undefined ? "remplacé" : "nouveau", note: String(v) })),
    notify: Boolean(d.notify),
    personality: { differs: Boolean(d.personality?.custom) && d.personality?.text !== readPersonality().text, custom: Boolean(d.personality?.custom) },
    commands: arr(d.commands).map((c) => ({ name: `/${c.name}`, status: validateCommand(c) ? "invalide" : own.has(c.name) ? "existe déjà" : "nouveau" })),
    automations: arr(d.automations).map((a) => ({ name: a.name, status: validateAutomation(a as AutomationInput) ? "invalide" : autos.has(a.name) ? "existe déjà" : "nouveau" })),
    mcp: arr(d.mcp).map((m) => ({ name: m.name, status: validateMcp(m as McpInput, []) ? "invalide" : mcpNames.includes(m.name) ? "existe déjà" : "nouveau" })),
    projects: arr(d.projects).map((p) => ({
      name: p.name,
      status: projectNames.has(p.name) || projectPaths.has(p.path) ? "existe déjà" : !existsSync(p.path) ? "chemin introuvable" : "nouveau",
      note: p.path,
    })),
    plugins: arr(d.plugins).map((p) => ({ name: p.name, status: installed.has(p.name) ? "existe déjà" : "à relire", source: p.source, subdir: p.subdir ?? null, ref: p.ref ?? null })),
    memories,
  };
}

/**
 * Importe : réglages et notifications remplacés ; commandes, automatisations, serveurs MCP et
 * projets ajoutés (ceux qui existent déjà restent tels quels) ; personnalité et mémoire sur choix.
 */
export async function applyImport(ctx: Ctx, raw: unknown, choices: { personality?: boolean; memories?: boolean } = {}) {
  const d = parse(raw);
  const { store } = ctx.hub.deps;
  const done = { settings: 0, commands: 0, automations: 0, mcp: 0, projects: 0, memories: 0, personality: false, skipped: [] as string[] };
  for (const [k, v] of Object.entries(d.settings ?? {})) {
    if (!SETTINGS.some((s) => s.key === k) || !ctx.settings) continue;
    const r = ctx.settings.set(k, v, ctx.hub.deps.config);
    if ("ok" in r) done.settings++;
    else done.skipped.push(`réglage ${k} : ${r.error}`);
  }
  if (d.notify && ctx.notify) ctx.notify.set(d.notify);
  if (d.voice) await store.voice.set({ mode: d.voice.mode, voice: d.voice.voice }).catch(() => {});
  for (const e of ["claude", "codex"] as const) {
    const c = (d.engines as any)?.[e];
    if (c && typeof c === "object") store.choices.set(e, { model: c.model ?? null, effort: c.effort ?? null });
  }
  if (choices.personality && d.personality?.custom && typeof d.personality.text === "string") {
    if ("ok" in savePersonality(d.personality.text.slice(0, PERSONALITY_LIMIT))) done.personality = true;
  }
  const own = new Set(ownCommands().map((c) => c.name));
  for (const c of arr(d.commands)) {
    if (own.has(c.name) || validateCommand(c)) continue;
    saveCommand({ name: c.name, description: c.description, mode: c.mode as CommandMode, prompt: c.prompt });
    done.commands++;
  }
  for (const m of arr(d.mcp)) {
    const r = store.mcp.add({ name: m.name, transport: m.transport, command: m.command, args: m.args, url: m.url, envVars: m.envVars, tokenVar: m.tokenVar, trust: m.trust });
    if (r.ok) {
      if (m.enabled === false) store.mcp.setEnabled(r.id, false);
      done.mcp++;
    }
  }
  for (const p of arr(d.projects)) {
    if (!existsSync(p.path)) {
      done.skipped.push(`projet ${p.name} : ${p.path} introuvable sur cette machine`);
      continue;
    }
    const r = await addProject(ctx.hub, { name: p.name, path: p.path, baseBranch: p.base, testCommand: oneLine(p.test) ?? undefined });
    if (!r.ok) continue;
    store.dev.updateProject(r.id, {
      defaultEngine: p.engine ?? null,
      defaultModel: p.model ?? null,
      defaultEffort: p.effort ?? null,
      setupCommand: oneLine(p.setup),
      // Les fichiers à copier repassent par les mêmes règles (jamais de secret).
      copyPaths: arr(p.copy).filter((x) => !checkCopyPath(String(x))),
      previewCommand: oneLine(p.previewCommand)?.includes("$PORT") ? oneLine(p.previewCommand) : null,
      // Mêmes règles que dans les réglages : un chemin dans le projet, sans remonter.
      previewPath: typeof p.previewPath === "string" && p.previewPath.length <= 200 && !/[\r\n]|(^|\/)\.\.(\/|$)/.test(p.previewPath) ? p.previewPath.replace(/^\/+/, "") || null : null,
    });
    done.projects++;
  }
  // Après les projets : une automatisation dev retrouve le sien par son nom.
  const autos = new Set(store.automations.list().map((a) => a.name));
  for (const a of arr(d.automations)) {
    if (autos.has(a.name)) continue;
    const kind = a.kind === "dev" || a.kind === "team" || a.kind === "chat" ? a.kind : a.team ? "team" : "chat";
    const projectId = kind === "dev" ? (store.dev.projects().find((p) => p.name === a.project)?.id ?? null) : null;
    if (kind === "dev" && projectId === null) {
      done.skipped.push(`automatisation ${a.name} : projet ${a.project ?? "?"} absent`);
      continue;
    }
    const input: AutomationInput = {
      name: a.name,
      prompt: a.prompt,
      frequency: a.frequency,
      time: a.time,
      weekday: a.weekday,
      team: kind === "team",
      kind,
      projectId,
      engine: a.engine ?? null,
      model: a.model ?? null,
      effort: a.effort ?? null,
      precheck: a.precheck ?? null,
      thread: a.thread === "own" ? "own" : "main",
      enabled: a.enabled !== false,
    };
    const bad = validateAutomation(input);
    if (bad) {
      done.skipped.push(`automatisation ${a.name} : ${bad}`);
      continue;
    }
    store.automations.create(input);
    done.automations++;
  }
  if (choices.memories && Array.isArray((d as any).memories)) {
    const has = store.db.prepare("SELECT 1 FROM memories WHERE archived = 0 AND status = 'confirmed' AND lower(content) = lower(?)");
    for (const m of (d as any).memories as any[]) {
      if (typeof m?.content !== "string" || has.get(m.content)) continue;
      try {
        store.remember({ kind: m.kind, content: m.content, tags: m.tags, importance: m.importance, source: m.source ?? "importé d'une configuration", expiresAt: m.expiresAt ?? undefined });
        done.memories++;
      } catch {
        done.skipped.push(`souvenir « ${String(m.content).slice(0, 40)} »`);
      }
    }
  }
  ctx.hub.touch();
  return done;
}
