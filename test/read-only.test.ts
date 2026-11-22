import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { TEAM_LABEL } from "../src/core/team.ts";
import type { Transport } from "../src/engines/codex-app-server.ts";
import { createCodexEngine } from "../src/engines/codex.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { createPolicy } from "../src/policy/permissions.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = {
  telegram: null,
  hasApiKey: true,
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

function base() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  return { store, journal, conversation };
}

// ── Les droits sont attribués par rôle ───────────────────────────────────

test("équipe : le Chercheur et le Relecteur tournent en lecture seule, le Rédacteur peut écrire", async () => {
  const access: Record<string, string | undefined> = {};
  const execute: typeof executeTask = async (deps, taskId, run) => {
    if (deps.journal.get(taskId)!.label === "plan") {
      // Clark choisit l'équipe habituelle pour un écrit.
      deps.journal.finish(taskId, "done", '{"standard": true}', 0);
      return { text: '{"standard": true}', costUsd: 0, status: "done" };
    }
    const t = deps.journal.get(taskId)!;
    access[t.label] = run.access;
    const text = t.label.startsWith("relecteur") ? "VERDICT : OK" : "…";
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  };
  const { store, journal, conversation } = base();
  await createHub({ config, store, journal, conversation }, { execute }).enqueue(OWNER_CHAT, "x", TEAM_LABEL, "web");
  assert.deepEqual(access, { chercheur: "read", "redacteur:1": "write", "relecteur:1": "read" });
});

// ── Moteur Claude : la politique refuse, sans rien demander ──────────────

test("moteur Claude : en lecture seule, écriture, shell et mémoire sont refusés sans rien demander", async () => {
  const { store, journal } = base();
  const id = journal.create(OWNER_CHAT, "chercheur", "x");
  const policy = createPolicy({
    store,
    journal,
    taskId: id,
    roots: ["/ws"],
    access: "read",
    approve: async () => assert.fail("aucune validation ne doit être demandée"),
  });
  const ctx = (n: string) => ({ signal: new AbortController().signal, toolUseID: n }) as Parameters<typeof policy>[2];
  for (const [i, [tool, input]] of (
    [
      ["Write", { file_path: "/ws/a.md", content: "x" }],
      ["Edit", { file_path: "/ws/a.md" }],
      ["Bash", { command: "ls" }],
      ["mcp__memory__propose_memory", { content: "x" }],
    ] as const
  ).entries()) {
    const d = await policy(tool, input as Record<string, unknown>, ctx(`w${i}`));
    assert.equal(d?.behavior, "deny", tool);
  }
  assert.equal((await policy("Read", { file_path: "/ws/a.md" }, ctx("r")))?.behavior, "allow");
  assert.equal((await policy("mcp__memory__recall", { query: "x" }, ctx("m")))?.behavior, "allow");
  assert.ok(journal.steps(id).filter((s) => s.tool !== "Read" && !s.tool.endsWith("recall")).every((s) => s.status === "denied"));
});

// ── Moteur Codex : bac à sable en lecture seule, élargissements refusés ──

test("moteur Codex : en lecture seule, bac à sable read-only et demandes d'écriture refusées sans rien demander", async () => {
  const sent: any[] = [];
  let toClark: (l: string) => void = () => {};
  const T = "t1";
  const transport: Transport = {
    write(line) {
      const m = JSON.parse(line);
      sent.push(m);
      const reply = (result: unknown) => queueMicrotask(() => toClark(JSON.stringify({ id: m.id, result })));
      const send = (x: unknown) => queueMicrotask(() => toClark(JSON.stringify(x)));
      if (m.method === "initialize") reply({});
      else if (m.method === "account/read") reply({ account: { type: "chatgpt", planType: "plus" } });
      else if (m.method === "thread/start") reply({ thread: { id: T } });
      else if (m.method === "turn/start") {
        reply({ turn: { id: "u" } });
        send({ method: "item/started", params: { threadId: T, item: { type: "fileChange", id: "p1", changes: [{ path: "/ws/a.md" }], status: "inProgress" } } });
        send({ id: 0, method: "item/fileChange/requestApproval", params: { threadId: T, itemId: "p1" } });
        send({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: T, itemId: "c1", command: "/bin/zsh -lc 'touch b'" } });
      } else if (m.id === 1 && m.result) {
        send({ method: "turn/completed", params: { threadId: T, turn: { status: "completed" } } });
      }
    },
    onLine: (fn) => (toClark = fn),
    onExit: () => {},
    close: () => {},
  };
  const { store, journal } = base();
  const engine = createCodexEngine({ transport: () => transport });
  const id = journal.create(OWNER_CHAT, "chercheur", "x");
  await engine.execute({ config, store, journal }, id, {
    prompt: "x",
    resume: undefined,
    mode: "new",
    access: "read",
    approve: async () => assert.fail("aucune validation ne doit être demandée"),
  });

  assert.equal(sent.find((m) => m.method === "thread/start").params.permissions, "clark-read");
  assert.equal(sent.find((m) => m.method === "turn/start").params.permissions, "clark-read", "profil lecture seule à chaque tour");
  assert.equal(sent.find((m) => m.method === "turn/start").params.sandboxPolicy, undefined, "pas d'ancien bac à sable qui rouvrirait les lectures");
  assert.equal(sent.find((m) => m.id === 0 && m.result).result.decision, "decline");
  assert.equal(sent.find((m) => m.id === 1 && m.result).result.decision, "decline");
  assert.equal(journal.get(id)!.access, "read");
});

// ── Mémoire : refus côté outil, quel que soit le moteur ──────────────────

test("mémoire : en lecture seule, proposer, corriger et oublier sont refusés ; chercher reste possible", async () => {
  const { store } = base();
  const keep = store.remember({ kind: "fact", content: "Le Mac a 8 Go de RAM" });
  const t = memoryTools(store, { taskId: () => undefined, writeRefusal: () => "Refusé : cet agent est en lecture seule." });
  assert.throws(() => t.propose_memory.run({ kind: "fact", content: "Charles a un chat", source: "x" }), /lecture seule/);
  assert.throws(() => t.propose_correction.run({ id: keep, content: "16 Go", source: "x" }), /lecture seule/);
  assert.throws(() => t.forget.run({ id: keep }), /lecture seule/);
  assert.match(await t.recall.run({ query: "RAM" }), /8 Go/);
  assert.equal(store.proposals().length, 0);
});

// ── Reprise en deux temps, aussi pour une tâche seule ────────────────────

test("reprise d'une tâche à vérifier : lecture seule d'abord, tâche toujours ouverte entre les deux, puis écriture", async () => {
  const calls: { access?: string; keepOpen?: boolean; statusBefore: string; prompt: string }[] = [];
  const execute: typeof executeTask = async (deps, taskId, run) => {
    calls.push({ access: run.access, keepOpen: run.keepOpen, statusBefore: deps.journal.get(taskId)!.status, prompt: run.prompt });
    deps.journal.setStatus(taskId, "running");
    const text = run.access === "read" ? "#1 : PAS FAIT — fichier absent" : "Fichier écrit.";
    if (!run.keepOpen) deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  };
  const { store, journal, conversation } = base();
  const hub = createHub({ config, store, journal, conversation }, { execute });
  const id = journal.create(OWNER_CHAT, "chat", "Écris relances.md");
  journal.setStatus(id, "running");
  journal.setSession(id, "s");
  journal.announceStep({ taskId: id, toolUseId: "w", tool: "Write", input: { file_path: "/ws/relances.md" }, tier: "workspace" });
  await hub.recover();
  assert.equal(journal.get(id)!.status, "needs_check");

  hub.resolveCheck(id, "resume");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    calls.map((c) => [c.access, c.keepOpen ?? false]),
    [
      ["read", true],
      [undefined, false],
    ],
  );
  assert.equal(calls[1].statusBefore, "running", "entre les deux temps, la tâche n'est jamais close");
  assert.match(calls[1].prompt, /PAS FAIT \(fichier absent\)/, "le constat est transmis à la reprise");
  assert.equal(journal.steps(id)[0].status, "verified");
  assert.equal(journal.get(id)!.status, "done");
});

// ── Constat non concluant : on n'écrit pas ───────────────────────────────

import { parseVerification } from "../src/tasks/journal.ts";
import { Bindings, boundTask } from "../src/engines/bindings.ts";

/** Tâche coupée en pleine écriture, reprise avec un faux moteur dont la vérification répond `report`. */
async function resumeWith(report: string, writes = 1) {
  const calls: { access?: string }[] = [];
  const execute: typeof executeTask = async (deps, taskId, run) => {
    calls.push({ access: run.access });
    deps.journal.setStatus(taskId, "running");
    const text = run.access === "read" ? report : "Écrit.";
    if (!run.keepOpen) deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  };
  const { store, journal, conversation } = base();
  const hub = createHub({ config, store, journal, conversation }, { execute });
  const id = journal.create(OWNER_CHAT, "chat", "Écris relances.md");
  journal.setStatus(id, "running");
  journal.setSession(id, "s");
  for (let i = 0; i < writes; i++) {
    journal.announceStep({ taskId: id, toolUseId: `w${i}`, tool: "Write", input: { file_path: `/ws/f${i}.md` }, tier: "workspace" });
  }
  await hub.recover();
  hub.resolveCheck(id, "resume");
  await new Promise((r) => setTimeout(r, 20));
  return { calls, journal, id, conversation };
}

test("constat « je ne peux pas déterminer » : pas de droit d'écrire, la tâche reste À vérifier", async () => {
  const { calls, journal, id } = await resumeWith("Je ne peux pas déterminer si le fichier a été écrit.");
  assert.deepEqual(calls.map((c) => c.access), ["read"], "aucune phase d'écriture");
  assert.equal(journal.get(id)!.status, "needs_check");
  assert.equal(journal.steps(id)[0].status, "running", "l'écriture reste incertaine");
  assert.match(journal.get(id)!.result!, /Vérification non concluante/);
  assert.match(journal.get(id)!.result!, /Je ne peux pas déterminer/, "le constat brut est montré à l'utilisateur");
});

test("constat INDÉTERMINÉ, ligne manquante ou contradictoire : rien n'est tranché pour ces écritures", async () => {
  const indet = await resumeWith("#1 : INDÉTERMINÉ — accès refusé au dossier");
  assert.equal(indet.journal.get(indet.id)!.status, "needs_check");

  // Deux écritures, un seul constat : la seconde reste incertaine, la première est notée.
  const partial = await resumeWith("#1 : FAIT — f0.md présent", 2);
  assert.deepEqual(partial.calls.map((c) => c.access), ["read"]);
  assert.deepEqual(partial.journal.steps(partial.id).map((s) => s.status), ["verified", "running"]);
  assert.equal(partial.journal.get(partial.id)!.status, "needs_check");
});

test("lecture du constat : seuls FAIT, PAS FAIT et PARTIEL tranchent", () => {
  assert.deepEqual(
    parseVerification("#1 : FAIT — ok\n#2 : pas fait\n#3 - PARTIEL : moitié\n#4 : INDETERMINE", 5).map((f) => f.state),
    ["fait", "pas fait", "partiel", "indéterminé", "indéterminé"],
  );
  assert.equal(parseVerification("#1 : FAIT\n#1 : PAS FAIT", 1)[0].state, "indéterminé", "contradiction");
  assert.equal(parseVerification("Le fichier semble FAIT.", 1)[0].state, "indéterminé", "phrase libre");
});

// ── Liaison des appels mémoire de Codex à leur tâche ─────────────────────

test("serveur de mémoire : écriture refusée sans tâche liée, permise seulement pendant le tour d'une tâche en écriture", () => {
  const { store, journal } = base();
  const bindings = new Bindings(store.db);
  const key = bindings.forThread(null);
  bindings.attach(key, "fil-1");
  assert.equal(bindings.forThread("fil-1"), key, "même fil, même clé (reprise)");

  const id = journal.create(OWNER_CHAT, "redacteur:1", "x");
  journal.setStatus(id, "running");
  journal.setAccess(id, "write");

  assert.equal(boundTask(store.db, undefined), null, "pas de clé");
  assert.equal(boundTask(store.db, "clé-inconnue"), null, "clé inconnue");
  assert.equal(boundTask(store.db, key), null, "hors d'un tour");

  bindings.setTask(key, id);
  assert.equal(boundTask(store.db, key)?.id, id);

  journal.finish(id, "done", "x", 0);
  assert.equal(boundTask(store.db, key), null, "tâche terminée");
});

test("moteur Codex : chaque fil reçoit sa clé, liée à la tâche pendant le tour puis déliée", async () => {
  const sent: any[] = [];
  let toClark: (l: string) => void = () => {};
  let duringTurn: unknown = "non vu";
  const { store, journal } = base();
  const transport: Transport = {
    write(line) {
      const m = JSON.parse(line);
      sent.push(m);
      const reply = (result: unknown) => queueMicrotask(() => toClark(JSON.stringify({ id: m.id, result })));
      if (m.method === "initialize") reply({});
      else if (m.method === "account/read") reply({ account: { type: "chatgpt", planType: "plus" } });
      else if (m.method === "thread/start") reply({ thread: { id: "fil-9" } });
      else if (m.method === "turn/start") {
        const key = sent.find((x) => x.method === "thread/start").params.config["mcp_servers.memory.env.CLARK_BINDING"];
        duringTurn = boundTask(store.db, key)?.id;
        reply({ turn: { id: "u" } });
        queueMicrotask(() => toClark(JSON.stringify({ method: "turn/completed", params: { threadId: "fil-9", turn: { status: "completed" } } })));
      }
    },
    onLine: (fn) => (toClark = fn),
    onExit: () => {},
    close: () => {},
  };
  const engine = createCodexEngine({ transport: () => transport });
  const id = journal.create(OWNER_CHAT, "chat", "x");
  await engine.execute({ config, store, journal }, id, { prompt: "x", resume: undefined, mode: "new", approve: async () => true });

  const key = sent.find((m) => m.method === "thread/start").params.config["mcp_servers.memory.env.CLARK_BINDING"];
  assert.match(key, /^[0-9a-f-]{36}$/);
  assert.equal(duringTurn, id, "pendant le tour, la clé mène à la tâche");
  assert.equal(new Bindings(store.db).forThread("fil-9"), key, "la clé est gardée pour la reprise du fil");
  assert.equal(store.db.prepare("SELECT task_id FROM codex_bindings WHERE binding = ?").get(key)!.task_id, null, "après le tour, plus rien n'est lié");
});
