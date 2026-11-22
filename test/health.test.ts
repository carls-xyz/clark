import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { healthReport, repeatedErrors } from "../src/core/health.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { redactSecrets } from "../src/core/redact.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null };
const root = mkdtempSync(join(tmpdir(), "clark-health-"));
after(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config, store, journal, conversation }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as unknown as typeof executeTask });
  return { store, journal, hub };
}

const TOKEN = "bot8123456789:AAEqpHRAZwfFlIc-mNzqcgdQoQKNiPRkNk0";

test("secrets masqués : jeton Telegram, clés d'API, jetons dans une adresse", () => {
  const line = `request to https://api.telegram.org/${TOKEN}/sendMessage failed (sk-ant-api03-abcdefghijkl, ghp_abcdefghijklmnopqrstuvwxyz12, https://x.test/?access_token=secret123&a=1)`;
  const out = redactSecrets(line);
  assert.doesNotMatch(out, /AAEqpHRA|abcdefghijkl|ghp_abc|secret123/);
  assert.match(out, /bot•••\/sendMessage/);
  assert.match(out, /access_token=•••&a=1/);
});

test("erreurs du journal : depuis le dernier démarrage, regroupées, secrets masqués", () => {
  const log = [
    "[clark] canal telegram : vieille erreur d'avant",
    "[clark] démarré — moteur claude",
    `[clark] canal telegram : HttpError: request to https://api.telegram.org/${TOKEN}/sendMessage failed`,
    `[clark] canal telegram : HttpError: request to https://api.telegram.org/${TOKEN}/sendMessage failed`,
    "    at emitErrorNT (node:internal/streams/destroy:170:8)",
    "[clark] tâche 12 interrompue : Error: quota",
    "[clark] tâche 13 interrompue : Error: quota",
    "[clark] interface : http://localhost:4310",
  ].join("\n");
  const errors = repeatedErrors(log);
  assert.deepEqual(
    errors.map((e) => e.count),
    [2, 2],
  );
  assert.ok(errors.every((e) => !e.text.includes("AAEqp")));
  assert.ok(!errors.some((e) => e.text.includes("vieille erreur")), "avant le démarrage : ignorée");
});

test("rapport : tout va bien, puis chaque point à regarder", () => {
  const { store, journal, hub } = setup();
  const backups = join(root, "backups");
  mkdirSync(backups);
  writeFileSync(join(backups, "clark-2026-11-22.db"), "x");
  const now = new Date();
  const base = { root, logFile: join(root, "absent.log"), backupDir: backups, now, git: (a: string[]) => (a[0] === "rev-parse" ? "abcdef1234567" : "main"), freeBytes: () => 50e9 };
  hub.setConnection("claude", { ready: true, account: "abonnement", problem: null });

  const ok = healthReport(hub, base);
  assert.equal(ok.level, "ok", JSON.stringify(ok.problems));
  assert.deepEqual(ok.version.commit, "abcdef1");
  assert.equal(ok.backup.count, 1);

  // Une version détachée (secours), un moteur principal déconnecté, une vieille sauvegarde, trois échecs, peu de place.
  hub.setConnection("claude", { ready: false, account: null, problem: "pas connecté" });
  utimesSync(join(backups, "clark-2026-11-22.db"), new Date(now.getTime() - 50 * 3_600_000), new Date(now.getTime() - 50 * 3_600_000));
  for (let i = 0; i < 3; i++) journal.finish(journal.create(OWNER_CHAT, "chat", `demande ${i}`), "failed", "non", 0);
  const bad = healthReport(hub, { ...base, git: (a: string[]) => (a[0] === "rev-parse" ? "abcdef1234567" : null), freeBytes: () => 1e9 });
  assert.equal(bad.level, "bad");
  const texts = bad.problems.map((p) => p.text).join("\n");
  assert.match(texts, /version détachée \(abcdef1\)/);
  assert.match(texts, /Claude n'est pas connecté/);
  assert.match(texts, /Dernière sauvegarde il y a 50 h/);
  assert.match(texts, /3 tâches en échec/);
  assert.match(texts, /Peu de place sur le disque : 1 Go/);
  assert.equal(bad.failures.length, 3);
});
