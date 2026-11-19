import { continuePrompt, describeStep, parseVerification, resumePrompt, uncertainSteps, verifyPrompt, type Task } from "../tasks/journal.ts";
import type { Approver } from "../policy/permissions.ts";
import type { Deps, RunResult, executeTask } from "./agent.ts";

export const INCONCLUSIVE = "Vérification non concluante";

/**
 * Reprend une tâche coupée. S'il reste une écriture incertaine, la reprise se fait
 * en deux temps, et c'est le code qui l'impose, pas la consigne :
 * 1. vérification en lecture seule (toute écriture est refusée par le moteur), avec un
 *    constat explicite par écriture : FAIT, PAS FAIT ou PARTIEL ;
 * 2. seulement si chaque écriture est tranchée, reprise avec le droit d'écrire.
 * Constat absent, ambigu ou « indéterminé » : la tâche repasse « À vérifier », sans écrire.
 * Entre les deux temps, la tâche reste ouverte : une coupure là refait la vérification.
 */
export async function resumeVerified(
  execute: typeof executeTask,
  deps: Deps,
  task: Task,
  approve: Approver,
  opts: { access?: "read" | "write"; keepOpen?: boolean; attempt?: string } = {},
): Promise<RunResult> {
  const { journal } = deps;
  const steps = journal.steps(task.id);
  const done = steps.filter((s) => s.status === "done");
  const uncertain = uncertainSteps(steps);
  const resume = () => journal.get(task.id)?.session_id ?? undefined;

  if (uncertain.length === 0) {
    return execute(deps, task.id, { prompt: resumePrompt(task, done), resume: resume(), approve, mode: "recovery", ...opts });
  }

  const check = await execute(deps, task.id, {
    prompt: verifyPrompt(task, uncertain),
    resume: resume(),
    approve,
    mode: "recovery",
    access: "read",
    keepOpen: true,
    attempt: opts.attempt,
  });
  if (check.status !== "done") return check;

  const findings = parseVerification(check.text, uncertain.length).map((f, i) => ({ ...f, step: uncertain[i] }));
  const settled = findings.filter((f) => f.state !== "indéterminé");
  const open = findings.filter((f) => f.state === "indéterminé");
  // Ce qui est tranché est noté ; le reste reste incertain.
  journal.markVerified(settled.map((f) => ({ toolUseId: f.step.tool_use_id, note: `${f.state}${f.detail ? ` (${f.detail})` : ""}` })));

  if (open.length > 0) {
    const text = `${INCONCLUSIVE} : je ne sais toujours pas si ces écritures ont eu lieu.
${open.map((f) => `- ${describeStep(f.step)} : ${f.detail}`).join("\n")}

Constat rendu pendant la vérification :
${check.text.trim().slice(0, 1500)}

Je ne reprends pas l'écriture sans toi. Regarde de ton côté, puis Reprendre (nouvelle vérification) ou Abandonner.`;
    journal.finish(task.id, "needs_check", text, 0, opts.attempt);
    return { text, costUsd: 0, status: "needs_check" };
  }

  return execute(deps, task.id, {
    prompt: continuePrompt(task, done, findings),
    resume: resume(),
    approve,
    mode: "recovery",
    ...opts,
  });
}
