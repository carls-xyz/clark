import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { paths } from "../config.ts";
import { enabledPluginParts } from "../plugins/index-file.ts";

/**
 * Skills et commandes perso (idée reprise de Spettro, format de Claude Code).
 *
 * - Skill : un dossier avec un SKILL.md (en-tête name / description, puis la méthode).
 *   Clark voit la liste (nom + description) et lit un skill en entier quand il en a besoin
 *   (outil use_skill). Lus dans skills/ de Clark et dans ~/.claude/skills (les tiens),
 *   en lecture seule.
 * - Commande : un fichier commands/<nom>.md (description, mode, puis la consigne, avec
 *   $ARGUMENTS pour ce qui suit la commande). Lancée par « /nom … » dans la conversation,
 *   sur Telegram, ou depuis Réglages.
 */
export type Skill = { name: string; description: string; dir: string; source: "clark" | "claude" | "plugin"; plugin?: string };
export type CommandMode = "chat" | "team" | "goal";
export type Command = { name: string; description: string; mode: CommandMode; prompt: string; file: string; plugin?: string };

export const skillDirs = (): { dir: string; source: Skill["source"]; plugin?: string }[] => [
  { dir: process.env.CLARK_SKILLS_DIR?.trim() || resolve(paths.root, "skills"), source: "clark" },
  { dir: process.env.CLARK_CLAUDE_SKILLS_DIR?.trim() || join(homedir(), ".claude/skills"), source: "claude" },
  // Ceux des plugins installés et activés, après les tiens : à nom égal, le tien gagne.
  ...enabledPluginParts().skillsDirs.map((d) => ({ dir: d.dir, source: "plugin" as const, plugin: d.plugin })),
];
export const commandsDir = () => process.env.CLARK_COMMANDS_DIR?.trim() || resolve(paths.root, "commands");

/** En-tête YAML simple : `clé: valeur`, valeurs entre guillemets, blocs `>` / `|` indentés. */
export function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
      value = folded ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[kv[1]] = value;
  }
  return { meta, body: m[2] };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function listSkills(): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const { dir, source, plugin } of skillDirs()) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const skillDir = join(dir, entry);
      const file = join(skillDir, "SKILL.md");
      try {
        if (!statSync(skillDir).isDirectory() || !existsSync(file)) continue;
        const { meta } = frontmatter(readFileSync(file, "utf8").slice(0, 8000));
        const name = (meta.name || entry).trim();
        if (seen.has(name)) continue; // celui de Clark passe avant le tien s'ils ont le même nom
        seen.add(name);
        out.push({ name, description: (meta.description ?? "").replace(/\s+/g, " ").trim().slice(0, 400), dir: skillDir, source, ...(plugin ? { plugin } : {}) });
      } catch {
        // lien cassé, dossier illisible : ignoré
      }
    }
  }
  return out;
}

/**
 * Lit un skill (SKILL.md) ou un de ses fichiers texte, sans jamais sortir de son dossier
 * (liens symboliques compris). Renvoie null si introuvable.
 */
export function readSkill(name: string, file = "SKILL.md"): { text: string; files: string[] } | null {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill) return null;
  const root = realpathSync(skill.dir);
  let target: string;
  try {
    target = realpathSync(resolve(root, file));
  } catch {
    return null;
  }
  if (target !== root && !target.startsWith(root + sep)) return null;
  if (!statSync(target).isFile() || statSync(target).size > 200_000) return null;
  const text = readFileSync(target, "utf8");
  if (text.includes("\u0000")) return null; // fichier binaire
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 2 || files.length > 40) return;
    for (const e of readdirSync(d)) {
      if (e.startsWith(".") || e === "node_modules") continue;
      const p = join(d, e);
      try {
        // Un lien qui mène hors du skill n'est ni lu ni listé.
        const real = realpathSync(p);
        if (real !== root && !real.startsWith(root + sep)) continue;
        if (statSync(p).isDirectory()) walk(p, depth + 1);
        else if (relative(root, p) !== "SKILL.md") files.push(relative(root, p));
      } catch {}
    }
  };
  walk(root, 0);
  return { text, files };
}

// ── Commandes ──

export function listCommands(): Command[] {
  const own = ownCommands();
  const taken = new Set(own.map((c) => c.name));
  // Les commandes des plugins activés, sous le nom choisi à l'installation.
  const fromPlugins = enabledPluginParts().commands.flatMap(({ file, name, plugin }) => {
    if (taken.has(name) || !NAME.test(name)) return [];
    try {
      const { meta, body } = frontmatter(readFileSync(file, "utf8"));
      const mode: CommandMode = meta.mode === "team" || meta.mode === "goal" ? meta.mode : "chat";
      taken.add(name);
      return [{ name, description: (meta.description ?? "").trim(), mode, prompt: body.trim(), file, plugin }];
    } catch {
      return [];
    }
  });
  return [...own, ...fromPlugins];
}

/** Tes commandes (dossier commands/) : les seules qu'on crée ou supprime ici. */
export function ownCommands(): Command[] {
  const dir = commandsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => {
      const name = f.slice(0, -3);
      if (!NAME.test(name)) return [];
      const { meta, body } = frontmatter(readFileSync(join(dir, f), "utf8"));
      const mode: CommandMode = meta.mode === "team" || meta.mode === "goal" ? meta.mode : "chat";
      return [{ name, description: (meta.description ?? "").trim(), mode, prompt: body.trim(), file: join(dir, f) }];
    });
}

export function validateCommand(c: { name: string; description?: string; mode?: string; prompt: string }): { field: string; error: string } | null {
  if (!NAME.test(c.name ?? "")) return { field: "name", error: "Nom : minuscules, chiffres et -, 48 caractères au plus (ex. relances)." };
  if (["nouveau", "start", "taches", "equipe", "memoire", "budget", "objectif"].includes(c.name)) return { field: "name", error: `« /${c.name} » est déjà une commande de Clark.` };
  if ((c.description ?? "").length > 200) return { field: "description", error: "Description : 200 caractères au plus." };
  if (c.mode && !["chat", "team", "goal"].includes(c.mode)) return { field: "mode", error: "Mode inconnu." };
  if ((c.prompt ?? "").trim().length < 10) return { field: "prompt", error: "Écris la consigne (10 caractères au moins)." };
  if (c.prompt.length > 8000) return { field: "prompt", error: "Consigne : 8000 caractères au plus." };
  return null;
}

export function saveCommand(c: { name: string; description?: string; mode?: CommandMode; prompt: string }) {
  mkdirSync(commandsDir(), { recursive: true });
  const desc = (c.description ?? "").replace(/[\r\n]+/g, " ").trim();
  writeFileSync(join(commandsDir(), `${c.name}.md`), `---\ndescription: ${JSON.stringify(desc)}\nmode: ${c.mode ?? "chat"}\n---\n\n${c.prompt.trim()}\n`);
}

export function deleteCommand(name: string): boolean {
  if (!NAME.test(name)) return false;
  const file = join(commandsDir(), `${name}.md`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/** « /relances Studio Pixel » → la consigne de la commande, avec ce qui suit à la place de $ARGUMENTS. */
export function expandCommand(text: string): { command: Command; prompt: string } | null {
  const m = text.trim().match(/^\/([a-z0-9][a-z0-9-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const command = listCommands().find((c) => c.name === m[1]);
  if (!command) return null;
  const args = (m[2] ?? "").trim();
  // « $1 », « $2 »… : les mots qui suivent la commande (entre guillemets pour en grouper plusieurs).
  const words = [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((w) => w[1] ?? w[2]);
  const positional = /\$[1-9]\b/.test(command.prompt);
  let prompt = command.prompt.replace(/\$([1-9])\b/g, (_, n) => words[Number(n) - 1] ?? "");
  prompt = prompt.includes("$ARGUMENTS") ? prompt.replaceAll("$ARGUMENTS", args) : args && !positional ? `${prompt}\n\n${args}` : prompt;
  // « !`git status` » (plugins Claude Code) : Clark ne lance rien avant la consigne ; l'agent le fera, avec ton accord.
  prompt = prompt.replace(/!`([^`\n]+)`/g, "(à obtenir toi-même avec la commande `$1`)");
  return { command, prompt };
}

/** Pour la consigne de Clark : la liste des skills, une ligne chacun. */
export function skillsForPrompt(limit = 40): string {
  const list = listSkills().slice(0, limit);
  if (!list.length) return "";
  return list.map((s) => `- ${s.name} : ${s.description.slice(0, 200)}`).join("\n");
}
