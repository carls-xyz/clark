import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import type { Transport } from "../src/engines/codex-app-server.ts";
import { createCodexEngine, permissionProfilesToml, stepOf, unwrapShell } from "../src/engines/codex.ts";
import { paths } from "../src/config.ts";
import { Store } from "../src/memory/store.ts";
import { planRecovery, TaskJournal } from "../src/tasks/journal.ts";

const config: Config = {
  telegram: null,
  hasApiKey: false,
  engine: "codex",
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

/**
 * Faux Codex App Server : répond aux requêtes de Clark selon un scénario, enregistre
 * tout ce que Clark envoie. `script` reçoit chaque message et peut répondre ou notifier.
 */
function fakeCodex(script: (msg: any, io: { reply: (r: unknown) => void; send: (m: unknown) => void; exit: (why: string) => void }) => void) {
  const sent: any[] = [];
  let toClark: (line: string) => void = () => {};
  let onExit: (why: string) => void = () => {};
  const transport: Transport = {
    write(line) {
      const msg = JSON.parse(line);
      sent.push(msg);
      queueMicrotask(() =>
        script(msg, {
          reply: (result) => toClark(JSON.stringify({ id: msg.id, result })),
          send: (m) => toClark(JSON.stringify(m)),
          exit: (why) => onExit(why),
        }),
      );
    },
    onLine: (fn) => (toClark = fn),
    onExit: (fn) => (onExit = fn),
    close: () => {},
  };
  return { transport, sent };
}

function setup(transport: Transport) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const engine = createCodexEngine({ transport: () => transport });
  const hub = createHub({ config, store, journal, conversation }, { execute: engine.execute });
  return { store, journal, conversation, hub, engine };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "condition jamais atteinte");
};

const T = "thread-1";
const cmdItem = (status: string) => ({
  type: "commandExecution",
  id: "exec-1",
  command: "/bin/zsh -lc 'touch relances.md'",
  cwd: "/ws",
  status,
  commandActions: [{ type: "unknown", command: "touch relances.md" }],
  aggregatedOutput: status === "completed" ? "" : null,
  exitCode: status === "completed" ? 0 : null,
});

/** Le parcours de la recette : message, demande d'accord, réponse. */
function happyPath(msg: any, io: any) {
  switch (msg.method) {
    case "initialize":
      return io.reply({ userAgent: "fake" });
    case "account/read":
      return io.reply({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true });
    case "thread/start":
    case "thread/resume":
      return io.reply({ thread: { id: T } });
    case "turn/start":
      io.reply({ turn: { id: "turn-1", status: "inProgress" } });
      io.send({ method: "item/started", params: { threadId: T, turnId: "turn-1", item: cmdItem("inProgress") } });
      io.send({
        id: 0,
        method: "item/commandExecution/requestApproval",
        params: { threadId: T, turnId: "turn-1", itemId: "exec-1", command: "/bin/zsh -lc 'touch relances.md'", cwd: "/ws", reason: null },
      });
      return;
  }
  if (msg.id === 0 && msg.result) {
    const accepted = msg.result.decision === "accept";
    io.send({ method: "item/completed", params: { threadId: T, turnId: "turn-1", item: cmdItem(accepted ? "completed" : "declined") } });
    io.send({ method: "item/completed", params: { threadId: T, turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: accepted ? "Fichier créé." : "Je n'ai rien fait.", phase: "final_answer" } } });
    io.send({ method: "turn/completed", params: { threadId: T, turn: { id: "turn-1", status: "completed", error: null } } });
  }
}

test("codex : un message du web, une demande d'accord qui remonte, la réponse qui arrive", async () => {
  const { transport, sent } = fakeCodex(happyPath);
  const { hub, journal, conversation } = setup(transport);

  void hub.enqueue(OWNER_CHAT, "Crée relances.md", "chat", "web");
  await until(() => hub.approvals().length === 1);

  const [approval] = hub.approvals();
  assert.match(approval.summary, /^Commande shell :\ntouch relances.md\nDossier : \/ws$/); // hors de son dossier : le dossier est affiché
  assert.equal(journal.steps(1)[0].status, "awaiting_approval");

  assert.ok(hub.resolveApproval(approval.id, true));
  await until(() => conversation.recent(OWNER_CHAT).some((m) => m.text === "Fichier créé."));

  assert.equal(sent.find((m) => m.id === 0)?.result.decision, "accept");
  assert.equal(journal.get(1)!.status, "done");
  assert.equal(journal.get(1)!.session_id, `codex:${T}`);
  assert.deepEqual(journal.steps(1).map((s) => [s.tool, s.effect, s.status]), [["Bash", "write", "done"]]);

  // Clark impose son cadre : pas de réseau, écriture limitée à ses dossiers, validation des commandes.
  const turn = sent.find((m) => m.method === "turn/start");
  assert.equal(turn.params.approvalPolicy, "untrusted");
  assert.equal(turn.params.permissions, "clark", "profil du bac à sable : dossier personnel fermé, dossier de Clark en écriture");
  assert.equal(turn.params.sandboxPolicy, undefined);
  assert.equal(sent.find((m) => m.method === "thread/start").params.permissions, "clark");
  assert.equal(sent.find((m) => m.method === "initialize").params.capabilities.experimentalApi, true, "nécessaire pour le profil par tour");
});

test("codex : un refus est transmis, rien n'est exécuté", async () => {
  const { transport, sent } = fakeCodex(happyPath);
  const { hub, journal, conversation } = setup(transport);
  void hub.enqueue(OWNER_CHAT, "Crée relances.md", "chat", "web");
  await until(() => hub.approvals().length === 1);
  hub.resolveApproval(hub.approvals()[0].id, false);
  await until(() => conversation.recent(OWNER_CHAT).some((m) => m.text === "Je n'ai rien fait."));
  assert.equal(sent.find((m) => m.id === 0)?.result.decision, "decline");
  assert.equal(journal.steps(1)[0].status, "denied");
});

test("codex : sans connexion ChatGPT, la tâche échoue avec la commande de connexion", async () => {
  const { transport } = fakeCodex((msg, io) => {
    if (msg.method === "initialize") io.reply({});
    if (msg.method === "account/read") io.reply({ account: null, requiresOpenaiAuth: true });
  });
  const { hub, conversation } = setup(transport);
  await hub.enqueue(OWNER_CHAT, "Salut", "chat", "web");
  const last = conversation.recent(OWNER_CHAT).at(-1)!;
  assert.match(last.text, /pas connecté à ChatGPT/);
  assert.match(last.text, /CODEX_HOME=.* codex login/);
});

test("codex : arrêt de Codex pendant une écriture → vérification, pas de reprise automatique", async () => {
  const { transport } = fakeCodex((msg, io) => {
    if (msg.method === "initialize") io.reply({});
    if (msg.method === "account/read") io.reply({ account: { type: "chatgpt", planType: "plus" } });
    if (msg.method === "thread/start") io.reply({ thread: { id: T } });
    if (msg.method === "turn/start") {
      io.reply({ turn: { id: "turn-1" } });
      io.send({ method: "item/started", params: { threadId: T, item: { type: "fileChange", id: "patch-1", changes: [{ path: "/ws/relances.md", kind: { type: "add" } }], status: "inProgress" } } });
      setTimeout(() => io.exit("codex app-server s'est arrêté (SIGKILL)"), 10);
    }
  });
  const { hub, journal } = setup(transport);
  await hub.enqueue(OWNER_CHAT, "Écris relances.md", "chat", "web");
  assert.equal(journal.get(1)!.status, "needs_check");
  assert.equal(journal.steps(1)[0].tool, "Edit");
});

test("codex : au redémarrage, la reprise rouvre le même fil Codex", async () => {
  const { transport, sent } = fakeCodex(happyPath);
  const { hub, journal, store } = setup(transport);
  // Une tâche coupée après des lectures, sur un fil Codex.
  const id = journal.create(OWNER_CHAT, "chat", "Fais le point");
  journal.setStatus(id, "running");
  journal.setSession(id, `codex:${T}`);
  store.setSession(OWNER_CHAT, `codex:${T}`);
  journal.announceStep({ taskId: id, toolUseId: "r1", tool: "Read", input: { file_path: "/ws/a.md" }, tier: "workspace" });
  journal.completeStep("r1", "…", false);
  assert.equal(planRecovery(journal.get(id)!, journal.steps(id)).action, "resume");

  await hub.recover();
  await until(() => sent.some((m) => m.method === "turn/start"));
  const resume = sent.find((m) => m.method === "thread/resume");
  assert.equal(resume?.params.threadId, T);
  assert.ok(!sent.some((m) => m.method === "thread/start"), "pas de nouveau fil");
});

test("codex : une session du moteur Claude n'est jamais reprise par Codex en récupération", async () => {
  const { transport } = fakeCodex(happyPath);
  const { hub, journal } = setup(transport);
  const id = journal.create(OWNER_CHAT, "chat", "x");
  journal.setStatus(id, "running");
  journal.setSession(id, "session-claude");
  journal.announceStep({ taskId: id, toolUseId: "r1", tool: "Read", input: {}, tier: "auto" });
  journal.completeStep("r1", "…", false);
  await hub.recover();
  await until(() => journal.get(id)!.status === "failed");
  assert.match(journal.get(id)!.result!, /moteur Claude/);
});

test("étapes Codex : une commande de lecture reste une lecture, le shell une écriture", () => {
  assert.equal(unwrapShell("/bin/zsh -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  const read = stepOf({ type: "commandExecution", command: "/bin/zsh -lc 'cat a.md'", commandActions: [{ type: "read", path: "/ws/a.md", name: "a.md", command: "cat a.md" }] });
  assert.equal(read?.tool, "Read");
  const write = stepOf({ type: "commandExecution", command: "/bin/zsh -lc 'rm a.md'", commandActions: [{ type: "unknown", command: "rm a.md" }] });
  assert.equal(write?.tool, "Bash");
  assert.equal(stepOf({ type: "mcpToolCall", server: "memory", tool: "recall", arguments: { query: "x" } })?.tool, "mcp__memory__recall");
  assert.equal(stepOf({ type: "agentMessage", text: "x" }), null);
});

test("profils de permissions : dossier personnel fermé, seuls les dossiers de Clark ouverts", () => {
  const toml = permissionProfilesToml("/Users/test");
  assert.match(toml, /^default_permissions = "clark-read"/, "par défaut, le profil le plus strict");
  for (const profile of ["clark", "clark-read"]) {
    const block = toml.split(`[permissions.${profile}.filesystem]`)[1].split("[permissions.")[0];
    assert.match(block, /"\/Users\/test" = "deny"/, `${profile} : dossier personnel fermé`);
    const mode = profile === "clark" ? "write" : "read";
    assert.ok(block.includes(`${JSON.stringify(paths.workspace)} = "${mode}"`), `${profile} : dossier de travail en ${mode}`);
    assert.ok(block.includes(`${JSON.stringify(paths.coreMemory)} = "${mode}"`), `${profile} : mémoire cœur en ${mode}`);
  }
  assert.match(toml, /\[permissions\.clark\]\n[^[]*extends = ":workspace"/);
  assert.match(toml, /\[permissions\.clark-read\]\n[^[]*extends = ":read-only"/);
});

test("codex : le modèle et la puissance choisis dans l'interface partent avec le tour", async () => {
  const { transport, sent } = fakeCodex(happyPath);
  const { hub, store } = setup(transport);
  store.choices.set("codex", { model: "modele-a", effort: "high" });
  void hub.enqueue(OWNER_CHAT, "Crée relances.md", "chat", "web");
  await until(() => sent.some((m) => m.method === "turn/start"));
  const turn = sent.find((m) => m.method === "turn/start");
  assert.equal(turn.params.model, "modele-a");
  assert.equal(turn.params.effort, "high");
  assert.equal(sent.find((m) => m.method === "thread/start").params.model, "modele-a");
});

test("codex : sans choix, rien n'est imposé (défaut de Codex)", async () => {
  const { transport, sent } = fakeCodex(happyPath);
  const { hub } = setup(transport);
  void hub.enqueue(OWNER_CHAT, "Crée relances.md", "chat", "web");
  await until(() => sent.some((m) => m.method === "turn/start"));
  const turn = sent.find((m) => m.method === "turn/start");
  assert.equal(turn.params.model, undefined);
  assert.equal(turn.params.effort, undefined);
});

/** Codex appelle un outil d'un serveur MCP ajouté : il demande l'accord, Clark le transmet à l'utilisateur. */
function mcpApprovalPath(msg: any, io: any) {
  switch (msg.method) {
    case "initialize":
      return io.reply({});
    case "account/read":
      return io.reply({ account: { type: "chatgpt", planType: "plus" } });
    case "thread/start":
    case "thread/resume":
      return io.reply({ thread: { id: T } });
    case "turn/start":
      io.reply({ turn: { id: "turn-1" } });
      io.send({ method: "item/started", params: { threadId: T, item: { type: "mcpToolCall", id: "call-1", server: "notion", tool: "create_page", arguments: { title: "Relances" }, status: "inProgress" } } });
      io.send({
        id: 7,
        method: "item/tool/requestUserInput",
        params: {
          threadId: T,
          turnId: "turn-1",
          itemId: "call-1",
          isBlocking: true,
          questions: [
            {
              id: "mcp_tool_call_approval_call-1",
              header: "Approve app tool call?",
              question: "Allow notion to run create_page?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Allow", description: "Run the tool and continue." },
                { label: "Allow for this session", description: "" },
                { label: "Allow and don't ask me again", description: "" },
                { label: "Cancel", description: "Cancel this tool call." },
              ],
            },
          ],
        },
      });
      return;
  }
  if (msg.id === 7 && msg.result) {
    io.send({ method: "item/completed", params: { threadId: T, item: { type: "mcpToolCall", id: "call-1", server: "notion", tool: "create_page", status: "completed" } } });
    io.send({ method: "item/completed", params: { threadId: T, item: { type: "agentMessage", id: "m1", text: "Fini.", phase: "final_answer" } } });
    io.send({ method: "turn/completed", params: { threadId: T, turn: { id: "turn-1", status: "completed", error: null } } });
  }
}

test("codex : outil MCP ajouté → ton accord, réponse « Allow » seulement pour cet appel", async () => {
  const { transport, sent } = fakeCodex(mcpApprovalPath);
  const { hub, store, conversation } = setup(transport);
  store.mcp.add({ name: "notion", transport: "stdio", command: "npx", args: ["-y", "x"], envVars: ["NOTION_TOKEN"] });
  void hub.enqueue(OWNER_CHAT, "Crée la page Relances dans Notion", "chat", "web");
  await until(() => hub.approvals().length === 1);
  assert.match(hub.approvals()[0].summary, /^Outil « create_page » du serveur MCP notion :/);
  hub.resolveApproval(hub.approvals()[0].id, true);
  await until(() => conversation.recent(OWNER_CHAT).some((m) => m.text === "Fini."));
  assert.deepEqual(sent.find((m) => m.id === 7).result, { answers: { "mcp_tool_call_approval_call-1": { answers: ["Allow"] } } });
  const cfg = sent.find((m) => m.method === "thread/start").params.config;
  assert.equal(cfg["mcp_servers.notion.command"], "npx");
  assert.deepEqual(cfg["mcp_servers.notion.env_vars"], ["NOTION_TOKEN"]);
  assert.equal(cfg["mcp_servers.notion.default_tools_approval_mode"], "prompt");
});

test("codex : ton refus → « Cancel »", async () => {
  const { transport, sent } = fakeCodex(mcpApprovalPath);
  const { hub, conversation } = setup(transport);
  void hub.enqueue(OWNER_CHAT, "Crée la page", "chat", "web");
  await until(() => hub.approvals().length === 1);
  hub.resolveApproval(hub.approvals()[0].id, false);
  await until(() => conversation.recent(OWNER_CHAT).some((m) => m.text === "Fini."));
  assert.deepEqual(sent.find((m) => m.id === 7).result.answers["mcp_tool_call_approval_call-1"], { answers: ["Cancel"] });
});

test("codex en lecture seule (relecteur) : une commande de pure lecture passe, toute autre est refusée", async () => {
  const run = async (command: string, actions: any[]) => {
    const item = (status: string) => ({ type: "commandExecution", id: "exec-1", command, cwd: "/ws", status, commandActions: actions, aggregatedOutput: status === "completed" ? "x" : null, exitCode: status === "completed" ? 0 : null });
    const { transport, sent } = fakeCodex((msg: any, io: any) => {
      if (msg.method === "turn/start") {
        io.reply({ turn: { id: "turn-1", status: "inProgress" } });
        io.send({ method: "item/started", params: { threadId: T, turnId: "turn-1", item: item("inProgress") } });
        io.send({ id: 0, method: "item/commandExecution/requestApproval", params: { threadId: T, turnId: "turn-1", itemId: "exec-1", command, cwd: "/ws", reason: null } });
        return;
      }
      if (msg.id === 0 && msg.result) {
        io.send({ method: "item/completed", params: { threadId: T, turnId: "turn-1", item: item(msg.result.decision === "accept" ? "completed" : "declined") } });
        io.send({ method: "item/completed", params: { threadId: T, turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "Relu.", phase: "final_answer" } } });
        io.send({ method: "turn/completed", params: { threadId: T, turn: { id: "turn-1", status: "completed", error: null } } });
        return;
      }
      return happyPath(msg, io);
    });
    const { hub, journal } = setup(transport);
    await hub.enqueue(OWNER_CHAT, "Relis ce diff", "chat", "web", { access: "read" });
    assert.equal(hub.approvals().length, 0, "rien n'est demandé à l'utilisateur");
    const turn = sent.find((m) => m.method === "turn/start");
    assert.equal(turn.params.permissions, "clark-read", "bac à sable en lecture seule");
    return { decision: sent.find((m) => m.id === 0)?.result.decision, steps: journal.steps(1) };
  };

  const read = await run("/bin/zsh -lc \"rg -n 'approve' src/browser/service.ts\"", [{ type: "search", query: "approve", path: "src/browser/service.ts", command: "rg -n approve src/browser/service.ts" }]);
  assert.equal(read.decision, "accept");
  assert.deepEqual(read.steps.map((s) => [s.tool, s.status]), [["Grep", "done"]]);

  const write = await run("/bin/zsh -lc 'touch a.txt'", [{ type: "unknown", command: "touch a.txt" }]);
  assert.equal(write.decision, "decline");
  assert.equal(write.steps[0].status, "denied");

  const mixed = await run("/bin/zsh -lc 'cat a.txt; rm a.txt'", [{ type: "read", path: "a.txt", command: "cat a.txt" }, { type: "unknown", command: "rm a.txt" }]);
  assert.equal(mixed.decision, "decline", "une lecture suivie d'autre chose : refusé");
});
