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

test("interface : un titre Markdown collé au texte qui suit reste un titre", () => {
  const s = appScript();
  const start = s.indexOf("const esc = ");
  const md = s.slice(s.indexOf("function md("), s.indexOf("// Confirmations"));
  const run = new Function(`${s.slice(start, s.indexOf(";", s.indexOf("[c])", start)) + 1)}\n${md}\nreturn md;`)() as (src: string) => string;
  assert.equal(run("## Effort\nDeux soirées"), '<p class="h">Effort</p><p>Deux soirées</p>');
  assert.equal(run("Avant\n## Après\nfin"), '<p>Avant</p><p class="h">Après</p><p>fin</p>');
  assert.equal(run("```\n## pas un titre\n```"), "<pre><code>## pas un titre</code></pre>");
});
