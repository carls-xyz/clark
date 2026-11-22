/**
 * Vérification de fin de tâche (idée reprise d'OpenBot, rien de copié). Un agent s'arrête
 * parfois à mi-chemin : « Veux-tu que je continue ? », ou une étape oubliée. Après un tour :
 *  1. une fin qui annonce la suite sans la faire → Clark continue (2 fois au plus) ;
 *  2. sinon, si le tour a agi, un juge rapide sans outils lit la demande, les étapes et la
 *     réponse, et dit « fini », « à continuer » (avec ce qui manque), « à l'utilisateur » ou « bloqué ».
 *     À continuer → un tour de plus (3 fois au plus). Dans le doute, il dit « fini ».
 * Une suite automatique ne fait jamais d'envoi vers l'extérieur sans l'accord habituel.
 */
export const NEXT_STEP_LIMIT = 2;
export const FINISH_CHECK_LIMIT = 3;

/** La réponse se termine en annonçant ou en demandant la suite, au lieu de la faire. */
export function announcesNextStep(text: string): boolean {
  const end = text.trim().slice(-280).toLowerCase();
  return /(veux[- ]tu|souhaites[- ]tu|tu veux) (que je|qu'on) (continue|poursuive|passe à la suite|m'en occupe|le fasse)[^?]*\?\s*$/.test(end) ||
    /(dois[- ]je|je peux) (continuer|poursuivre)[^?]*\?\s*$/.test(end) ||
    /\b(je (vais|m'apprête à) (maintenant|ensuite)|maintenant,? je vais|passons (maintenant )?à)\b[^.?!]*[.:…]?\s*$/.test(end) ||
    /(shall i (continue|proceed)|let me now|next,? i('ll| will))[^?]*[?.:]?\s*$/.test(end);
}

export type Verdict = { verdict: "done" | "continue" | "user" | "blocked"; missing: string[] };

export function judgePrompt(request: string, steps: { text: string; failed: boolean }[], answer: string): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return `Tu vérifies si un assistant a fini le travail demandé. Tu n'as aucun outil ; tu réponds seulement par un bloc JSON.

Demande de Charles :
${clip(request, 2000)}

Dernières actions de l'assistant :
${steps.length ? steps.map((s) => `- ${s.failed ? "[ÉCHEC] " : ""}${clip(s.text, 200)}`).join("\n") : "(aucune)"}

Réponse finale de l'assistant :
${clip(answer, 3000)}

Réponds :
- "done" si la demande est traitée, même imparfaitement. Dans le doute, "done". Ne demande ni finition, ni polissage, ni action risquée.
- "continue" seulement s'il manque clairement une partie demandée que l'assistant peut faire seul maintenant ; liste-la en 3 points courts au plus.
- "user" s'il attend légitimement une décision ou une information de Charles.
- "blocked" s'il ne peut pas avancer (accès, erreur répétée).

\`\`\`json
{"verdict": "done", "missing": []}
\`\`\``;
}

export function parseVerdict(text: string): Verdict {
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const v = JSON.parse(m ? m[0] : text) as Partial<Verdict>;
    const verdict = v.verdict === "continue" || v.verdict === "user" || v.verdict === "blocked" ? v.verdict : "done";
    const missing = Array.isArray(v.missing) ? v.missing.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 3) : [];
    // « À continuer » sans rien de précis : on ne relance pas pour rien.
    return verdict === "continue" && !missing.length ? { verdict: "done", missing: [] } : { verdict, missing };
  } catch {
    return { verdict: "done", missing: [] };
  }
}

export function continuePrompt(missing: string[] | null): string {
  return missing
    ? `[Suite automatique] La vérification de fin indique qu'il manque :
${missing.map((m) => `- ${m}`).join("\n")}
Termine ces points sans redemander à Charles, puis donne la réponse complète. Rien d'irréversible ni d'envoi vers l'extérieur sans son accord habituel.`
    : `[Suite automatique] Tu as annoncé l'étape suivante sans la faire : fais-la maintenant, sans redemander à Charles, puis donne la réponse complète. Rien d'irréversible ni d'envoi vers l'extérieur sans son accord habituel.`;
}
