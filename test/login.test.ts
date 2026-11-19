import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createLogins, type LoginEngine, type LoginState } from "../src/engines/login.ts";

/** Une fausse commande de connexion : un petit programme node qui imite la vraie. */
const fake = (script: string) => () => spawn(process.execPath, ["-e", script], { stdio: "pipe" });
const CLAUDE = `process.stdout.write("Opening browser…\\nIf the browser didn't open, visit: \\x1b[1mhttps://claude.com/cai/oauth/authorize?x=1\\x1b[0m\\nPaste code here if prompted > ");process.stdin.once("data",(d)=>{const c=String(d);if(c!=="abc-123\\n"){console.error("Invalid code");process.exit(1)}process.exit(0)});`;

function setup(script: string) {
  const done: LoginEngine[] = [];
  let changed = 0;
  const logins = createLogins({ onChange: () => void changed++, onDone: (e) => void done.push(e), spawn: fake(script) });
  return { logins, done, changes: () => changed };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const state = (l: ReturnType<typeof setup>["logins"], e: LoginEngine): LoginState | undefined => l.list().find((s) => s.engine === e);

test("connexion Claude : lien repéré (sans codes couleur), code transmis tel quel, connexion faite", async () => {
  const { logins, done } = setup(CLAUDE);
  logins.start("claude");
  await until(() => Boolean(state(logins, "claude")?.asksCode));
  assert.equal(state(logins, "claude")?.url, "https://claude.com/cai/oauth/authorize?x=1");
  assert.deepEqual(logins.sendCode("claude", "  abc-123  "), { ok: true });
  assert.equal(state(logins, "claude")?.codeSent, true);
  await until(() => state(logins, "claude")?.status === "done");
  assert.deepEqual(done, ["claude"]);
});

test("connexion Claude : code refusé → échec avec la raison donnée par la commande", async () => {
  const { logins, done } = setup(CLAUDE);
  logins.start("claude");
  await until(() => Boolean(state(logins, "claude")?.asksCode));
  logins.sendCode("claude", "mauvais");
  await until(() => state(logins, "claude")?.status === "failed");
  assert.equal(state(logins, "claude")?.error, "Invalid code");
  assert.deepEqual(done, []);
});

test("connexion : un code sur plusieurs lignes ou sans connexion en cours est refusé", async () => {
  const { logins } = setup(CLAUDE);
  assert.ok("error" in logins.sendCode("claude", "abc"));
  logins.start("claude");
  assert.ok("error" in logins.sendCode("claude", "abc\nrm -rf"));
  assert.ok("error" in logins.sendCode("claude", "   "));
  logins.cancel("claude");
  assert.equal(state(logins, "claude"), undefined);
});

test("connexion : seuls les liens d'Anthropic et d'OpenAI sont montrés", async () => {
  const { logins } = setup(`console.log("visit: https://evil.example.com/login");setTimeout(()=>{},2000)`);
  logins.start("codex");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state(logins, "codex")?.url, null);
  logins.close();
});

test("connexion : commande introuvable → message clair", async () => {
  const done: LoginEngine[] = [];
  const logins = createLogins({ onChange: () => {}, onDone: (e) => void done.push(e), spawn: () => spawn("commande-qui-n-existe-pas-clark", [], { stdio: "pipe" }) });
  logins.start("codex");
  await until(() => state(logins, "codex")?.status === "failed");
  assert.match(state(logins, "codex")!.error!, /Codex n'est pas installé/);
});

test("connexion : relancer remplace la tentative d'avant (l'ancienne ne compte plus)", async () => {
  const { logins, done } = setup(`setTimeout(()=>process.exit(0),400)`);
  logins.start("codex");
  logins.start("codex");
  await until(() => state(logins, "codex")?.status === "done");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(done, ["codex"]);
});
