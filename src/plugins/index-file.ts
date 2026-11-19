import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { paths } from "../config.ts";

/** Où vivent les plugins installés, et leur index (un fichier : lu aussi par le serveur MCP de Codex). */
export const pluginsDir = () => process.env.CLARK_PLUGINS_DIR?.trim() || resolve(paths.root, "data/plugins");
const indexFile = () => join(pluginsDir(), "index.json");
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type InstalledPlugin = {
  name: string;
  version: string | null;
  description: string;
  source: string;
  subdir: string | null;
  /** Branche ou étiquette suivie (null : la branche par défaut). */
  ref?: string | null;
  commit: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  /** Fichier de commande → nom sous lequel elle est lancée (« /nom »). */
  commands: { file: string; name: string }[];
  skills: string[];
  mcp: string[];
};

export function readIndex(): InstalledPlugin[] {
  try {
    const list = JSON.parse(readFileSync(indexFile(), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function writeIndex(list: InstalledPlugin[]) {
  mkdirSync(pluginsDir(), { recursive: true });
  const tmp = `${indexFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, indexFile());
}

/** Pour la bibliothèque : les dossiers de skills et les commandes des plugins activés. */
export function enabledPluginParts(): { skillsDirs: { dir: string; plugin: string }[]; commands: { file: string; name: string; plugin: string }[] } {
  const skillsDirs: { dir: string; plugin: string }[] = [];
  const commands: { file: string; name: string; plugin: string }[] = [];
  for (const p of readIndex()) {
    if (!p.enabled || !NAME.test(p.name)) continue;
    const root = join(pluginsDir(), p.name);
    skillsDirs.push({ dir: join(root, "skills"), plugin: p.name });
    for (const c of p.commands) {
      const file = resolve(root, c.file);
      if (file.startsWith(root + sep)) commands.push({ file, name: c.name, plugin: p.name });
    }
  }
  return { skillsDirs, commands };
}

