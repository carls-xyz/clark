import type { Access, Approver } from "../policy/permissions.ts";
import { describeStep, uncertainSteps, type Step, type Task } from "../tasks/journal.ts";
import { INCONCLUSIVE, resumeVerified } from "./recovery.ts";
import { nextBatch, parsePlan, plannerPrompt, stepLabel, stepPrompt, synthesisPrompt, type PlanStep } from "./plan.ts";
import type { Deps, RunResult, executeTask } from "./agent.ts";

/**
 * Équipe d'agents, première version : Clark est chef d'équipe et enchaîne
 * Chercheur → Rédacteur → Relecteur. Les agents ne se parlent pas entre eux :
 * Clark transmet le résultat de l'un au suivant. Chaque agent est une sous-tâche
 * du journal, avec ses propres étapes : une coupure se reprend agent par agent,
 * et un agent terminé n'est jamais relancé.
 */
export const TEAM_LABEL = "team";
export const MAX_REVIEWS = 2;

export type Role = "chercheur" | "redacteur" | "relecteur";
export const ROLES: Role[] = ["chercheur", "redacteur", "relecteur"];
export const ROLE_NAMES: Record<Role, string> = { chercheur: "Chercheur", redacteur: "Rédacteur", relecteur: "Relecteur" };

/** Droits imposés par le code : seul le Rédacteur peut écrire. */
export const ROLE_ACCESS: Record<Role, Access> = { chercheur: "read", redacteur: "write", relecteur: "read" };

/** « redacteur:2 » → rôle et tour. */
export function parseLabel(label: string): { role: Role | null; round: number } {
  const [role, round] = label.split(":");
  return { role: (ROLES as string[]).includes(role) ? (role as Role) : null, round: Number(round) || 1 };
}

export const agentName = (label: string) => {
  const { role } = parseLabel(label);
  return role ? ROLE_NAMES[role] : label;
};

/** Repère placé en tête de chaque consigne d'agent (sert aussi à la démo pour reconnaître le rôle). */
export const roleMarker = (role: Role) => `[Équipe de Clark — ${ROLE_NAMES[role]}]`;

export const draftFile = (parentId: number, round: number) => `equipe/${parentId}/brouillon-v${round}.md`;

// ── Consignes des agents ────────────────────────────────────────────────

export function chercheurPrompt(request: string): string {
  return `${roleMarker("chercheur")}
Tu es le Chercheur de l'équipe de Clark. Tu rassembles les faits utiles à la demande de Charles ; tu n'écris et ne modifies rien.
- Lis les sources disponibles : les fichiers de ton dossier de travail et la mémoire (outil recall).
- Rends une liste de faits, chacun avec sa source exacte (nom du fichier ou « mémoire »).
- Signale explicitement toute contradiction entre sources, sans trancher.
- N'invente rien. Si une information manque, écris qu'elle manque.

Demande de Charles : « ${request} »`;
}

export function redacteurPrompt(request: string, facts: string, round: number, file: string, previous?: { draft: string; points: string[] }): string {
  const correction = previous
    ? `

Le Relecteur a demandé des corrections sur ta version précédente. Corrige chacun de ces points :
${previous.points.map((p) => `- ${p}`).join("\n") || "- (aucun point précis : relis l'ensemble)"}

Ta version précédente :
${previous.draft}`
    : "";
  return `${roleMarker("redacteur")}
Tu es le Rédacteur de l'équipe de Clark. Tu rédiges le livrable demandé par Charles à partir des faits du Chercheur, et de rien d'autre.
- Une information contradictoire ou manquante reste « à confirmer » : tu ne choisis pas à la place de Charles.
- Écris le brouillon dans le fichier ${file}.
- Ta réponse finale est le brouillon complet, sans commentaire autour.

Demande de Charles : « ${request} »

Faits rassemblés par le Chercheur :
${facts}${correction}`;
}

export function relecteurPrompt(request: string, facts: string, draft: string, round: number): string {
  return `${roleMarker("relecteur")}
Tu es le Relecteur de l'équipe de Clark (relecture ${round} sur ${MAX_REVIEWS} au plus). Tu compares le brouillon à la demande de Charles et aux faits du Chercheur. Tu ne modifies rien toi-même.
Vérifie en particulier :
- chaque fait du brouillon figure dans les faits du Chercheur ;
- aucune information contradictoire n'est présentée comme sûre ;
- le brouillon répond à toute la demande.
Termine par une ligne exacte « VERDICT : OK » ou « VERDICT : À CORRIGER », suivie des points, un par ligne commençant par « - ». Avec OK, liste quand même ce qui reste à confirmer par Charles.

Demande de Charles : « ${request} »

Faits du Chercheur :
${facts}

Brouillon à relire :
${draft}`;
}

export type Verdict = { ok: boolean; points: string[] };

/** Lit le verdict du Relecteur. Sans verdict lisible, on considère qu'il faut corriger. */
export function parseVerdict(text: string): Verdict {
  const m = text.match(/VERDICT\s*:\s*(OK|[ÀA]\s*CORRIGER)/i);
  const after = m ? text.slice(m.index! + m[0].length) : text;
  const points = after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-•*]\s+/.test(l))
    .map((l) => l.replace(/^[-•*]\s+/, ""));
  if (!m) return { ok: false, points: ["Le Relecteur n'a pas donné de verdict lisible.", ...points] };
  return { ok: /^ok$/i.test(m[1]), points };
}

export function finalReport(draft: string, verdict: Verdict, reviews: number): string {
  const list = verdict.points.map((p) => `- ${p}`).join("\n");
  if (verdict.ok) {
    return `**Brouillon validé par le Relecteur** (${reviews} relecture${reviews > 1 ? "s" : ""})

${draft.trim()}

**Relecture :** OK.${list ? `\n\nÀ confirmer de ton côté :\n\n${list}` : ""}`;
  }
  return `**Brouillon arrêté après ${reviews} relectures** : le Relecteur n'est pas encore d'accord. Je te le montre tel quel plutôt que de tourner en rond.

${draft.trim()}

**Verdict du Relecteur :** à corriger.

Points encore ouverts :

${list || "- (non précisés)"}`;
}

/** Texte de l'alerte quand l'équipe est coupée pendant une écriture d'agent. */
export function teamCheckText(parent: Task, children: Task[], active: Task, uncertain: Step[]): string {
  const what = parent.prompt.length > 80 ? `${parent.prompt.slice(0, 80)}…` : parent.prompt;
  const done = children.filter((c) => c.status === "done" && c.label !== "plan").map(displayName);
  const kept = done.length ? `Déjà terminé, et conservé : ${[...new Set(done)].join(", ")}.` : "Aucun agent n'avait terminé.";
  const list = uncertain.map((s) => `- ${describeStep(s)}`).join("\n") || "- (étape inconnue)";
  return `J'ai été coupé pendant le travail de l'équipe sur « ${what} ».

${kept}
${displayName(active)} était en train d'écrire :
${list}

Cette écriture a peut-être déjà eu lieu. Je ne la refais pas sans toi : si tu reprends, ${displayName(active)} vérifie d'abord ce qui existe.`;
}

class TeamStop extends Error {
  readonly result: RunResult;
  readonly child: Task;
  constructor(result: RunResult, child: Task) {
    super(result.text);
    this.result = result;
    this.child = child;
  }
}

/** Nom affiché d'un agent : le repère en tête de sa consigne, sinon son rôle. */
export function displayName(task: Pick<Task, "label" | "prompt">): string {
  const m = task.prompt.match(/^\[Équipe de Clark — ([^\]]+)\]/);
  if (m) return m[1] === "Plan" ? "Clark (plan)" : m[1] === "Synthèse" ? "Clark (synthèse)" : m[1];
  return agentName(task.label);
}

/** Le résultat tardif d'une ancienne tentative : on l'ignore, la tentative en cours fait foi. */
export class StaleAttempt extends Error {}

/** Un moteur prêt à exécuter un agent. */
export type EngineChoice = { name: string; execute: typeof executeTask };

export function createTeam(o: {
  deps: Deps;
  execute: typeof executeTask;
  approverFor: (chatId: number, taskId: number, agent?: string) => Approver;
  /** Moteur attribué à un rôle (regard croisé : Codex rédige, Claude relit…). Absent : un seul moteur. */
  engineFor?: (role: string) => EngineChoice;
  /** Moteur par son nom, pour reprendre un agent sur celui qui l'a commencé. undefined : indisponible. */
  engineByName?: (name: string) => (typeof executeTask) | undefined;
}) {
  const { journal } = o.deps;
  const pick = (role: string): EngineChoice => o.engineFor?.(role) ?? { name: "", execute: o.execute };

  /**
   * Lance un agent, ou le reprend s'il a été coupé. Un agent terminé n'est jamais
   * relancé : son résultat, gardé dans le journal, est transmis tel quel aux suivants.
   * Chaque exécution est une tentative avec son identifiant : seul le résultat de la
   * tentative en cours est accepté.
   */
  async function agent(
    parent: Task,
    label: string,
    prompt: () => string,
    opts: { access?: Access; name?: string; role?: string } = {},
  ): Promise<string> {
    const existing = journal
      .children(parent.id)
      .filter((c) => c.label === label)
      .at(-1);
    if (existing?.status === "done") return existing.result ?? "";

    const role = parseLabel(label).role;
    const access: Access = opts.access ?? (role ? ROLE_ACCESS[role] : "read");
    let child: Task;
    let r: RunResult;
    let attempt: string;
    if (existing && (existing.status === "running" || existing.status === "needs_check")) {
      // Coupé en cours : il reprend sur sa propre session, dans une nouvelle tentative, et sur le
      // moteur qui l'a commencé (une session Codex ne se reprend pas avec Claude, et inversement).
      // Une écriture incertaine est d'abord vérifiée en lecture seule, puis il reprend.
      journal.expireApprovals(existing.id);
      child = existing;
      const execute = existing.engine && o.engineByName ? o.engineByName(existing.engine) : o.execute;
      if (!execute) {
        const text = `${displayName(existing)} avait commencé avec le moteur ${existing.engine}, qui n'est plus disponible : je ne peux pas reprendre sa session.`;
        journal.finish(existing.id, "failed", text, 0);
        throw new TeamStop({ text, costUsd: 0, status: "failed" }, journal.get(existing.id)!);
      }
      attempt = journal.startAttempt(child.id);
      r = await resumeVerified(execute, o.deps, journal.get(child.id)!, o.approverFor(parent.chat_id, child.id, opts.name ?? displayName(child)), {
        access,
        attempt,
      });
    } else {
      // Jamais lancé, ou échoué : un nouvel essai, avec une consigne neuve, sur le moteur de son rôle.
      const id = existing?.status === "queued" ? existing.id : journal.create(parent.chat_id, label, prompt(), parent.id);
      child = journal.get(id)!;
      const engine = pick(opts.role ?? role ?? "temporaire");
      if (engine.name) journal.setEngine(child.id, engine.name);
      attempt = journal.startAttempt(child.id);
      r = await engine.execute(o.deps, child.id, {
        prompt: child.prompt,
        resume: undefined,
        mode: "new",
        access,
        attempt,
        approve: o.approverFor(parent.chat_id, child.id, opts.name ?? displayName(child)),
      });
    }
    if (journal.get(child.id)?.attempt !== attempt) throw new StaleAttempt(`tentative remplacée (${label})`);
    if (r.status !== "done") throw new TeamStop(r, journal.get(child.id)!);
    return r.text;
  }

  /** L'équipe habituelle pour un écrit : Chercheur → Rédacteur ⇄ Relecteur, 2 relectures au plus. */
  async function standard(parent: Task, request: string): Promise<RunResult> {
    const facts = await agent(parent, "chercheur", () => chercheurPrompt(request));
    let draft = "";
    let verdict: Verdict = { ok: false, points: [] };
    let reviews = 0;
    for (let round = 1; round <= MAX_REVIEWS; round++) {
      const previous = round > 1 ? { draft, points: verdict.points } : undefined;
      draft = await agent(parent, `redacteur:${round}`, () => redacteurPrompt(request, facts, round, draftFile(parent.id, round), previous));
      const review = await agent(parent, `relecteur:${round}`, () => relecteurPrompt(request, facts, draft, round));
      verdict = parseVerdict(review);
      reviews = round;
      if (verdict.ok) break;
    }
    const text = finalReport(draft, verdict, reviews);
    journal.finish(parent.id, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  }

  /**
   * Plan composé par Clark : chaque spécialiste part dès que ses dépendances sont faites,
   * deux en même temps au plus s'ils sont en lecture seule. Les résultats déjà obtenus
   * sont gardés ; Clark fait la synthèse quand tout le monde a rendu son livrable.
   */
  async function planned(parent: Task, request: string, steps: PlanStep[]): Promise<RunResult> {
    const results = new Map<string, string>();
    for (const s of steps) {
      const c = journal
        .children(parent.id)
        .filter((x) => x.label === stepLabel(s.key))
        .at(-1);
      if (c?.status === "done") results.set(s.key, c.result ?? "");
    }
    while (results.size < steps.length) {
      const batch = nextBatch(steps, new Set(results.keys()), new Set());
      if (batch.length === 0) throw new Error("plan bloqué : aucun spécialiste ne peut partir");
      const outcomes = await Promise.allSettled(
        batch.map((s) =>
          agent(
            parent,
            stepLabel(s.key),
            () =>
              stepPrompt(
                request,
                s,
                s.dependsOn.map((d) => ({ step: steps.find((x) => x.key === d)!, result: results.get(d) ?? "" })),
                `equipe/${parent.id}/${s.key}.md`,
              ),
            { access: s.access, name: s.name, role: s.role },
          ),
        ),
      );
      // On garde tout ce qui a abouti, même si l'autre spécialiste du lot a échoué.
      outcomes.forEach((out, i) => {
        if (out.status === "fulfilled") results.set(batch[i].key, out.value);
      });
      const failures = outcomes.filter((x): x is PromiseRejectedResult => x.status === "rejected").map((x) => x.reason);
      if (failures.length) {
        // Une vérification à faire passe avant un échec simple : c'est elle qui demande Charles.
        throw failures.find((f) => f instanceof TeamStop && f.result.status === "needs_check") ?? failures[0];
      }
    }
    const synthesis = await agent(
      parent,
      "synthese",
      () => synthesisPrompt(request, steps.map((s) => ({ step: s, result: results.get(s.key) ?? "" }))),
      { access: "read", name: "Clark (synthèse)", role: "synthese" },
    );
    const team = steps.map((s) => `${s.name}${s.role === "temporaire" ? " (temporaire)" : ""}`).join(", ");
    const text = `**Équipe :** ${team}\n\n${synthesis.trim()}`;
    journal.finish(parent.id, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  }

  /** Déroule (ou reprend) le travail d'équipe. Rejouable : ce qui est fait est réutilisé. */
  async function run(parentId: number): Promise<RunResult> {
    const parent = journal.get(parentId);
    if (!parent) throw new Error(`Tâche ${parentId} introuvable`);
    journal.setStatus(parentId, "running");
    const request = parent.prompt;

    try {
      // Équipe commencée avant les plans (aucun plan, mais des agents) : on la finit telle quelle,
      // sans recomposer l'équipe par-dessus un travail en cours.
      const children = journal.children(parentId);
      if (children.length > 0 && !children.some((c) => c.label === "plan")) return await standard(parent, request);
      // 1. Clark compose l'équipe (en lecture seule). Le plan est gardé : une reprise ne le refait pas.
      const plan = parsePlan(await agent(parent, "plan", () => plannerPrompt(request), { access: "read", name: "Clark (plan)", role: "plan" }));
      return plan.kind === "graph" ? await planned(parent, request, plan.steps) : await standard(parent, request);
    } catch (err) {
      if (err instanceof StaleAttempt) throw err;
      if (!(err instanceof TeamStop)) throw err;
      const who = displayName(err.child);
      if (err.result.status === "needs_check") {
        const steps = journal.steps(err.child.id);
        const children = journal.children(parentId);
        const kept = [...new Set(children.filter((c) => c.status === "done").map(displayName))];
        // Vérification non concluante : on le dit tel quel, l'équipe attend Charles.
        const text = err.result.text.startsWith(INCONCLUSIVE)
          ? `L'équipe attend ta décision sur « ${parent.prompt.slice(0, 80)} ».${kept.length ? ` Déjà terminé, et conservé : ${kept.join(", ")}.` : ""}\n\n${who} — ${err.result.text}`
          : teamCheckText(parent, children, err.child, uncertainSteps(steps));
        journal.finish(parentId, "needs_check", text, 0);
        return { text, costUsd: 0, status: "needs_check" };
      }
      const text = `L'équipe s'est arrêtée : ${who} n'a pas pu finir.\n\n${err.result.text}`;
      journal.finish(parentId, "failed", text, 0);
      return { text, costUsd: 0, status: "failed" };
    }
  }

  return { run };
}
