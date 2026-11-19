import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { probeMcp } from "../src/mcp/probe.ts";
import { claudeMcpConfig, codexMcpConfig, serverEnv, validateMcp } from "../src/mcp/servers.ts";
import { Store } from "../src/memory/store.ts";
import { classify, effectOf, setReadOnlyMcp, summarize } from "../src/policy/permissions.ts";

const fixture = resolve(import.meta.dirname, "fixtures/mcp-ping.ts");

test("serveur MCP : validation avant enregistrement", () => {
  const ok = { name: "notion", transport: "stdio" as const, command: "npx", args: ["-y", "pkg"] };
  assert.equal(validateMcp(ok), null);
  assert.equal(validateMcp({ ...ok, name: "Notion!" })?.field, "name");
  assert.match(validateMcp({ ...ok, name: "memory" })!.error, /réservé/);
  assert.match(validateMcp(ok, ["notion"])!.error, /déjà/);
  assert.equal(validateMcp({ ...ok, command: "npx\nrm -rf ~" })?.field, "command");
  assert.equal(validateMcp({ ...ok, envVars: ["notion_token"] })?.field, "envVars", "noms de variables seulement");
  assert.equal(validateMcp({ name: "web", transport: "http", url: "http://exemple.com/mcp" })?.field, "url", "https obligatoire hors de ce Mac");
  assert.equal(validateMcp({ name: "web", transport: "http", url: "http://localhost:3000/mcp" }), null);
  assert.match(validateMcp({ name: "web", transport: "http", url: "https://user:mdp@exemple.com" })!.error, /identifiants/);
});

test("serveur MCP : aucun secret en base ni dans la config Codex, seulement les variables déclarées au serveur", () => {
  process.env.FIXTURE_SECRET = "valeur-secrete";
  process.env.OTHER_SECRET = "autre";
  const s = new Store(":memory:");
  const add = s.mcp.add({ name: "ping", transport: "stdio", command: "node", args: [" a ", "", "b"], envVars: ["FIXTURE_SECRET"] });
  assert.ok(add.ok);
  const server = s.mcp.list()[0];
  assert.deepEqual(server.args, ["a", "b"], "arguments vides retirés");
  assert.ok(!JSON.stringify(s.db.prepare("SELECT * FROM mcp_servers").all()).includes("valeur-secrete"));

  const env = serverEnv(server);
  assert.equal(env.FIXTURE_SECRET, "valeur-secrete");
  assert.equal(env.OTHER_SECRET, undefined, "les autres secrets de Clark ne sont pas transmis");

  const codex = codexMcpConfig([server]);
  assert.deepEqual(codex["mcp_servers.ping.env_vars"], ["FIXTURE_SECRET"]);
  assert.equal(codex["mcp_servers.ping.default_tools_approval_mode"], "prompt", "par défaut : accord à chaque appel");
  assert.ok(!JSON.stringify(codex).includes("valeur-secrete"), "Codex lit la valeur lui-même, par son nom");
  assert.equal(claudeMcpConfig([server]).ping.command, "node");

  s.mcp.setTrust(server.id, "read");
  assert.equal(codexMcpConfig(s.mcp.list())["mcp_servers.ping.default_tools_approval_mode"], "approve");
  s.mcp.setEnabled(server.id, false);
  assert.equal(s.mcp.enabled().length, 0);
});

test("serveur MCP : « Tester » lance le serveur et liste ses outils", async () => {
  process.env.FIXTURE_SECRET = "valeur-secrete";
  const s = new Store(":memory:");
  s.mcp.add({ name: "ping", transport: "stdio", command: process.execPath, args: [fixture], envVars: ["FIXTURE_SECRET"] });
  const check = await probeMcp(s.mcp.list()[0], 20_000);
  assert.equal(check.error, null);
  assert.deepEqual(check.tools.map((t) => t.name), ["ping"]);
  assert.match(check.tools[0].description, /secret vu : oui, autre : non/, "le serveur reçoit sa variable, pas les autres");

  s.mcp.add({ name: "absent", transport: "stdio", command: "commande-qui-n-existe-pas" });
  const bad = await probeMcp(s.mcp.list()[1], 10_000);
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test("permissions : outils MCP ajoutés soumis à accord, sauf serveur déclaré en lecture seule", () => {
  setReadOnlyMcp([]);
  assert.equal(effectOf("mcp__notion__search"), "write");
  assert.equal(classify("mcp__notion__search", {}, []), "ask");
  setReadOnlyMcp(["notion"]);
  assert.equal(effectOf("mcp__notion__search"), "read");
  assert.equal(classify("mcp__notion__search", {}, []), "auto");
  assert.equal(effectOf("mcp__drive__upload"), "write", "seul le serveur déclaré");
  setReadOnlyMcp([]);
  assert.match(summarize("mcp__notion__create_page", { title: "Relances" }), /^Outil « create_page » du serveur MCP notion :\n\{\n {2}"title": "Relances"/);
});
