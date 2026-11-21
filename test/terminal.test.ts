import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { requestResult, resolveCwd, shellEnv, stripAnsi, Terminal, TerminalRequests, type TerminalRun } from "../src/terminal/terminal.ts";

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 30));
  }
};

const done = (t: Terminal, id: number) => until(() => t.get(id)?.status !== "running");

test("terminal : une commande tourne, sa sortie et son code reviennent, « cd » est suivi", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clark-term-")));
  const t = new Terminal({ cwd: dir });
  const a = t.run("echo bonjour; printf '\\033[31mrouge\\033[0m'", { by: "charles" }) as TerminalRun;
  await done(t, a.id);
  assert.equal(a.status, "done");
  assert.equal(a.exitCode, 0);
  assert.equal(a.output, "bonjour\nrouge", "couleurs retirées, marque du dossier cachée");
  const b = t.run("mkdir sous && cd sous", { by: "charles" }) as TerminalRun;
  await done(t, b.id);
  assert.equal(t.cwd, join(dir, "sous"), "le dossier de Charles suit son cd");
  const c = t.run("cd / && exit 3", { by: "clark", cwd: dir }) as TerminalRun;
  await done(t, c.id);
  assert.equal(c.status, "failed");
  assert.equal(c.exitCode, 3);
  assert.equal(t.cwd, join(dir, "sous"), "une commande de Clark ne déplace pas Charles");
});

test("terminal : une seule commande à la fois, et « Arrêter » coupe tout ce qu'elle a lancé", async () => {
  const t = new Terminal({ cwd: tmpdir() });
  const a = t.run("sleep 30", { by: "charles" }) as TerminalRun;
  assert.match(String(t.run("echo deux", { by: "charles" })), /tourne déjà/);
  assert.ok(t.stop(a.id));
  await done(t, a.id);
  assert.equal(a.status, "stopped");
  assert.match(a.output, /arrêtée/);
});

test("terminal : le shell ne reçoit pas les secrets de Clark, et les dossiers sont vérifiés", () => {
  process.env.GOOGLE_CLIENT_SECRET = "secret-de-test";
  const env = shellEnv();
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(Object.keys(env).some((k) => /TOKEN|SECRET|KEY/.test(k)), false);
  assert.equal(resolveCwd("/dossier/qui/nexiste/pas", tmpdir()), null);
  assert.equal(resolveCwd("", "/tmp"), "/tmp");
  assert.equal(stripAnsi("a\u001b[1;32mb\u001b[0m\rc"), "abc");
});

test("terminal : une commande proposée par Clark attend le clic, tourne, puis Clark lit le résultat", async () => {
  const db = new DatabaseSync(":memory:");
  const requests = new TerminalRequests(db);
  const t = new Terminal({ cwd: tmpdir() });
  const id = requests.add(12, "echo prêt && exit 1", tmpdir(), "vérifier");
  const waiting = requests.wait(id, { pollMs: 20 });
  // Le clic « Lancer » (ce que fait la route de l'interface) :
  assert.ok(requests.move(id, "pending", "running"));
  assert.equal(requests.move(id, "pending", "running"), false, "deux clics : un seul lance");
  t.run("echo prêt && exit 1", { by: "clark", cwd: tmpdir(), taskId: 12, onEnd: (run) => requests.finish(id, run.status === "done" ? "done" : "failed", run.exitCode, run.output) });
  const r = await waiting;
  const said = requestResult(r);
  assert.match(said, /Code de sortie : 1 \(échec\)/);
  assert.match(said, /prêt/);
  // Refus, puis expiration sans réponse.
  const no = requests.add(12, "rm -rf build", tmpdir());
  requests.move(no, "pending", "refused");
  assert.match(requestResult(await requests.wait(no, { pollMs: 10 })), /refusé/);
  const late = requests.add(12, "npm test", tmpdir());
  assert.match(requestResult(await requests.wait(late, { decisionMs: 30, pollMs: 10 })), /n'a pas tourné/);
  // Après un redémarrage, rien ne reste en attente.
  requests.add(12, "ls", tmpdir());
  requests.expireStale();
  assert.equal(requests.pending().length, 0);
});

test("terminal : Clark ne propose pas de commande quand Charles écrit depuis Telegram (personne pour cliquer)", async () => {
  const { Store } = await import("../src/memory/store.ts");
  const { TaskJournal } = await import("../src/tasks/journal.ts");
  const { memoryTools } = await import("../src/memory/tools.ts");
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const fromPhone = journal.create(1, "chat", "lance les tests");
  journal.setSource(fromPhone, "telegram");
  let current = fromPhone;
  const t = memoryTools(store, { taskId: () => current, writeRefusal: () => null });
  const said = await t.run_command.run({ command: "npm test", cwd: tmpdir(), reason: "vérifier" });
  assert.match(said, /Pas proposée/);
  assert.equal(store.terminal.pending().length, 0, "rien n'attend un clic impossible");
  // Depuis l'interface du Mac : la demande part (et attend le clic).
  const fromMac = journal.create(1, "chat", "lance les tests");
  journal.setSource(fromMac, "web");
  current = fromMac;
  void t.run_command.run({ command: "npm test", cwd: tmpdir(), reason: "vérifier" });
  await until(() => store.terminal.pending().length === 1);
  store.terminal.expireStale();
});
