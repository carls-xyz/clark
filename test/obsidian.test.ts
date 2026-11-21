import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/memory/store.ts";
import { MEMORY_DIR, parseNote, readVaultNote, searchVault, VaultSync, wikiLinks, writeVaultNote } from "../src/obsidian/vault.ts";

const vault = () => mkdtempSync(join(tmpdir(), "clark-vault-"));
const notesIn = (root: string) => readdirSync(join(root, MEMORY_DIR)).filter((f) => f.endsWith(".md"));

test("obsidian : chaque souvenir confirmé devient une note, avec ses propriétés et son type", () => {
  const root = vault();
  const store = new Store(":memory:");
  const id = store.remember({ kind: "preference", content: "Charles préfère les messages courts.", source: "conversation du 21 novembre" });
  const sync = new VaultSync(store, root);
  const r = sync.sync();
  assert.equal(r.written, 1);
  const file = notesIn(root).find((f) => f.includes(`(${id})`))!;
  const note = parseNote(readFileSync(join(root, MEMORY_DIR, file), "utf8"));
  assert.equal(note.props.clark_id, String(id));
  assert.equal(note.props.type, "préférence");
  assert.match(note.body, /Charles préfère les messages courts\./);
  assert.deepEqual(wikiLinks(note.body), ["Préférences"]);
  assert.match(readFileSync(join(root, MEMORY_DIR, "Préférences.md"), "utf8"), new RegExp(`\\[\\[${file.replace(".md", "").replace(/[()]/g, "\\$&")}\\]\\]`));
  assert.ok(existsSync(join(root, "Clark", "Clark.md")));
  assert.deepEqual(sync.sync(), { written: 0, edited: 0, forgotten: 0, learned: 0 }, "rien de neuf : rien ne bouge");
});

test("obsidian : Charles corrige, supprime ou écrit une note, Clark suit", () => {
  const root = vault();
  const store = new Store(":memory:");
  const a = store.remember({ kind: "fact", content: "Le portfolio est en Next.js." });
  const b = store.remember({ kind: "fact", content: "Charles habite à Lyon." });
  const sync = new VaultSync(store, root);
  sync.sync();
  const fileA = join(root, MEMORY_DIR, notesIn(root).find((f) => f.includes(`(${a})`))!);
  const fileB = join(root, MEMORY_DIR, notesIn(root).find((f) => f.includes(`(${b})`))!);

  // Correction : le texte avant « ## Liens » remplace le souvenir.
  writeFileSync(fileA, readFileSync(fileA, "utf8").replace("Le portfolio est en Next.js.", "Le portfolio est en Next.js 16, déployé sur Vercel."));
  // Suppression : Clark oublie (archivé).
  unlinkSync(fileB);
  // Nouvelle note de Charles dans le dossier : apprise.
  writeFileSync(join(root, MEMORY_DIR, "Mon alternance.md"), "---\ntype: projet\n---\nCharles cherche une alternance dev pour septembre.\n");

  const r = sync.sync();
  assert.equal(r.edited, 1);
  assert.equal(r.forgotten, 1);
  assert.equal(r.learned, 1);
  assert.equal(store.get(a)?.content, "Le portfolio est en Next.js 16, déployé sur Vercel.");
  assert.equal(store.get(b)?.archived, 1);
  const learned = store.recall("alternance septembre")[0];
  assert.equal(learned.kind, "project");
  assert.match(learned.source ?? "", /Obsidian/);
  // La note de Charles garde son nom, et reçoit son clark_id.
  assert.equal(parseNote(readFileSync(join(root, MEMORY_DIR, "Mon alternance.md"), "utf8")).props.clark_id, String(learned.id));
  assert.deepEqual(sync.sync(), { written: 0, edited: 0, forgotten: 0, learned: 0 });
});

test("obsidian : un souvenir oublié chez Clark part dans « Oubliés », rien n'est effacé", () => {
  const root = vault();
  const store = new Store(":memory:");
  const id = store.remember({ kind: "event", content: "Rendez-vous chez le dentiste le 3 décembre." });
  const sync = new VaultSync(store, root);
  sync.sync();
  store.forget(id);
  sync.sync();
  assert.equal(notesIn(root).some((f) => f.includes(`(${id})`)), false);
  const forgotten = readdirSync(join(root, MEMORY_DIR, "Oubliés"));
  assert.equal(forgotten.length, 1);
  assert.match(readFileSync(join(root, MEMORY_DIR, "Oubliés", forgotten[0]), "utf8"), /oublié: oui/);
});

test("obsidian : Clark cherche et lit tout le coffre, mais n'écrit que dans Clark/", () => {
  const root = vault();
  mkdirSync(join(root, "Cours"), { recursive: true });
  writeFileSync(join(root, "Cours", "React.md"), "# Hooks\nuseEffect et useMemo. Voir [[Projets IIM]].");
  writeFileSync(join(root, "Projets IIM.md"), "Le projet de fin d'année.");
  const hits = searchVault(root, "useeffect hooks");
  assert.equal(hits[0].path, join("Cours", "React.md"));
  const read = readVaultNote(root, "Projets IIM");
  assert.deepEqual(read?.backlinks, [join("Cours", "React.md")]);
  assert.match(writeVaultNote(root, "Cours/React", "écrasé", "replace"), /Refusé/);
  assert.match(writeVaultNote(root, "../hors-du-coffre", "x", "create"), /Refusé/);
  assert.match(writeVaultNote(root, "Clark/Mémoire/truc", "x", "create"), /Refusé/);
  assert.match(writeVaultNote(root, "Clark/Veille/2026-11-21", "# Veille", "create"), /créée/);
  assert.match(writeVaultNote(root, "Clark/Veille/2026-11-21", "Une trouvaille", "append"), /complétée/);
  assert.equal(readFileSync(join(root, "Clark", "Veille", "2026-11-21.md"), "utf8"), "# Veille\n\nUne trouvaille\n");
});
