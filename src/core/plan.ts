import type { Access } from "../policy/permissions.ts";

/**
 * Plan d'équipe : Clark choisit les spécialistes, le livrable de chacun et les
 * dépendances entre eux (un graphe sans cycle). Idée reprise des tâches à
 * dépendances de l'orchestration d'Orca.
 *
 * Les droits ne viennent jamais du plan : c'est le code qui les fixe par rôle.
 * Seul le Rédacteur écrit ; tout autre spécialiste, y compris temporaire, lit seulement.
 */
export type CatalogRole = "chercheur" | "redacteur" | "relecteur" | "contenu";

export const CATALOG: Record<CatalogRole, { name: string; mission: string; access: Access }> = {
  chercheur: { name: "Chercheur", mission: "rassembler les faits utiles, avec leur source, sans rien modifier", access: "read" },
  contenu: { name: "Spécialiste Contenu", mission: "juger les textes : clarté, ton, structure, fautes", access: "read" },
  redacteur: { name: "Rédacteur", mission: "écrire le livrable dans le dossier de la mission", access: "write" },
  relecteur: { name: "Relecteur", mission: "vérifier les travaux reçus, repérer les contradictions et prioriser", access: "read" },
};

export const MAX_STEPS = 6;
export const MAX_PARALLEL = 2;

export type PlanStep = {
  key: string;
  /** Rôle du catalogue, ou « temporaire » : spécialiste créé pour cette mission. */
  role: CatalogRole | "temporaire";
  name: string;
  mission: string;
  deliverable: string;
  dependsOn: string[];
  access: Access;
};

export type Plan =
  | { kind: "standard"; reason: string }
  | { kind: "graph"; steps: PlanStep[] };

export function plannerPrompt(request: string): string {
  const catalog = (Object.keys(CATALOG) as CatalogRole[]).map((r) => `- ${r} : ${CATALOG[r].name}, pour ${CATALOG[r].mission}`).join("\n");
  return `[Équipe de Clark — Plan]
Tu es Clark, chef d'équipe. Compose l'équipe pour la demande de Charles. Tu ne fais pas le travail toi-même et tu ne modifies rien.

Spécialistes disponibles :
${catalog}
Si une compétence manque, crée un spécialiste temporaire (role « temporaire ») : donne-lui un nom et une mission précise. Il aura les mêmes outils que les autres, en lecture seule.

Règles :
- ${MAX_STEPS} spécialistes au plus, chacun avec un livrable précis.
- « dependsOn » liste les clés des spécialistes dont il a besoin des résultats. Des spécialistes sans dépendance entre eux peuvent travailler en même temps.
- Seul le Rédacteur peut écrire des fichiers.
- Si la demande est un écrit à produire puis relire (relances, lettre, message), réponds seulement {"standard": true} : l'équipe habituelle Chercheur → Rédacteur ⇄ Relecteur s'en charge.

Réponds uniquement par un bloc JSON :
\`\`\`json
{"steps": [
  {"key": "a11y", "role": "temporaire", "name": "Spécialiste Accessibilité", "mission": "…", "deliverable": "…", "dependsOn": []},
  {"key": "revue", "role": "relecteur", "name": "Relecteur", "mission": "…", "deliverable": "…", "dependsOn": ["a11y"]}
]}
\`\`\`

Demande de Charles : « ${request} »`;
}

const KEY = /^[a-z0-9][a-z0-9-]{0,29}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Lit et vérifie le plan rendu par Clark. Un plan illisible ou incohérent n'est pas
 * deviné : l'équipe habituelle prend le relais, en le disant.
 */
export function parsePlan(text: string): Plan {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let raw: any;
  try {
    raw = JSON.parse(block);
  } catch {
    return { kind: "standard", reason: "plan illisible" };
  }
  if (raw?.standard === true) return { kind: "standard", reason: "équipe habituelle choisie par Clark" };
  if (!Array.isArray(raw?.steps) || raw.steps.length === 0) return { kind: "standard", reason: "plan vide" };
  if (raw.steps.length > MAX_STEPS) return { kind: "standard", reason: `plan de plus de ${MAX_STEPS} spécialistes` };

  const steps: PlanStep[] = [];
  for (const s of raw.steps) {
    const key = str(s?.key, 30).toLowerCase();
    if (!KEY.test(key)) return { kind: "standard", reason: `clé de spécialiste invalide (${String(s?.key)})` };
    if (steps.some((x) => x.key === key)) return { kind: "standard", reason: `clé en double (${key})` };
    const role = (Object.keys(CATALOG) as string[]).includes(s?.role) ? (s.role as CatalogRole) : "temporaire";
    const name = role === "temporaire" ? str(s?.name, 60) : CATALOG[role].name;
    const mission = str(s?.mission, 600) || (role === "temporaire" ? "" : CATALOG[role].mission);
    const deliverable = str(s?.deliverable, 300);
    if (!name || !mission || !deliverable) return { kind: "standard", reason: `spécialiste incomplet (${key})` };
    const dependsOn = Array.isArray(s?.dependsOn) ? [...new Set(s.dependsOn.map((d: unknown) => String(d).toLowerCase()))] : [];
    // Les droits sont fixés par le code : le plan ne peut pas en accorder.
    const access: Access = role === "temporaire" ? "read" : CATALOG[role].access;
    steps.push({ key, role, name, mission, deliverable, dependsOn: dependsOn as string[], access });
  }
  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (d === s.key) return { kind: "standard", reason: `${s.key} dépend de lui-même` };
      if (!steps.some((x) => x.key === d)) return { kind: "standard", reason: `${s.key} dépend d'un spécialiste inconnu (${d})` };
    }
  }
  if (hasCycle(steps)) return { kind: "standard", reason: "dépendances en boucle" };
  return { kind: "graph", steps };
}

function hasCycle(steps: PlanStep[]): boolean {
  const state = new Map<string, "visiting" | "done">();
  const visit = (k: string): boolean => {
    if (state.get(k) === "done") return false;
    if (state.get(k) === "visiting") return true;
    state.set(k, "visiting");
    const cyc = steps.find((s) => s.key === k)!.dependsOn.some(visit);
    state.set(k, "done");
    return cyc;
  };
  return steps.some((s) => visit(s.key));
}

/**
 * Ce qui peut partir maintenant : toutes les dépendances sont faites.
 * Deux spécialistes au plus en même temps, et seulement s'ils sont tous deux en
 * lecture seule ; un spécialiste qui écrit part seul.
 */
export function nextBatch(steps: PlanStep[], done: Set<string>, started: Set<string>): PlanStep[] {
  const ready = steps.filter((s) => !done.has(s.key) && !started.has(s.key) && s.dependsOn.every((d) => done.has(d)));
  if (ready.length === 0) return [];
  const writer = ready.find((s) => s.access === "write");
  const readers = ready.filter((s) => s.access === "read");
  if (readers.length === 0) return writer ? [writer] : [];
  return readers.slice(0, MAX_PARALLEL);
}

export const stepLabel = (key: string) => `node:${key}`;

export function stepPrompt(request: string, step: PlanStep, inputs: { step: PlanStep; result: string }[], file: string): string {
  const rights =
    step.access === "write"
      ? `Tu peux écrire dans le fichier ${file}.`
      : "Tu es en lecture seule : tu lis et tu analyses, tu ne modifies rien (toute écriture sera refusée).";
  const received = inputs.length
    ? `\n\nRésultats dont tu dépends :\n${inputs.map((i) => `### ${i.step.name} — ${i.step.deliverable}\n${i.result}`).join("\n\n")}`
    : "";
  return `[Équipe de Clark — ${step.name}]
Tu es ${step.name}${step.role === "temporaire" ? ", spécialiste créé par Clark pour cette mission" : ""}.
Mission : ${step.mission}
Livrable attendu : ${step.deliverable}
${rights}
Cite tes sources (fichiers lus). Si une information manque ou se contredit, dis-le au lieu de choisir. Si une décision revient à Charles, pose-lui la question (ask_charles).
Une mission d'équipe précédente sur le même sujet ? Ses rendus sont dans equipe/<numéro>/rendu-*.md (dans ton dossier), et les échanges avec Charles se relisent avec history_search puis history_read : cherche-les avant de lui redemander quelque chose.
À chaque étape importante, note ton avancement en une ligne (report_progress) : ce que tu viens de faire, puis la suite.
Ta réponse finale est ton livrable, sans commentaire autour.

Demande de Charles : « ${request} »${received}`;
}

export function synthesisPrompt(request: string, results: { step: PlanStep; result: string }[]): string {
  return `[Équipe de Clark — Synthèse]
Tu es Clark. Ton équipe a terminé. Fais la synthèse pour Charles, sans rien modifier :
1. Ce que l'équipe a trouvé, l'essentiel en premier, en citant le spécialiste et ses sources.
2. Ce qui reste à trancher par Charles (contradictions, choix, informations manquantes).
Ne rajoute aucun fait que les spécialistes n'ont pas donné.

Demande de Charles : « ${request} »

${results.map((r) => `### ${r.step.name} — ${r.step.deliverable}\n${r.result}`).join("\n\n")}`;
}
