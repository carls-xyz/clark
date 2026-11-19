import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/memory/store.ts";
import { createPolicy } from "../src/policy/permissions.ts";
import { planRecovery, resumePrompt, TaskJournal } from "../src/tasks/journal.ts";

const ROOTS = ["/tmp/clark-ws"];

function setup(path = ":memory:") {
  const store = new Store(path);
  const journal = new TaskJournal(store.db);
  return { store, journal };
}

/** Appelle la policy comme le ferait le SDK. */
function callPolicy(policy: ReturnType<typeof createPolicy>, tool: string, input: Record<string, unknown>, id: string) {
  return policy(tool, input, { signal: new AbortController().signal, toolUseID: id } as Parameters<typeof policy>[2]);
}

test("une tâche jamais commencée est relancée normalement", () => {
  const { journal } = setup();
  const id = journal.create(1, "chat", "Fais le point sur mes candidatures");
  const plan = planRecovery(journal.get(id)!, journal.steps(id));
  assert.equal(plan.action, "restart");
});

test("coupée pendant des lectures : reprise automatique au dernier résultat", () => {
  const { journal } = setup();
  const id = journal.create(1, "chat", "Lis mes 3 notes");
  journal.setStatus(id, "running");
  journal.setSession(id, "sess-1");
  journal.announceStep({ taskId: id, toolUseId: "t1", tool: "Read", input: { file_path: "/tmp/clark-ws/note1.md" }, tier: "workspace" });
  journal.completeStep("t1", "Candidature Ubisoft, relance prévue le 20/11", false);
  journal.announceStep({ taskId: id, toolUseId: "t2", tool: "Read", input: { file_path: "/tmp/clark-ws/note2.md" }, tier: "workspace" });
  // coupure ici : t2 sans résultat

  const plan = planRecovery(journal.get(id)!, journal.steps(id));
  assert.equal(plan.action, "resume");
  assert.equal(plan.action === "resume" && plan.done.length, 1);
  const prompt = resumePrompt(journal.get(id)!, plan.action === "resume" ? plan.done : []);
  assert.match(prompt, /note1\.md/);
  assert.doesNotMatch(prompt, /note2\.md/);
});

test("coupée après validation d'une action à effet : vérification demandée, pas de rejeu", async () => {
  const { store, journal } = setup();
  const id = journal.create(1, "chat", "Supprime les brouillons");
  journal.setStatus(id, "running");
  journal.setSession(id, "sess-2");
  const policy = createPolicy({ store, journal, taskId: id, roots: ROOTS, approve: async () => true });

  // Le SDK annonce l'outil, puis demande la permission : l'ordre ne doit rien changer.
  journal.announceStep({ taskId: id, toolUseId: "b1", tool: "Bash", input: { command: "rm -r drafts" }, tier: "ask" });
  const decision = await callPolicy(policy, "Bash", { command: "rm -r drafts" }, "b1");
  assert.equal(decision?.behavior, "allow");
  // coupure avant le résultat

  const plan = planRecovery(journal.get(id)!, journal.steps(id));
  assert.equal(plan.action, "check");
  assert.equal(plan.action === "check" && plan.uncertain[0].tool, "Bash");
  const prompt = resumePrompt(journal.get(id)!, [], plan.action === "check" ? plan.uncertain : []);
  assert.match(prompt, /rm -r drafts/);
  assert.match(prompt, /Vérifie d'abord leur effet/);
  assert.match(prompt, /redemande-la/);
});

test("validation restée sans réponse : expirée, puis reprise (elle sera redemandée)", async () => {
  const { store, journal } = setup();
  const id = journal.create(1, "chat", "Lance le script");
  journal.setStatus(id, "running");
  journal.setSession(id, "sess-3");
  let release!: (ok: boolean) => void;
  const policy = createPolicy({ store, journal, taskId: id, roots: ROOTS, approve: () => new Promise((r) => (release = r)) });

  const waiting = callPolicy(policy, "Bash", { command: "./script.sh" }, "b2");
  // L'annonce arrive pendant l'attente : elle ne doit pas écraser « awaiting_approval ».
  journal.announceStep({ taskId: id, toolUseId: "b2", tool: "Bash", input: { command: "./script.sh" }, tier: "ask" });
  assert.equal(journal.steps(id)[0].status, "awaiting_approval");

  // coupure pendant l'attente
  assert.equal(journal.expireApprovals(id), 1);
  const plan = planRecovery(journal.get(id)!, journal.steps(id));
  assert.equal(plan.action, "resume");
  release(false);
  await waiting;
});

test("une action refusée ou terminée n'est jamais considérée comme incertaine", async () => {
  const { store, journal } = setup();
  const id = journal.create(1, "chat", "x");
  journal.setStatus(id, "running");
  journal.setSession(id, "sess-4");
  const deny = createPolicy({ store, journal, taskId: id, roots: ROOTS, approve: async () => false });
  await callPolicy(deny, "Bash", { command: "ls" }, "d1");
  journal.announceStep({ taskId: id, toolUseId: "d1", tool: "Bash", input: {}, tier: "ask" });
  assert.equal(journal.steps(id)[0].status, "denied");

  const allow = createPolicy({ store, journal, taskId: id, roots: ROOTS, approve: async () => true });
  await callPolicy(allow, "Bash", { command: "ls" }, "d2");
  journal.completeStep("d2", "a b c", false);
  assert.equal(planRecovery(journal.get(id)!, journal.steps(id)).action, "resume");
});

test("une écriture coupée sans session enregistrée part en vérification", () => {
  const { journal } = setup();
  const id = journal.create(1, "chat", "x");
  journal.setStatus(id, "running");
  journal.announceStep({ taskId: id, toolUseId: "w1", tool: "Write", input: { file_path: "/tmp/a.md" }, tier: "workspace" });
  assert.equal(planRecovery(journal.get(id)!, journal.steps(id)).action, "check");
});

test("des lectures coupées sans session enregistrée : on recommence, sans risque", () => {
  const { journal } = setup();
  const id = journal.create(1, "chat", "x");
  journal.setStatus(id, "running");
  journal.announceStep({ taskId: id, toolUseId: "r1", tool: "Read", input: {}, tier: "workspace" });
  assert.equal(planRecovery(journal.get(id)!, journal.steps(id)).action, "restart");
});

test("coupure réelle du processus : le journal survit sur disque", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-"));
  const db = join(dir, "clark.db");
  try {
    const a = setup(db);
    const done = a.journal.create(1, "chat", "Bonjour");
    a.journal.finish(done, "done", "Salut", 0.01);
    const cut = a.journal.create(1, "chat", "Fais le point sur mes candidatures");
    a.journal.setStatus(cut, "running");
    a.journal.setSession(cut, "sess-5");
    a.journal.announceStep({ taskId: cut, toolUseId: "n1", tool: "Read", input: { file_path: "/tmp/clark-ws/n1.md" }, tier: "workspace" });
    a.journal.completeStep("n1", "note 1", false);
    const waiting = a.journal.create(1, "chat", "Et ensuite ?");
    a.store.db.close(); // le processus meurt

    const b = setup(db);
    const open = b.journal.unfinished();
    assert.deepEqual(open.map((t) => t.id), [cut, waiting]);
    assert.equal(planRecovery(open[0], b.journal.steps(cut)).action, "resume");
    assert.equal(planRecovery(open[1], b.journal.steps(waiting)).action, "restart");
    b.store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("un statut terminal n'est jamais écrasé par une annonce tardive", () => {
  const { journal } = setup();
  const id = journal.create(1, "chat", "x");
  journal.recordStep({ taskId: id, toolUseId: "z", tool: "Bash", input: {}, tier: "ask", status: "running" });
  journal.completeStep("z", "ok", false);
  journal.recordStep({ taskId: id, toolUseId: "z", tool: "Bash", input: {}, tier: "ask", status: "running" });
  assert.equal(journal.steps(id)[0].status, "done");
});
