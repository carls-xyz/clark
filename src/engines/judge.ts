import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "./claude-auth.ts";

/**
 * Juge rapide sans outils (vérification de fin de tâche) : un petit modèle, un seul tour,
 * aucune session gardée. Il lit et répond, il ne peut rien faire.
 */
export async function claudeJudge(prompt: string): Promise<string> {
  return claudeThink(prompt, "Tu vérifies le travail d'un assistant. Tu réponds uniquement par un bloc JSON, sans rien d'autre.");
}

/** Même chose, avec sa propre consigne (relecture de mémoire…). */
export async function claudeThink(prompt: string, system: string): Promise<string> {
  const run = query({
    prompt,
    options: {
      model: "haiku",
      tools: [],
      maxTurns: 1,
      settingSources: [],
          strictMcpConfig: true, // seulement les serveurs MCP de Clark, jamais ceux de ton compte claude.ai
      persistSession: false,
      systemPrompt: system,
      env: claudeEnv(),
    },
  });
  let out = "";
  for await (const msg of run) if (msg.type === "result" && msg.subtype === "success") out = msg.result;
  return out;
}
