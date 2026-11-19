import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backupNow } from "../src/core/backup.ts";

test("sauvegarde de nuit : une copie lisible par jour, les 7 dernières gardées", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-backup-"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('souvenir')");
  for (let d = 1; d <= 9; d++) backupNow(db, dir, `2026-11-${String(d).padStart(2, "0")}`);
  assert.equal(backupNow(db, dir, "2026-11-09"), null, "une seule par jour");
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["03", "04", "05", "06", "07", "08", "09"].map((d) => `clark-2026-11-${d}.db`));
  const copy = new DatabaseSync(join(dir, files.at(-1)!));
  assert.equal((copy.prepare("SELECT x FROM t").get() as { x: string }).x, "souvenir");
});
