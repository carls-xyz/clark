import type { Hub } from "./hub.ts";
import { CATEGORY_LABEL, DECLINE_LABEL, type CategoryStats, type Initiative, type Outcome } from "./initiatives.ts";
import { parisParts } from "../scheduler/automations.ts";

/**
 * La boucle d'initiatives : observer (tour de veille) → proposer (avec un critère de réussite) → décider
 * (toi, ou Clark en autonomie) → exécuter → **mesurer** → **apprendre**. Ce fichier fait les deux dernières :
 *
 * - Mesurer : chaque minute, les propositions lancées et finies sont comparées à leur critère par un modèle
 *   rapide (atteint, partiel, raté). Une tâche en échec ou arrêtée, un objectif arrêté : raté, sans appel.
 *   Sans modèle : « terminé », non évalué. Ton avis (Utile / Pas utile) vient ensuite, dans Activité.
 * - Apprendre : un bilan par catégorie (acceptées, critère atteint, jugées utiles), et des règles fixes
 *   (« à éviter », « marche bien ») données au tour de veille. Chaque dimanche soir, un bilan au Calendrier.
 */

/** Conversation à part du bilan hebdomadaire (rangé au Calendrier, jamais dans ta conversation). */
export const BILAN_CHAT = 7_000_001;
export const BILAN_LABEL = "bilan";
export const BILAN_HOUR = 20;
/** Seuils des règles d'apprentissage (sur 30 jours). */
export const RULES = { minFeedback: 3, minProposed: 3, avoidRate: 1 / 3, goodRate: 2 / 3, notUseful: 2 } as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** La consigne du juge : le résultat contre le critère, une réponse JSON. */
export function verdictPrompt(i: Pick<Initiative, "title" | "action" | "success">, result: string): string {
  return `Tu juges si une action menée par un assistant a atteint son critère de réussite. Sois strict et factuel : seulement ce que montre le compte rendu.

Action : ${i.title}
Consigne suivie : ${clip(i.action, 800)}
Critère de réussite : ${i.success ?? "(aucun critère donné)"}

Compte rendu de l'assistant :
${clip(result, 3000)}

Réponds uniquement par un JSON : {"verdict": "atteint" | "partiel" | "rate", "note": "une phrase : ce qui est fait, ou ce qui manque"}`;
}

export function parseVerdict(raw: string): { outcome: Exclude<Outcome, "termine">; note: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { verdict?: string; note?: string };
    const v = j.verdict === "atteint" || j.verdict === "partiel" || j.verdict === "rate" ? j.verdict : j.verdict === "raté" ? "rate" : null;
    return v ? { outcome: v, note: clip(String(j.note ?? "").trim(), 240) } : null;
  } catch {
    return null;
  }
}

/** Un passage de mesure : les propositions lancées et finies reçoivent leur résultat. Renvoie combien. */
export async function measureInitiatives(hub: Hub, judge?: (prompt: string) => Promise<string>): Promise<number> {
  const { store, journal } = hub.deps;
  let done = 0;
  for (const i of store.initiatives.toMeasure()) {
    let result: string | null = null;
    let fail: string | null = null;
    if (i.exec_task_id !== null) {
      const t = journal.get(i.exec_task_id);
      if (!t) fail = "tâche introuvable";
      else if (t.status === "failed" || t.status === "abandoned") fail = t.status === "failed" ? "la tâche a échoué" : "la tâche a été abandonnée";
      else if (t.status === "done") result = t.result ?? "";
      else continue; // en file, en cours, à vérifier : plus tard
    } else if (i.exec_goal_id !== null) {
      const g = store.goals.get(i.exec_goal_id);
      if (!g) fail = "objectif introuvable";
      else if (g.status === "stopped") fail = "l'objectif a été arrêté";
      else if (g.status === "done") result = g.summary ?? "";
      else continue;
    }
    if (fail) {
      store.initiatives.setOutcome(i.id, "rate", fail);
      done++;
      continue;
    }
    if (!judge || !i.success) {
      store.initiatives.setOutcome(i.id, "termine", i.success ? "pas évalué (pas de modèle rapide)" : "pas de critère de réussite");
      done++;
      continue;
    }
    try {
      const v = parseVerdict(await judge(verdictPrompt(i, result ?? "")));
      store.initiatives.setOutcome(i.id, v?.outcome ?? "termine", v?.note ?? "réponse du juge illisible");
    } catch (err) {
      console.warn("[clark] proposition non évaluée :", err instanceof Error ? err.message : err);
      continue; // retentée au passage suivant
    }
    done++;
  }
  return done;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

/** Ce que le bilan conclut pour une catégorie (règles fixes, calculées ici, pas laissées au modèle). */
export function verdictOf(s: CategoryStats): "eviter" | "marche" | null {
  if (s.notUseful >= RULES.notUseful) return "eviter";
  if (s.feedback >= RULES.minFeedback && s.useful / s.feedback < RULES.avoidRate) return "eviter";
  if (s.proposed >= RULES.minProposed && s.accepted / s.proposed < RULES.avoidRate) return "eviter";
  if (s.feedback >= RULES.minFeedback && s.useful / s.feedback >= RULES.goodRate) return "marche";
  return null;
}

/** Une ligne par catégorie : « Relances : 6 proposées, 6 acceptées, 5/6 atteintes, 4/4 utiles → continue ». */
export function statsLines(stats: CategoryStats[]): string[] {
  return stats.map((s) => {
    const parts = [`${s.proposed} proposée${s.proposed > 1 ? "s" : ""}`, `${s.accepted} acceptée${s.accepted > 1 ? "s" : ""}`];
    if (s.finished) parts.push(`${s.reached}/${s.finished} critère atteint`);
    if (s.feedback) parts.push(`${s.useful}/${s.feedback} jugée${s.useful > 1 ? "s" : ""} utile${s.useful > 1 ? "s" : ""}`);
    if (s.notUseful) parts.push(`${s.notUseful} refusée${s.notUseful > 1 ? "s" : ""} comme pas utile${s.notUseful > 1 ? "s" : ""}`);
    const v = verdictOf(s);
    const rule = v === "eviter" ? " → à éviter : n'en propose plus, sauf urgence réelle" : v === "marche" ? " → ça marche : continue" : "";
    return `- ${CATEGORY_LABEL[s.category]} (${s.category}) : ${parts.join(", ")}${rule}`;
  });
}

/** Pour le tour de veille : le bilan des 30 jours, et les derniers refus avec leur raison. */
export function learningForPrompt(hub: Hub, now = new Date()): string {
  const { store } = hub.deps;
  const lines = statsLines(store.initiatives.stats(30, now));
  const refusals = store.initiatives
    .recentDecisions(15)
    .filter((i) => i.status === "declined" && i.decline_kind)
    .slice(0, 6)
    .map((i) => `- « ${i.title} » : ${DECLINE_LABEL[i.decline_kind!].toLowerCase()}${i.decline_reason ? ` (${i.decline_reason})` : ""}`);
  const misses = store.initiatives
    .recent(20)
    .filter((i) => i.outcome === "rate" || i.outcome === "partiel" || i.feedback === "inutile")
    .slice(0, 4)
    .map((i) => `- « ${i.title} » : ${i.feedback === "inutile" ? "jugée pas utile" : i.outcome === "partiel" ? "critère en partie atteint" : "ratée"}${i.outcome_note ? ` (${i.outcome_note})` : ""}`);
  if (!lines.length) return "";
  return `Bilan de tes propositions sur 30 jours (respecte les conclusions « à éviter ») :
${lines.join("\n")}${refusals.length ? `\n\nDerniers refus de Charles, et pourquoi :\n${refusals.join("\n")}` : ""}${misses.length ? `\n\nCe qui n'a pas marché (fais mieux, ou ne le repropose pas) :\n${misses.join("\n")}` : ""}`;
}

/** Le bilan de la semaine, pour le Calendrier. */
export function weeklyBilan(hub: Hub, now = new Date()): string {
  const stats = hub.deps.store.initiatives.stats(7, now);
  if (!stats.length) return "Aucune proposition cette semaine.";
  const total = stats.reduce((a, s) => ({ p: a.p + s.proposed, a: a.a + s.accepted, f: a.f + s.feedback, u: a.u + s.useful }), { p: 0, a: 0, f: 0, u: 0 });
  const head = `${total.p} proposition${total.p > 1 ? "s" : ""}, ${total.a} acceptée${total.a > 1 ? "s" : ""}${total.f ? `, ${pct(total.u, total.f)} % jugées utiles` : ""}.`;
  return `## Bilan des propositions\n\n${head}\n\n${statsLines(stats).join("\n")}`;
}

/**
 * La boucle : la mesure chaque minute ; le bilan de la semaine le dimanche à 20 h (une fois), au Calendrier.
 */
export function startInitiativeLoop(hub: Hub, judge?: (prompt: string) => Promise<string>, now: () => Date = () => new Date()): () => void {
  const { store, journal } = hub.deps;
  store.db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  let busy = false;
  const tick = async () => {
    if (busy || !store.db.isOpen) return;
    busy = true;
    try {
      const n = await measureInitiatives(hub, judge);
      if (n) hub.touch();
      const p = parisParts(now());
      const done = store.db.prepare("SELECT value FROM app_settings WHERE key = 'initiatives_bilan_day'").get() as { value: string } | undefined;
      if (p.weekday === 7 && p.hour >= BILAN_HOUR && done?.value !== p.date) {
        store.db.prepare("INSERT INTO app_settings (key, value) VALUES ('initiatives_bilan_day', ?) ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(p.date);
        const t = journal.create(BILAN_CHAT, BILAN_LABEL, "Bilan des propositions de la semaine");
        journal.finish(t, "done", weeklyBilan(hub, now()), 0);
        hub.touch();
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
