// Serveur MCP de la mémoire de Clark, en processus séparé (stdio), pour le moteur Codex.
// Codex le lance lui-même d'après data/codex-home/config.toml, écrit par Clark au démarrage.
// Il ouvre la même base SQLite que Clark (mode WAL : les deux écrivent sans se gêner).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.ts";
import { boundTask } from "../engines/bindings.ts";
import { READ_ONLY_REFUSAL } from "../policy/permissions.ts";
import { memoryTools, toolReply } from "./tools.ts";

const db = process.env.CLARK_DB;
if (!db) {
  console.error("CLARK_DB manquant");
  process.exit(1);
}

const store = new Store(db);

/**
 * La tâche qui appelle : retrouvée par la clé de liaison que Clark a donnée au fil Codex
 * (CLARK_BINDING), jamais devinée. Introuvable, ou sans le droit d'écrire : écriture refusée.
 */
const binding = process.env.CLARK_BINDING;
const writeRefusal = (): string | null => {
  const task = boundTask(store.db, binding);
  if (!task) return "Refusé : je ne retrouve pas la tâche Clark qui fait cet appel. Rien n'est écrit en mémoire.";
  if (task.access !== "write") return READ_ONLY_REFUSAL;
  return null;
};

const tools = memoryTools(store, { taskId: () => boundTask(store.db, binding)?.id, writeRefusal });
const server = new McpServer({ name: "memory", version: "0.2.0" });

type ToolResult = Parameters<typeof toolReply>[0];
type Reply = ReturnType<typeof toolReply> & { isError?: boolean };
const reply = async (run: () => ToolResult | Promise<ToolResult>): Promise<Reply> => {
  try {
    return toolReply(await run());
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
};

const { propose_memory, recall, propose_correction, forget, ask_charles, report_progress, prepare_social_post, propose_initiative } = tools;
server.registerTool("delegate", { description: tools.delegate.description, inputSchema: tools.delegate.shape }, async (a) => reply(() => tools.delegate.run(a)));
server.registerTool("start_code_task", { description: tools.start_code_task.description, inputSchema: tools.start_code_task.shape }, async (a) => reply(() => tools.start_code_task.run(a)));
server.registerTool("confirm_plan", { description: tools.confirm_plan.description, inputSchema: tools.confirm_plan.shape }, async (a) => reply(() => tools.confirm_plan.run(a)));
server.registerTool("history_search", { description: tools.history_search.description, inputSchema: tools.history_search.shape }, async (a) => reply(() => tools.history_search.run(a)));
server.registerTool("history_read", { description: tools.history_read.description, inputSchema: tools.history_read.shape }, async (a) => reply(() => tools.history_read.run(a)));
server.registerTool("remind_me", { description: tools.remind_me.description, inputSchema: tools.remind_me.shape }, async (a) => reply(() => tools.remind_me.run(a)));
server.registerTool("create_automation", { description: tools.create_automation.description, inputSchema: tools.create_automation.shape }, async (a) => reply(() => tools.create_automation.run(a)));
server.registerTool("nothing_new", { description: tools.nothing_new.description, inputSchema: tools.nothing_new.shape }, async () => reply(() => tools.nothing_new.run()));
server.registerTool("report_failure", { description: tools.report_failure.description, inputSchema: tools.report_failure.shape }, async (a) => reply(() => tools.report_failure.run(a)));
server.registerTool("propose_initiative", { description: propose_initiative.description, inputSchema: propose_initiative.shape }, async (a) =>
  reply(() => propose_initiative.run(a)),
);
server.registerTool("prepare_social_post", { description: prepare_social_post.description, inputSchema: prepare_social_post.shape }, async (a) =>
  reply(() => prepare_social_post.run(a)),
);
server.registerTool("report_progress", { description: report_progress.description, inputSchema: report_progress.shape }, async (a) => reply(() => report_progress.run(a)));
server.registerTool("ask_charles", { description: ask_charles.description, inputSchema: ask_charles.shape }, async (a) => reply(() => ask_charles.run(a)));
server.registerTool("propose_memory", { description: propose_memory.description, inputSchema: propose_memory.shape }, async (a) => reply(() => propose_memory.run(a)));
server.registerTool("recall", { description: recall.description, inputSchema: recall.shape }, async (a) => reply(() => recall.run(a)));
server.registerTool("propose_correction", { description: propose_correction.description, inputSchema: propose_correction.shape }, async (a) =>
  reply(() => propose_correction.run(a)),
);
for (const name of ["note_idea", "idea_report", "mail_search", "mail_read", "calendar_events", "send_mail", "run_command", "vault_search", "vault_read", "vault_write", "report_goal", "use_skill", "messages_recent", "messages_read", "send_imessage", "browser_open", "browser_read", "browser_scroll", "browser_back", "browser_click", "browser_type", "browser_select", "computer_screenshot", "computer_click_at", "computer_scroll", "computer_key"] as const) {
  const t = tools[name] as { description: string; shape: any; run: (a: any) => ToolResult | Promise<ToolResult> };
  server.registerTool(name, { description: t.description, inputSchema: t.shape }, async (a: any) => reply(() => t.run(a)));
}
server.registerTool("forget", { description: forget.description, inputSchema: forget.shape }, async (a) => reply(() => forget.run(a)));

await server.connect(new StdioServerTransport());
