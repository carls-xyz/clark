import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EngineName } from "../config.ts";
import type { Hub } from "../core/hub.ts";
import { OWNER_CHAT } from "../core/hub.ts";
import { addWorktree, freshBase, git, removeWorktree } from "./git.ts";
import { devSlug, launchReady, startDevTask, worktreesDir, type DevOutcome } from "./runner.ts";
import { DEV_CRITIQUE_PREFIX, DEV_PLAN_PREFIX, devCritiqueChat, devGroupChat } from "./store.ts";
import { authorOf, otherEngine, planCritiquePrompt, planRevisePrompt } from "./binome.ts";
import { once } from "./in-flight.ts";

const run = promisify(execFile);
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const errText = (err: unknown) => {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).split("\n").slice(-3).join(" ").slice(0, 400);
};

/**
 * Deuxième passe du côté dev : une consigne découpée en sous-tâches que plusieurs agents
 * font en même temps, chacun dans sa copie ; puis les sous-tâches acceptées sont réunies
 * sur une branche ; puis une pull request, sur ton accord.
 */
export type PlannedTask = { title: string; instruction: string; files: string[]; after: number[] };
export type PlannedDecision = { question: string; options: string[]; tasks: number[] };

export function devPlanPrompt(projectName: string, dir: string, instruction: string): string {
  return `[Plan dev — projet ${projectName}]
Tu lis une copie du dépôt « ${projectName} », en lecture seule : ${dir}

Consigne de Charles : ${instruction}

Découpe cette consigne en 1 à 5 sous-tâches, chacune faite par un agent dans sa propre copie du dépôt.
- Les sous-tâches indépendantes tournent EN MÊME TEMPS : elles doivent toucher des fichiers différents, sinon leurs changements entreront en conflit quand on les réunira.
- Si une sous-tâche a besoin du résultat d'une autre (une API avant la page qui l'utilise), indique-le dans "after" avec les numéros des sous-tâches précédentes (la 1re est 1). Elle partira de leur travail une fois accepté par Charles. N'enchaîne que ce qui doit vraiment l'être.
- Si un choix de Charles change vraiment le travail (deux approches possibles), pose-le dans "decisions", avec 2 à 4 options et les sous-tâches qui en dépendent ; elles attendront sa réponse. Tout ce que tu peux décider seul, décide-le. Au plus 2 décisions.
Lis le projet autant qu'il faut pour savoir quels fichiers chaque sous-tâche touchera.

Réponds uniquement par ce JSON :
{"tasks":[{"title":"titre court","instruction":"consigne complète et autonome pour un agent qui ne voit pas les autres","files":["chemins concernés"],"after":[]}],"decisions":[{"question":"…","options":["…","…"],"tasks":[2]}]}`;
}

/** Le plan rendu par l'agent ; null s'il est illisible (on fait alors une seule sous-tâche). */
export function parseDevPlan(text: string | null | undefined): { tasks: PlannedTask[]; overlap: string[]; decisions: PlannedDecision[] } | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: any;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(data?.tasks) || data.tasks.length < 1 || data.tasks.length > 5) return null;
  const tasks: PlannedTask[] = [];
  for (const [i, t] of data.tasks.entries()) {
    if (typeof t?.instruction !== "string" || t.instruction.trim().length < 10) return null;
    // Une sous-tâche ne dépend que de sous-tâches d'avant : pas de boucle possible.
    const after = Array.isArray(t.after) ? [...new Set<number>(t.after.map(Number).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= i).map((n: number) => n - 1))] : [];
    tasks.push({
      title: short(String(t.title ?? t.instruction).trim(), 80),
      instruction: t.instruction.trim(),
      files: Array.isArray(t.files) ? t.files.filter((f: unknown): f is string => typeof f === "string").slice(0, 40) : [],
      after,
    });
  }
  // Seules des sous-tâches qui tournent en même temps peuvent entrer en conflit.
  const chained = (a: number, b: number): boolean => {
    const reach = (from: number, to: number): boolean => tasks[from].after.some((x) => x === to || reach(x, to));
    return reach(a, b) || reach(b, a);
  };
  const overlap = new Set<string>();
  tasks.forEach((t, i) => t.files.forEach((f) => tasks.forEach((u, j) => j > i && u.files.includes(f) && !chained(i, j) && overlap.add(f))));
  const decisions: PlannedDecision[] = (Array.isArray(data.decisions) ? data.decisions : [])
    .slice(0, 2)
    .flatMap((d: any) => {
      const options = Array.isArray(d?.options) ? d.options.filter((o: unknown): o is string => typeof o === "string" && o.trim().length > 0).map((o: string) => short(o.trim(), 120)).slice(0, 4) : [];
      const which = Array.isArray(d?.tasks) ? [...new Set<number>(d.tasks.map(Number).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= tasks.length).map((n: number) => n - 1))] : [];
      return typeof d?.question === "string" && d.question.trim().length >= 5 && options.length >= 2 && which.length ? [{ question: short(d.question.trim(), 300), options, tasks: which }] : [];
    });
  return { tasks, overlap: [...overlap], decisions };
}

export function startDevGroup(
  hub: Hub,
  input: { projectId: number; instruction: string; engine?: EngineName | null; title?: string; issue?: { number: number; url: string }; binome?: boolean },
): { ok: true; id: number } | { ok: false; error: string } {
  const { store, journal } = hub.deps;
  const p = store.dev.project(input.projectId);
  if (!p) return { ok: false, error: "Projet introuvable" };
  const instruction = input.instruction.trim();
  if (instruction.length < 10) return { ok: false, error: "Décris la tâche en une phrase au moins" };
  // Binôme : les deux moteurs doivent être là (l'un écrit, l'autre relit).
  if (input.binome && !hub.canRun("claude")) return { ok: false, error: "Binôme : Claude n'est pas connecté." };
  if (input.binome && !hub.canRun("codex")) return { ok: false, error: "Binôme : connecte d'abord Codex (Réglages › Moteurs)." };
  const stamp = Date.now().toString(36);
  const planDir = join(worktreesDir(), `plan-${p.name}-${stamp}`);
  // Binôme : Claude fait le plan, Codex le critique.
  const engine = (input.binome ? "claude" : (input.engine ?? p.default_engine ?? null)) as EngineName | null;
  const id = store.dev.createGroup({ projectId: p.id, title: short(input.title?.trim() || instruction.split("\n")[0], 80), instruction, engine, planWorktree: planDir });
  if (input.issue) store.dev.updateGroup(id, { issue_number: input.issue.number, issue_url: input.issue.url });
  if (input.binome) store.dev.updateGroup(id, { mode: "binome" });
  void (async () => {
    try {
      mkdirSync(worktreesDir(), { recursive: true });
      await git(p.path, ["worktree", "add", "--detach", planDir, p.base_branch]);
    } catch (err) {
      store.dev.updateGroup(id, { status: "failed", error: `Copie pour le plan impossible : ${errText(err)}` });
      return;
    }
    const label = `${DEV_PLAN_PREFIX}${id}`;
    await hub.enqueue(devGroupChat(id), devPlanPrompt(p.name, planDir, instruction), label, label, {
      access: "read",
      ...(engine ? { engine } : {}),
    });
    let result = journal.lastByLabel(label);
    // Binôme : Codex critique le plan dans la même copie, puis Claude le corrige (même fil, il garde son contexte).
    if (input.binome && result?.status === "done" && parseDevPlan(result.result)) {
      const critic = otherEngine("claude");
      const critLabel = `${DEV_CRITIQUE_PREFIX}${id}`;
      await hub.enqueue(devCritiqueChat(id), planCritiquePrompt(p.name, planDir, instruction, result.result!.slice(result.result!.indexOf("{"), result.result!.lastIndexOf("}") + 1), "claude"), critLabel, critLabel, {
        access: "read",
        engine: critic,
      });
      const critique = journal.lastByLabel(critLabel);
      if (critique?.status === "done" && critique.result?.trim()) {
        store.dev.updateGroup(id, { plan_note: critique.result.trim().slice(0, 4000) });
        await hub.enqueue(devGroupChat(id), planRevisePrompt(critic, critique.result), label, label, { access: "read", engine: "claude" });
        const revised = journal.lastByLabel(label);
        // Plan corrigé illisible : on garde le premier, qui était bon.
        if (revised?.status === "done" && parseDevPlan(revised.result)) result = revised;
        else result = journal.lastByLabel(label, 1) ?? result;
      }
    }
    await git(p.path, ["worktree", "remove", "--force", planDir]).catch(() => {});
    store.dev.updateGroup(id, { plan_worktree: null });
    const plan = result?.status === "done" ? parseDevPlan(result.result) : null;
    const tasks = plan?.tasks ?? [{ title: short(instruction.split("\n")[0], 80), instruction, files: [], after: [] }];
    const decisions = plan?.decisions ?? [];
    store.dev.updateGroup(id, {
      status: "running",
      error: !plan ? "Plan illisible : une seule sous-tâche, avec toute la consigne." : plan.overlap.length ? `Attention, sous-tâches sur les mêmes fichiers (${plan.overlap.slice(0, 5).join(", ")}) : conflits possibles à la réunion.` : null,
    });
    // Les sous-tâches qui attendent (dépendances, décisions) sont créées en attente, puis lancées quand tout est prêt.
    const gated = new Set(decisions.flatMap((d) => d.tasks));
    const ids: number[] = [];
    tasks.forEach((t, i) => {
      // Binôme : les auteurs alternent (Claude, Codex, Claude…), le relecteur est l'autre.
      const author = input.binome ? authorOf(i) : engine;
      const r = startDevTask(hub, {
        projectId: p.id,
        instruction: t.instruction,
        title: t.title,
        engine: author,
        groupId: id,
        dependsOn: t.after.map((a) => ids[a]),
        waiting: t.after.length > 0 || gated.has(i),
      });
      if (r.ok) {
        ids.push(r.id);
        if (input.binome && author) store.dev.update(r.id, { reviewer: otherEngine(author) });
      }
    });
    for (const d of decisions) store.dev.createGate({ groupId: id, question: d.question, options: d.options, taskIds: d.tasks.map((i) => ids[i]) });
    const now = tasks.filter((t, i) => !t.after.length && !gated.has(i)).length;
    const later = tasks.length - now;
    await hub.post(
      OWNER_CHAT,
      `${input.binome ? "Binôme" : "Groupe dev"} #${id} (${p.name}) : ${input.binome ? `plan de Claude relu par Codex, ` : ""}${now} sous-tâche${now > 1 ? "s" : ""} lancée${now > 1 ? "s" : ""}${later ? `, ${later} en attente${decisions.length ? ` (dont ${decisions.length} décision${decisions.length > 1 ? "s" : ""} à prendre dans Activité)` : " de celles dont elles dépendent"}` : ""}.`,
      "system", "dev");
  })();
  return { ok: true, id };
}

/**
 * Réunit les sous-tâches acceptées sur une nouvelle branche (fusions sans crochets). Un
 * conflit annule tout et liste les fichiers en cause : rien n'est laissé à moitié.
 */
export function integrateGroup(hub: Hub, id: number): Promise<DevOutcome> {
  return once(`integrate:${id}`, "already" as const, () => integrateGroupNow(hub, id));
}

async function integrateGroupNow(hub: Hub, id: number): Promise<DevOutcome> {
  const { store } = hub.deps;
  const g = store.dev.group(id);
  if (!g) return "missing";
  if (g.status !== "running") return "already";
  const tasks = store.dev.groupTasks(id);
  if (tasks.some((t) => !["accepted", "discarded"].includes(t.status))) return { error: "Accepte ou jette d'abord chaque sous-tâche." };
  const commits = tasks.filter((t) => t.status === "accepted" && t.commit);
  if (!commits.length) return { error: "Aucune sous-tâche acceptée avec des changements." };
  const p = store.dev.project(g.project_id)!;
  const stamp = Date.now().toString(36);
  const branch = `clark/${devSlug(g.title)}-${stamp}`;
  const dir = join(worktreesDir(), `reunion-${p.name}-${stamp}`);
  try {
    // Même point de départ à jour que les sous-tâches (dépôt distant récupéré si possible).
    await addWorktree(p.path, dir, branch, p.base_branch, (await freshBase(p.path, p.base_branch)).ref);
  } catch (err) {
    return { error: `Copie pour la réunion impossible : ${errText(err)}` };
  }
  // Une résolution de conflit acceptée contient déjà les sous-tâches qu'elle réunit : elle passe en premier,
  // et ce qu'elle contient n'est pas refusionné.
  const ordered = [...commits.filter((t) => t.merge_branch), ...commits.filter((t) => !t.merge_branch)];
  for (const t of ordered) {
    const already = await git(dir, ["merge-base", "--is-ancestor", t.commit!, "HEAD"]).then(() => true, () => false);
    if (already) continue;
    try {
      await git(dir, ["-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "--no-verify", "-m", `Réunit la sous-tâche #${t.id} : ${t.title}`, t.branch]);
    } catch (err) {
      const conflicts = (await git(dir, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim().split("\n").filter(Boolean);
      await git(dir, ["merge", "--abort"]).catch(() => {});
      // La branche de réunion (ce qui est déjà réuni) est gardée : un agent y résout le conflit.
      await removeWorktree(p.path, dir, branch, false).catch(() => {});
      if (!conflicts.length) {
        const why = errText(err);
        store.dev.updateGroup(id, { error: `Réunion impossible : ${why}.` });
        return { error: `Réunion impossible : ${why}.` };
      }
      const r = startDevTask(hub, {
        projectId: p.id,
        groupId: id,
        title: `Résoudre le conflit avec #${t.id}`,
        instruction: `Résous le conflit entre ce qui est déjà réuni du groupe « ${g.title} » et la sous-tâche #${t.id} (« ${t.title} ») sur ${conflicts.join(", ")}.`,
        onBranch: branch,
        mergeBranch: t.branch,
      });
      const why = `conflit entre sous-tâches sur ${conflicts.join(", ")}`;
      store.dev.updateGroup(id, { error: r.ok ? `Conflit sur ${conflicts.join(", ")} : un agent le résout (tâche #${r.id}). Accepte-la, puis réunis à nouveau.` : `Réunion impossible : ${why}.` });
      if (r.ok) await hub.post(OWNER_CHAT, `Groupe dev #${id} : ${why}. J'ai lancé un agent pour le résoudre (tâche #${r.id}). Relis-la, accepte-la, puis réunis à nouveau.`, "system", "dev");
      return r.ok ? "done" : { error: `Réunion impossible : ${why}.` };
    }
  }
  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  await removeWorktree(p.path, dir, branch, false).catch(() => {});
  store.dev.updateGroup(id, { status: "integrated", branch, commit_sha: sha, error: null });
  await hub.post(OWNER_CHAT, `Groupe dev #${id} réuni : ${commits.length} sous-tâche${commits.length > 1 ? "s" : ""} sur la branche ${branch} de ${p.name}.`, "system", "dev");
  return "done";
}

/** La réponse de Charles à une décision du plan : ajoutée à la consigne des sous-tâches concernées, qui partent si tout est prêt. */
export function resolveGate(hub: Hub, gateId: number, resolution: string): DevOutcome {
  const { store } = hub.deps;
  const g = store.dev.gate(gateId);
  if (!g) return "missing";
  const text = resolution.trim();
  if (text.length < 1 || text.length > 1000) return { error: "Écris ta décision (1000 caractères au plus)." };
  if (!store.dev.resolveGate(gateId, text)) return "already";
  for (const tid of g.task_ids) {
    const t = store.dev.get(tid);
    if (t && ["waiting", "failed", "review"].includes(t.status)) store.dev.update(tid, { instruction: `${t.instruction}\n\nDécision de Charles — ${g.question} : ${text}` });
  }
  launchReady(hub, g.group_id);
  void hub.post(OWNER_CHAT, `Groupe dev #${g.group_id} : décision prise (« ${short(g.question, 80)} » : ${short(text, 120)}).`, "system", "dev");
  return "done";
}

export function discardGroup(hub: Hub, id: number): DevOutcome {
  const { store } = hub.deps;
  const g = store.dev.group(id);
  if (!g) return "missing";
  if (store.dev.groupTasks(id).some((t) => ["waiting", "preparing", "working", "review", "failed"].includes(t.status))) return { error: "Jette ou accepte d'abord chaque sous-tâche." };
  if (g.status === "planning" || g.status === "discarded") return "already";
  store.dev.updateGroup(id, { status: "discarded" });
  return "done";
}

/** Au démarrage : un plan coupé ne reprend pas (sa copie est retirée), le groupe est en échec. */
export function startDevGroups(hub: Hub) {
  const { store } = hub.deps;
  for (const g of store.dev.groups(100).filter((x) => x.status === "planning")) {
    const p = store.dev.project(g.project_id);
    if (p && g.plan_worktree) void git(p.path, ["worktree", "remove", "--force", g.plan_worktree]).catch(() => git(p.path, ["worktree", "prune"]).catch(() => {}));
    store.dev.updateGroup(g.id, { status: "failed", plan_worktree: null, error: "Clark a été coupé pendant le plan : relance la tâche." });
  }
  // Une acceptation juste avant la coupure : ce qui attendait part maintenant.
  for (const g of store.dev.groups(100).filter((x) => x.status === "running")) launchReady(hub, g.id);
}

// ── Pull requests ──

/** Ce que la PR proposera par défaut (Charles le relit et le modifie avant d'envoyer). */
export function prDraft(hub: Hub, kind: "task" | "group", id: number): { title: string; body: string; branch: string; base: string } | null {
  const { store } = hub.deps;
  if (kind === "task") {
    const t = store.dev.get(id);
    if (!t || t.status !== "accepted" || !t.commit) return null;
    const p = store.dev.project(t.project_id)!;
    return {
      title: t.title,
      body: `${t.summary?.trim() || t.instruction}${t.issue_number ? `\n\nCloses #${t.issue_number}` : ""}\n\n---\nTâche dev #${t.id}, faite par Clark et relue par Charles.`,
      branch: t.branch,
      base: p.base_branch,
    };
  }
  const g = store.dev.group(id);
  if (!g || g.status !== "integrated" || !g.branch) return null;
  const p = store.dev.project(g.project_id)!;
  const parts = store.dev
    .groupTasks(id)
    .filter((t) => t.status === "accepted" && t.commit)
    .map((t) => `- ${t.title}${t.summary ? ` : ${short(t.summary.replace(/\s+/g, " "), 200)}` : ""}`);
  return {
    title: g.title,
    body: `${g.instruction}\n\nSous-tâches réunies :\n${parts.join("\n")}${g.issue_number ? `\n\nCloses #${g.issue_number}` : ""}\n\n---\nGroupe dev #${g.id}, fait par Clark et relu par Charles.`,
    branch: g.branch,
    base: p.base_branch,
  };
}

/**
 * Ouvre la pull request, sur le clic de Charles, avec le titre et le texte qu'il a relus :
 * envoi de la branche sur « origin » (sans crochets), puis `gh pr create`. Une seule fois.
 */
export function openPullRequest(hub: Hub, kind: "task" | "group", id: number, input: { title: string; body: string }): Promise<DevOutcome> {
  return once(`pr:${kind}:${id}`, "already" as const, () => openPullRequestNow(hub, kind, id, input));
}

async function openPullRequestNow(hub: Hub, kind: "task" | "group", id: number, input: { title: string; body: string }): Promise<DevOutcome> {
  const { store } = hub.deps;
  const draft = prDraft(hub, kind, id);
  if (!draft) return { error: kind === "task" ? "La PR s'ouvre sur une tâche acceptée avec des changements." : "La PR s'ouvre sur un groupe réuni." };
  const existing = kind === "task" ? store.dev.get(id)?.pr_url : store.dev.group(id)?.pr_url;
  if (existing) return "already";
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < 3 || title.length > 200) return { error: "Titre : 3 à 200 caractères." };
  if (body.length > 20_000) return { error: "Texte trop long." };
  const projectId = kind === "task" ? store.dev.get(id)!.project_id : store.dev.group(id)!.project_id;
  const p = store.dev.project(projectId)!;
  try {
    await git(p.path, ["remote", "get-url", "origin"]);
  } catch {
    return { error: "Ce dépôt n'a pas de dépôt distant « origin » : pas de PR possible." };
  }
  const gh = process.env.CLARK_GH_BIN?.trim() || "gh";
  try {
    await run(gh, ["auth", "status"], { cwd: p.path, timeout: 20_000 });
  } catch {
    return { error: "GitHub CLI pas connecté : lance « gh auth login » dans un terminal." };
  }
  try {
    await git(p.path, ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", "-u", "origin", draft.branch], { timeoutMs: 120_000 });
  } catch (err) {
    return { error: `Envoi de la branche impossible : ${errText(err)}` };
  }
  let url: string;
  try {
    const { stdout } = await run(gh, ["pr", "create", "--base", draft.base, "--head", draft.branch, "--title", title, "--body", body], { cwd: p.path, timeout: 60_000 });
    url = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    if (!/^https?:\/\//.test(url)) throw new Error(`réponse inattendue de gh : ${short(stdout.trim(), 200)}`);
  } catch (err) {
    return { error: `La branche est envoyée, mais la PR n'a pas pu s'ouvrir : ${errText(err)}` };
  }
  if (kind === "task") store.dev.update(id, { pr_url: url });
  else store.dev.updateGroup(id, { pr_url: url });
  await hub.post(OWNER_CHAT, `Pull request ouverte (${p.name}) : ${url}`, "system", "dev");
  return "done";
}
