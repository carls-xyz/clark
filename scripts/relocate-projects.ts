// Après une migration (scripts/migrate.sh) : les projets dev de la base pointent encore vers les dossiers
// du Mac. Chacun est re-cloné sur ce serveur (s'il n'y est pas déjà) et son chemin mis à jour :
// le projet de Clark lui-même devient ce dossier ; les autres vont dans ~/Developer/<nom>.
//   node scripts/relocate-projects.ts data/migration-projects.tsv
// Le fichier : une ligne « clark_root <tab> chemin de Clark sur le Mac », puis « id <tab> nom <tab> chemin <tab> dépôt ».
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Relocation = { id: number; name: string; from: string; to: string; url: string | null; action: "self" | "kept" | "clone" | "missing" };

/** Où va chaque projet, et ce qu'il faut faire (sans rien toucher). */
export function planRelocation(tsv: string, clarkRoot: string, developer: string, exists: (p: string) => boolean = existsSync): Relocation[] {
  const lines = tsv.split("\n").filter(Boolean);
  const macRoot = lines.find((l) => l.startsWith("clark_root\t"))?.split("\t")[1] ?? null;
  return lines
    .filter((l) => !l.startsWith("clark_root\t"))
    .map((l) => {
      const [id, name, from, url] = l.split("\t");
      const safe = name.replace(/[^\w.-]/g, "-");
      if (macRoot && from === macRoot) return { id: Number(id), name, from, to: clarkRoot, url: url || null, action: "self" as const };
      const to = join(developer, safe);
      return { id: Number(id), name, from, to, url: url || null, action: exists(to) ? ("kept" as const) : url ? ("clone" as const) : ("missing" as const) };
    });
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage : node scripts/relocate-projects.ts data/migration-projects.tsv");
    process.exit(2);
  }
  const root = resolve(import.meta.dirname, "..");
  const developer = join(homedir(), "Developer");
  mkdirSync(developer, { recursive: true });
  const db = new DatabaseSync(join(root, "data", "clark.db"));
  for (const r of planRelocation(readFileSync(file, "utf8"), root, developer)) {
    if (r.action === "clone") {
      try {
        execFileSync("git", ["clone", r.url!, r.to], { stdio: "inherit" });
      } catch {
        console.log(`✗ ${r.name} : clonage impossible (${r.url}). Clone-le à la main dans ${r.to} ; son chemin est quand même mis à jour.`);
      }
    }
    if (r.action === "missing") console.log(`✗ ${r.name} : pas de dépôt distant connu. Copie-le dans ${r.to} ; son chemin est quand même mis à jour.`);
    db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(r.to, r.id);
    console.log(`✓ ${r.name} : ${r.from} → ${r.to}${r.action === "kept" ? " (déjà là)" : r.action === "self" ? " (Clark lui-même)" : ""}`);
  }
  db.close();
}
