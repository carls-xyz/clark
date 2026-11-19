import { MAX_REVIEWS, parseLabel, parseVerdict, ROLE_NAMES, ROLES } from "../core/team.ts";
import { MAX_PARALLEL, parsePlan, stepLabel } from "../core/plan.ts";
import { describeStep, type Task, type TaskJournal } from "../tasks/journal.ts";

/** Statut affiché d'un agent : coupé pendant une écriture, il reste « en cours » dans le journal mais attend Charles. */
function agentStatus(journal: TaskJournal, parent: Task, child: Task | undefined) {
  if (!child) return { status: "waiting", detail: null as string | null, checkpoint: null as string | null };
  const status = parent.status === "needs_check" && child.status === "running" ? "needs_check" : child.status;
  let detail: string | null = null;
  if (status === "running") {
    const last = journal.recentSteps(child.id, 1)[0];
    detail = last ? describeStep(last) : "réfléchit";
  }
  // Point d'étape de l'agent : ce qu'il dit de son avancement, plus parlant que sa dernière lecture.
  const checkpoint = status === "running" || status === "needs_check" || status === "failed" ? child.checkpoint : null;
  return { status, detail, checkpoint };
}

/**
 * Arbre de l'équipe : le plan, puis chaque agent avec son statut et sa dernière étape.
 * Plan composé par Clark : les spécialistes choisis, leurs dépendances, puis la synthèse.
 */
export function teamView(journal: TaskJournal, parent: Task, engineFor: (role: string) => string = () => "") {
  const children = journal.children(parent.id);
  const latest = (label: string) => children.filter((c) => c.label === label).at(-1);
  const planChild = latest("plan");
  const plan = planChild?.status === "done" ? parsePlan(planChild.result ?? "") : null;

  // Pas encore de plan : Clark compose l'équipe. (Une équipe d'avant les plans, déjà commencée, garde la vue habituelle.)
  if (!plan && (planChild || children.length === 0)) {
    const s = agentStatus(journal, parent, planChild);
    return {
      plan: "Clark compose l'équipe",
      agents: [
        {
          role: "plan",
          name: "Clark (plan)",
          round: null,
          status: s.status,
          detail: s.detail,
          checkpoint: s.checkpoint,
          after: null,
          temporary: false,
          engine: planChild?.engine ?? engineFor("plan"),
        },
      ],
    };
  }

  if (plan?.kind === "graph") {
    const names = new Map(plan.steps.map((st) => [st.key, st.name]));
    const synth = agentStatus(journal, parent, latest("synthese"));
    return {
      plan: `${plan.steps.length} spécialistes choisis par Clark · ${MAX_PARALLEL} en même temps au plus, en lecture seule`,
      agents: [
        ...plan.steps.map((st) => {
          const s = agentStatus(journal, parent, latest(stepLabel(st.key)));
          return {
            role: st.role,
            name: st.name,
            round: null,
            status: s.status,
            detail: s.detail,
            checkpoint: s.checkpoint,
            engine: latest(stepLabel(st.key))?.engine ?? engineFor(st.role),
            after: st.dependsOn.length ? `après ${st.dependsOn.map((d) => names.get(d)).join(" et ")}` : null,
            temporary: st.role === "temporaire",
          };
        }),
        {
          role: "synthese",
          name: "Synthèse de Clark",
          round: null,
          status: synth.status,
          detail: synth.detail,
          checkpoint: synth.checkpoint,
          engine: latest("synthese")?.engine ?? engineFor("synthese"),
          after: "après toute l'équipe",
          temporary: false,
        },
      ],
    };
  }

  // Équipe habituelle : Chercheur → Rédacteur ⇄ Relecteur.
  const reviews = children.filter((c) => parseLabel(c.label).role === "relecteur" && c.status === "done");
  const lastReview = reviews.at(-1);
  return {
    plan: `${ROLES.map((r) => ROLE_NAMES[r]).join(" → ")} · ${MAX_REVIEWS} relectures au plus`,
    agents: ROLES.map((role) => {
      const child = children.filter((c) => parseLabel(c.label).role === role).at(-1);
      const s = agentStatus(journal, parent, child);
      let detail = s.detail;
      if (role === "relecteur" && child?.status === "done" && lastReview) {
        const v = parseVerdict(lastReview.result ?? "");
        detail = v.ok ? "OK" : `à corriger : ${v.points.length} point${v.points.length > 1 ? "s" : ""}`;
      }
      return {
        role,
        name: ROLE_NAMES[role],
        round: role === "chercheur" || !child ? null : parseLabel(child.label).round,
        status: s.status,
        detail,
        checkpoint: s.checkpoint,
        engine: child?.engine ?? engineFor(role),
        after: null,
        temporary: false,
      };
    }),
  };
}
