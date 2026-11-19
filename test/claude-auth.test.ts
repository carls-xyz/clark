import assert from "node:assert/strict";
import { test } from "node:test";
import { checkClaudeAuth, CLAUDE_LOGIN_COMMAND, claudeEnv } from "../src/engines/claude-auth.ts";
import { paths } from "../src/config.ts";

/** Faux `claude auth status --json` : rend la sortie donnée, ou échoue. */
const fakeRun = (out: unknown, calls: unknown[][] = []) =>
  ((...args: unknown[]) => {
    calls.push(args);
    if (out instanceof Error) throw out;
    return JSON.stringify(out);
  }) as never;

test("accès Claude : avec une clé API, Claude Code n'est même pas interrogé", () => {
  const calls: unknown[][] = [];
  assert.deepEqual(checkClaudeAuth(true, fakeRun({}, calls)), { mode: "api", plan: null, problem: null });
  assert.equal(calls.length, 0);
});

test("accès Claude : abonnement connecté dans le dossier de Clark, sans lire aucun jeton", () => {
  const calls: unknown[][] = [];
  const a = checkClaudeAuth(false, fakeRun({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", accessToken: "SECRET" }, calls));
  assert.deepEqual(a, { mode: "subscription", plan: "Claude Max", problem: null });
  assert.ok(!JSON.stringify(a).includes("SECRET"), "aucun jeton ne ressort");
  const [cmd, args, opts] = calls[0] as [string, string[], { env: Record<string, string> }];
  assert.equal(cmd, "claude");
  assert.deepEqual(args, ["auth", "status", "--json"]);
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, paths.claudeHome, "le dossier Claude de Clark, pas ~/.claude");
});

test("accès Claude : pas connecté (Claude Code répond avec un code d'erreur) → la marche à suivre, pas « introuvable »", () => {
  const err = Object.assign(new Error("Command failed: claude auth status --json"), { stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) });
  assert.deepEqual(checkClaudeAuth(false, fakeRun(err)), { mode: "none", plan: null, problem: "not_logged_in" });
});

test("accès Claude : pas connecté, ou Claude Code absent → aucun accès, avec la marche à suivre", () => {
  assert.deepEqual(checkClaudeAuth(false, fakeRun({ loggedIn: false, authMethod: "none" })), { mode: "none", plan: null, problem: "not_logged_in" });
  const missing = checkClaudeAuth(false, fakeRun(new Error("spawn claude ENOENT")));
  assert.equal(missing.mode, "none");
  assert.match(missing.problem!, /Claude Code introuvable/);
  assert.match(CLAUDE_LOGIN_COMMAND, /CLAUDE_CONFIG_DIR=".*data\/claude-home" claude auth login/);
  assert.equal(claudeEnv().CLAUDE_CONFIG_DIR, paths.claudeHome);
});
