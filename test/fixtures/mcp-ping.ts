// Petit serveur MCP pour les tests : un outil « ping », et il signale s'il voit FIXTURE_SECRET.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "ping", version: "1.0.0" });
server.registerTool("ping", { description: `Répond pong (secret vu : ${process.env.FIXTURE_SECRET ? "oui" : "non"}, autre : ${process.env.OTHER_SECRET ? "oui" : "non"})` }, async () => ({
  content: [{ type: "text", text: "pong" }],
}));
await server.connect(new StdioServerTransport());
