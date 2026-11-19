import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/memory/store.ts";
import { checkSource, checkSubdir, inspectPackage, Plugins, readIndex } from "../src/plugins/plugins.ts";
import { expandCommand, listCommands, listSkills, ownCommands, saveCommand } from "../src/skills/library.ts";

const base = mkdtempSync(join(tmpdir(), "clark-plugins-test-"));
process.env.CLARK_PLUGINS_DIR = join(base, "installed");
process.env.CLARK_COMMANDS_DIR = join(base, "commands");
process.env.CLARK_SKILLS_DIR = join(base, "skills");
process.env.CLARK_CLAUDE_SKILLS_DIR = join(base, "claude-skills");

function write(file: string, text: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

function makePlugin(dir: string, opts: { name?: string; extra?: (dir: string) => void } = {}) {
  write(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name: opts.name ?? "candidatures", version: "1.0.0", description: "Suivi des candidatures", author: { name: "Quelqu'un" } }));
  write(join(dir, "commands/relance.md"), "---\ndescription: Relance une candidature\n---\n\nPrépare une relance pour $ARGUMENTS. Ne l'envoie pas.\n");
  write(join(dir, "commands/start.md"), "---\ndescription: Nom réservé\n---\n\nCommande au nom réservé par Clark.\n");
  write(join(dir, "skills/lettre/SKILL.md"), "---\nname: lettre\ndescription: Écrire une lettre de motivation\n---\n\nTrois paragraphes.\n");
  write(join(dir, "skills/lettre/scripts/compter.sh"), "#!/bin/sh\nwc -w \"$1\"\n");
  write(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "job-board": { command: "${CLAUDE_PLUGIN_ROOT}/bin/serveur", args: ["--dossier", "${CLAUDE_PLUGIN_ROOT}/data"], env: { JOB_TOKEN: "${JOB_TOKEN}", REGION: "fr" } },
        notes: { type: "http", url: "https://notes.example/mcp", headers: { Authorization: "Bearer ${NOTES_TOKEN}" } },
      },
    }),
  );
  write(join(dir, "hooks/hooks.json"), "{}");
  write(join(dir, "agents/relecteur.md"), "---\nname: relecteur\n---\nTu relis.");
  opts.extra?.(dir);
}

const ctx = (over: Partial<Parameters<typeof inspectPackage>[1]> = {}) => ({
  source: "/x",
  subdir: null,
  commit: "abc",
  installedRoot: "/plugins/candidatures",
  commandsTaken: [],
  skillsTaken: [],
  mcpTaken: [],
  ...over,
});

test("plugins : adresses et sous-dossiers acceptés", () => {
  assert.deepEqual(checkSource("https://github.com/exemple/plugin/"), { kind: "git", value: "https://github.com/exemple/plugin" });
  assert.ok("error" in checkSource("http://github.com/exemple/plugin"));
  assert.ok("error" in checkSource("https://moi:secret@github.com/exemple/plugin"));
  assert.ok("error" in checkSource("git@github.com:exemple/plugin.git"));
  assert.ok("error" in checkSource("plugins/relatif"));
  assert.ok("error" in checkSource("/n/existe/pas"));
  assert.equal(checkSubdir(" plugins/mon-plugin/ "), "plugins/mon-plugin");
  assert.equal(checkSubdir(""), null);
  assert.ok(typeof checkSubdir("../ailleurs") === "object");
});

test("plugins : la relecture montre tout ce que le paquet apporte, et ce qui n'est pas repris", () => {
  const dir = join(base, "pkg-inspect");
  makePlugin(dir);
  const r = inspectPackage(dir, ctx({ commandsTaken: ["relance"], skillsTaken: ["lettre"] }));
  assert.equal(r.name, "candidatures");
  assert.equal(r.author, "Quelqu'un");
  assert.deepEqual(r.errors, []);
  // Une commande déjà prise (la tienne) ou réservée par Clark : renommée avec le nom du plugin.
  assert.deepEqual(
    r.commands.map((c) => [c.name, c.renamed]),
    [
      ["candidatures-relance", true],
      ["candidatures-start", true],
    ],
  );
  assert.match(r.commands[0].prompt, /Prépare une relance pour \$ARGUMENTS/);
  assert.equal(r.skills[0].hidden, true, "à nom égal, ton skill gagne");
  assert.deepEqual(r.skills[0].files, [{ path: "scripts/compter.sh", script: true }]);

  const [job, notes] = r.mcp;
  assert.equal(job.transport, "stdio");
  assert.equal(job.command, "/plugins/candidatures/bin/serveur");
  assert.deepEqual(job.args, ["--dossier", "/plugins/candidatures/data"]);
  assert.deepEqual(job.envVars, ["JOB_TOKEN", "REGION"]);
  assert.match(job.fixed[0], /REGION : valeur écrite en clair dans le plugin, ignorée/);
  assert.equal(job.trust, "ask", "chaque appel demandera l'accord");
  assert.equal(notes.transport, "http");
  assert.equal(notes.tokenVar, "NOTES_TOKEN");

  assert.deepEqual(
    r.ignored.map((i) => i.what),
    ["Crochets (hooks)", "Agents"],
  );
});

test("plugins : paquets refusés (pas de manifeste, catalogue, serveur en http, rien d'utilisable) ; liens symboliques ignorés", () => {
  const none = join(base, "pkg-none");
  write(join(none, "README.md"), "rien");
  assert.match(inspectPackage(none, ctx()).errors.join(" "), /plugin\.json absent/);

  const market = join(base, "pkg-market");
  write(join(market, ".claude-plugin/marketplace.json"), "{}");
  assert.match(inspectPackage(market, ctx()).errors.join(" "), /catalogue de plugins, mais il est vide/);

  const http = join(base, "pkg-http");
  makePlugin(http, { extra: (d) => write(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { x: { type: "http", url: "http://evil.example/mcp" } } })) });
  assert.match(inspectPackage(http, ctx()).errors.join(" "), /Serveur MCP « x » : .*https/);

  const empty = join(base, "pkg-empty");
  write(join(empty, ".claude-plugin/plugin.json"), JSON.stringify({ name: "vide" }));
  write(join(empty, "hooks/hooks.json"), "{}");
  assert.match(inspectPackage(empty, ctx()).errors.join(" "), /n'apporte ni commande/);

  const linked = join(base, "pkg-link");
  makePlugin(linked, { name: "lie" });
  symlinkSync("/etc/hosts", join(linked, "skills/lettre/hosts"));
  const r = inspectPackage(linked, ctx());
  assert.match(r.warnings.join(" "), /1 lien symbolique ignoré/);
  assert.ok(!r.skills[0].files.some((f) => f.path.includes("hosts")));
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();

test("plugins : relire, installer depuis git, utiliser, mettre à jour, couper, désinstaller", async () => {
  rmSync(process.env.CLARK_PLUGINS_DIR!, { recursive: true, force: true });
  const repo = join(base, "repo");
  makePlugin(join(repo, "plugins/candidatures"));
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "v1");
  const sha1 = git(repo, "rev-parse", "HEAD");

  saveCommand({ name: "relance", description: "la mienne", prompt: "Ma propre consigne de relance." });
  const store = new Store(":memory:");
  const plugins = new Plugins({ mcp: store.mcp, ownCommands: () => ownCommands().map((c) => c.name), otherSkills: () => listSkills().filter((s) => s.source !== "plugin").map((s) => s.name) });

  const wrong = await plugins.review(repo);
  assert.match(wrong.errors.join(" "), /plugin\.json absent/, "le dépôt n'est pas le plugin : il faut le sous-dossier");
  assert.throws(() => plugins.install(wrong.token), /plugin\.json absent/);
  const review = await plugins.review(repo, "plugins/candidatures");
  assert.equal(review.commit, sha1);
  assert.equal(readIndex().length, 0, "relire n'installe rien");
  assert.equal(store.mcp.list().length, 0);
  assert.equal(review.mcp[0].command, join(process.env.CLARK_PLUGINS_DIR!, "candidatures/bin/serveur"));

  const installed = plugins.install(review.token);
  assert.throws(() => plugins.install(review.token), /Relecture expirée/, "une relecture ne sert qu'une fois");
  assert.equal(installed.commit, sha1);
  const root = join(process.env.CLARK_PLUGINS_DIR!, "candidatures");
  assert.ok(existsSync(join(root, "commands/relance.md")));
  assert.ok(!existsSync(join(root, ".git")));
  assert.equal(expandCommand("/relance Studio Pixel")?.prompt, "Ma propre consigne de relance.\n\nStudio Pixel", "ta commande reste la tienne");
  assert.equal(expandCommand("/candidatures-relance Studio Pixel")?.prompt, "Prépare une relance pour Studio Pixel. Ne l'envoie pas.");
  assert.ok(listSkills().some((s) => s.name === "lettre" && s.plugin === "candidatures"));
  assert.deepEqual(
    store.mcp.list().map((m) => [m.name, m.plugin, m.trust, m.enabled]),
    [
      ["job-board", "candidatures", "ask", true],
      ["notes", "candidatures", "ask", true],
    ],
  );

  // Déjà installé : on passe par la mise à jour.
  assert.match((await plugins.review(repo, "plugins/candidatures")).errors.join(" "), /déjà installé/);

  // Nouvelle version : la relecture dit ce qui change.
  write(join(repo, "plugins/candidatures/commands/entretiens.md"), "---\ndescription: Mes entretiens\n---\n\nListe mes entretiens à venir.\n");
  write(join(repo, "plugins/candidatures/commands/relance.md"), "---\ndescription: Relance\n---\n\nPrépare une relance très courte pour $ARGUMENTS.\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "v2");
  const update = await plugins.checkUpdate("candidatures");
  assert.equal(update.update?.from, sha1);
  assert.deepEqual(update.update?.changes, [
    { path: "commands/entretiens.md", kind: "ajouté" },
    { path: "commands/relance.md", kind: "modifié" },
  ]);
  assert.deepEqual(update.errors, []);
  plugins.install(update.token);
  assert.equal(readIndex()[0].commit, git(repo, "rev-parse", "HEAD"));
  assert.ok(listCommands().some((c) => c.name === "entretiens" && c.plugin === "candidatures"));
  assert.equal(store.mcp.list().length, 2, "ses serveurs sont remplacés, pas doublés");

  plugins.setEnabled("candidatures", false);
  assert.ok(!listCommands().some((c) => c.plugin));
  assert.ok(!listSkills().some((s) => s.plugin));
  assert.ok(store.mcp.list().every((m) => !m.enabled));
  plugins.setEnabled("candidatures", true);

  assert.ok(plugins.uninstall("candidatures"));
  assert.equal(readIndex().length, 0);
  assert.ok(!existsSync(root));
  assert.equal(store.mcp.list().length, 0);
  assert.deepEqual(
    listCommands().map((c) => c.name),
    ["relance"],
  );
});

test("plugins Claude Code réels : catalogue listé, commandes avec !`…` et allowed-tools, $1/$2, fichiers en plus, .mcp.json sans enveloppe", async () => {
  // Un catalogue (marketplace.json) : ses plugins, à relire un par un.
  const market = join(base, "pkg-catalogue");
  write(
    join(market, ".claude-plugin/marketplace.json"),
    JSON.stringify({
      plugins: [
        { name: "commit-commands", description: "Commits", source: "./plugins/commit-commands" },
        { name: "externe", description: "Ailleurs", source: { source: "git-subdir", url: "https://github.com/ex/plugins.git", path: "plugins/x", ref: "v1.2.0" } },
        { name: "par-url", source: { source: "url", url: "https://github.com/ex/autre.git" } },
        { name: "xcode", source: { source: "command", command: "xcrun agent plugin path" } },
      ],
    }),
  );
  const cat = inspectPackage(market, ctx({ source: "https://github.com/anthropics/catalogue" }));
  assert.deepEqual(cat.errors, ["C'est un catalogue de 4 plugins, pas un plugin : choisis-en un dans la liste."]);
  assert.deepEqual(
    cat.catalog!.map((e) => [e.name, e.source, e.subdir, e.ref, e.supported]),
    [
      ["commit-commands", "https://github.com/anthropics/catalogue", "plugins/commit-commands", null, true],
      ["externe", "https://github.com/ex/plugins", "plugins/x", "v1.2.0", true],
      ["par-url", "https://github.com/ex/autre", null, null, true],
      ["xcode", "https://github.com/anthropics/catalogue", null, null, false],
    ],
  );

  // Un plugin comme ceux d'Anthropic : contexte shell, outils autorisés, code annexe, crochets.
  const real = join(base, "pkg-real");
  write(join(real, ".claude-plugin/plugin.json"), JSON.stringify({ name: "commits", version: "1.0.1" }));
  write(
    join(real, "commands/commit.md"),
    "---\nallowed-tools: Bash(git add:*), Bash(git commit:*)\ndescription: Create a git commit\n---\n\n- Current git status: !`git status`\n- Branch: !`git branch --show-current`\n\nCreate a commit for $1 with message $2.\n",
  );
  write(join(real, "core/rule_engine.py"), "print('x')\n");
  write(join(real, "examples/regle.md"), "exemple\n");
  write(join(real, "README.md"), "lisez-moi\n");
  write(join(real, "hooks/hooks.json"), "{}");
  write(join(real, ".mcp.json"), JSON.stringify({ github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } }));
  const r = inspectPackage(real, ctx());
  assert.deepEqual(r.commands[0].shell, ["git status", "git branch --show-current"]);
  assert.equal(r.commands[0].allowedTools, "Bash(git add:*), Bash(git commit:*)");
  assert.deepEqual(r.otherFiles, [
    { path: "core/rule_engine.py", script: true },
    { path: "examples/regle.md", script: false },
  ]);
  assert.match(r.warnings.join(" "), /crochets non repris/);
  assert.deepEqual([r.mcp[0].name, r.mcp[0].tokenVar], ["github", "GITHUB_TOKEN"], "serveurs sans l'enveloppe mcpServers");

  // Lancée par Clark : les mots remplacent $1, $2 ; les !`…` deviennent des choses à obtenir soi-même.
  const store = new Store(":memory:");
  rmSync(process.env.CLARK_PLUGINS_DIR!, { recursive: true, force: true });
  const plugins = new Plugins({ mcp: store.mcp, ownCommands: () => ownCommands().map((c) => c.name), otherSkills: () => [] });
  const review = await plugins.review(real);
  plugins.install(review.token);
  const run = expandCommand('/commit site-demo "Corrige le contraste"')!;
  assert.equal(run.command.plugin, "commits");
  assert.match(run.prompt, /Current git status: \(à obtenir toi-même avec la commande `git status`\)/);
  assert.match(run.prompt, /Create a commit for site-demo with message Corrige le contraste\./);
  assert.ok(!run.prompt.includes("!`"));
  plugins.uninstall("commits");
});
