import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { pickPath } from "../src/core/attachments.ts";
import { platformInfo, takeRollbackNote } from "../src/core/platform.ts";
import { MacMessages } from "../src/imessage/backend.ts";

const root = mkdtempSync(join(tmpdir(), "clark-platform-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("hors Mac : iMessage et la fenêtre de choix sont absents, avec une raison claire", async () => {
  assert.deepEqual(platformInfo("darwin"), { mac: true, name: "macOS", missing: [] });
  assert.deepEqual(platformInfo("linux"), { mac: false, name: "Linux", missing: ["imessage", "filePicker", "keepAwake", "voice"] });

  let called = false;
  const run = (() => (called = true)) as any;
  await assert.rejects(pickPath("file", run, "linux"), /seulement quand Clark tourne sur un Mac/);
  assert.equal(called, false, "osascript n'est pas lancé");

  assert.deepEqual(new MacMessages("linux").status(), { access: false, problem: "not_mac" });
});

test("note de retour arrière : lue une fois, puis effacée", () => {
  const file = join(root, "rollback.txt");
  assert.equal(takeRollbackNote(file), null, "pas de note : rien");
  writeFileSync(file, "bbbbbbbbbb\nmain\naaaaaaaaaa\n");
  const note = takeRollbackNote(file)!;
  assert.match(note, /version de secours \(aaaaaaa\)/);
  assert.match(note, /nouvelle version \(bbbbbbb, branche main\)/);
  assert.match(note, /git switch main && scripts\/service\.sh restart/);
  assert.ok(!existsSync(file));
  assert.equal(takeRollbackNote(file), null);
});

/** Un port libre pour le faux Clark. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

test("service.sh : une version qui ne démarre pas → retour à la dernière qui marchait", { timeout: 60_000 }, async () => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  copyFileSync(resolve(import.meta.dirname, "../scripts/service.sh"), join(repo, "scripts/service.sh"));
  writeFileSync(join(repo, ".gitignore"), "data/\n");
  writeFileSync(join(repo, "version.txt"), "bonne\n");
  git("add", ".");
  git("commit", "-q", "-m", "bonne");
  const goodSha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "version.txt"), "cassée\n");
  git("commit", "-qam", "cassée");
  const badSha = git("rev-parse", "HEAD");
  mkdirSync(join(repo, "data"));
  writeFileSync(join(repo, "data/last-good-commit"), `${goodSha}\n`);

  // Faux service : « redémarre » un petit serveur de santé, seulement si la version est la bonne.
  const port = await freePort();
  const pidFile = join(root, "fake.pid");
  const fake = join(root, "fake-service.sh");
  writeFileSync(
    fake,
    `#!/bin/bash
[ -f "${pidFile}" ] && kill "$(cat "${pidFile}")" 2>/dev/null; rm -f "${pidFile}"
if grep -q bonne "${repo}/version.txt"; then
  "${process.execPath}" -e 'require("http").createServer((q,r)=>r.end("{}")).listen(${port},"127.0.0.1")' >/dev/null 2>&1 &
  echo $! > "${pidFile}"
fi
`,
  );
  chmodSync(fake, 0o755);
  after(() => {
    if (existsSync(pidFile)) spawnSync("kill", [readFileSync(pidFile, "utf8").trim()]);
  });

  const r = spawnSync("bash", [join(repo, "scripts/service.sh"), "restart"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLARK_SERVICE_FAKE: fake, CLARK_WEB_PORT: String(port), CLARK_HEALTH_WAIT: "3" },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Je reviens à la dernière version qui marchait/);
  assert.match(r.stdout, /Clark répond de nouveau/);
  assert.equal(git("rev-parse", "HEAD"), goodSha, "revenu à la bonne version");
  assert.equal(readFileSync(join(repo, "data/rollback.txt"), "utf8"), `${badSha}\nmain\n${goodSha}\n`);

  // Retour sur main corrigée : le redémarrage marche, la version est notée bonne.
  git("switch", "-q", "main");
  writeFileSync(join(repo, "version.txt"), "bonne encore\n");
  git("commit", "-qam", "corrigée");
  const fixed = git("rev-parse", "HEAD");
  const ok = spawnSync("bash", [join(repo, "scripts/service.sh"), "restart"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLARK_SERVICE_FAKE: fake, CLARK_WEB_PORT: String(port), CLARK_HEALTH_WAIT: "3" },
  });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(readFileSync(join(repo, "data/last-good-commit"), "utf8").trim(), fixed);

  // Une version cassée commitée, avec en plus des modifications non commitées : pas de retour automatique.
  writeFileSync(join(repo, "version.txt"), "cassée à nouveau\n");
  git("commit", "-qam", "cassée 2");
  const broken = git("rev-parse", "HEAD");
  writeFileSync(join(repo, ".gitignore"), "data/\nautre/\n");
  const dirty = spawnSync("bash", [join(repo, "scripts/service.sh"), "restart"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLARK_SERVICE_FAKE: fake, CLARK_WEB_PORT: String(port), CLARK_HEALTH_WAIT: "2" },
  });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /modifications non commitées/);
  assert.equal(git("rev-parse", "HEAD"), broken, "rien n'a bougé");
});
