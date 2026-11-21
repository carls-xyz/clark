import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/memory/store.ts";
import { SemanticIndex, type EmbedFn } from "../src/memory/semantic.ts";

// Faux modèle : un axe par thème ; « site », « portfolio », « vercel » tombent sur le même.
const THEMES = [/site|portfolio|vercel|next/i, /mail|promo|newsletter/i, /dentiste|rendez-vous|médecin/i];
const fake: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = THEMES.map((re) => (re.test(t) ? 1 : 0.05));
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });

test("recherche par le sens : l'index suit souvenirs et notes, et retrouve sans les mêmes mots", async () => {
  const store = new Store(":memory:");
  const site = store.remember({ kind: "fact", content: "Le portfolio est déployé sur Vercel." });
  store.remember({ kind: "preference", content: "Pas de promos ni de newsletters dans la boîte mail." });
  const vault = mkdtempSync(join(tmpdir(), "clark-sem-"));
  writeFileSync(join(vault, "Santé.md"), "Rendez-vous chez le dentiste jeudi.");
  let calls = 0;
  const index = new SemanticIndex(store, async (t) => {
    calls++;
    return fake(t);
  });

  assert.equal(await index.refresh(vault), 3);
  assert.equal(await index.refresh(vault), 0, "rien de changé : rien de recalculé");
  const before = calls;

  const hits = await index.search("où est mon site perso ?", { min: 0.5 });
  assert.equal(hits[0].ref, `memory:${site}`);
  const notes = await index.search("médecin", { kind: "note", min: 0.5 });
  assert.equal(notes[0].ref, "note:Santé.md");
  assert.equal(calls, before + 2, "une question = un seul calcul");

  // Un souvenir oublié quitte l'index.
  store.forget(site);
  await index.refresh(vault);
  assert.equal((await index.search("site", { min: 0.5 })).some((h) => h.ref === `memory:${site}`), false);
});

test("recherche par le sens : voisins d'un souvenir sans recalcul, coupée avec CLARK_EMBEDDINGS=off", async () => {
  const store = new Store(":memory:");
  const a = store.remember({ kind: "fact", content: "Le portfolio est en Next.js." });
  const b = store.remember({ kind: "fact", content: "Le site est sur Vercel." });
  store.remember({ kind: "event", content: "Dentiste le 3 décembre." });
  const index = new SemanticIndex(store, fake);
  await index.refresh(null);
  assert.deepEqual(index.neighbours(a, 3, 0.9), [b]);
  process.env.CLARK_EMBEDDINGS = "off";
  try {
    assert.deepEqual(await index.search("site"), []);
  } finally {
    delete process.env.CLARK_EMBEDDINGS;
  }
});
