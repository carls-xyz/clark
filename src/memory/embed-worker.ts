/**
 * Processus à part qui calcule les embeddings (le modèle pèse ~650 Mo en mémoire) : lancé à la
 * demande par src/memory/semantic.ts, il s'arrête tout seul quand on ne lui demande plus rien.
 * Protocole : une ligne JSON par demande { id, texts }, une ligne par réponse { id, vectors } ou { id, error }.
 */
import { createInterface } from "node:readline";
import { env, pipeline } from "@huggingface/transformers";
import { EMBED_MODEL } from "./embed-model.ts";

env.cacheDir = process.env.CLARK_MODELS_DIR ?? env.cacheDir;
const MODEL = process.env.CLARK_EMBED_MODEL ?? EMBED_MODEL;

let extractor: Awaited<ReturnType<typeof pipeline>> | null = null;
const load = async () => (extractor ??= await pipeline("feature-extraction", MODEL, { dtype: "q8" }));

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  let id = 0;
  try {
    const req = JSON.parse(line) as { id: number; texts: string[] };
    id = req.id;
    const fe = (await load()) as (t: string[], o: object) => Promise<{ tolist(): number[][] }>;
    const out = await fe(req.texts, { pooling: "mean", normalize: true });
    process.stdout.write(`${JSON.stringify({ id, vectors: out.tolist() })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ id, error: err instanceof Error ? err.message : String(err) })}\n`);
  }
}
