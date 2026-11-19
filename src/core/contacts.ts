import type { Access } from "../policy/permissions.ts";
import { CATALOG, type CatalogRole } from "./plan.ts";

/**
 * Les agents de l'équipe comme contacts : Charles peut écrire directement au Chercheur,
 * au Rédacteur… chacun dans ses propres conversations. Les droits restent ceux de l'équipe,
 * fixés par le code : seul le Rédacteur écrit, les autres lisent seulement.
 */
export type Contact = { role: CatalogRole | "groupe" | null; name: string; badge: string; mission: string; access: Access };

/** Conversation de groupe : chaque spécialiste répond de son côté (idée reprise d'OpenBot). */
export const GROUP_CONTACT: Contact = { role: "groupe", name: "Toute l'équipe", badge: "Avis croisés", mission: "donner chacun son avis, sans voir celui des autres", access: "read" };
export const GROUP_MEMBERS: CatalogRole[] = ["chercheur", "redacteur", "relecteur", "contenu"];

export const CLARK_CONTACT: Contact = { role: null, name: "Clark", badge: "Chef d'orchestre", mission: "recevoir tes demandes, les analyser et confier chaque tâche au bon agent", access: "write" };

/** Les petits noms de l'équipe (ceux de leurs bonshommes pixelisés), avec leur spécialité. */
export const NICKNAMES: Record<CatalogRole | "code", string> = { chercheur: "Mousse", redacteur: "Braise", relecteur: "Guimauve", contenu: "Lilas", code: "Boulon" };
export const SPECIALTIES: Record<CatalogRole | "code", string> = { chercheur: "Recherche", redacteur: "Rédaction", relecteur: "Relecture", contenu: "Contenu", code: "Code" };

export const CONTACTS: Contact[] = [
  CLARK_CONTACT,
  ...(["chercheur", "redacteur", "relecteur", "contenu"] as CatalogRole[]).map((role) => ({
    role,
    name: NICKNAMES[role],
    badge: SPECIALTIES[role],
    mission: CATALOG[role].mission,
    access: CATALOG[role].access,
  })),
];

export const isContactRole = (role: unknown): role is CatalogRole => typeof role === "string" && role in CATALOG;
export const isConversationAgent = (role: unknown): role is CatalogRole | "groupe" => role === "groupe" || isContactRole(role);

/** Un membre du groupe répond à Charles : son avis à lui, sans voir celui des autres. */
export function groupPrompt(role: CatalogRole, text: string, recent: { who: string; text: string }[]): string {
  const context = recent.length ? `\n\nDerniers échanges de ce groupe :\n${recent.map((r) => `${r.who} : ${r.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}` : "";
  return `${directPrompt(role, text)}

Charles a posé la question à toute l'équipe. Chacun répond de son côté, sans voir les réponses des autres : donne ton propre avis, depuis ton rôle, en 5 à 10 lignes. Tu lis seulement.${context}`;
}

export function contactOf(agent: string | null | undefined): Contact {
  return (agent && CONTACTS.find((c) => c.role === agent)) || CLARK_CONTACT;
}

/** Repère en tête du message : sert aussi à la démo pour savoir à qui Charles parle. */
export const directMarker = (role: CatalogRole) => `[Discussion directe — ${CATALOG[role].name}]`;

/** Le message de Charles, adressé à un agent plutôt qu'à Clark. */
export function directPrompt(role: CatalogRole, text: string): string {
  const c = CATALOG[role];
  const rights =
    c.access === "read"
      ? "Tu lis seulement : tu ne modifies aucun fichier (le code te l'interdit de toute façon)."
      : "Tu peux écrire dans ton dossier de travail ; tout envoi vers l'extérieur passe par l'accord de Charles.";
  return `${directMarker(role)}
Charles t'écrit directement, sans passer par Clark. Tu es ${NICKNAMES[role]}, le ${c.name} de l'équipe de Clark (${SPECIALTIES[role]}) : ton rôle est de ${c.mission}. ${rights}
Réponds en ton nom, en restant dans ton rôle. Si la demande sort de ton rôle, dis-le et suggère d'en parler à Clark.

Message de Charles : « ${text} »`;
}
