import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { applyImport, exportConfig, planImport } from "../src/core/config-export.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { checkPrefs, defaultPrefs, heldCount, inQuiet, notifyAllowed, NotifyStore, setNotifyStore } from "../src/core/notify.ts";
import { savePersonality } from "../src/core/personality.ts";
import { Settings } from "../src/core/settings.ts";
import { checkCopyPath, prepareCopy, validateCopyPaths } from "../src/dev/project-setup.ts";
import { Store } from "../src/memory/store.ts";
import { ownCommands, saveCommand } from "../src/skills/library.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const root = mkdtempSync(join(tmpdir(), "clark-settings-"));
process.env.CLARK_COMMANDS_DIR = join(root, "commands");
process.env.CLARK_PERSONALITY_FILE = join(root, "personnalite.md");
process.env.CLARK_PLUGINS_DIR = join(root, "plugins");
after(() => {
  setNotifyStore(null);
  rmSync(root, { recursive: true, force: true });
});

const config = (): Config => ({
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 120,
  roleEngines: {},
  webPort: 0,
  model: "m",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
});

test("réglages : l'interface passe devant .env, vérifiés, appliqués tout de suite, et « revenir » rend la main à .env", () => {
  process.env.CLARK_STALL_MINUTES = "7";
  delete process.env.CLARK_HEARTBEAT_MINUTES;
  const store = new Store(":memory:");
  const s = new Settings(store.db);
  const cfg = config();
  const view = (k: string) => s.view().find((x) => x.key === k)!;
  assert.deepEqual([view("stall").value, view("stall").source], ["7", ".env"]);
  assert.deepEqual([view("heartbeat").value, view("heartbeat").source], ["120", "défaut"]);

  assert.deepEqual(s.set("stall", "3", cfg), { ok: true, restart: false });
  assert.equal(process.env.CLARK_STALL_MINUTES, "3", "pris en compte sans redémarrer");
  assert.deepEqual(s.set("heartbeat", "45", cfg), { ok: true, restart: false });
  assert.equal(cfg.heartbeatMinutes, 45);
  assert.deepEqual(s.set("brief", "8", cfg), { ok: true, restart: false });
  assert.equal(cfg.briefHour, 8);
  assert.deepEqual(s.set("roles", "relecteur=claude,redacteur=codex", cfg), { ok: true, restart: false });
  assert.deepEqual(cfg.roleEngines, { relecteur: "claude", redacteur: "codex" });
  assert.deepEqual(s.set("prPoll", "5", cfg), { ok: true, restart: true }, "relu au démarrage");

  for (const [k, v] of [
    ["stall", "0"],
    ["stall", "abc"],
    ["brief", "25"],
    ["devParallel", "2.5"],
    ["sandbox", "peut-être"],
    ["engine", "gpt"],
    ["roles", "chef=claude"],
    ["inconnu", "1"],
  ])
    assert.ok("error" in s.set(k, v, cfg), `${k}=${v} refusé`);

  assert.deepEqual(s.set("stall", null, cfg), { ok: true, restart: false });
  assert.equal(process.env.CLARK_STALL_MINUTES, "7", "retour à la valeur de .env");
  assert.equal(view("stall").source, ".env");

  // Au démarrage suivant : la valeur de l'interface est posée avant de lire la config.
  process.env.CLARK_HEARTBEAT_MINUTES = "999";
  new Settings(store.db).applyToEnv();
  assert.equal(process.env.CLARK_HEARTBEAT_MINUTES, "45");
  delete process.env.CLARK_STALL_MINUTES;
  for (const k of ["CLARK_HEARTBEAT_MINUTES", "CLARK_BRIEF_HOUR", "CLARK_ROLE_ENGINES", "CLARK_PR_POLL_MINUTES"]) delete process.env[k];
});

test("notifications : réglages vérifiés, heures calmes qui passent minuit, canal par canal", () => {
  assert.ok("error" in checkPrefs({ quiet: { from: "25:00" } }));
  assert.ok("error" in checkPrefs({ awake: "parfois" }));
  const p = defaultPrefs();
  assert.equal(p.routes.reply.telegram && p.routes.reply.imessage && p.routes.reply.browser, true);
  assert.equal(p.routes.pr.imessage, false, "par défaut, iMessage : réponses et accords seulement");

  const quiet = { ...p, quiet: { on: true, from: "23:00", to: "08:00", approvals: true } };
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 19, h - 1, m)); // heure de Paris = UTC+1
  assert.equal(inQuiet(quiet, at(23, 30)), true);
  assert.equal(inQuiet(quiet, at(3)), true);
  assert.equal(inQuiet(quiet, at(8)), false);
  assert.equal(inQuiet(quiet, at(12)), false);
  assert.equal(inQuiet({ ...quiet, quiet: { ...quiet.quiet, from: "13:00", to: "14:00" } }, at(13, 30)), true);
  assert.equal(inQuiet({ ...quiet, quiet: { ...quiet.quiet, on: false } }, at(3)), false);

  const store = new Store(":memory:");
  const n = new NotifyStore(store.db);
  setNotifyStore(n);
  try {
    n.set({ ...p, routes: { ...p.routes, pr: { telegram: false, imessage: false, browser: false } } });
    assert.equal(notifyAllowed("telegram", "reply"), true);
    assert.equal(notifyAllowed("telegram", "pr"), false);
    assert.equal(notifyAllowed("imessage", "dev"), false);
    assert.equal(notifyAllowed("un-autre-canal", "pr"), true, "un canal inconnu reçoit tout");
    n.set({ ...p, quiet: { on: true, from: "00:00", to: "23:59", approvals: true } });
    const before = heldCount();
    assert.equal(notifyAllowed("telegram", "reply", "Rien d'urgent"), false, "heures calmes");
    assert.equal(notifyAllowed("telegram", "approval", "Je peux ?"), true, "sauf les accords");
    assert.equal(notifyAllowed("telegram", "digest", "résumé"), true);
    assert.equal(heldCount(), before + 1, "retenu pour le résumé de fin");
  } finally {
    setNotifyStore(null);
  }
});

test("notifications dans le hub : un canal ne reçoit que ce qu'il veut", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const hub = createHub({ config: config(), store, journal, conversation }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as typeof executeTask });
  const got: string[] = [];
  hub.addChannel({ name: "telegram", deliver: async (m) => void got.push(`${m.kind}:${m.text}`) });
  const n = new NotifyStore(store.db);
  setNotifyStore(n);
  try {
    const p = defaultPrefs();
    n.set({ ...p, routes: { ...p.routes, pr: { telegram: false, imessage: false, browser: false } } });
    await hub.post(OWNER_CHAT, "Bonjour", "clark");
    await hub.post(OWNER_CHAT, "PR #7 : CI en échec", "system", "pr");
    await hub.post(OWNER_CHAT, "Tâche dev #3 prête", "system", "dev");
    assert.deepEqual(got, ["reply:Bonjour", "dev:Tâche dev #3 prête"]);
    assert.equal(conversation.recent(OWNER_CHAT).length, 3, "tout reste dans la conversation");
  } finally {
    setNotifyStore(null);
  }
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("projet : fichiers à copier (ignorés par git, jamais un secret), commande de préparation, fichiers qu'elle salit signalés", async () => {
  for (const bad of [".env", "config/.env.local", "certs/server.pem", "id_ed25519", ".npmrc", "../ailleurs", "/etc/hosts", "credentials.json"]) assert.ok(checkCopyPath(bad), bad);
  assert.equal(checkCopyPath("config/local.json"), null);

  const repo = join(root, "repo");
  mkdirSync(join(repo, "config"), { recursive: true });
  sh(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, ".gitignore"), "config/local.json\nnode_modules/\n");
  writeFileSync(join(repo, "app.txt"), "a\n");
  writeFileSync(join(repo, "config/local.json"), '{"port":3000}\n');
  sh(repo, "add", ".");
  sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  const project = { id: 1, name: "p", path: repo, base_branch: "main", test_command: null, default_engine: null, default_model: null, default_effort: null, setup_command: "echo prêt && echo trace > trace-setup.txt", copy_paths: JSON.stringify(["config/local.json"]), preview_command: null, preview_path: null, created_at: "" };
  assert.match((await validateCopyPaths(project, ["app.txt"]))!, /suivi par git/);
  assert.match((await validateCopyPaths(project, ["config/absent.json"]))!, /n'existe pas/);
  assert.equal(await validateCopyPaths(project, ["config/local.json"]), null);

  const copy = join(root, "copy");
  sh(repo, "worktree", "add", "-q", "-b", "t", copy, "main");
  const log = (await prepareCopy(project, copy))!;
  assert.deepEqual(log.copied, ["config/local.json"]);
  assert.equal(readFileSync(join(copy, "config/local.json"), "utf8"), '{"port":3000}\n');
  assert.equal(log.ok, true);
  assert.match(log.output, /prêt/);
  assert.deepEqual(log.dirty, ["trace-setup.txt"], "un fichier créé par la préparation, non ignoré, est signalé");

  const failing = (await prepareCopy({ ...project, copy_paths: null, setup_command: "exit 3" }, copy))!;
  assert.deepEqual([failing.ok, failing.code], [false, 3]);
  assert.equal(await prepareCopy({ ...project, copy_paths: null, setup_command: null }, copy), null);
});

test("sauvegarde : export sans secret, aperçu, puis import (l'existant reste, les plugins se relisent, mémoire et personnalité au choix)", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:super-secret-token";
  process.env.NOTION_TOKEN = "ntn_super_secret";
  try {
    const a = new Store(":memory:");
    const hubA = createHub({ config: config(), store: a, journal: new TaskJournal(a.db), conversation: new Conversation(a.db) }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as typeof executeTask });
    const sa = new Settings(a.db);
    sa.set("heartbeat", "60");
    saveCommand({ name: "relances", description: "Relances", mode: "chat", prompt: "Prépare mes relances de candidature." });
    a.automations.create({ name: "Brief du lundi", prompt: "Résume ma semaine.", frequency: "weekly", time: "08:00", weekday: 1 });
    a.mcp.add({ name: "notion", transport: "http", url: "https://mcp.notion.example/mcp", tokenVar: "NOTION_TOKEN", trust: "ask" });
    a.remember({ kind: "fact", content: "Charles préfère les relances courtes", source: "conversation" });
    savePersonality("- Pince-sans-rire.");
    const data = exportConfig({ hub: hubA, settings: sa, notify: null }, { memory: true });
    const text = JSON.stringify(data);
    assert.ok(!text.includes("super-secret"), "aucun secret dans le fichier");
    assert.ok(text.includes('"tokenVar":"NOTION_TOKEN"'), "seulement le nom de la variable");
    assert.equal(data.memories?.length, 1);

    // Sur une autre machine : base neuve, commandes déjà en partie là.
    rmSync(process.env.CLARK_COMMANDS_DIR!, { recursive: true, force: true });
    saveCommand({ name: "relances", description: "La mienne", mode: "chat", prompt: "Ma version locale, à garder." });
    savePersonality("");
    const b = new Store(":memory:");
    const hubB = createHub({ config: config(), store: b, journal: new TaskJournal(b.db), conversation: new Conversation(b.db) }, { execute: (async () => ({ text: "", costUsd: 0, status: "done" })) as typeof executeTask });
    const sb = new Settings(b.db);
    const withPlugin = { ...data, plugins: [{ name: "commit-commands", source: "https://github.com/anthropics/claude-plugins-official", subdir: "plugins/commit-commands", ref: null, enabled: true }], projects: [{ name: "absent", path: "/nulle/part", base: "main", test: null, engine: null, model: null, effort: null, setup: null, copy: [] }] };
    const plan = planImport({ hub: hubB, settings: sb, notify: null }, withPlugin);
    assert.deepEqual(plan.commands, [{ name: "/relances", status: "existe déjà" }]);
    assert.deepEqual(plan.automations.map((x) => x.status), ["nouveau"]);
    assert.deepEqual(plan.plugins.map((x) => x.status), ["à relire"]);
    assert.deepEqual(plan.projects.map((x) => x.status), ["chemin introuvable"]);
    assert.deepEqual(plan.memories, { total: 1, fresh: 1 });
    assert.equal(plan.personality.differs, true);
    assert.throws(() => planImport({ hub: hubB, settings: sb, notify: null }, { format: "autre" }), /pas une configuration de Clark/);

    const done = await applyImport({ hub: hubB, settings: sb, notify: null }, withPlugin, { memories: true, personality: false });
    assert.equal(done.settings, 1);
    assert.equal(sb.view().find((x) => x.key === "heartbeat")!.value, "60");
    assert.equal(ownCommands().find((c) => c.name === "relances")!.prompt, "Ma version locale, à garder.", "l'existant reste tel quel");
    assert.equal(b.automations.list().length, 1);
    assert.deepEqual(b.mcp.list().map((m) => [m.name, m.tokenVar]), [["notion", "NOTION_TOKEN"]]);
    assert.equal(done.memories, 1);
    assert.equal(done.personality, false, "la personnalité ne change que sur ton choix");
    assert.match(done.skipped.join(" "), /absent : \/nulle\/part introuvable/);
    assert.ok(!existsSync(join(process.env.CLARK_PLUGINS_DIR!, "commit-commands")), "aucun plugin installé d'office");
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NOTION_TOKEN;
    delete process.env.CLARK_HEARTBEAT_MINUTES;
  }
});
