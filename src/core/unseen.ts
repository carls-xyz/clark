import { NEW_CONVERSATION_NOTE, type Conversation } from "./conversation.ts";

/**
 * Messages affichés à l'utilisateur dans la conversation depuis sa dernière demande, sans que l'agent
 * les ait écrits pendant un tour : rappels, décisions prises seul, propositions, notes du système.
 * Ils ne sont pas dans la session de l'agent ; on les lui donne avec le message suivant de l'utilisateur.
 */
export const UNSEEN_MAX = 10;

export function unseenNotes(conversation: Conversation, conversationId: number): string | null {
  const recent = conversation.messagesOf(conversationId, 60);
  const lastAsk = recent.map((m) => m.role).lastIndexOf("user");
  const shown = recent
    .slice(lastAsk + 1)
    // Écrits hors d'un tour (pas de tâche) : l'agent ne les a jamais vus.
    .filter((m) => m.task_id === null && m.role !== "user" && m.text !== NEW_CONVERSATION_NOTE)
    .slice(-UNSEEN_MAX);
  if (!shown.length) return null;
  const at = (s: string) => new Date(`${s.replace(" ", "T")}Z`).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  const clip = (s: string) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > 400 ? `${one.slice(0, 400)}…` : one;
  };
  return `[Affiché à Charles depuis votre dernier échange, envoyé en ton nom par Clark (rappels, décisions prises seul, notes) — tu ne l'as pas écrit pendant un tour, mais c'est bien de toi :]
${shown.map((m) => `- ${at(m.created_at)} ${m.role === "clark" ? "Clark" : "note"} : ${clip(m.text)}`).join("\n")}`;
}
