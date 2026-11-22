import type { Hub } from "../core/hub.ts";
import { OWNER_CHAT } from "../core/hub.ts";
import type { DevTask } from "./store.ts";

/**
 * Pilote automatique (choisi par l'utilisateur au lancement d'une tâche de code, d'un groupe ou d'un
 * binôme) : Clark accepte seul une version prête dont les tests sont verts (et, en binôme, que
 * le relecteur a approuvée), réunit le groupe quand tout est accepté, puis ouvre la PR.
 * L'utilisateur ne valide qu'une fois : la fusion de la PR, sur GitHub. Clark ne fusionne jamais.
 *
 * Il s'arrête et rend la main dès que quelque chose demande un humain : tests rouges, désaccord
 * du binôme, relecture qui n'a pas abouti, décision à prendre, conflit qui ne se résout pas.
 */

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type AutopilotDeps = {
  accept: (hub: Hub, id: number) => Promise<unknown>;
  integrate: (hub: Hub, groupId: number) => Promise<unknown>;
  draft: (hub: Hub, kind: "task" | "group", id: number) => { title: string; body: string } | null;
  openPr: (hub: Hub, kind: "task" | "group", id: number, input: { title: string; body: string }) => Promise<unknown>;
};

export function isAutopilot(hub: Hub, t: Pick<DevTask, "autopilot" | "group_id">): boolean {
  if (t.autopilot) return true;
  return Boolean(t.group_id && hub.deps.store.dev.group(t.group_id)?.autopilot);
}

/** Pourquoi le pilote ne peut pas accepter cette version (null : il peut). */
export function autopilotBlocker(hub: Hub, t: DevTask): string | null {
  if (t.status !== "review") return "la tâche n'est pas prête";
  if (t.reviewer && t.review_state !== "approved") return t.review_state === "disagree" ? "les deux moteurs ne sont pas d'accord" : "la relecture croisée n'a pas abouti";
  const p = hub.deps.store.dev.project(t.project_id);
  if (p?.test_command) {
    const tests = t.tests ? (JSON.parse(t.tests) as { ok?: boolean; round?: number | null; timedOut?: boolean }) : null;
    if (!tests || tests.round !== t.rounds) return "les tests n'ont pas tourné sur cette version";
    if (!tests.ok) return tests.timedOut ? "les tests sont trop longs" : "les tests sont rouges";
  }
  return null;
}

const say = (hub: Hub, text: string) => hub.post(OWNER_CHAT, text, "system", "dev");

/** Une version vient d'être prête : le pilote l'accepte, ou rend la main en disant pourquoi. */
export async function autopilotReady(hub: Hub, id: number, deps: AutopilotDeps): Promise<void> {
  const { store } = hub.deps;
  const t = store.dev.get(id);
  if (!t || !isAutopilot(hub, t)) return;
  const name = `#${id} « ${short(t.title, 80)} »`;
  const blocker = autopilotBlocker(hub, t);
  if (blocker) {
    await say(hub, `Pilote automatique arrêté sur ${name} : ${blocker}. À toi de la relire dans Dev.`);
    return;
  }
  const r = await deps.accept(hub, id);
  if (r !== "done") {
    const why = typeof r === "object" && r && "error" in r ? String((r as { error: string }).error) : String(r);
    await say(hub, `Pilote automatique arrêté sur ${name} : l'acceptation a échoué (${short(why, 200)}).`);
    return;
  }
  const after = store.dev.get(id)!;
  if (after.group_id) return autopilotGroup(hub, after.group_id, deps);
  await openPr(hub, "task", id, deps);
}

/** Toutes les sous-tâches décidées : le pilote réunit le groupe, puis ouvre la PR. */
export async function autopilotGroup(hub: Hub, groupId: number, deps: AutopilotDeps): Promise<void> {
  const { store } = hub.deps;
  const g = store.dev.group(groupId);
  if (!g || !g.autopilot || g.status !== "running") return;
  const tasks = store.dev.groupTasks(groupId);
  // Il reste du travail (sous-tâches en cours, en attente d'une décision ou d'une dépendance) : rien à réunir.
  if (!tasks.length || tasks.some((x) => x.status !== "accepted" && x.status !== "discarded")) return;
  const r = await deps.integrate(hub, groupId);
  if (r !== "done") {
    // Un conflit crée une tâche de résolution dans le groupe : le pilote la reprendra quand elle sera prête.
    const why = typeof r === "object" && r && "error" in r ? String((r as { error: string }).error) : String(r);
    if (r !== "already") await say(hub, `Pilote automatique, groupe #${groupId} : réunion pas encore possible (${short(why, 200)}).`);
    return;
  }
  await openPr(hub, "group", groupId, deps);
}

async function openPr(hub: Hub, kind: "task" | "group", id: number, deps: AutopilotDeps) {
  const draft = deps.draft(hub, kind, id);
  if (!draft) return;
  const body = draft.body.replace(/, fait par Clark et relu par Charles\.$/, ", fait par Clark en pilote automatique (tests verts) : à relire par Charles avant de fusionner.").replace(/, faite par Clark et relue par Charles\.$/, ", faite par Clark en pilote automatique (tests verts) : à relire par Charles avant de fusionner.");
  const r = await deps.openPr(hub, kind, id, { title: draft.title, body });
  const label = kind === "task" ? `Tâche dev #${id}` : `Groupe #${id}`;
  if (r === "done") {
    const url = kind === "task" ? hub.deps.store.dev.get(id)?.pr_url : hub.deps.store.dev.group(id)?.pr_url;
    await say(hub, `Pilote automatique : ${label} terminé, PR ouverte${url ? ` : ${url}` : ""}. À toi de la relire et de la fusionner.`);
  } else {
    const why = typeof r === "object" && r && "error" in r ? String((r as { error: string }).error) : String(r);
    await say(hub, `Pilote automatique : ${label} accepté, mais la PR n'a pas pu s'ouvrir (${short(why, 200)}). Ouvre-la depuis Dev.`);
  }
}
