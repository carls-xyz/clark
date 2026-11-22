import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../src/config.ts";
import { Conversation } from "../src/core/conversation.ts";
import { keepRendering, renderingFile } from "../src/core/team.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { effectOf } from "../src/policy/permissions.ts";

test("autonomie : relire l'historique est une lecture (permis aux agents en lecture seule)", () => {
  assert.equal(effectOf("mcp__memory__history_search"), "read");
  assert.equal(effectOf("mcp__memory__history_read"), "read");
});

test("autonomie : history_read rend un long message de l'utilisateur en entier", () => {
  const store = new Store(":memory:");
  const conversation = new Conversation(store.db);
  const long = `Feu vert. ${"Point détaillé de la consigne. ".repeat(150)}FIN-DU-MESSAGE`;
  conversation.add({ chatId: 1, role: "user", text: long });
  const id = conversation.current(1);
  const t = memoryTools(store, { taskId: () => undefined, writeRefusal: () => null });
  const out = t.history_read.run({ conversation: id });
  assert.ok(long.length > 4000);
  assert.match(out, /FIN-DU-MESSAGE/, "le message n'est plus coupé à 1 200 caractères");
});

test("autonomie : le rendu de chaque spécialiste est gardé dans equipe/<mission>/rendu-<étape>.md", () => {
  const id = 900_000 + Math.floor(Math.random() * 1000);
  try {
    keepRendering(id, { key: "revue", name: "Relecteur" }, "Verdict : à corriger.\n5. Définir journalThink avant startWeb.");
    const file = join(paths.workspace, renderingFile(id, "revue"));
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, "utf8"), /^# Relecteur — mission \d+\n\nVerdict : à corriger\.\n5\. Définir journalThink/);
  } finally {
    rmSync(join(paths.workspace, "equipe", String(id)), { recursive: true, force: true });
  }
});
