import type { EngineName } from "../config.ts";
import type { Hub } from "../core/hub.ts";
import { OWNER_CHAT } from "../core/hub.ts";
import { acceptDevTask, devSideLabel, discardDevTask, isWaitingSlot, setAsideDevTask, startDevTask, type DevOutcome } from "./runner.ts";
import { DEV_LABEL_PREFIX } from "./store.ts";

/**
 * Comparer : la même consigne confiée à deux agents (Claude et Codex, ou deux efforts), chacun
 * dans sa copie. Charles garde une version : elle est acceptée, l'autre est jetée.
 */

export type CompareSide = { engine: EngineName | null; model?: string | null; effort?: string | null };

const sameSide = (a: CompareSide, b: CompareSide) => (a.engine ?? null) === (b.engine ?? null) && (a.model ?? null) === (b.model ?? null) && (a.effort ?? null) === (b.effort ?? null);

export function startDevCompare(
  hub: Hub,
  input: { projectId: number; instruction: string; title?: string; issue?: { number: number; url: string }; sides: [CompareSide, CompareSide] },
): { ok: true; id: number; ids: [number, number] } | { ok: false; error: string } {
  const [a, b] = input.sides;
  if (sameSide(a, b)) return { ok: false, error: "Choisis deux agents différents (moteur, modèle ou effort)." };
  const first = startDevTask(hub, { projectId: input.projectId, instruction: input.instruction, title: input.title, issue: input.issue, engine: a.engine, model: a.model ?? null, effort: a.effort ?? null });
  if (!first.ok) return first;
  const second = startDevTask(hub, { projectId: input.projectId, instruction: input.instruction, title: input.title, issue: input.issue, engine: b.engine, model: b.model ?? null, effort: b.effort ?? null, compareWith: first.id });
  if (!second.ok) return second;
  return { ok: true, id: first.id, ids: [first.id, second.id] };
}

/** Depuis une tâche seule : la même consigne, confiée aussi à un autre agent. */
export function compareDevTask(hub: Hub, id: number, side: CompareSide): { ok: true; id: number } | { ok: false; error: string } {
  const { store } = hub.deps;
  const t = store.dev.get(id);
  if (!t) return { ok: false, error: "Tâche introuvable" };
  if (t.compare_with) return { ok: false, error: "Cette tâche est déjà comparée à une autre." };
  if (t.group_id || t.pr_of || t.existing_branch) return { ok: false, error: "Seule une tâche dev simple peut être comparée." };
  if (["accepted", "discarded"].includes(t.status)) return { ok: false, error: "Cette tâche est déjà tranchée." };
  if (sameSide(side, { engine: (t.engine as EngineName | null) ?? null, model: t.model, effort: t.effort })) return { ok: false, error: "Choisis un autre agent que celui de cette tâche." };
  return startDevTask(hub, {
    projectId: t.project_id,
    instruction: t.instruction,
    title: t.title,
    ...(t.issue_number ? { issue: { number: t.issue_number, url: t.issue_url ?? "" } } : {}),
    engine: side.engine,
    model: side.model ?? null,
    effort: side.effort ?? null,
    compareWith: id,
  });
}

/** « Garder celle-ci » : accepter cette version, jeter l'autre (arrêtée d'abord si elle travaille). */
export async function keepComparedTask(hub: Hub, id: number): Promise<DevOutcome> {
  const { store } = hub.deps;
  const t = store.dev.get(id);
  if (!t) return "missing";
  if (!t.compare_with) return { error: "Cette tâche n'est pas une comparaison." };
  if (t.status !== "review") return { error: "Cette version n'est pas prête : attends la fin de son tour." };
  const r = await acceptDevTask(hub, id);
  if (r !== "done") return r;
  const other = store.dev.get(t.compare_with);
  if (other && !["accepted", "discarded"].includes(other.status)) void dropOther(hub, other.id, t.id);
  return "done";
}

const settled = ["review", "failed"];

async function dropOther(hub: Hub, id: number, kept: number) {
  const { store, journal } = hub.deps;
  const end = Date.now() + 10 * 60_000;
  let asked = false;
  while (Date.now() < end) {
    const o = store.dev.get(id);
    if (!o || ["accepted", "discarded"].includes(o.status)) return;
    if (settled.includes(o.status) || o.status === "waiting") break;
    if (o.status === "working" && !asked) {
      if (isWaitingSlot(id)) {
        setAsideDevTask(id);
        asked = true;
      } else {
        const run = journal.lastByLabel(`${DEV_LABEL_PREFIX}${id}`);
        if (run && run.status === "running" && hub.stopTask(run.id) === "stopped") asked = true;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const r = await discardDevTask(hub, id);
  const o = store.dev.get(id)!;
  const keptTask = store.dev.get(kept)!;
  if (r === "done" || r === "already")
    await hub.post(OWNER_CHAT, `Comparaison tranchée : #${kept} (${devSideLabel(hub, keptTask)}) gardée, #${id} (${devSideLabel(hub, o)}) jetée.`, "system", "dev");
  else await hub.post(OWNER_CHAT, `#${kept} gardée, mais l'autre version #${id} n'a pas pu être jetée${typeof r === "object" ? ` : ${r.error}` : ""}. Jette-la dans Dev.`, "system", "dev");
}
