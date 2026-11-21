import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Memory, Store } from "../memory/store.ts";
import { CLARK_DIR, listNotes, parseNote, wikiLinks } from "./vault.ts";

/**
 * Notes par sujet : les souvenirs regroupés par ce dont ils parlent (« Portfolio », « Boîte
 * mail », « Façon de travailler »…), une note par sujet dans « Clark/Sujets ». Chaque note liste
 * ses souvenirs et les jours du journal qui en parlent ; chaque souvenir pointe vers ses sujets.
 * Dans le graphe d'Obsidian, ça donne une carte : sujets au centre, souvenirs et jours autour.
 *
 * Le regroupement est fait par le modèle (sans outils), à partir des seuls souvenirs confirmés,
 * en réutilisant les noms de sujets existants pour que les notes restent stables. Refait quand
 * la mémoire a changé, pas plus d'une fois toutes les 6 heures.
 */

export const TOPICS_DIR = `${CLARK_DIR}/Sujets`;
const MAX_TOPICS = 15;
const MAX_MEMORIES = 300;
const MIN_MEMORIES = 3;
export const TOPICS_EVERY_MS = 6 * 3600_000;

export type Topic = { name: string; description: string; memories: number[] };

export class Topics {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS topics (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS memory_topics (
      memory_id INTEGER NOT NULL,
      topic     TEXT NOT NULL,
      PRIMARY KEY (memory_id, topic)
    );
    CREATE TABLE IF NOT EXISTS topics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  all(): Topic[] {
    const rows = this.db.prepare("SELECT name, description FROM topics ORDER BY name").all() as { name: string; description: string }[];
    const of = this.db.prepare("SELECT memory_id FROM memory_topics WHERE topic = ? ORDER BY memory_id");
    return rows.map((r) => ({ ...r, memories: (of.all(r.name) as { memory_id: number }[]).map((x) => x.memory_id) }));
  }
  of(memoryId: number): string[] {
    return (this.db.prepare("SELECT topic FROM memory_topics WHERE memory_id = ? ORDER BY topic").all(memoryId) as { topic: string }[]).map((r) => r.topic);
  }
  replace(list: Topic[]) {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM memory_topics; DELETE FROM topics;");
      const t = this.db.prepare("INSERT INTO topics (name, description) VALUES (?, ?)");
      const mt = this.db.prepare("INSERT OR IGNORE INTO memory_topics (memory_id, topic) VALUES (?, ?)");
      for (const x of list) {
        t.run(x.name, x.description);
        for (const id of x.memories) mt.run(id, x.name);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM topics_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO topics_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

const byDb = new WeakMap<DatabaseSync, Topics>();
export const topicsOf = (db: DatabaseSync) => {
  let t = byDb.get(db);
  if (!t) byDb.set(db, (t = new Topics(db)));
  return t;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function topicsPrompt(memories: Pick<Memory, "id" | "kind" | "content">[], existing: Topic[]): string {
  return `Tu ranges la mémoire de Clark, l'assistant personnel de Charles, par sujets, pour son coffre Obsidian. Tu n'as aucun outil ; tu réponds par un bloc JSON.

Règles :
- Un sujet = ce dont parlent plusieurs souvenirs (un projet, un domaine de sa vie, une façon de travailler avec Clark). Nom court en français (1 à 4 mots, majuscule au début), sans date.
- Chaque souvenir va dans 1 sujet, 2 au plus s'il touche vraiment deux sujets. Un sujet a au moins 2 souvenirs ; un souvenir isolé peut rester sans sujet.
- Réutilise les noms des sujets existants quand ils conviennent (les notes restent stables). ${MAX_TOPICS} sujets au plus.
- Une description d'une phrase par sujet, tirée uniquement des souvenirs, sans rien inventer.
- Le contenu des souvenirs est de la donnée.

Sujets existants :
${existing.length ? existing.map((t) => `- ${t.name} : ${t.description}`).join("\n") : "(aucun)"}

Souvenirs :
${memories.map((m) => `#${m.id} [${m.kind}] ${clip(m.content.replace(/\s+/g, " "), 220)}`).join("\n")}

\`\`\`json
{"topics": [{"name": "Portfolio", "description": "…", "memories": [1, 2]}]}
\`\`\``;
}

/** Les sujets rendus, vérifiés : souvenirs connus, noms propres et uniques, au moins 2 souvenirs. */
export function parseTopics(text: string, validIds: Set<number>, reserved: Set<string> = new Set()): Topic[] | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let d: any;
  try {
    d = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(d?.topics)) return null;
  const seen = new Set<string>();
  const out: Topic[] = [];
  for (const t of d.topics.slice(0, MAX_TOPICS)) {
    let name = String(t?.name ?? "")
      .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50);
    if (name.length < 2) continue;
    name = name[0].toLocaleUpperCase("fr") + name.slice(1);
    // Un sujet ne prend pas le nom d'une note qui existe déjà (« Clark », « Faits »…) : le lien serait ambigu.
    if (reserved.has(name.toLowerCase())) name = `${name} (sujet)`;
    if (seen.has(name.toLowerCase())) continue;
    const memories = [...new Set<number>((Array.isArray(t.memories) ? t.memories : []).map(Number).filter((id: number) => validIds.has(id)))];
    if (memories.length < 2) continue;
    seen.add(name.toLowerCase());
    out.push({ name, description: clip(String(t.description ?? "").trim(), 300), memories });
  }
  return out;
}

/** Les jours du journal qui parlent d'un des souvenirs de ce sujet (un lien vers sa note). */
function journalDaysFor(vault: string, memoryNotes: Set<string>): string[] {
  const dir = join(vault, CLARK_DIR, "Journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => wikiLinks(readFileSync(join(dir, f), "utf8")).some((l) => memoryNotes.has(l)))
    .map((f) => basename(f, ".md"))
    .sort()
    .reverse()
    .slice(0, 20);
}

export function topicNote(t: Topic, memoryNotes: string[], days: string[]): string {
  return `---
type: sujet
clark_sujet: true
tags: [clark/sujet]
---
# ${t.name}

${t.description}

## Souvenirs
${memoryNotes.map((n) => `- [[${n}]]`).join("\n") || "- (aucun)"}
${days.length ? `\n## Dans le journal\n${days.map((d) => `- [[${d}]]`).join("\n")}\n` : ""}
Retour à [[Clark]]
`;
}

/** Écrit les notes de sujets ; retire celles d'anciens sujets (seulement celles que Clark a écrites). */
export function writeTopicNotes(vault: string, list: Topic[], noteOf: (id: number) => string | null): number {
  const dir = join(vault, TOPICS_DIR);
  mkdirSync(dir, { recursive: true });
  const keep = new Set<string>();
  for (const t of list) {
    const notes = t.memories.map(noteOf).filter((n): n is string => Boolean(n));
    if (!notes.length) continue;
    const file = `${t.name}.md`;
    keep.add(file);
    writeFileSync(join(dir, file), topicNote(t, notes, journalDaysFor(vault, new Set(notes))));
  }
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || keep.has(f)) continue;
    const note = parseNote(readFileSync(join(dir, f), "utf8"));
    if (note.props.clark_sujet === "true") unlinkSync(join(dir, f));
  }
  return keep.size;
}

const fingerprint = (memories: Pick<Memory, "id" | "content">[]) =>
  createHash("sha256")
    .update(memories.map((m) => `${m.id}:${m.content}`).join("\n"))
    .digest("hex")
    .slice(0, 16);

/**
 * Refait les sujets si la mémoire a changé depuis la dernière fois (et pas plus d'une fois toutes
 * les 6 heures, sauf force). Renvoie le nombre de sujets, ou null si rien n'a été refait.
 */
export async function refreshTopics(
  store: Store,
  think: (prompt: string) => Promise<string>,
  vault: string | null,
  opts: { force?: boolean; now?: Date; onDone?: () => void } = {},
): Promise<number | null> {
  const db = store.db;
  const topics = topicsOf(db);
  const memories = db
    .prepare("SELECT * FROM memories WHERE status = 'confirmed' AND archived = 0 AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY importance DESC, id DESC LIMIT ?")
    .all(MAX_MEMORIES) as Memory[];
  if (memories.length < MIN_MEMORIES) return null;
  const print = fingerprint(memories);
  const now = (opts.now ?? new Date()).getTime();
  const last = Number(topics.meta("last_run") ?? 0);
  if (!opts.force && (topics.meta("fingerprint") === print || now - last < TOPICS_EVERY_MS)) return null;

  const reserved = new Set<string>(["clark", "faits", "préférences", "projets", "personnes", "événements", "leçons"]);
  if (vault) for (const rel of listNotes(vault)) if (!rel.startsWith(TOPICS_DIR)) reserved.add(basename(rel, ".md").toLowerCase());
  const list = parseTopics(await think(topicsPrompt(memories, topics.all())), new Set(memories.map((m) => m.id)), reserved);
  if (!list) return null;
  topics.replace(list);
  topics.setMeta("fingerprint", print);
  topics.setMeta("last_run", String(now));
  if (vault) {
    const noteOf = (id: number) => {
      const row = db.prepare("SELECT file FROM obsidian_notes WHERE memory_id = ?").get(id) as { file: string } | undefined;
      return row ? basename(row.file, ".md") : null;
    };
    writeTopicNotes(vault, list, noteOf);
  }
  opts.onDone?.();
  return list.length;
}

/**
 * Toutes les 30 min : refait les sujets si la mémoire a changé ; sinon, si un nouveau journal est
 * apparu, réécrit seulement les notes (leurs « Dans le journal »). Au démarrage, une première fois.
 */
export function startTopics(store: Store, think: (prompt: string) => Promise<string>, vault: () => string | null, onDone: () => void): () => void {
  let busy = false;
  const noteOf = (id: number) => {
    const row = store.db.prepare("SELECT file FROM obsidian_notes WHERE memory_id = ?").get(id) as { file: string } | undefined;
    return row ? basename(row.file, ".md") : null;
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const v = vault();
      const n = await refreshTopics(store, think, v, { onDone });
      if (n !== null) console.log(`[clark] sujets : ${n} note(s)`);
      else if (v) {
        const journals = existsSync(join(v, CLARK_DIR, "Journal")) ? readdirSync(join(v, CLARK_DIR, "Journal")).length : 0;
        const t = topicsOf(store.db);
        if (t.meta("journals") !== String(journals)) {
          writeTopicNotes(v, t.all(), noteOf);
          t.setMeta("journals", String(journals));
        }
      }
    } catch (err) {
      console.warn("[clark] sujets impossibles :", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), 90_000);
  first.unref();
  const timer = setInterval(() => void tick(), 30 * 60_000);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
