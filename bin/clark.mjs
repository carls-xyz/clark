#!/usr/bin/env node
// La commande « clark » : parler à Clark depuis le terminal (ou depuis un autre agent).
// Elle passe par l'interface locale de Clark (127.0.0.1). Elle ne donne JAMAIS d'accord et ne
// répond à aucune question à ta place : ça se fait sur le web, Telegram ou iMessage.
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.CLARK_WEB_PORT) || 4310;
const BASE = `http://127.0.0.1:${PORT}`;
const HELP = `clark — parler à Clark depuis le terminal

  clark "texte"                        envoie un message (comme dans la conversation)
  clark envoie "texte" [--equipe | --objectif] [--attendre]
  clark dev <projet> "consigne" [--parallele] [--moteur claude|codex] [--attendre]
  clark dev <projet> "#12"             part de l'issue GitHub #12
  clark taches                         ce qui tourne, ce qui t'attend
  clark attendre dev <id>              attend qu'une tâche dev soit à relire (ou arrêtée)
  clark etat                           moteur, quota, ce qui t'attend
  clark export [--memoire] [-o fichier]  la configuration, sans secrets

Options : --json (sortie pour un script ou un agent), --attendre (jusqu'à la réponse, 10 min au plus).
Les accords et les réponses aux questions ne se donnent pas ici : sur le web, Telegram ou iMessage.`;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0 || i === args.length - 1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const asJson = flag("--json");
const wait = flag("--attendre") || flag("--wait");

async function api(path, body) {
  let res;
  try {
    res = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) });
  } catch {
    fail(`Clark ne répond pas sur ${BASE} : est-il démarré ? (scripts/service.sh status)`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error || `erreur ${res.status}`);
  return data;
}

function fail(msg) {
  if (asJson) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
  else process.stderr.write(`clark : ${msg}\n`);
  process.exit(1);
}

const out = (human, data) => process.stdout.write(asJson ? JSON.stringify(data) + "\n" : human + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attend la réponse de Clark au message qu'on vient d'envoyer (10 minutes au plus). */
async function waitReply(sinceId, timeoutMs = 10 * 60_000) {
  const end = Date.now() + timeoutMs;
  let warned = false;
  while (Date.now() < end) {
    const s = await api("/api/state");
    const mine = s.messages.find((m) => m.id > sinceId && m.role === "user" && m.source === "cli");
    if (mine) {
      const reply = s.messages.find((m) => m.id > mine.id && m.role === "clark" && m.taskId === mine.taskId);
      if (reply) return reply;
      // Il attend ton accord ou ta réponse : on le dit, on n'y répond pas.
      if (!warned && (s.approvals.some((a) => a.taskId === mine.taskId) || s.questions.some((q) => q.taskId === mine.taskId))) {
        process.stderr.write("clark : il attend ton accord ou ta réponse (web, Telegram ou iMessage).\n");
        warned = true;
      }
    }
    await sleep(1500);
  }
  fail("pas de réponse dans les 10 minutes (la tâche continue : regarde dans l'interface)");
}

/** Attend qu'une tâche dev soit à relire, arrêtée ou décidée (une heure au plus). */
async function waitDev(id) {
  const end = Date.now() + 60 * 60_000;
  while (Date.now() < end) {
    const s = await api("/api/state");
    const t = [...(s.dev?.tasks ?? []), ...(s.dev?.groups ?? []).flatMap((g) => g.tasks)].find((x) => x.id === id);
    if (!t) fail(`tâche dev #${id} introuvable`);
    if (!["waiting", "preparing", "working"].includes(t.status))
      return out(`Tâche dev #${id} : ${t.status}${t.error ? ` — ${t.error}` : ""}\n${t.summary ?? ""}`.trim(), { id, status: t.status, summary: t.summary, error: t.error, branch: t.branch });
    await sleep(3000);
  }
  fail("toujours en cours après une heure");
}

async function main() {
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "aide" || cmd === "--help" || cmd === "-h") return out(HELP, { help: HELP });

  if (cmd === "etat" || cmd === "status") {
    const s = await api("/api/state");
    const waiting = s.approvals.length + s.questions.length + (s.mails ?? []).length + (s.gates ?? []).length;
    const main = (s.engines ?? []).find((e) => e.main);
    const w = main?.quota?.windows?.slice().sort((a, b) => b.usedPercent - a.usedPercent)[0];
    return out(
      `Moteur : ${s.clark.engine.name}${s.clark.engine.problem ? ` (problème : ${s.clark.engine.problem})` : ""}${w ? ` · ${w.label} : ${w.usedPercent} %` : ""}\nEn cours : ${s.running.length} · t'attend : ${waiting}${waiting ? " (web, Telegram ou iMessage)" : ""}`,
      { engine: s.clark.engine.name, problem: s.clark.engine.problem ?? null, running: s.running.length, waiting },
    );
  }

  if (cmd === "taches" || cmd === "tasks") {
    const s = await api("/api/state");
    const dev = [...(s.dev?.tasks ?? []), ...(s.dev?.groups ?? []).flatMap((g) => g.tasks)].filter((t) => ["waiting", "preparing", "working", "review", "failed"].includes(t.status));
    const lines = [
      ...s.running.map((t) => `#${t.id} en cours : ${t.prompt}${t.checkpoint ? `\n    ${t.checkpoint}` : ""}`),
      ...dev.map((t) => `dev #${t.id} (${t.project}) ${t.status} : ${t.title}`),
      ...s.approvals.map((a) => `accord demandé : ${a.summary.split("\n")[0]}`),
      ...s.questions.map((q) => `question : ${q.question}`),
    ];
    return out(lines.length ? lines.join("\n") : "Rien en cours, rien ne t'attend.", { running: s.running, dev, approvals: s.approvals.length, questions: s.questions.length });
  }

  if (cmd === "export") {
    const memory = flag("--memoire") || flag("--memory");
    const file = option("-o");
    const res = await fetch(`${BASE}/api/config/export${memory ? "?memory=1" : ""}`).catch(() => fail(`Clark ne répond pas sur ${BASE}`));
    const text = await res.text();
    if (!res.ok) fail(text);
    if (file) {
      writeFileSync(file, text);
      return out(`Configuration écrite dans ${file} (sans secrets).`, { file });
    }
    return process.stdout.write(text + "\n");
  }

  if (cmd === "attendre" && args[1] === "dev") {
    const id = Number(args[2]);
    if (!Number.isInteger(id)) fail("clark attendre dev <id>");
    return waitDev(id);
  }

  if (cmd === "dev") {
    const split = flag("--parallele") || flag("--split");
    const engine = option("--moteur") ?? option("--engine") ?? "";
    const [, project, ...rest] = args;
    const instruction = rest.join(" ").trim();
    if (!project || !instruction) fail('clark dev <projet> "consigne"');
    const s = await api("/api/state");
    const p = (s.dev?.projects ?? []).find((x) => x.name === project);
    if (!p) fail(`projet inconnu : ${project} (projets : ${(s.dev?.projects ?? []).map((x) => x.name).join(", ") || "aucun"})`);
    const r = await api("/api/dev/tasks", { projectId: p.id, instruction, engine, split });
    if (!wait || split) return out(`${split ? "Groupe" : "Tâche"} dev #${r.id} lancé${split ? "" : "e"} sur ${project}.${split ? "" : ` Pour attendre : clark attendre dev ${r.id}`}`, { id: r.id, group: split });
    return waitDev(r.id);
  }

  // Un message : « clark envoie "…" » ou directement « clark "…" ».
  const team = flag("--equipe") || flag("--team");
  const goal = flag("--objectif") || flag("--goal");
  const text = (cmd === "envoie" || cmd === "send" ? args.slice(1) : args).join(" ").trim();
  if (!text) fail("message vide");
  const before = await api("/api/state");
  const lastId = before.messages.at(-1)?.id ?? 0;
  const r = await api("/api/messages", { text, mode: goal ? "goal" : team ? "team" : "chat", source: "cli" });
  if (r.kind === "goal") return out(`Objectif #${r.id} lancé. Le suivi est dans l'interface.`, r);
  if (!wait) return out("Envoyé. La réponse arrive dans la conversation (ou ajoute --attendre).", { ok: true, kind: r.kind });
  const reply = await waitReply(lastId);
  return out(reply.text, { reply: reply.text, taskId: reply.taskId });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
