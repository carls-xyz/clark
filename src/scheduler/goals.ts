import type { Hub } from "../core/hub.ts";
import { OWNER_CHAT } from "../core/hub.ts";
import { GOAL_LABEL_PREFIX, goalChat, sameProgress, type Goal, type GoalEvent } from "../core/goals.ts";
import { NEAR_LIMIT_PERCENT, tightest } from "../engines/quota.ts";

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Décision après un tour : continuer, objectif atteint, ou attendre l'utilisateur (avec la raison). */
export type GoalDecision = { action: "continue" } | { action: "done"; summary: string } | { action: "wait"; reason: string };

export function decideAfterTurn(s: {
  taskStatus: string | null;
  taskResult?: string | null;
  report: GoalEvent | undefined;
  previous: GoalEvent | undefined;
  /** Tours d'affilée, en comptant celui-ci, terminés sans compte rendu. */
  silentTurns: number;
  turns: number;
  maxTurns: number;
}): GoalDecision {
  if (s.taskStatus === "needs_check") return { action: "wait", reason: "le tour a été coupé en pleine écriture : vérifie-le dans Activité, puis reprends l'objectif" };
  if (s.taskStatus === "failed" || s.taskStatus === "abandoned")
    return { action: "wait", reason: `le tour a échoué${s.taskResult ? ` : ${short(s.taskResult.replace(/\s+/g, " "), 200)}` : ""}` };
  if (s.report?.kind === "done") return { action: "done", summary: s.report.text };
  if (s.report?.kind === "blocked") return { action: "wait", reason: `Clark a besoin de toi : ${s.report.text}` };
  if (!s.report && s.silentTurns >= 2) return { action: "wait", reason: "deux tours sans compte rendu : Clark tourne peut-être en rond" };
  if (s.report?.kind === "progress" && s.previous?.kind === "progress" && sameProgress(s.report.text, s.previous.text))
    return { action: "wait", reason: "deux tours qui disent la même chose : Clark tourne en rond" };
  if (s.turns >= s.maxTurns) return { action: "wait", reason: `limite de ${s.maxTurns} tours atteinte` };
  return { action: "continue" };
}

export function goalPrompt(g: Goal, events: GoalEvent[], turn: number): string {
  const history = events
    .filter((e) => e.kind !== "system")
    .slice(-12)
    .map((e) =>
      e.kind === "note"
        ? `- Charles : ${e.text}`
        : `- Tour ${e.turn}${e.kind === "blocked" ? " (bloqué)" : ""} : ${e.text}${e.next_step ? ` (prochaine étape : ${e.next_step})` : ""}`,
    );
  return `[Objectif de Clark #${g.id} — tour ${turn} sur ${g.max_turns}]
Objectif de Charles : ${g.objective}

Ce qui a été fait jusqu'ici :
${history.length ? history.join("\n") : "(premier tour)"}

Ce tour : avance concrètement vers l'objectif, une ou plusieurs étapes. Les actions qui sortent de ton dossier ou ont un effet passent par l'accord de Charles, comme d'habitude. Note où tu en es avec report_progress si le tour est long.

À la fin du tour, appelle report_goal une seule fois :
- status "progress" : ce que tu as fait pendant ce tour (concret, vérifiable) et la prochaine étape ;
- status "done" : l'objectif est atteint et c'est vérifiable ; résume ce qui a été fait et où trouver le résultat ;
- status "blocked" : il te manque une décision ou une information de Charles ; formule-la comme une question.
Si tu ne fais que répéter le tour précédent, réponds "blocked" et dis pourquoi.`;
}

// Un objectif n'est piloté qu'une fois à la fois, même si on clique deux fois sur « Reprendre ».
const driving = new Set<number>();

/**
 * Pilote un objectif : évalue le dernier tour, puis lance le suivant, tant qu'il reste actif.
 * Après un redémarrage, attend d'abord que le tour repris par la récupération soit fini.
 */
export async function driveGoal(hub: Hub, id: number): Promise<void> {
  if (driving.has(id)) return;
  driving.add(id);
  const { store, journal } = hub.deps;
  const label = `${GOAL_LABEL_PREFIX}${id}`;
  try {
    while (journal.unfinished().some((t) => t.label === label)) await sleep(2000);
    for (;;) {
      const g = store.goals.get(id);
      if (!g || g.status !== "active") return;

      if (g.turns > g.evaluated) {
        const task = journal.lastByLabel(label);
        let silent = 0;
        for (let t = g.turns; t >= 1 && !store.goals.reportOf(id, t); t--) silent++;
        const d = decideAfterTurn({
          taskStatus: task?.status ?? null,
          taskResult: task?.result ?? null,
          report: store.goals.reportOf(id, g.turns),
          previous: store.goals.reportOf(id, g.turns - 1),
          silentTurns: silent,
          turns: g.turns,
          maxTurns: g.max_turns,
        });
        store.goals.markEvaluated(id);
        if (d.action === "done") {
          store.goals.finish(id, d.summary);
          await hub.post(OWNER_CHAT, `Objectif atteint (#${id}) : « ${short(g.objective, 120)} »\n\n${d.summary}`, "clark");
          return;
        }
        if (d.action === "wait") return wait(hub, g, d.reason);
      }

      // Avant chaque tour : de la marge, un moteur, et du quota.
      if (g.turns >= g.max_turns) return wait(hub, g, `limite de ${g.max_turns} tours atteinte`);
      if (!hub.engine().ready) return wait(hub, g, "aucun moteur connecté");
      const tight = tightest(hub.quota());
      if (tight && tight.usedPercent >= NEAR_LIMIT_PERCENT) return wait(hub, g, `quota presque épuisé (${Math.round(tight.usedPercent)} % de la ${tight.label.toLowerCase()})`);

      const turn = store.goals.startTurn(id);
      await hub.enqueue(goalChat(id), goalPrompt(g, store.goals.events(id), turn), label, label);
    }
  } finally {
    driving.delete(id);
  }
}

async function wait(hub: Hub, g: Goal, reason: string) {
  if (!hub.deps.store.goals.setStatus(g.id, "waiting", reason, ["active"])) return;
  hub.deps.store.goals.addEvent({ goalId: g.id, turn: g.turns, kind: "system", text: `En attente : ${reason}` });
  await hub.post(OWNER_CHAT, `Objectif #${g.id} en attente (« ${short(g.objective, 100)} ») : ${reason}. Tu peux le reprendre dans Activité.`, "system");
}

export function createGoal(hub: Hub, objective: string, maxTurns?: number, source = "web"): number {
  const { store } = hub.deps;
  const id = store.goals.create(objective, maxTurns);
  store.goals.addEvent({ goalId: id, turn: 0, kind: "system", text: source === "clark" ? "Objectif lancé par Clark, seul (autonomie)" : `Objectif donné par toi (${source === "telegram" ? "Telegram" : "interface"})` });
  void hub.post(OWNER_CHAT, `Nouvel objectif #${id} : « ${short(objective.trim(), 200)} ». Clark enchaîne les tours ; tu suis dans Activité.`, "system");
  void driveGoal(hub, id);
  return id;
}

/** Pause, reprise (avec une réponse éventuelle de l'utilisateur) ou arrêt. */
export function controlGoal(hub: Hub, id: number, action: "pause" | "resume" | "stop", note?: string): "done" | "already" | "missing" {
  const { store } = hub.deps;
  const g = store.goals.get(id);
  if (!g) return "missing";
  if (action === "pause") return store.goals.setStatus(id, "paused", "mis en pause à ta demande", ["active", "waiting"]) ? "done" : "already";
  if (action === "stop") {
    if (!store.goals.setStatus(id, "stopped", "arrêté à ta demande", ["active", "waiting", "paused"])) return "already";
    store.goals.addEvent({ goalId: id, turn: g.turns, kind: "system", text: "Arrêté à ta demande" });
    return "done";
  }
  if (g.status !== "paused" && g.status !== "waiting") return "already";
  if (note?.trim()) store.goals.addEvent({ goalId: id, turn: g.turns, kind: "note", text: note.trim() });
  // Reprise après la limite de tours : quelques tours de plus. Le tour qui a bloqué ne compte plus.
  if (g.turns >= g.max_turns) store.goals.extend(id);
  store.goals.markEvaluated(id);
  store.goals.setStatus(id, "active", null, ["paused", "waiting"]);
  store.goals.addEvent({ goalId: id, turn: g.turns, kind: "system", text: "Repris à ta demande" });
  void driveGoal(hub, id);
  return "done";
}

/** Au démarrage : les objectifs actifs reprennent (après le tour éventuellement repris par la récupération). */
export function startGoals(hub: Hub) {
  for (const g of hub.deps.store.goals.byStatus("active")) void driveGoal(hub, g.id);
}
