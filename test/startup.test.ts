import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/memory/store.ts";

const selectNote = "SELECT file FROM obsidian_notes WHERE memory_id = ?";

test("Store crée obsidian_notes au démarrage sans coffre", () => {
  using emptyDb = new DatabaseSync(":memory:");
  assert.throws(() => emptyDb.prepare(selectNote), /no such table: obsidian_notes/);

  const store = new Store(":memory:");
  using db = store.db;
  const noteOfMemory = db.prepare(selectNote);
  assert.equal(noteOfMemory.get(1), undefined);

  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='obsidian_notes'",
  ).get();
  assert.equal(table?.name, "obsidian_notes");
});

test("Store conserve les lignes de obsidian_notes à la réouverture", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-startup-"));
  const path = join(dir, "clark.db");
  const note = { memory_id: 1, file: "note.md", body_hash: "body", content_hash: "content" };

  try {
    {
      using db = new Store(path).db;
      db.prepare("INSERT INTO obsidian_notes (memory_id, file, body_hash, content_hash) VALUES (?, ?, ?, ?)")
        .run(note.memory_id, note.file, note.body_hash, note.content_hash);
    }

    using db = new Store(path).db;
    const row = db.prepare("SELECT * FROM obsidian_notes WHERE memory_id = ?").get(note.memory_id);
    assert.ok(row);
    assert.deepEqual({ ...row }, note);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
