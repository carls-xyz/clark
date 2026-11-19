import type { Hub } from "./hub.ts";
import { CATALOG, type CatalogRole } from "./plan.ts";
import { agentLabel, delegationsOf, missionPrompt, type Delegation } from "./delegation.ts";
import { NICKNAMES } from "./contacts.ts";
import { startDevTask } from "../dev/runner.ts";

/**
 * Exécute les missions que Clark confie à son équipe (outil delegate) et les tâches de code
 * (start_code_task). Hors de la file de la conversation : Clark l'occupe en attendant la réponse.
 * Deux missions à la fois au plus (Mac de 8 Go).
 */
const MAX_AT_ONCE = 2;

export async function runDelegation(hub: Hub, d: Delegation): Promise<void> {
  const { journal, store } = hub.deps;
  const delegations = delegationsOf(store.db);
  const parent = journal.get(d.task_id);
  if (!parent) return delegations.finish(d.id, "failed", "la demande de Clark n'existe plus");
  if (d.role === "code") {
    const projects = store.dev.projects();
    const wanted = d.project?.toLowerCase();
    const match = wanted ? projects.filter((p) => p.name.toLowerCase().includes(wanted)) : projects;
    if (match.length !== 1) {
      const list = projects.map((p) => p.name).join(", ") || "aucun";
      return delegations.finish(
        d.id,
        "failed",
        projects.length ? `Précise le projet (${list}).` : "Aucun projet de code n'est ajouté dans Clark : propose à Charles d'en ajouter un dans Dev › Projets.",
      );
    }
    const r = startDevTask(hub, { projectId: match[0].id, instruction: d.mission });
    if (!r.ok) return delegations.finish(d.id, "failed", `Tâche de code refusée : ${r.error}`);
    delegations.setChild(d.id, r.id);
    await hub.postAs(parent.chat_id, `Je m'y mets : tâche de code #${r.id} sur ${match[0].name}, sur sa propre branche. Tu relis le diff avant de garder quoi que ce soit.`, "code", parent.id);
    return delegations.finish(d.id, "done", `Tâche de code #${r.id} lancée par Boulon (Code) sur ${match[0].name}. Elle travaille en arrière-plan ; Charles sera prévenu quand elle sera prête à relire.`);
  }
  const role = d.role as CatalogRole;
  const childId = journal.create(parent.chat_id, role, missionPrompt(role, d.mission), parent.id);
  delegations.setChild(d.id, childId);
  const engine = hub.executorFor(role);
  if (engine.name) journal.setEngine(childId, engine.name);
  try {
    const r = await engine.execute(hub.deps, childId, {
      prompt: missionPrompt(role, d.mission),
      resume: undefined,
      mode: "new",
      access: CATALOG[role].access,
      approve: (req) => hub.approveTask(childId, req),
    });
    // La réponse de l'agent s'affiche dans la conversation, signée : on voit qui fait quoi.
    if (r.status === "done") await hub.postAs(parent.chat_id, r.text, role, parent.id);
    delegations.finish(d.id, r.status === "done" ? "done" : "failed", r.status === "done" ? r.text : `${NICKNAMES[role]} s'est arrêté : ${r.text}`);
  } catch (err) {
    delegations.finish(d.id, "failed", `${agentLabel(role)} : ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function startDelegations(hub: Hub): () => void {
  const delegations = delegationsOf(hub.deps.store.db);
  // Missions coupées par un redémarrage : Clark ne les attend plus (son tour a été coupé aussi).
  for (const d of delegations.running()) delegations.finish(d.id, "failed", "Clark a redémarré pendant la mission");
  let active = 0;
  const tick = () => {
    if (!hub.deps.store.db.isOpen) return clearInterval(timer);
    while (active < MAX_AT_ONCE) {
      const d = delegations.claim();
      if (!d) return;
      active++;
      void runDelegation(hub, d).finally(() => {
        active--;
        hub.touch();
      });
    }
  };
  const timer = setInterval(tick, 500);
  timer.unref();
  return () => clearInterval(timer);
}
