import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appScript } from "../src/gateway/web.ts";

test("interface : les zones de src/web/app/ s'assemblent dans l'ordre, en un script valide", () => {
  const files = readdirSync(join(import.meta.dirname, "../src/web/app")).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 10);
  assert.ok(files.every((f) => /^\d{2}-[\w-]+\.js$/.test(f)), "noms NN-zone.js");
  const s = appScript();
  // L'ordre compte : les utilitaires d'abord, la connexion au serveur en dernier.
  assert.ok(s.indexOf("// ── Utilitaires") < s.indexOf("// ── Fil de la conversation"));
  assert.ok(s.trimEnd().length > 0 && s.lastIndexOf("// ── Connexion") > s.lastIndexOf("// ── Clark, la mascotte"));
  const file = join(mkdtempSync(join(tmpdir(), "clark-app-")), "app.mjs");
  writeFileSync(file, s);
  execFileSync(process.execPath, ["--check", file]);
});
