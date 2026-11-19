import { directPrompt, GROUP_MEMBERS, groupPrompt, isContactRole } from "./contacts.ts";
import { canSteer, steer } from "./steer.ts";
import { CATALOG } from "./plan.ts";
import type { EngineName } from "../config.ts";
import type { Hub } from "./hub.ts";
import { OWNER_CHAT } from "./hub.ts";
import { TEAM_LABEL } from "./team.ts";
import { DEFAULT_MAX_TURNS } from "./goals.ts";
import { createGoal } from "../scheduler/goals.ts";
import { expandCommand } from "../skills/library.ts";

export type Mode = "chat" | "team" | "goal";

/**
 * Une demande de Charles, d'où qu'elle vienne (web, Telegram) : une commande perso
 * (« /relances Studio Pixel ») est remplacée par sa consigne et prend son mode ; sinon le
 * mode choisi (message, équipe, objectif).
 */
export function submitRequest(hub: Hub, text: string, opts: { source: "web" | "telegram" | "imessage" | "cli"; mode?: Mode; onCreated?: (taskId: number) => void }): { kind: Mode; command?: string; id?: number } | { error: string } {
  // Telegram, iMessage, terminal : on parle à Clark. Si l'interface avait une conversation avec
  // un agent ou avec toute l'équipe ouverte, on revient à la dernière conversation de Clark.
  if (opts.source !== "web") {
    const conv = hub.deps.conversation;
    if ((conv.conversation(conv.current(OWNER_CHAT))?.agent ?? null) !== null) hub.openAgent(null);
  }
  const expanded = expandCommand(text);
  const prompt = expanded ? expanded.prompt : text.trim();
  const mode: Mode = expanded ? expanded.command.mode : (opts.mode ?? "chat");
  if (!prompt) return { error: "Message vide" };
  if (mode === "goal") {
    if (prompt.length < 10) return { error: "Décris l'objectif en une phrase au moins" };
    const id = createGoal(hub, prompt, DEFAULT_MAX_TURNS, opts.source);
    return { kind: "goal", id, command: expanded?.command.name };
  }
  // Un agent travaille déjà dans cette conversation : le message lui est glissé dans le tour en
  // cours (« ah, et aussi… ») au lieu d'attendre la fin. S'il vient de finir, il part normalement.
  if (mode === "chat" && !expanded) {
    const conv = hub.deps.conversation;
    const current = conv.current(OWNER_CHAT);
    const busy = hub.deps.journal
      .unfinished()
      .find((t) => t.chat_id === OWNER_CHAT && t.parent_id === null && t.label === "chat" && t.status === "running" && canSteer(t.id) && conv.conversationOfTask(t.id) === current);
    if (busy) {
      void steer(busy.id, prompt).then((ok) => {
        if (ok) {
          conv.add({ chatId: OWNER_CHAT, role: "user", text: prompt, taskId: busy.id, source: opts.source });
          hub.touch();
        } else submitRequest(hub, text, opts);
      });
      return { kind: "chat" };
    }
  }

  // Conversation avec un agent de l'équipe : c'est lui qui répond, avec ses droits et son moteur.
  const agent = hub.deps.conversation.conversation(hub.deps.conversation.current(OWNER_CHAT))?.agent ?? null;
  // « Toute l'équipe » : chaque membre répond de son côté, en lecture seule, sans voir les autres.
  if (agent === "groupe") {
    const conv = hub.deps.conversation;
    const recent = conv
      .messagesOf(conv.current(OWNER_CHAT), 12)
      .filter((m) => m.role !== "system")
      .map((m) => ({ who: m.role === "user" ? "Charles" : (m.agent ? (CATALOG as Record<string, { name: string }>)[m.agent]?.name : null) ?? "Clark", text: m.text }));
    const parent = hub.deps.journal.create(OWNER_CHAT, "groupe", prompt);
    hub.deps.journal.setSource(parent, opts.source);
    conv.add({ chatId: OWNER_CHAT, role: "user", text: expanded ? text.trim() : prompt, taskId: parent, source: opts.source });
    hub.deps.journal.finish(parent, "done", "Question posée à toute l'équipe.", 0);
    for (const role of GROUP_MEMBERS) {
      void hub.enqueue(OWNER_CHAT, groupPrompt(role, prompt, recent), `avis:${role}`, opts.source, { access: "read", engine: hub.engineFor(role) as EngineName, parentId: parent });
    }
    opts.onCreated?.(parent);
    return { kind: "chat", command: expanded?.command.name };
  }
  if (isContactRole(agent)) {
    const engine = hub.engineFor(agent) as EngineName;
    void hub.enqueue(OWNER_CHAT, directPrompt(agent, prompt), "chat", opts.source, {
      display: expanded ? text.trim() : prompt,
      access: CATALOG[agent].access,
      engine,
      ...(opts.onCreated ? { onCreated: opts.onCreated } : {}),
    });
    return { kind: "chat", command: expanded?.command.name };
  }
  // Le fil montre la commande tapée ; l'agent reçoit sa consigne complète.
  void hub.enqueue(OWNER_CHAT, prompt, mode === "team" ? TEAM_LABEL : "chat", opts.source, {
    ...(expanded ? { display: text.trim() } : {}),
    ...(opts.onCreated ? { onCreated: opts.onCreated } : {}),
  });
  return { kind: mode, command: expanded?.command.name };
}
