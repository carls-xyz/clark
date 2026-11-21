import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MEMORY_KINDS, type Memory, type MemoryKind, type Store } from "../memory/store.ts";

/**
 * Le coffre Obsidian de Charles comme mémoire visible de Clark.
 *
 * - Chaque souvenir confirmé devient une note dans « Clark/Mémoire » : propriétés (type, source,
 *   dates), le texte, et des liens (son type, et les souvenirs proches quand la recherche par le
 *   sens est là). Le graphe d'Obsidian montre ce que Clark sait.
 * - Charles corrige une note : Clark reprend le texte. Il la supprime : Clark oublie (archivé,
 *   jamais effacé). Il écrit une nouvelle note dans ce dossier : Clark l'apprend.
 * - Ailleurs dans le coffre, Clark lit (outils vault_*) ; il n'écrit que dans « Clark/ ».
 */

export const CLARK_DIR = "Clark";
export const MEMORY_DIR = "Clark/Mémoire";

export const KIND_LABELS: Record<MemoryKind, { one: string; hub: string }> = {
  fact: { one: "fait", hub: "Faits" },
  preference: { one: "préférence", hub: "Préférences" },
  project: { one: "projet", hub: "Projets" },
  person: { one: "personne", hub: "Personnes" },
  event: { one: "événement", hub: "Événements" },
  lesson: { one: "leçon", hub: "Leçons" },
};
const HUBS = new Set(Object.values(KIND_LABELS).map((k) => k.hub));
const kindOfLabel = (label: string | undefined): MemoryKind => {
  const l = (label ?? "").trim().toLowerCase();
  return (MEMORY_KINDS as readonly string[]).includes(l) ? (l as MemoryKind) : ((Object.entries(KIND_LABELS).find(([, v]) => v.one === l)?.[0] as MemoryKind) ?? "fact");
};

/** Le coffre : CLARK_OBSIDIAN_VAULT, sinon celui d'Obsidian par défaut s'il existe. null : pas de coffre. */
export function vaultPath(): string | null {
  const env = process.env.CLARK_OBSIDIAN_VAULT?.trim();
  if (env === "off") return null;
  const candidates = env ? [env.replace(/^~(?=\/|$)/, homedir())] : [join(homedir(), "Documents", "Obsidian Vault")];
  for (const c of candidates) if (isAbsolute(c) && existsSync(c) && statSync(c).isDirectory()) return c;
  return null;
}

// ── Notes : propriétés (frontmatter), corps, liens ──────────────────────────

export type Note = { props: Record<string, string>; body: string };

/** Les propriétés simples d'une note (clé: valeur sur une ligne), et son corps. */
export function parseNote(text: string): Note {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { props: {}, body: text };
  const props: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\p{L}\w-]+):\s*(.*)$/u);
    if (kv) props[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { props, body: text.slice(m[0].length) };
}

/** Le texte du souvenir dans une note : le corps, sans la section de liens ajoutée par Clark. */
export function memoryText(body: string): string {
  return body.split(/\n## Liens\b/)[0].trim();
}

/** Les liens [[…]] d'un texte (sans l'alias ni la section). */
export function wikiLinks(text: string): string[] {
  return [...new Set([...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim()))];
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const yamlValue = (s: string) => (/^[\w .,'()éèêàâùûôîïç-]*$/iu.test(s) && !/^\s|\s$/.test(s) ? s : JSON.stringify(s));
const day = (sqlite: string | null) => (sqlite ? sqlite.slice(0, 10) : "");

/** Un nom de fichier lisible et stable : début du souvenir et son numéro. */
export function noteName(m: Pick<Memory, "id" | "content">): string {
  const words = m.content
    .replace(/^(Au|Le) \d{4}-\d{2}-\d{2},?\s*/i, "")
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/\s+\S*$/, "");
  return `${words || "Souvenir"} (${m.id})`;
}

export function renderMemoryNote(m: Memory, related: string[] = []): string {
  const k = KIND_LABELS[m.kind as MemoryKind] ?? KIND_LABELS.fact;
  const tags = ["clark/memoire", `clark/${k.one.normalize("NFD").replace(/\p{Diacritic}/gu, "")}`, ...m.tags.split(",").map((t) => t.trim()).filter(Boolean)];
  const props = [
    `clark_id: ${m.id}`,
    `type: ${k.one}`,
    m.source ? `source: ${yamlValue(m.source)}` : null,
    m.confirmed_at || m.created_at ? `confirmé: ${day(m.confirmed_at ?? m.created_at)}` : null,
    m.expires_at ? `expire: ${day(m.expires_at)}` : null,
    `importance: ${m.importance}`,
    `tags: [${tags.map((t) => yamlValue(t.replace(/\s+/g, "-"))).join(", ")}]`,
  ].filter(Boolean);
  const links = [`- Type : [[${k.hub}]]`, ...(related.length ? [`- Proche de : ${related.map((r) => `[[${r}]]`).join(", ")}`] : [])];
  return `---\n${props.join("\n")}\n---\n${m.content.trim()}\n\n## Liens\n${links.join("\n")}\n`;
}

// ── Synchronisation souvenirs ⇄ notes ───────────────────────────────────────

type Mapping = { memory_id: number; file: string; body_hash: string; content_hash: string };

export class VaultSync {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  readonly root: string;
  private readonly opts: { related?: (m: Memory) => string[]; log?: (msg: string) => void };
  constructor(store: Store, root: string, opts: { related?: (m: Memory) => string[]; log?: (msg: string) => void } = {}) {
    this.store = store;
    this.root = root;
    this.opts = opts;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS obsidian_notes (
      memory_id    INTEGER PRIMARY KEY,
      file         TEXT NOT NULL,
      body_hash    TEXT NOT NULL,
      content_hash TEXT NOT NULL
    )`);
  }

  private get dir() {
    return join(this.root, MEMORY_DIR);
  }

  private mappings(): Map<number, Mapping> {
    return new Map((this.db.prepare("SELECT * FROM obsidian_notes").all() as Mapping[]).map((r) => [r.memory_id, r]));
  }

  private save(m: Mapping) {
    this.db
      .prepare("INSERT INTO obsidian_notes (memory_id, file, body_hash, content_hash) VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET file = excluded.file, body_hash = excluded.body_hash, content_hash = excluded.content_hash")
      .run(m.memory_id, m.file, m.body_hash, m.content_hash);
  }

  /** Les notes du dossier Mémoire (sous-dossiers compris : Charles peut ranger), par clark_id. */
  private scan(): { byId: Map<number, string>; orphans: string[] } {
    const byId = new Map<number, string>();
    const orphans: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        // « Oubliés » : une note qu'on y range ne compte plus (y glisser une note, c'est oublier).
        if (e.isDirectory()) {
          if (!(dir === this.dir && e.name === "Oubliés")) walk(full);
        } else if (extname(e.name) === ".md" && !(dir === this.dir && HUBS.has(basename(e.name, ".md")))) {
          const id = Number(parseNote(readFileSync(full, "utf8")).props.clark_id);
          if (Number.isInteger(id) && id > 0) byId.set(id, relative(this.root, full));
          else orphans.push(relative(this.root, full));
        }
      }
    };
    walk(this.dir);
    return { byId, orphans };
  }

  private active(): Memory[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE status = 'confirmed' AND archived = 0 AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY id")
      .all() as Memory[];
  }

  private write(rel: string, text: string) {
    const full = join(this.root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  /**
   * Un tour de synchro. Ordre : ce que Charles a changé dans Obsidian d'abord (il a le dernier
   * mot), puis ce qui a changé chez Clark. Renvoie ce qui a bougé, pour le journal.
   */
  sync(): { written: number; edited: number; forgotten: number; learned: number } {
    const out = { written: 0, edited: 0, forgotten: 0, learned: 0 };
    mkdirSync(this.dir, { recursive: true });
    const maps = this.mappings();
    const { byId, orphans } = this.scan();
    const active = new Map(this.active().map((m) => [m.id, m]));

    // 1. Notes supprimées ou modifiées par Charles.
    for (const [id, map] of maps) {
      const file = byId.get(id) ?? (existsSync(join(this.root, map.file)) ? map.file : null);
      const m = active.get(id);
      if (!file) {
        // Note supprimée : Clark oublie (archivé, on peut revenir en arrière).
        if (m && this.store.forget(id)) {
          out.forgotten++;
          active.delete(id);
          this.opts.log?.(`souvenir #${id} oublié (note supprimée dans Obsidian)`);
        }
        this.db.prepare("DELETE FROM obsidian_notes WHERE memory_id = ?").run(id);
        maps.delete(id);
        continue;
      }
      if (file !== map.file) this.save({ ...map, file }); // déplacée ou renommée par Charles
      const text = memoryText(parseNote(readFileSync(join(this.root, file), "utf8")).body);
      if (m && hash(text) !== map.body_hash && text && text !== m.content.trim()) {
        this.store.update(id, text);
        out.edited++;
        active.set(id, { ...m, content: text });
        this.opts.log?.(`souvenir #${id} corrigé depuis Obsidian`);
      }
    }

    // 2. Nouvelles notes écrites par Charles dans le dossier : Clark les apprend.
    for (const rel of orphans) {
      const note = parseNote(readFileSync(join(this.root, rel), "utf8"));
      const text = memoryText(note.body);
      if (text.length < 3) continue;
      const id = this.store.remember({ kind: kindOfLabel(note.props.type), content: text, source: `Charles, dans Obsidian (${basename(rel, ".md")})` });
      const m = this.store.get(id)!;
      active.set(id, m);
      // La note garde son nom : Charles l'a choisi. Clark y ajoute ses propriétés.
      this.writeMemory(m, rel);
      out.learned++;
      this.opts.log?.(`souvenir #${id} appris depuis Obsidian`);
    }

    // 3. Souvenirs de Clark : nouveaux, changés, oubliés.
    const fresh = this.mappings();
    for (const [id, m] of active) {
      const map = fresh.get(id);
      const rel = map?.file ?? join(MEMORY_DIR, `${noteName(m)}.md`);
      if (map && map.content_hash === hash(m.content + (this.opts.related?.(m) ?? []).join("|")) && existsSync(join(this.root, rel))) continue;
      this.writeMemory(m, rel);
      out.written++;
    }
    for (const [id, map] of fresh) {
      if (active.has(id)) continue;
      // Oublié ou expiré chez Clark : la note part dans « Clark/Mémoire/Oubliés » (rien n'est effacé).
      const from = join(this.root, map.file);
      if (existsSync(from)) {
        const to = join(MEMORY_DIR, "Oubliés", basename(map.file));
        this.write(to, readFileSync(from, "utf8").replace(/^---\n/, "---\noublié: oui\n"));
        unlinkSync(from);
      }
      this.db.prepare("DELETE FROM obsidian_notes WHERE memory_id = ?").run(id);
    }

    this.writeHubs([...active.values()]);
    return out;
  }

  private writeMemory(m: Memory, rel: string) {
    const related = this.opts.related?.(m) ?? [];
    const text = renderMemoryNote(m, related);
    this.write(rel, text);
    this.save({ memory_id: m.id, file: rel, body_hash: hash(m.content.trim()), content_hash: hash(m.content + related.join("|")) });
  }

  /** Une note par type (Faits, Leçons…) qui liste ses souvenirs, et l'accueil « Clark ». */
  private writeHubs(memories: Memory[]) {
    const maps = this.mappings();
    for (const [kind, label] of Object.entries(KIND_LABELS)) {
      const list = memories.filter((m) => (m.kind as string) === kind);
      const lines = list.map((m) => `- [[${basename(maps.get(m.id)?.file ?? noteName(m), ".md")}]]`);
      this.write(join(MEMORY_DIR, `${label.hub}.md`), `---\ntags: [clark/type]\n---\n${list.length ? `Ce que Clark sait (${label.hub.toLowerCase()}) :\n\n${lines.join("\n")}` : "Rien pour l'instant."}\n\nRetour à [[Clark]]\n`);
    }
    const home = `---\ntags: [clark]\n---\n# Clark\n\nLa mémoire de Clark, tenue à jour par lui. Corrige une note : il reprend ton texte. Supprime-la : il oublie. Écris une note dans « ${MEMORY_DIR} » : il l'apprend.\n\n${Object.values(KIND_LABELS)
      .map((l) => `- [[${l.hub}]]`)
      .join("\n")}\n`;
    this.write(join(CLARK_DIR, "Clark.md"), home);
  }
}

// ── Lire et écrire dans le coffre (outils de Clark) ─────────────────────────

/** Chemin d'une note du coffre, vérifié : il reste dans le coffre. */
export function notePath(root: string, rel: string): string | null {
  const clean = rel.trim().replace(/^\/+/, "");
  const full = resolve(root, clean.endsWith(".md") ? clean : `${clean}.md`);
  return full === root || !full.startsWith(root + sep) ? null : full;
}

export function listNotes(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (extname(e.name) === ".md") out.push(relative(root, full));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Recherche plein texte simple dans le coffre : titre et contenu, mots dans n'importe quel ordre. */
export function searchVault(root: string, query: string, limit = 10): { path: string; title: string; snippet: string; score: number }[] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const words = fold(query).split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const hits = [];
  for (const rel of listNotes(root)) {
    const text = readFileSync(join(root, rel), "utf8");
    const title = basename(rel, ".md");
    const hay = fold(`${title}\n${text}`);
    const found = words.filter((w) => hay.includes(w)).length;
    if (!found) continue;
    const score = found / words.length + (words.some((w) => fold(title).includes(w)) ? 0.5 : 0);
    const body = parseNote(text).body.replace(/\s+/g, " ");
    const at = Math.max(0, fold(body).indexOf(words.find((w) => fold(body).includes(w)) ?? "") - 60);
    hits.push({ path: rel, title, snippet: body.slice(at, at + 220).trim(), score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Une note, ses liens sortants et les notes qui pointent vers elle. */
export function readVaultNote(root: string, rel: string): { path: string; text: string; links: string[]; backlinks: string[] } | null {
  const full = notePath(root, rel);
  if (!full || !existsSync(full)) {
    // « Faits » ou un nom de note sans dossier : on cherche par nom, comme Obsidian.
    const byName = listNotes(root).find((p) => basename(p, ".md").toLowerCase() === basename(rel, ".md").toLowerCase());
    if (!byName) return null;
    return readVaultNote(root, byName);
  }
  const text = readFileSync(full, "utf8");
  const title = basename(full, ".md");
  const backlinks = listNotes(root).filter((p) => p !== relative(root, full) && wikiLinks(readFileSync(join(root, p), "utf8")).some((l) => basename(l).toLowerCase() === title.toLowerCase()));
  return { path: relative(root, full), text, links: wikiLinks(text), backlinks };
}

/** Clark écrit seulement dans « Clark/ », hors du dossier Mémoire (tenu par la synchro). */
export function writeVaultNote(root: string, rel: string, content: string, mode: "create" | "append" | "replace"): string {
  const full = notePath(root, rel);
  if (!full) return "Refusé : chemin hors du coffre.";
  const inside = relative(root, full);
  if (!(inside === CLARK_DIR || inside.startsWith(CLARK_DIR + sep))) return `Refusé : j'écris seulement dans « ${CLARK_DIR}/ ». Pour une autre note, propose le texte à Charles.`;
  if (inside.startsWith(MEMORY_DIR + sep)) return "Refusé : « Clark/Mémoire » suit tes souvenirs confirmés ; pour retenir quelque chose, propose un souvenir (propose_memory).";
  const exists = existsSync(full);
  if (mode === "create" && exists) return `Refusé : ${inside} existe déjà (mode append ou replace).`;
  mkdirSync(dirname(full), { recursive: true });
  if (mode === "append" && exists) writeFileSync(full, `${readFileSync(full, "utf8").replace(/\n*$/, "\n\n")}${content.trim()}\n`);
  else writeFileSync(full, `${content.trim()}\n`);
  return `Note ${exists ? (mode === "append" ? "complétée" : "remplacée") : "créée"} : ${inside}`;
}
