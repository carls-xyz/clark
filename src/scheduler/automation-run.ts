import { spawn } from "node:child_process";
import { paths, type EngineName } from "../config.ts";
import type { Hub } from "../core/hub.ts";
import { OWNER_CHAT } from "../core/hub.ts";
import { TEAM_LABEL } from "../core/team.ts";
import { startDevTask } from "../dev/runner.ts";
import { automationChat, type Automation } from "./automations.ts";
import { killTree } from "../core/kill-tree.ts";
import { loginShell } from "../core/platform.ts";

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Pré-vérification : ta commande, 60 secondes au plus. Code 0 : on lance ; sinon : on saute. */
export function runPrecheck(command: string, cwd: string, timeoutMs = 60_000): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(loginShell(), ["-lc", command], { cwd, env: { ...process.env, CI: "1" }, detached: true });
    let out = "";
    const keep = (d: Buffer) => (out = (out + d.toString()).slice(-1500));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      killTree(child);
      done({ ok: false, code: null, output: `${out}\n(arrêtée : plus de ${timeoutMs / 1000} s)` });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, code, output: out.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, code: null, output: err.message });
    });
  });
}

/**
 * Lance une automatisation (à l'heure prévue, ou sur « Lancer maintenant ») :
 * la pré-vérification d'abord, puis selon son type un message, l'équipe ou une tâche dev.
 * Chaque exécution est notée (lancée, sautée, en échec). Renvoie l'id de l'exécution.
 */
export async function launchAutomation(hub: Hub, a: Automation, opts: { slot?: string | null; manual?: boolean } = {}): Promise<number> {
  const { store, journal } = hub.deps;
  const runs = store.automations;
  const runId = runs.startRun(a.id, opts.slot ?? null, opts.manual === true);
  const project = a.kind === "dev" && a.project_id ? store.dev.project(a.project_id) : undefined;
  if (a.kind === "dev" && !project) {
    runs.updateRun(runId, { status: "failed", note: "Projet introuvable (retiré ?)." });
    return runId;
  }

  if (a.precheck) {
    const check = await runPrecheck(a.precheck, project?.path ?? paths.workspace);
    if (!check.ok) {
      runs.updateRun(runId, { status: "skipped", note: `Pré-vérification : ${check.code === null ? "pas aboutie" : `code ${check.code}`}${check.output ? ` — ${short(check.output.split("\n").at(-1) ?? "", 200)}` : ""}` });
      return runId;
    }
  }

  const engine = a.engine === "claude" || a.engine === "codex" ? (a.engine as EngineName) : null;
  if (a.kind === "dev") {
    const r = startDevTask(hub, { projectId: project!.id, instruction: a.prompt, title: `${a.name} (automatisation)`, engine });
    if (!r.ok) {
      runs.updateRun(runId, { status: "failed", note: r.error });
      return runId;
    }
    if (engine && (a.model || a.effort)) store.dev.update(r.id, { model: a.model, effort: a.effort });
    runs.updateRun(runId, { dev_task_id: r.id });
    await hub.post(OWNER_CHAT, `Automatisation « ${a.name} » : tâche dev #${r.id} lancée sur ${project!.name}. Tu la relis quand elle est prête.`, "system", "dev");
    return runId;
  }

  // Son propre fil, ou le calendrier : la tâche tourne hors de ta conversation.
  const own = a.thread === "own" || a.thread === "calendar";
  const calendar = a.thread === "calendar";
  const chatId = own ? automationChat(a.id) : OWNER_CHAT;
  let taskId: number | null = null;
  const done = hub.enqueue(chatId, a.prompt, a.kind === "team" ? TEAM_LABEL : "chat", `automation:${a.name}`, {
    onCreated: (id) => {
      taskId = id;
      runs.recordTask(a.id, id);
      runs.updateRun(runId, { task_id: id });
    },
    ...(engine ? { engine } : {}),
    ...(engine && a.model ? { model: a.model } : {}),
    ...(engine && a.effort ? { effort: a.effort } : {}),
  });
  // Dans son propre fil : le résultat t'est annoncé dans ta conversation, en une fois (sauf calendrier).
  if (own)
    void done.then(() => {
      const t = taskId ? journal.get(taskId) : undefined;
      if (!t) return;
      // Rien de neuf : noté dans l'historique de l'automatisation, sans te déranger.
      const said = journal.outcome(t.id);
      if (said.outcome === "quiet") return runs.updateRun(runId, { status: "skipped", note: "Rien de neuf." });
      if (said.outcome === "failed") {
        runs.updateRun(runId, { status: "failed", note: said.note ?? "Pas abouti." });
        // Calendrier : l'échec y est noté ; une ligne courte ici, pour ne pas le rater.
        return void hub.post(OWNER_CHAT, `Automatisation « ${a.name} » (pas abouti) : ${short(said.note ?? "raison non donnée", calendar ? 160 : 300)}`, "system", "system");
      }
      const ok = t.status === "done";
      // Calendrier : le compte rendu y reste, rien dans ta conversation. Un échec est quand même signalé.
      if (calendar) {
        if (!ok) void hub.post(OWNER_CHAT, `Automatisation « ${a.name} » : pas aboutie, le détail est dans le calendrier.`, "system", "system");
        return;
      }
      void hub.post(OWNER_CHAT, `Automatisation « ${a.name} »${ok ? "" : " (pas abouti)"} : ${short((t.result ?? "").trim() || "(pas de réponse)", 1500)}`, ok ? "clark" : "system", ok ? "reply" : "system");
    });
  return runId;
}
