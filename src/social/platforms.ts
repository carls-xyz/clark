import { hashtagsOf, type Platform, type Post } from "./posts.ts";

/**
 * Ce que Clark vérifie avant de te montrer un brouillon, plateforme par plateforme.
 * « règle » : ce que la plateforme impose ou demande. « conseil » : un repère de Clark,
 * à ignorer si tu as une raison.
 */
export type Check = { ok: boolean; kind: "règle" | "conseil" | "rappel"; text: string };

export const PLATFORMS: Record<Platform, { name: string; checks: (p: Post) => Check[] }> = {
  tiktok: {
    name: "TikTok",
    checks: (p) => {
      const tags = hashtagsOf(p);
      return [
        { ok: p.width === 1080 && p.height === 1920, kind: "règle", text: `Format vertical 9:16 (${p.width}×${p.height})` },
        { ok: p.caption.trim().length > 0, kind: "règle", text: "Une légende est écrite" },
        { ok: p.duration <= 60, kind: "conseil", text: `Durée ${Math.round(p.duration)} s : en dessous d'une minute pour une démo produit` },
        { ok: tags.length >= 2 && tags.length <= 6, kind: "conseil", text: `${tags.length} mot${tags.length > 1 ? "s" : ""}-clé${tags.length > 1 ? "s" : ""} : entre 2 et 6, précis plutôt que génériques` },
        { ok: true, kind: "rappel", text: "Ajoute la musique dans TikTok, avec un titre de sa bibliothèque : la vidéo est muette" },
        { ok: true, kind: "rappel", text: "Si une image est générée ou retouchée de façon réaliste par une IA, active l'étiquette « contenu généré par IA »" },
      ];
    },
  },
};

export const platformName = (p: Platform) => PLATFORMS[p]?.name ?? p;
