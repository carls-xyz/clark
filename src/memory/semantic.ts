import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { paths } from "../config.ts";
import type { Memory, Store } from "./store.ts";
import { listNotes, MEMORY_DIR, parseNote } from "../obsidian/vault.ts";
import { EMBED_MODEL, prefixes } from "./embed-model.ts";

/**
 * Recherche par le sens : chaque souvenir et chaque note du coffre a son vecteur (embedding),
 * rangé dans la base de Clark. Une question trouve ce qui en est proche, même sans les mêmes mots.
 *
 * Le modèle (paraphrase-multilingual-MiniLM, local, ~120 Mo sur disque) tourne dans un processus à part,
 * lancé à la demande et arrêté après 2 minutes sans usage : le Mac (8 Go) ne le garde pas en mémoire.
 * À cette échelle (quelques milliers d'entrées), une comparaison directe suffit : pas d'index vectoriel.
 * CLARK_EMBEDDINGS=off coupe tout.
 */

export const enabled = () => process.env.CLARK_EMBEDDINGS?.trim() !== "off";
const IDLE_MS = 2 * 60_000;
/** Seuils réglés sur la vraie mémoire de Clark : en dessous, ce n'est plus vraiment le même sujet. */
export const MIN_SCORE = 0.25;
export const NEIGHBOUR_SCORE = 0.55;
const BATCH = 16;

// ── Le processus du modèle ──────────────────────────────────────────────────

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

class Embedder {
  private child: ChildProcess | null = null;
  private next = 1;
  private waiting = new Map<number, { ok: (v: number[][]) => void; ko: (e: Error) => void }>();
  private idle: NodeJS.Timeout | null = null;

  private start() {
    const worker = resolve(import.meta.dirname, "embed-worker.ts");
    const child = spawn(process.execPath, [worker], {
      cwd: paths.root,
      env: { ...process.env, CLARK_MODELS_DIR: join(paths.root, "data", "models") },
      stdio: ["pipe", "pipe", "ignore"],
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const r = JSON.parse(line) as { id: number; vectors?: number[][]; error?: string };
        const w = this.waiting.get(r.id);
        if (!w) return;
        this.waiting.delete(r.id);
        if (!this.waiting.size) this.hold(false);
        if (r.vectors) w.ok(r.vectors);
        else w.ko(new Error(r.error ?? "embedding impossible"));
      } catch {}
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      for (const w of this.waiting.values()) w.ko(new Error("le processus des embeddings s'est arrêté"));
      this.waiting.clear();
    });
    this.child = child;
    this.hold(false);
  }

  /** Une demande en cours retient Node (la réponse doit arriver) ; au repos, le modèle ne retient rien. */
  private hold(on: boolean) {
    const c = this.child;
    if (!c) return;
    const io = c.stdout as unknown as { ref?: () => void; unref?: () => void };
    if (on) {
      c.ref();
      io.ref?.();
    } else {
      c.unref();
      io.unref?.();
    }
  }

  embed: EmbedFn = (texts) => {
    if (!texts.length) return Promise.resolve([]);
    if (!this.child) this.start();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref();
    const id = this.next++;
    this.hold(true);
    return new Promise((ok, ko) => {
      this.waiting.set(id, { ok, ko });
      this.child!.stdin!.write(`${JSON.stringify({ id, texts })}\n`);
    });
  };

  stop() {
    this.child?.kill();
    this.child = null;
  }
}

let shared: Embedder | null = null;
export const defaultEmbed: EmbedFn = (texts) => (shared ??= new Embedder()).embed(texts);
export const stopEmbedder = () => shared?.stop();

// ── L'index ─────────────────────────────────────────────────────────────────

// Le modèle fait partie de l'empreinte : en changer recalcule tout (des vecteurs de modèles différents ne se comparent pas).
const sha = (s: string) => createHash("sha256").update(`${process.env.CLARK_EMBED_MODEL ?? EMBED_MODEL}|${s}`).digest("hex").slice(0, 16);
const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
function cosine(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vecteurs normalisés
}

export type SemanticHit = { ref: string; kind: "memory" | "note"; title: string; score: number };

export class SemanticIndex {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  private readonly embed: EmbedFn;
  private indexing: Promise<number> | null = null;

  constructor(store: Store, embed: EmbedFn = defaultEmbed) {
    this.store = store;
    this.db = store.db;
    this.embed = embed;
    this.db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      ref        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      hash       TEXT NOT NULL,
      vec        BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  /** Ce qui doit avoir un vecteur : souvenirs actifs, notes du coffre (hors copies de la mémoire). */
  private sources(vault: string | null): { ref: string; kind: "memory" | "note"; title: string; text: string }[] {
    const mems = this.db
      .prepare("SELECT * FROM memories WHERE status = 'confirmed' AND archived = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))")
      .all() as Memory[];
    const out: { ref: string; kind: "memory" | "note"; title: string; text: string }[] = mems.map((m) => ({ ref: `memory:${m.id}`, kind: "memory", title: m.content.slice(0, 80), text: m.content }));
    if (vault) {
      for (const rel of listNotes(vault)) {
        if (rel.startsWith(MEMORY_DIR)) continue; // déjà là comme souvenirs
        try {
          const body = parseNote(readFileSync(join(vault, rel), "utf8")).body.replace(/\s+/g, " ").trim();
          const title = basename(rel, ".md");
          // Une note = un vecteur : son titre et son début (assez pour en saisir le sujet).
          out.push({ ref: `note:${rel}`, kind: "note", title, text: `${title}. ${body}`.slice(0, 2000) });
        } catch {}
      }
    }
    return out;
  }

  /** Met l'index à jour : seulement ce qui est nouveau ou a changé ; retire ce qui a disparu. */
  refresh(vault: string | null): Promise<number> {
    if (!enabled()) return Promise.resolve(0);
    if (this.indexing) return this.indexing;
    // Le « en cours » est retiré après coup : une mise à jour sans rien à calculer finit tout de suite.
    const run = (async () => {
      {
        const want = this.sources(vault);
        const have = new Map((this.db.prepare("SELECT ref, hash FROM embeddings").all() as { ref: string; hash: string }[]).map((r) => [r.ref, r.hash]));
        const todo = want.filter((w) => have.get(w.ref) !== sha(w.text));
        const keep = new Set(want.map((w) => w.ref));
        for (const ref of have.keys()) if (!keep.has(ref)) this.db.prepare("DELETE FROM embeddings WHERE ref = ?").run(ref);
        for (let i = 0; i < todo.length; i += BATCH) {
          const batch = todo.slice(i, i + BATCH);
          const vecs = await this.embed(batch.map((b) => `${prefixes().passage}${b.text}`));
          const put = this.db.prepare(
            "INSERT INTO embeddings (ref, kind, title, hash, vec) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, title = excluded.title, hash = excluded.hash, vec = excluded.vec, updated_at = datetime('now')",
          );
          batch.forEach((b, k) => put.run(b.ref, b.kind, b.title, sha(b.text), toBlob(vecs[k])));
        }
        return todo.length;
      }
    })();
    this.indexing = run;
    void run.finally(() => {
      if (this.indexing === run) this.indexing = null;
    }).catch(() => {});
    return run;
  }

  private rows(kind?: "memory" | "note") {
    return (kind ? this.db.prepare("SELECT ref, kind, title, vec FROM embeddings WHERE kind = ?").all(kind) : this.db.prepare("SELECT ref, kind, title, vec FROM embeddings").all()) as {
      ref: string;
      kind: "memory" | "note";
      title: string;
      vec: Uint8Array;
    }[];
  }

  /** Les entrées les plus proches d'une question (par le sens). */
  async search(query: string, opts: { kind?: "memory" | "note"; limit?: number; min?: number } = {}): Promise<SemanticHit[]> {
    if (!enabled()) return [];
    const rows = this.rows(opts.kind);
    if (!rows.length) return [];
    const [q] = await this.embed([`${prefixes().query}${query}`]);
    const qv = new Float32Array(q);
    return rows
      .map((r) => ({ ref: r.ref, kind: r.kind, title: r.title, score: cosine(qv, fromBlob(r.vec)) }))
      .filter((h) => h.score >= (opts.min ?? MIN_SCORE))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 8);
  }

  /**
   * Les souvenirs proches d'un souvenir, sans calcul (vecteurs déjà rangés) : pour les liens
   * « Proche de » des notes : trois au plus, au-dessus d'un seuil.
   */
  neighbours(memoryId: number, limit = 3, min = NEIGHBOUR_SCORE): number[] {
    const all = this.rows("memory");
    const me = all.find((r) => r.ref === `memory:${memoryId}`);
    if (!me) return [];
    const v = fromBlob(me.vec);
    return all
      .filter((r) => r.ref !== me.ref)
      .map((r) => ({ id: Number(r.ref.slice(7)), score: cosine(v, fromBlob(r.vec)) }))
      .filter((r) => r.score >= min)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.id);
  }
}

const byDb = new WeakMap<DatabaseSync, SemanticIndex>();
export function semanticOf(store: Store, embed?: EmbedFn): SemanticIndex {
  let s = byDb.get(store.db);
  if (!s) byDb.set(store.db, (s = new SemanticIndex(store, embed)));
  return s;
}
