import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/memory/store.ts";
import { MEMORY_DIR, parseNote, VaultSync, wikiLinks } from "../src/obsidian/vault.ts";
import { parseTopics, refreshTopics, topicsOf, TOPICS_DIR } from "../src/obsidian/topics.ts";

test("sujets : JSON vérifié (souvenirs connus, 2 au moins, noms propres, pas le nom d'une note existante)", () => {
  const ids = new Set([1, 2, 3, 4]);
  const out = parseTopics(
    `{"topics":[
      {"name":"portfolio","description":"Le site.","memories":[1,2,99]},
      {"name":"Seul","description":"x","memories":[3]},
      {"name":"Clark","description":"Méthode.","memories":[3,4]},
      {"name":"Portfolio","description":"doublon","memories":[1,2]},
      {"name":"a/b:c","description":"","memories":[2,4]}
    ]}`,
    ids,
    new Set(["clark"]),
  )!;
  assert.deepEqual(out.map((t) => t.name), ["Portfolio", "Clark (sujet)", "A b c"]);
  assert.deepEqual(out[0].memories, [1, 2], "souvenir inconnu retiré");
  assert.equal(parseTopics("pas de json", ids), null);
});

test("sujets : une note par sujet, reliée aux souvenirs et aux jours du journal ; chaque souvenir pointe vers ses sujets", async () => {
  const store = new Store(":memory:");
  const vault = mkdtempSync(join(tmpdir(), "clark-sujets-"));
  const a = store.remember({ kind: "project", content: "Le portfolio est en Next.js sur Vercel." });
  const b = store.remember({ kind: "fact", content: "Le formulaire de contact du portfolio utilise Resend." });
  const c = store.remember({ kind: "preference", content: "Charles veut une boîte mail sans promos." });
  const sync = new VaultSync(store, vault, { topics: (m) => topicsOf(store.db).of(m.id) });
  sync.sync();
  const nameOf = (id: number) => (store.db.prepare("SELECT file FROM obsidian_notes WHERE memory_id = ?").get(id) as { file: string }).file.split("/").pop()!.replace(/\.md$/, "");
  // Un jour du journal qui parle du portfolio.
  mkdirSync(join(vault, "Clark", "Journal"), { recursive: true });
  writeFileSync(join(vault, "Clark", "Journal", "Journal 2026-11-20.md"), `## En bref\nOn a corrigé [[${nameOf(a)}]].\n`);

  let calls = 0;
  const think = async () => {
    calls++;
    return JSON.stringify({ topics: [{ name: "Portfolio", description: "Le site de Charles.", memories: [a, b] }] });
  };
  assert.equal(await refreshTopics(store, think, vault, { onDone: () => sync.sync() }), 1);
  const note = readFileSync(join(vault, TOPICS_DIR, "Portfolio.md"), "utf8");
  assert.equal(parseNote(note).props.type, "sujet");
  assert.deepEqual(wikiLinks(note).sort(), [nameOf(a), nameOf(b), "Journal 2026-11-20", "Clark"].sort());
  // Les notes de souvenirs pointent vers leur sujet ; celle qui n'en a pas, non.
  assert.match(readFileSync(join(vault, MEMORY_DIR, `${nameOf(a)}.md`), "utf8"), /- Sujet : \[\[Portfolio\]\]/);
  assert.doesNotMatch(readFileSync(join(vault, MEMORY_DIR, `${nameOf(c)}.md`), "utf8"), /Sujet/);

  // Rien de changé dans la mémoire : pas de nouvel appel au modèle.
  assert.equal(await refreshTopics(store, think, vault), null);
  assert.equal(calls, 1);

  // Un sujet qui disparaît : sa note (écrite par Clark) part, une note de Charles dans le dossier reste.
  writeFileSync(join(vault, TOPICS_DIR, "Mes idées.md"), "Une note à moi.");
  store.remember({ kind: "fact", content: "Nouveau souvenir pour changer la mémoire." });
  const think2 = async () => JSON.stringify({ topics: [{ name: "Site perso", description: "Le portfolio.", memories: [a, b] }] });
  assert.equal(await refreshTopics(store, think2, vault, { force: true, onDone: () => sync.sync() }), 1);
  assert.ok(!existsSync(join(vault, TOPICS_DIR, "Portfolio.md")));
  assert.ok(existsSync(join(vault, TOPICS_DIR, "Site perso.md")));
  assert.ok(existsSync(join(vault, TOPICS_DIR, "Mes idées.md")), "une note de Charles n'est jamais supprimée");
  assert.match(readFileSync(join(vault, MEMORY_DIR, `${nameOf(a)}.md`), "utf8"), /- Sujet : \[\[Site perso\]\]/);
});
