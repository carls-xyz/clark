import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { TEAM_LABEL } from "../src/core/team.ts";
import { snapshot } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { effectOf } from "../src/policy/permissions.ts";
import { describeStep, TaskJournal } from "../src/tasks/journal.ts";

const config: Config = {
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: 0,
  model: "claude-opus-5-5",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
};

test("point d'étape : noté sur la tâche de l'agent, une ligne, refusé sans tâche", () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const id = journal.create(OWNER_CHAT, "node:a11y", "x");
  const t = memoryTools(store, { taskId: () => id, writeRefusal: () => "lecture seule" });
  assert.equal(t.report_progress.run({ note: "3 pages lues sur 5 ;\n  contraste à revoir" }), "Point d'étape noté.");
  assert.equal(journal.get(id)!.checkpoint, "3 pages lues sur 5 ; contraste à revoir", "une seule ligne");
  assert.ok(journal.get(id)!.checkpoint_at);

  const none = memoryTools(store, { taskId: () => undefined, writeRefusal: () => null });
  assert.match(none.report_progress.run({ note: "x y z" }), /je ne retrouve pas la tâche/);
});

test("point d'étape : permis en lecture seule, c'est une lecture", () => {
  assert.equal(effectOf("mcp__memory__report_progress"), "read");
  assert.equal(
    describeStep({ tool: "mcp__memory__report_progress", input: JSON.stringify({ note: "contrastes vérifiés" }) } as never),
    "point d'étape : contrastes vérifiés",
  );
});

test("point d'étape écrit par un autre processus (Codex) : vu par l'interface, sur l'agent en cours seulement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-cp-"));
  try {
    const db = join(dir, "clark.db");
    const store = new Store(db);
    const journal = new TaskJournal(store.db);
    const hub = createHub({ config, store, journal, conversation: new Conversation(store.db) });
    let changes = 0;
    hub.onChange(() => changes++);

    const parent = journal.create(OWNER_CHAT, TEAM_LABEL, "Revue de portfolio");
    journal.setStatus(parent, "running");
    const plan = journal.create(OWNER_CHAT, "plan", "[Équipe de Clark — Plan]", parent);
    journal.finish(
      plan,
      "done",
      `{"steps":[{"key":"a11y","role":"temporaire","name":"Spécialiste Accessibilité","mission":"m","deliverable":"d","dependsOn":[]},{"key":"contenu","role":"contenu","deliverable":"d","dependsOn":[]}]}`,
      0,
    );
    const a11y = journal.create(OWNER_CHAT, "node:a11y", "x", parent);
    journal.setStatus(a11y, "running");
    const contenu = journal.create(OWNER_CHAT, "node:contenu", "x", parent);

    // Le serveur de mémoire de Codex écrit le point d'étape dans son propre processus.
    const other = new Store(db);
    const before = changes;
    await new Promise((r) => setTimeout(r, 1100)); // premier relevé
    memoryTools(other, { taskId: () => a11y, writeRefusal: () => null }).report_progress.run({ note: "Contraste trop faible sur Projets" });
    memoryTools(other, { taskId: () => contenu, writeRefusal: () => null }).report_progress.run({ note: "vieux point d'étape" });
    journal.finish(contenu, "done", "rapport", 0);
    const start = Date.now();
    while (changes === before && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(changes > before, "l'interface est prévenue");

    const agents = snapshot(hub).running[0].team!.agents;
    assert.equal(agents[0].checkpoint, "Contraste trop faible sur Projets");
    assert.equal(agents[1].checkpoint, null, "un agent terminé n'affiche plus son ancien point d'étape");
    other.db.close();
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
