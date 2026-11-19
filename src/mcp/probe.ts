import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpCheck, McpServer } from "./servers.ts";
import { serverEnv } from "./servers.ts";

/**
 * « Tester » dans Plugins : lance le serveur, lui demande sa liste d'outils, puis le ferme.
 * Aucun outil n'est appelé. Le résultat est affiché tel quel (outils, ou l'erreur).
 */
export async function probeMcp(s: McpServer, timeoutMs = 30_000): Promise<McpCheck> {
  const client = new Client({ name: "clark", version: "0.1.0" });
  let stderr = "";
  const transport =
    s.transport === "stdio"
      ? new StdioClientTransport({ command: s.command!, args: s.args, env: serverEnv(s), stderr: "pipe" })
      : new StreamableHTTPClientTransport(new URL(s.url!), {
          requestInit: s.tokenVar && process.env[s.tokenVar]?.trim() ? { headers: { Authorization: `Bearer ${process.env[s.tokenVar]!.trim()}` } } : {},
        });
  if (transport instanceof StdioClientTransport) transport.stderr?.on("data", (d) => (stderr = (stderr + d.toString()).slice(-600)));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pas de réponse en ${timeoutMs / 1000} s`)), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    return { ok: true, at: Date.now(), tools: tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 200) })), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /ENOENT/.test(msg) ? ` (commande introuvable : ${s.command})` : "";
    const tail = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
    return { ok: false, at: Date.now(), tools: [], error: `${msg}${hint}${tail ? ` — ${tail}` : ""}` };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
