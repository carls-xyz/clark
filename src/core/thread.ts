import type { Message } from "./conversation.ts";

/**
 * Ce que montre ta conversation : toi et Clark, et les notes qui font partie d'un de vos
 * échanges (« Je continue », « Quota atteint… », « Ça a planté… »). Le reste (dev, PR,
 * souvenirs, propositions, agents silencieux, accords donnés…) part dans Activité.
 *
 * Rien n'est supprimé : les notes restent dans la base, partent sur les canaux comme avant,
 * et Clark les relit avec ton message suivant (src/core/unseen.ts). Seul l'affichage change.
 * Ce qui attend ta réponse (accords, questions, mails, vidéos) reste en cartes au bas du fil.
 */

/** Notes jamais montrées dans le fil, même liées à un de vos échanges. */
const OUT_KINDS = new Set(["dev", "pr", "stalled", "proposals", "approval", "digest"]);
const OUT_TEXT = /^(Validé|Refusé|Sans réponse après 10 minutes|Clark propose de (retenir|corriger)|Souvenir (confirmé|corrigé|ignoré)|J'ai retenu|Ta réponse|Clark te pose une question|Clark te propose|Proposition refusée|Ce que j'ai décidé seul)/;

/**
 * Le message a-t-il sa place dans le fil ? `taskChat` donne la conversation (chat) d'une tâche :
 * une note liée à une tâche de ta conversation est un morceau de l'échange ; une note sans tâche,
 * ou liée à une tâche d'ailleurs (dev, objectif…), est un évènement.
 */
export function inThread(m: Pick<Message, "role" | "kind" | "text" | "task_id">, ownerChat: number, taskChat: (taskId: number) => number | undefined): boolean {
  if (m.role !== "system") return true;
  if (m.kind && OUT_KINDS.has(m.kind)) return false;
  if (OUT_TEXT.test(m.text)) return false;
  if (m.task_id === null || m.task_id === undefined) return false;
  return taskChat(m.task_id) === ownerChat;
}

export type NoteCategory = "dev" | "memoire" | "propositions" | "accords" | "agents" | "autres";

export const NOTE_CATEGORIES: [NoteCategory, string][] = [
  ["dev", "Dev et PR"],
  ["memoire", "Mémoire"],
  ["propositions", "Propositions"],
  ["accords", "Accords et questions"],
  ["agents", "Agents silencieux"],
  ["autres", "Autres"],
];

/** Le rayon d'Activité où ranger une note. */
export function noteCategory(m: Pick<Message, "kind" | "text">): NoteCategory {
  if (m.kind === "dev" || m.kind === "pr") return "dev";
  if (m.kind === "stalled") return "agents";
  if (/^(Clark propose de (retenir|corriger)|Souvenir |J'ai retenu)/.test(m.text)) return "memoire";
  if (m.kind === "proposals" || /^(Clark te propose|Proposition (acceptée|refusée)|Ce que j'ai décidé seul|Idée |Tour d'idées)/.test(m.text)) return "propositions";
  if (m.kind === "approval" || /^(Validé|Refusé|Sans réponse après 10 minutes|Ta réponse|Clark te pose une question)/.test(m.text)) return "accords";
  return "autres";
}
