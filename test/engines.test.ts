import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub } from "../src/core/hub.ts";
import { checkChoice, type Catalog } from "../src/engines/choices.ts";
import { claudeModels, claudeQuota } from "../src/engines/claude-probe.ts";
import { codexModels } from "../src/engines/codex.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = {
  telegram: null,
  hasApiKey: false,
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

const catalog: Catalog = {
  readAt: 0,
  models: [
    { id: "opus", name: "Opus", description: "", efforts: ["low", "high", "max"], defaultEffort: null },
    { id: "haiku", name: "Haiku", description: "", efforts: [], defaultEffort: null },
  ],
};

test("quota Claude : fenêtres de 5 h et 7 jours, comme /usage", () => {
  const now = Date.parse("2026-11-19T10:00:00Z");
  const q = claudeQuota(
    {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.5, resets_at: "2026-11-19T13:00:00Z" },
        seven_day: { utilization: 100, resets_at: null },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 7, resets_at: "2026-11-22T10:00:00Z" },
      },
    },
    now,
  )!;
  assert.equal(q.plan, "max");
  assert.deepEqual(
    q.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]),
    [
      ["Fenêtre de 5 h", 42.5, Date.parse("2026-11-19T13:00:00Z")],
      ["Fenêtre de 7 jours", 100, null],
      ["Fenêtre de 7 jours (Sonnet)", 7, Date.parse("2026-11-22T10:00:00Z")],
    ],
  );
  assert.equal(q.reached, true, "une fenêtre à 100 % : limite atteinte");
  assert.equal(claudeQuota({ rate_limits_available: false, rate_limits: null }), null, "clé API : pas de quota de forfait");
  assert.equal(claudeQuota({ rate_limits_available: true, rate_limits: {} }), null);
});

test("modèles : lus auprès de Claude et de Codex, avec leurs niveaux de puissance", () => {
  const claude = claudeModels([
    { value: "opus", displayName: "Opus", description: "le plus capable", supportsEffort: true, supportedEffortLevels: ["low", "max"] },
    { value: "haiku", displayName: "Haiku", description: "rapide" },
  ] as any);
  assert.deepEqual(claude.map((m) => [m.id, m.efforts]), [["opus", ["low", "max"]], ["haiku", []]]);

  const codex = codexModels({
    data: [
      { id: "a", model: "modele-a", displayName: "A", description: "", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: true },
      { id: "b", model: "modele-cache", displayName: "B", hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: "low" },
    ],
  });
  assert.deepEqual(codex, [{ id: "modele-a", name: "A", description: "", efforts: ["low", "high"], defaultEffort: "high", isDefault: true }]);
});

test("choix : seulement un modèle et une puissance que le moteur propose", () => {
  assert.equal(checkChoice({ model: "opus", effort: "max" }, catalog), null);
  assert.equal(checkChoice({ model: null, effort: null }, catalog), null, "retour au défaut");
  assert.match(checkChoice({ model: "opus", effort: "xhigh" }, catalog)!, /ne propose pas ce niveau/);
  assert.match(checkChoice({ model: "haiku", effort: "low" }, catalog)!, /ne propose pas ce niveau/);
  assert.match(checkChoice({ model: "gpt-x", effort: null }, catalog)!, /Modèle inconnu/);
  assert.match(checkChoice({ model: null, effort: "low" }, catalog)!, /Choisis un modèle/);
  assert.match(checkChoice({ model: "opus", effort: null }, null)!, /pas encore la liste/, "sans liste lue, on ne devine pas");
});

test("hub : choix gardés en base, quota par moteur, limite signalée pendant une tâche", () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config, store, journal, conversation }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as unknown as typeof executeTask });

  assert.match(hub.setChoice("claude", { model: "opus", effort: "high" })!, /pas encore la liste/);
  hub.setCatalog("claude", catalog);
  assert.equal(hub.setChoice("claude", { model: "opus", effort: "high" }), null);
  assert.deepEqual(new Store(":memory:").choices.get("claude"), { model: null, effort: null, wanted: null });
  assert.deepEqual(store.choices.get("claude"), { model: "opus", effort: "high", wanted: "high" }, "rangé en base : survit au redémarrage");
  hub.setCatalog("claude", null, "Claude ne répond pas");
  assert.equal(hub.catalog("claude")!.catalog!.models.length, 2, "un échec de relecture garde la dernière liste");

  const q = { plan: "plus", windows: [{ label: "Fenêtre de 5 h", usedPercent: 50, durationMins: 300, resetsAt: null }], reached: false, readAt: 1 };
  hub.setQuota(q, "codex");
  assert.equal(hub.quota(), null, "le quota principal est celui de Claude ici");
  assert.equal(hub.quotaOf("codex"), q);
  hub.markLimitReached("claude", Date.parse("2026-11-19T15:00:00Z"));
  assert.equal(hub.quota()!.reached, true);
  assert.equal(hub.quota()!.windows[0].resetsAt, Date.parse("2026-11-19T15:00:00Z"));
});

test("bac à sable Claude : dossier personnel fermé sauf le dossier de travail, pas de réseau, échec fermé", async () => {
  const { claudeSandbox } = await import("../src/engines/sandbox.ts");
  const { homedir } = await import("node:os");
  const { realpathSync } = await import("node:fs");
  const { paths } = await import("../src/config.ts");
  const s = claudeSandbox()!;
  assert.equal(s.enabled, true);
  assert.equal(s.failIfUnavailable, true, "s'il ne démarre pas, rien ne tourne");
  assert.equal(s.allowUnsandboxedCommands, false, "le modèle ne peut pas demander à en sortir");
  assert.equal(s.autoAllowBashIfSandboxed, false, "la validation par bouton reste");
  assert.deepEqual(s.filesystem!.denyRead, [realpathSync(homedir())]);
  assert.ok(s.filesystem!.allowRead!.includes(realpathSync(paths.workspace)));
  assert.ok(!s.filesystem!.allowRead!.some((p) => p === realpathSync(paths.root)), "ni .env ni data/");
  assert.deepEqual(s.network!.allowedDomains, []);
  process.env.CLARK_SANDBOX = "off";
  assert.equal(claudeSandbox(), undefined);
  delete process.env.CLARK_SANDBOX;
});

test("hub : l'effort choisi survit à un aller-retour par un modèle qui ne l'a pas (il ne « repasse » plus en Auto)", () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config, store, journal, conversation }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as unknown as typeof executeTask });
  hub.setCatalog("claude", catalog);
  assert.equal(hub.setChoice("claude", { model: "opus", effort: "high" }), null);
  // Vers un modèle sans « élevée » : Auto, mais le choix reste en mémoire.
  assert.equal(hub.setChoice("claude", { model: "haiku", effort: null }, "model"), null);
  assert.deepEqual(store.choices.get("claude"), { model: "haiku", effort: null, wanted: "high" });
  // « Par défaut » non plus.
  assert.equal(hub.setChoice("claude", { model: null, effort: null }, "model"), null);
  assert.equal(store.choices.get("claude").wanted, "high");
  // Retour sur un modèle qui l'a : il revient tout seul.
  assert.equal(hub.setChoice("claude", { model: "opus", effort: null }, "model"), null);
  assert.deepEqual(store.choices.get("claude"), { model: "opus", effort: "high", wanted: "high" });
  // Auto choisi exprès : là, on oublie le niveau.
  assert.equal(hub.setChoice("claude", { model: "opus", effort: null }), null);
  assert.equal(hub.setChoice("claude", { model: "haiku", effort: null }, "model"), null);
  assert.equal(hub.setChoice("claude", { model: "opus", effort: null }, "model"), null);
  assert.deepEqual(store.choices.get("claude"), { model: "opus", effort: null, wanted: null });
  // Chaque changement laisse une trace, avec d'où il vient.
  const traces = store.db.prepare("SELECT decision, detail FROM audit WHERE tool = 'engine_choice'").all() as { decision: string; detail: string }[];
  assert.equal(traces.length, 7);
  assert.match(traces[1].detail, /"from":"interface"/);
});
