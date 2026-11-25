import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { executeTask, RunOptions } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { acceptDevTask, addProject, devPatch, discardDevTask, retouchDevTask, retryDevTask, runDevTests, startDevTask, unblockDevTask } from "../src/dev/runner.ts";
import { onStop } from "../src/core/stops.ts";
import { DevStore } from "../src/dev/store.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const root = mkdtempSync(join(tmpdir(), "clark-dev-"));
// Les copies des tests vont dans le dossier temporaire, pas dans le vrai dossier de travail.
process.env.CLARK_DEV_DIR = join(root, "worktrees");
after(() => rmSync(root, { recursive: true, force: true }));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Un petit dépôt : main avec un fichier, et un crochet pre-commit piégé. */
function repo(name: string) {
  const dir = join(root, name);
  execFileSync("mkdir", ["-p", dir]);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "app.txt"), "ligne 1\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "départ");
  writeFileSync(join(dir, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch ${join(root, `hook-${name}`)}\n`);
  chmodSync(join(dir, ".git/hooks/pre-commit"), 0o755);
  return dir;
}

const config: Config = {
  telegram: null,
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: 0,
  model: "m",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
};

const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "condition jamais atteinte");
};

/** Un faux agent : modifie et crée des fichiers dans son dossier de travail (opts.cwd). */
function setup(agent: (cwd: string, prompt: string) => { status?: "done" | "failed"; result?: string } = () => ({})) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: { engine: string; cwd?: string; prompt: string; resume?: string; model?: string | null; effort?: string | null }[] = [];
  const fake = (engine: string) =>
    (async (deps: any, taskId: number, opts: RunOptions) => {
      runs.push({ engine, cwd: opts.cwd, prompt: opts.prompt, resume: opts.resume, model: opts.model, effort: opts.effort });
      const r = agent(opts.cwd!, opts.prompt);
      deps.store.setSession(deps.journal.get(taskId).chat_id, `session-${taskId}`);
      const status = r.status ?? "done";
      deps.journal.finish(taskId, status, status === "done" ? (r.result ?? "J'ai ajouté hello.txt et complété app.txt.") : "Erreur de l'agent", 0);
      return { text: "fini", costUsd: 0, status };
    }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute: fake("claude"), executors: { claude: fake("claude"), codex: fake("codex") } });
  return { store, journal, conversation, hub, runs };
}

test("projet : un vrai dépôt git, à sa racine, avec une branche qui existe", async () => {
  const dir = repo("valide");
  const { hub } = setup();
  assert.equal((await addProject(hub, { name: "Pas Bon", path: dir }) as any).field, "name");
  assert.equal((await addProject(hub, { name: "x", path: "relatif/chemin" }) as any).field, "path");
  assert.match((await addProject(hub, { name: "x", path: root }) as any).error, /pas un dépôt git/);
  execFileSync("mkdir", ["-p", join(dir, "sous")]);
  assert.match((await addProject(hub, { name: "x", path: join(dir, "sous") }) as any).error, /racine du dépôt/);
  assert.match((await addProject(hub, { name: "x", path: dir, baseBranch: "nope" }) as any).error, /Branche introuvable/);
  const ok = await addProject(hub, { name: "valide", path: dir });
  assert.ok(ok.ok);
  assert.equal(hub.deps.store.dev.project((ok as any).id)!.base_branch, "main", "branche par défaut détectée");
  assert.match((await addProject(hub, { name: "autre", path: dir }) as any).error, /déjà un projet/);
});

test("tâche dev : l'agent travaille dans sa copie, l'utilisateur relit le diff, accepte → commit sur la branche, sans crochet", async () => {
  const dir = repo("site");
  const { hub, store, conversation, runs } = setup((cwd) => {
    writeFileSync(join(cwd, "hello.txt"), "bonjour\n");
    writeFileSync(join(cwd, "app.txt"), "ligne 1\nligne 2\n");
    return {};
  });
  const p = (await addProject(hub, { name: "site", path: dir, testCommand: "grep -q 'ligne 2' app.txt" })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Ajoute un fichier hello et complète app.txt", engine: "codex" }) as any;
  await until(() => store.dev.get(r.id)!.status === "review");
  const t = store.dev.get(r.id)!;

  assert.equal(runs[0].engine, "codex", "le moteur choisi pour la tâche");
  assert.equal(runs[0].cwd, t.worktree, "l'agent travaille dans la copie");
  assert.match(runs[0].prompt, /Ne modifie que les fichiers de cette copie/);
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "ligne 1\n", "le dépôt d'origine n'est pas touché");
  const stat = JSON.parse(t.diff_stat!);
  assert.deepEqual(stat.files.map((f: any) => [f.path, f.status]).sort(), [["app.txt", "modifié"], ["hello.txt", "ajouté"]]);
  assert.match((await devPatch(hub, r.id))!, /\+bonjour/);
  assert.ok(conversation.recent(OWNER_CHAT).some((m) => /Tâche dev #\d+ prête à relire \(site\).*2 fichiers \(\+2 −0\)/.test(m.text)));

  assert.equal(await runDevTests(hub, r.id), "done");
  assert.equal(JSON.parse(store.dev.get(r.id)!.tests!).ok, true);

  assert.equal(await acceptDevTask(hub, r.id), "done");
  assert.equal(await acceptDevTask(hub, r.id), "already", "une seule fois");
  const done = store.dev.get(r.id)!;
  assert.equal(done.status, "accepted");
  assert.ok(!existsSync(done.worktree), "copie retirée");
  assert.equal(sh(dir, "show", `${t.branch}:hello.txt`), "bonjour", "commit sur la branche clark/…");
  assert.equal(sh(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "ligne 1\n", "main reste intacte");
  assert.ok(!existsSync(join(root, "hook-site")), "le crochet pre-commit du dépôt n'a pas tourné");
});

test("tâche dev : retouche dans la même copie et la même session, puis Jeter supprime copie et branche", async () => {
  const dir = repo("api");
  let round = 0;
  const { hub, store, runs } = setup((cwd) => {
    writeFileSync(join(cwd, "app.txt"), round++ === 0 ? "v1\n" : "v2\n");
    return {};
  });
  const p = (await addProject(hub, { name: "api", path: dir })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Change le contenu de app.txt" }) as any;
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.equal(retouchDevTask(hub, r.id, "Mets v2 à la place"), "done");
  assert.equal(retouchDevTask(hub, r.id, "encore"), "already", "pas deux retouches en même temps");
  await until(() => store.dev.get(r.id)!.status === "review" && store.dev.get(r.id)!.rounds === 2);
  assert.match(runs[1].prompt, /^Retouche demandée par Charles/);
  assert.equal(runs[1].cwd, runs[0].cwd);
  assert.ok(runs[1].resume?.startsWith("session-"), "reprend la session de l'agent");
  assert.match((await devPatch(hub, r.id))!, /\+v2/);

  const t = store.dev.get(r.id)!;
  assert.equal(await discardDevTask(hub, r.id), "done");
  assert.ok(!existsSync(t.worktree));
  assert.equal(sh(dir, "branch", "--list", t.branch), "", "branche supprimée");
  assert.equal(store.dev.removeProject(p.id), "done", "plus de tâche ouverte : le projet se retire");
});

test("tâche dev : un agent qui échoue laisse la tâche en échec, retouchable ; tests en échec signalés", async () => {
  const dir = repo("echec");
  let fail = true;
  const { hub, store } = setup(() => ({ status: fail ? "failed" : "done" }));
  const p = (await addProject(hub, { name: "echec", path: dir, testCommand: "exit 3" })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Une tâche qui va échouer d'abord" }) as any;
  await until(() => store.dev.get(r.id)!.status === "failed");
  assert.match(store.dev.get(r.id)!.error!, /pas fini/);
  assert.equal(store.dev.removeProject(p.id), "busy");
  fail = false;
  retouchDevTask(hub, r.id, "Réessaie");
  await until(() => store.dev.get(r.id)!.status === "review");
  await runDevTests(hub, r.id);
  const tests = JSON.parse(store.dev.get(r.id)!.tests!);
  assert.equal(tests.ok, false);
  assert.equal(tests.code, 3);
  assert.ok(startDevTask(hub, { projectId: 999, instruction: "projet qui n'existe pas" }).ok === false);
});

// ── Deuxième passe : groupes en parallèle, réunion, pull request ──

const { parseDevPlan, startDevGroup, integrateGroup, openPullRequest, prDraft, resolveGate } = await import("../src/dev/groups.ts");

test("plan dev : JSON lu dans la réponse, 1 à 5 sous-tâches, chevauchements signalés", () => {
  const plan = parseDevPlan('Voici le plan :\n{"tasks":[{"title":"CSS","instruction":"Fonce le texte secondaire","files":["style.css"]},{"title":"HTML","instruction":"Ajoute un titre de section","files":["index.html","style.css"]}]}');
  assert.deepEqual(plan!.tasks.map((t) => t.title), ["CSS", "HTML"]);
  assert.deepEqual(plan!.overlap, ["style.css"]);
  assert.equal(parseDevPlan("pas de JSON"), null);
  assert.equal(parseDevPlan('{"tasks":[]}'), null);
  assert.equal(parseDevPlan('{"tasks":[{"instruction":"court"}]}'), null);
  assert.equal(parseDevPlan(`{"tasks":${JSON.stringify(Array(6).fill({ instruction: "une consigne assez longue" }))}}`), null);
});

/** Faux agents : celui du plan rend le plan donné ; chaque sous-tâche écrit son fichier. */
function groupSetup(plan: object, write: (cwd: string, prompt: string) => void) {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  let running = 0;
  let peak = 0;
  const execute = (async (deps: any, taskId: number, opts: RunOptions) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 60));
    let text = "Fait.";
    if (opts.prompt.startsWith("[Plan dev")) {
      assert.equal(opts.access, "read", "l'agent de plan ne fait que lire");
      text = JSON.stringify(plan);
    } else write(opts.cwd!, opts.prompt);
    running--;
    deps.journal.finish(taskId, "done", text, 0);
    return { text, costUsd: 0, status: "done" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute });
  return { store, hub, conversation, peak: () => peak };
}

test("groupe : plan, sous-tâches en parallèle (2 au plus), puis réunion sur une branche", async () => {
  const dir = repo("groupe");
  const plan = {
    tasks: [
      { title: "CSS", instruction: "Écris le fichier a.txt avec A", files: ["a.txt"] },
      { title: "HTML", instruction: "Écris le fichier b.txt avec B", files: ["b.txt"] },
      { title: "Doc", instruction: "Écris le fichier c.txt avec C", files: ["c.txt"] },
    ],
  };
  const { store, hub, peak } = groupSetup(plan, (cwd, prompt) => {
    const f = prompt.match(/fichier (\w\.txt) avec (\w)/)!;
    writeFileSync(join(cwd, f[1]), `${f[2]}\n`);
  });
  const p = (await addProject(hub, { name: "groupe", path: dir })) as any;
  const g = startDevGroup(hub, { projectId: p.id, instruction: "Ajoute trois fichiers au projet" }) as any;
  await until(() => store.dev.groupTasks(g.id).length === 3 && store.dev.groupTasks(g.id).every((t) => t.status === "review"));
  assert.equal(store.dev.group(g.id)!.status, "running");
  assert.ok(peak() <= 2, `au plus 2 agents à la fois (vu : ${peak()})`);
  assert.equal(store.dev.group(g.id)!.plan_worktree, null, "copie du plan retirée");
  assert.equal(store.dev.list().length, 0, "les sous-tâches ne sont pas listées comme tâches seules");

  assert.deepEqual(await integrateGroup(hub, g.id), { error: "Accepte ou jette d'abord chaque sous-tâche." });
  const [a, b, c] = store.dev.groupTasks(g.id);
  await acceptDevTask(hub, a.id);
  await acceptDevTask(hub, b.id);
  await discardDevTask(hub, c.id);
  assert.equal(await integrateGroup(hub, g.id), "done");
  const grp = store.dev.group(g.id)!;
  assert.equal(grp.status, "integrated");
  assert.equal(sh(dir, "show", `${grp.branch}:a.txt`), "A");
  assert.equal(sh(dir, "show", `${grp.branch}:b.txt`), "B");
  assert.throws(() => sh(dir, "show", `${grp.branch}:c.txt`), "la sous-tâche jetée n'y est pas");
  assert.equal(sh(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.ok(!existsSync(join(root, "hook-groupe")), "aucun crochet n'a tourné pendant la réunion");
  assert.equal(await integrateGroup(hub, g.id), "already");
});

test("groupe : deux sous-tâches qui changent le même fichier → un agent résout le conflit, puis la réunion passe", async () => {
  const dir = repo("conflit");
  const plan = { tasks: [{ title: "Un", instruction: "Mets UN dans app.txt" }, { title: "Deux", instruction: "Mets DEUX dans app.txt" }] };
  const { store, hub } = groupSetup(plan, (cwd, prompt) => writeFileSync(join(cwd, "app.txt"), prompt.includes("UN dans") ? "UN\n" : "DEUX\n"));
  const p = (await addProject(hub, { name: "conflit", path: dir })) as any;
  const g = startDevGroup(hub, { projectId: p.id, instruction: "Change app.txt de deux façons" }) as any;
  await until(() => store.dev.groupTasks(g.id).length === 2 && store.dev.groupTasks(g.id).every((t) => t.status === "review"));
  for (const t of store.dev.groupTasks(g.id)) await acceptDevTask(hub, t.id);
  assert.equal(await integrateGroup(hub, g.id), "done");
  assert.match(store.dev.group(g.id)!.error ?? "", /Conflit sur app\.txt : un agent le résout/);
  assert.equal(store.dev.group(g.id)!.status, "running");
  // L'agent de résolution reçoit la fusion en conflit et retire les marqueurs.
  await until(() => store.dev.groupTasks(g.id).some((t) => t.merge_branch && t.status === "review"));
  const fix = store.dev.groupTasks(g.id).find((t) => t.merge_branch)!;
  const resolved = readFileSync(join(fix.worktree, "app.txt"), "utf8");
  assert.match(resolved, /^(UN|DEUX)\n$/, "plus de marqueur de conflit");
  assert.equal(await acceptDevTask(hub, fix.id), "done");
  assert.equal(await integrateGroup(hub, g.id), "done");
  assert.equal(store.dev.group(g.id)!.status, "integrated");
  assert.equal(sh(dir, "show", `${store.dev.group(g.id)!.branch}:app.txt`), resolved.trim(), "la résolution est gardée, sans refusionner les sous-tâches");
});

test("pull request : la branche part sur origin (sans crochet), gh reçoit le titre et le texte relus, une seule fois", async () => {
  const dir = repo("pr");
  const bare = join(root, "pr-remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  sh(dir, "remote", "add", "origin", bare);
  writeFileSync(join(dir, ".git/hooks/pre-push"), `#!/bin/sh\ntouch ${join(root, "hook-pr-push")}\nexit 1\n`);
  chmodSync(join(dir, ".git/hooks/pre-push"), 0o755);
  const ghLog = join(root, "gh-args.txt");
  const fakeGh = join(root, "fake-gh");
  writeFileSync(fakeGh, `#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\nprintf '%s\\n' "$@" > ${ghLog}\necho https://github.com/exemple/pr/pull/7\n`);
  chmodSync(fakeGh, 0o755);
  process.env.CLARK_GH_BIN = fakeGh;

  const { hub, store } = setup((cwd) => {
    writeFileSync(join(cwd, "hello.txt"), "bonjour\n");
    return {};
  });
  const p = (await addProject(hub, { name: "pr", path: dir })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Ajoute un fichier hello" }) as any;
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.equal(prDraft(hub, "task", r.id), null, "pas de PR avant d'accepter");
  await acceptDevTask(hub, r.id);
  const draft = prDraft(hub, "task", r.id)!;
  assert.match(draft.body, /Tâche dev #\d+, faite par Clark/);
  assert.equal(await openPullRequest(hub, "task", r.id, { title: "Ajoute hello", body: "Texte relu par Charles" }), "done");
  const t = store.dev.get(r.id)!;
  assert.equal(t.pr_url, "https://github.com/exemple/pr/pull/7");
  assert.ok(execFileSync("git", ["ls-remote", bare, t.branch], { encoding: "utf8" }).includes(t.branch), "branche envoyée sur origin");
  assert.ok(!existsSync(join(root, "hook-pr-push")), "le crochet pre-push n'a pas tourné");
  const args = readFileSync(ghLog, "utf8").split("\n");
  assert.deepEqual(args.slice(0, 2), ["pr", "create"]);
  assert.equal(args[args.indexOf("--title") + 1], "Ajoute hello");
  assert.equal(args[args.indexOf("--body") + 1], "Texte relu par Charles");
  assert.equal(args[args.indexOf("--base") + 1], "main");
  assert.equal(await openPullRequest(hub, "task", r.id, { title: "Encore", body: "x" }), "already");
  delete process.env.CLARK_GH_BIN;
});


test("plan dev : dépendances seulement vers des sous-tâches d'avant (pas de boucle), décisions lues, chevauchement ignoré si enchaîné", () => {
  const plan = parseDevPlan(
    JSON.stringify({
      tasks: [
        { title: "API", instruction: "Écris l'API de contact", files: ["api.ts"] },
        { title: "Page", instruction: "Écris la page qui appelle l'API", files: ["page.ts", "api.ts"], after: [1, 1, 3, 0] },
        { title: "Tests", instruction: "Écris les tests de la page", files: ["page.ts"], after: [2] },
      ],
      decisions: [
        { question: "Toast ou fenêtre pour l'erreur ?", options: ["Toast", "Fenêtre", ""], tasks: [2, 9] },
        { question: "x", options: ["a", "b"], tasks: [1] },
        { question: "Une seule option possible ?", options: ["a"], tasks: [1] },
      ],
    }),
  )!;
  assert.deepEqual(
    plan.tasks.map((t) => t.after),
    [[], [0], [1]],
    "« 3 » (plus loin) et « 0 » ignorés, doublons retirés",
  );
  assert.deepEqual(plan.overlap, [], "api.ts et page.ts sont touchés par des sous-tâches enchaînées : pas de conflit");
  assert.deepEqual(plan.decisions, [{ question: "Toast ou fenêtre pour l'erreur ?", options: ["Toast", "Fenêtre"], tasks: [1] }]);
});

test("groupe : une sous-tâche attend celle dont elle dépend ET ta décision, puis part de son travail", async () => {
  const dir = repo("chaine");
  const plan = {
    tasks: [
      { title: "API", instruction: "Écris le fichier api.txt avec API", files: ["api.txt"] },
      { title: "Page", instruction: "Écris le fichier page.txt avec PAGE", files: ["page.txt"], after: [1] },
      { title: "Doc", instruction: "Écris le fichier doc.txt avec DOC", files: ["doc.txt"] },
    ],
    decisions: [{ question: "Titre de la page ?", options: ["Contact", "Me contacter"], tasks: [2] }],
  };
  const prompts: string[] = [];
  const { store, hub } = groupSetup(plan, (cwd, prompt) => {
    prompts.push(prompt);
    const f = prompt.match(/fichier (\w+\.txt) avec (\w+)/)!;
    writeFileSync(join(cwd, f[1]), `${f[2]}\n`);
  });
  const p = (await addProject(hub, { name: "chaine", path: dir })) as any;
  const g = startDevGroup(hub, { projectId: p.id, instruction: "Ajoute une API et sa page" }) as any;
  await until(() => store.dev.groupTasks(g.id).filter((t) => t.status === "review").length === 2);
  const [api, page, doc] = store.dev.groupTasks(g.id);
  assert.equal(page.status, "waiting");
  assert.deepEqual(JSON.parse(page.depends_on!), [api.id]);
  const [gate] = store.dev.gates(g.id);
  assert.deepEqual(gate.task_ids, [page.id]);

  await acceptDevTask(hub, api.id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(store.dev.get(page.id)!.status, "waiting", "la décision manque encore");
  assert.equal(resolveGate(hub, gate.id, "Me contacter"), "done");
  assert.equal(resolveGate(hub, gate.id, "Contact"), "already", "une décision ne se prend qu'une fois");
  await until(() => store.dev.get(page.id)!.status === "review");
  const pageTask = store.dev.get(page.id)!;
  assert.match(prompts.at(-1)!, /Décision de Charles — Titre de la page \? : Me contacter/);
  assert.match(prompts.at(-1)!, new RegExp(`contient déjà le travail accepté de : #${api.id}`));
  // Sa copie contient le travail de l'API, mais son diff ne montre que le sien.
  assert.equal(sh(pageTask.worktree, "show", "HEAD:api.txt"), "API");
  assert.deepEqual(JSON.parse(pageTask.diff_stat!).files.map((f: { path: string }) => f.path), ["page.txt"]);

  await acceptDevTask(hub, page.id);
  await acceptDevTask(hub, doc.id);
  assert.equal(await integrateGroup(hub, g.id), "done");
  const branch = store.dev.group(g.id)!.branch!;
  assert.deepEqual(["api.txt", "page.txt", "doc.txt"].map((f) => sh(dir, "show", `${branch}:${f}`)), ["API", "PAGE", "DOC"]);
});

test("groupe : la sous-tâche dont elle dépend est jetée → elle s'arrête ; réessayée, elle repart sans", async () => {
  const dir = repo("jetee");
  const plan = {
    tasks: [
      { title: "API", instruction: "Écris le fichier api.txt avec API", files: ["api.txt"] },
      { title: "Page", instruction: "Écris le fichier page.txt avec PAGE", files: ["page.txt"], after: [1] },
    ],
  };
  const { store, hub } = groupSetup(plan, (cwd, prompt) => {
    const f = prompt.match(/fichier (\w+\.txt) avec (\w+)/)!;
    writeFileSync(join(cwd, f[1]), `${f[2]}\n`);
  });
  const p = (await addProject(hub, { name: "jetee", path: dir })) as any;
  const g = startDevGroup(hub, { projectId: p.id, instruction: "Ajoute une API et sa page" }) as any;
  await until(() => store.dev.groupTasks(g.id)[0]?.status === "review");
  const [api, page] = store.dev.groupTasks(g.id);
  await discardDevTask(hub, api.id);
  assert.equal(store.dev.get(page.id)!.status, "failed");
  assert.match(store.dev.get(page.id)!.error!, /dépendait de .*jetée/);
  assert.equal(await retryDevTask(hub, page.id, {}), "done");
  await until(() => store.dev.get(page.id)!.status === "review");
  assert.equal(store.dev.get(page.id)!.depends_on, null);
});

test("réessayer : copie et branche neuves, conversation neuve, autre moteur, modèle et effort ; l'ancienne branche disparaît", async () => {
  const dir = repo("reessai");
  const { store, hub, runs } = setup((cwd) => {
    writeFileSync(join(cwd, "hello.txt"), "salut\n");
    return { status: "failed" };
  });
  const p = (await addProject(hub, { name: "reessai", path: dir })) as any;
  const t = startDevTask(hub, { projectId: p.id, instruction: "Ajoute un fichier hello.txt" }) as any;
  await until(() => store.dev.get(t.id)!.status === "failed");
  const first = store.dev.get(t.id)!;
  assert.ok(store.getSession(2000 + t.id), "la première tentative avait sa conversation");
  assert.equal(await retryDevTask(hub, t.id, { engine: "codex", model: "gpt-x", effort: "high" }), "done");
  await until(() => store.dev.get(t.id)!.status === "failed" && store.dev.get(t.id)!.attempts === 2);
  const second = store.dev.get(t.id)!;
  assert.notEqual(second.branch, first.branch);
  assert.notEqual(second.worktree, first.worktree);
  assert.equal(runs.at(-1)!.engine, "codex");
  assert.equal(runs.at(-1)!.resume, undefined, "la tentative ratée n'est pas reprise");
  assert.equal(runs.at(-1)!.model, "gpt-x", "le modèle choisi est passé au moteur pour ce tour");
  assert.equal(runs.at(-1)!.effort, "high");
  assert.ok(!sh(dir, "branch", "--list", first.branch), "l'ancienne branche est supprimée");
  assert.equal(await retryDevTask(hub, 999, {}), "missing");
});

test("agent silencieux : signalé une fois, pas quand il t'attend ; Arrêter interrompt son tour", async () => {
  process.env.CLARK_STALL_MINUTES = "1";
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const execute = (async (deps: any, taskId: number, opts: RunOptions) => {
    deps.journal.setStatus(taskId, "running");
    // D'abord il attend l'accord de l'utilisateur : ce n'est pas être bloqué.
    await opts.approve({ tool: "Bash", summary: "Commande shell :\necho test" });
    await new Promise<void>((r) => onStop(taskId, r));
    deps.journal.finish(taskId, "failed", "Arrêté", 0);
    return { text: "Arrêté", costUsd: 0, status: "failed" };
  }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute });
  void hub.enqueue(OWNER_CHAT, "Une tâche qui ne bouge plus", "chat", "web");
  await until(() => journal.unfinished().some((t) => t.status === "running"));
  const task = journal.unfinished()[0];
  await until(() => hub.approvals().length === 1);
  const old = () => store.db.prepare("UPDATE tasks SET updated_at = datetime('now', '-2 minutes') WHERE id = ?").run(task.id);
  old();
  hub.checkStalls();
  assert.equal(hub.stalled().length, 0, "il attend ton accord : pas bloqué");
  hub.resolveApproval(hub.approvals()[0].id, true);
  await new Promise((r) => setTimeout(r, 30));
  // Accord donné, puis plus rien depuis deux minutes.
  hub.checkStalls();
  hub.checkStalls();
  assert.deepEqual(hub.stalled().map((x) => [x.taskId, x.stoppable]), [[task.id, true]]);
  assert.equal(conversation.recent(OWNER_CHAT).filter((m) => /ne donne plus signe de vie/.test(m.text)).length, 1, "signalé une seule fois");

  assert.equal(hub.stopTask(task.id), "stopped");
  await until(() => journal.get(task.id)!.status === "failed");
  assert.equal(hub.stopTask(task.id), "not_running");
  assert.equal(hub.stalled().length, 0);
  delete process.env.CLARK_STALL_MINUTES;
});

test("fin de tour : les tests du projet tournent avant la relecture ; rouges, l'agent corrige seul, et la tâche arrive au vert", async () => {
  const dir = repo("verif");
  let round = 0;
  const { hub, store, runs } = setup((cwd) => {
    round++;
    // Premier tour : oublie la ligne attendue ; la correction l'ajoute.
    writeFileSync(join(cwd, "app.txt"), round === 1 ? "ligne 1\n" : "ligne 1\nok\n");
    return {};
  });
  const p = (await addProject(hub, { name: "verif", path: dir, testCommand: "grep -q ok app.txt" })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Ajoute la ligne ok dans app.txt" }) as any;
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.equal(runs.length, 2, "une correction automatique avant que tu ne voies la tâche");
  assert.match(runs[0].prompt, /lance les tests \(« grep -q ok app\.txt »\)/, "la consigne demande de vérifier soi-même");
  assert.match(runs[1].prompt, /Clark a lancé les tests du projet \(grep -q ok app\.txt\) : ils échouent/);
  assert.equal(JSON.parse(store.dev.get(r.id)!.tests!).ok, true);
  assert.equal(await acceptDevTask(hub, r.id), "done", "tests déjà verts pour cette version : gardé sans les relancer");
  assert.equal(sh(dir, "show", `${store.dev.get(r.id)!.branch}:app.txt`), "ligne 1\nok");
});

test("fin de tour : toujours rouge après 2 corrections → la tâche arrive chez toi avec les tests, et Accepter refuse", async () => {
  const dir = repo("rouge");
  const { hub, store, runs } = setup((cwd) => {
    writeFileSync(join(cwd, "app.txt"), "ligne 1\n");
    return {};
  });
  const p = (await addProject(hub, { name: "rouge", path: dir, testCommand: "grep -q ok app.txt" })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Ajoute la ligne ok dans app.txt" }) as any;
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.equal(runs.length, 3, "le tour, puis 2 corrections au plus");
  assert.equal(JSON.parse(store.dev.get(r.id)!.tests!).ok, false, "les tests rouges sont affichés");
  const refused = (await acceptDevTask(hub, r.id)) as any;
  assert.match(refused.error, /Tests en échec : rien n'est gardé/);
});

test("copies légères : node_modules du dépôt partagé par un lien, l'installation seule est sautée", async () => {
  const dir = repo("leger");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  sh(dir, "add", ".gitignore");
  sh(dir, "commit", "-q", "-m", "ignore");
  execFileSync("mkdir", ["-p", join(dir, "node_modules", "lib")]);
  const { hub, store } = setup((cwd) => (writeFileSync(join(cwd, "app.txt"), "ligne 1\nfait\n"), {}));
  const p = (await addProject(hub, { name: "leger", path: dir })) as any;
  const { prepareCopy } = await import("../src/dev/project-setup.ts");
  const wt = join(root, "wt-leger");
  sh(dir, "worktree", "add", "-q", "--detach", wt);
  const log = await prepareCopy({ ...store.dev.project(p.id)!, setup_command: "npm ci" }, wt);
  assert.ok(lstatSync(join(wt, "node_modules")).isSymbolicLink(), "lien vers les dépendances du dépôt");
  assert.equal(log?.command, null, "npm ci sauté");
  assert.match(log?.output ?? "", /« npm ci » sauté : dépendances partagées/);
  assert.equal(sh(wt, "status", "--porcelain"), "", "le lien n'apparaît pas dans le diff");
});

test("copie préparée d'avance : la tâche part de la copie déjà faite, puis rien ne traîne", async () => {
  const dir = repo("chaud");
  const { hub, store } = setup((cwd) => (writeFileSync(join(cwd, "app.txt"), "ligne 1\nchaud\n"), {}));
  const p = (await addProject(hub, { name: "chaud", path: dir })) as any;
  const { prewarmCopy } = await import("../src/dev/runner.ts");
  assert.equal(await prewarmCopy(hub, p.id), "ready");
  const warm = readdirSync(process.env.CLARK_DEV_DIR!).find((n) => n.startsWith(".prewarm-chaud-"));
  assert.ok(warm, "copie préparée");
  const r = startDevTask(hub, { projectId: p.id, instruction: "Ajoute la ligne chaud dans app.txt" }) as any;
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.ok(!existsSync(join(process.env.CLARK_DEV_DIR!, warm!)), "la copie préparée a été prise");
  assert.equal(readFileSync(join(store.dev.get(r.id)!.worktree, "app.txt"), "utf8"), "ligne 1\nchaud\n");
  assert.equal(sh(store.dev.get(r.id)!.worktree, "rev-parse", "--abbrev-ref", "HEAD"), store.dev.get(r.id)!.branch);
});

test("nettoyage : une copie oubliée part, une copie avec un fichier irremplaçable reste", async () => {
  const dir = repo("menage");
  writeFileSync(join(dir, ".gitignore"), "*.local\n");
  sh(dir, "add", ".gitignore");
  sh(dir, "commit", "-q", "-m", "ignore");
  const { hub } = setup();
  await addProject(hub, { name: "menage", path: dir });
  const base = process.env.CLARK_DEV_DIR!;
  execFileSync("mkdir", ["-p", base]);
  const lost = join(base, "menage-oubliee");
  const keep = join(base, "menage-gardee");
  sh(dir, "worktree", "add", "-q", "--detach", lost);
  sh(dir, "worktree", "add", "-q", "--detach", keep);
  writeFileSync(join(keep, "notes.local"), "à ne pas perdre");
  const { sweepWorktrees } = await import("../src/dev/cleanup.ts");
  const r = await sweepWorktrees(hub, Date.now() + 2 * 3600_000);
  assert.ok(r.removed.includes(lost));
  assert.ok(!existsSync(lost));
  assert.deepEqual(r.kept.map((k) => [k.dir, k.files]), [[keep, ["notes.local"]]]);
  assert.ok(existsSync(join(keep, "notes.local")));
});

test("binôme : Claude planifie, Codex critique, auteurs alternés, relecture croisée jusqu'à l'accord ou au désaccord", async () => {
  const dir = repo("binome");
  const plan = (extra = "") => ({
    tasks: [
      { title: "Fichier A", instruction: `Écris le fichier a.txt avec A${extra}`, files: ["a.txt"] },
      { title: "Fichier B", instruction: `Écris le fichier b.txt avec B${extra}`, files: ["b.txt"] },
    ],
  });
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const calls: { engine: string; kind: string; access?: string; prompt: string }[] = [];
  const reviewsOfA = { n: 0 };
  const fake = (engine: string) =>
    (async (deps: any, taskId: number, opts: RunOptions) => {
      const p = opts.prompt;
      const kind = p.startsWith("[Plan dev") ? "plan" : p.startsWith("[Critique de plan") ? "critique" : p.startsWith("[Plan corrigé") ? "revise" : p.startsWith("[Relecture croisée") ? "review" : "code";
      calls.push({ engine, kind, access: opts.access, prompt: p });
      let text = "Fait. BILAN : fait";
      if (kind === "plan") text = JSON.stringify(plan());
      else if (kind === "critique") text = "Il manque des tests pour chaque fichier.";
      else if (kind === "revise") text = JSON.stringify(plan(" et un test"));
      else if (kind === "review") {
        // A : un problème au premier tour, approuvé ensuite. B : jamais d'accord.
        text = p.includes("a.txt")
          ? JSON.stringify(++reviewsOfA.n === 1 ? { approve: false, summary: "Presque.", issues: [{ file: "a.txt", problem: "pas de fin de ligne", fix: "ajoute-la", severity: "important" }] } : { approve: true, summary: "Bon.", issues: [] })
          : JSON.stringify({ approve: false, summary: "Non.", issues: [{ file: "b.txt", problem: "mauvais contenu", fix: "écris C", severity: "bloquant" }] });
      } else {
        const f = p.match(/fichier (\w\.txt) avec (\w)/);
        const fix = p.match(/(\w\.txt) : /);
        if (p.startsWith("Relecture de") && fix) writeFileSync(join(opts.cwd!, fix[1]), `${readFileSync(join(opts.cwd!, fix[1]), "utf8").trim()}!\n`);
        else if (f) writeFileSync(join(opts.cwd!, f[1]), `${f[2]}\n`);
      }
      deps.journal.finish(taskId, "done", text, 0);
      return { text, costUsd: 0, status: "done" };
    }) as unknown as typeof executeTask;
  const hub = createHub({ config, store, journal, conversation }, { execute: fake("claude"), executors: { claude: fake("claude"), codex: fake("codex") } });
  const p = (await addProject(hub, { name: "binome", path: dir })) as any;

  // Sans Codex connecté : refusé, on ne fait pas semblant.
  hub.setConnection("codex", { ready: false, account: null, problem: "pas connecté" });
  assert.match((startDevGroup(hub, { projectId: p.id, instruction: "Ajoute deux fichiers au projet", binome: true }) as any).error, /Codex/);
  hub.setConnection("codex", { ready: true, account: "ChatGPT", problem: null });

  const g = startDevGroup(hub, { projectId: p.id, instruction: "Ajoute deux fichiers au projet", binome: true }) as any;
  await until(() => store.dev.groupTasks(g.id).length === 2 && store.dev.groupTasks(g.id).every((t) => t.status === "review"), 30_000);

  // Plan : Claude, critique : Codex (lecture seule), correction : Claude ; la critique est gardée.
  const planning = calls.filter((c) => ["plan", "critique", "revise"].includes(c.kind)).map((c) => `${c.kind}:${c.engine}`);
  assert.deepEqual(planning, ["plan:claude", "critique:codex", "revise:claude"]);
  assert.equal(calls.find((c) => c.kind === "critique")!.access, "read");
  assert.match(store.dev.group(g.id)!.plan_note ?? "", /tests/);
  assert.equal(store.dev.group(g.id)!.mode, "binome");

  const [a, b] = store.dev.groupTasks(g.id);
  assert.match(a.instruction, /et un test/, "les sous-tâches viennent du plan corrigé");
  assert.deepEqual([a.engine, a.reviewer, b.engine, b.reviewer], ["claude", "codex", "codex", "claude"]);
  // A : relue par Codex, corrigée une fois par Claude, puis approuvée.
  assert.equal(a.review_state, "approved");
  assert.equal(a.review_rounds, 2);
  assert.equal(readFileSync(join(a.worktree, "a.txt"), "utf8"), "A!\n", "la correction de l'auteur est dans la copie");
  assert.ok(calls.some((c) => c.kind === "code" && c.engine === "claude" && c.prompt.includes("Relecture de Codex")));
  // B : jamais d'accord → au bout de 3 tours, l'utilisateur tranche.
  assert.equal(b.review_state, "disagree");
  assert.equal(b.review_rounds, 3);
  assert.ok(calls.filter((c) => c.kind === "review").every((c) => c.access === "read"), "le relecteur ne fait que lire");
  const said = conversation.recent(OWNER_CHAT).map((m) => m.text).join("\n");
  assert.match(said, /écrite par Claude, relue et approuvée par Codex après 2 tours/);
  assert.match(said, /Codex et Claude ne sont pas d'accord après 3 tours/);
});

test("tâche longue : limite d'étapes atteinte → l'agent reprend seul (3 fois au plus), puis s'arrête", async () => {
  const dir = repo("longue");
  let n = 0;
  const { hub, store, runs } = setup((cwd) => {
    n++;
    writeFileSync(join(cwd, `part${n}.txt`), "x\n");
    return { status: "failed" };
  });
  // Le faux agent rend le texte d'arrêt du SDK quand on dépasse les étapes.
  const journal = (hub.deps as any).journal;
  const finish = journal.finish.bind(journal);
  journal.finish = (id: number, status: string, text: string, cost: number) => finish(id, status, status === "failed" ? "J'ai atteint le nombre maximum d'étapes pour cette tâche. Dis-moi si je continue." : text, cost);
  const p = (await addProject(hub, { name: "longue", path: dir })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Une très longue tâche en plusieurs parties" }) as any;
  await until(() => store.dev.get(r.id)!.status === "failed");
  assert.equal(runs.length, 4, "le tour, puis 3 relances");
  assert.match(runs[1].prompt, /limite d'étapes de ce tour \(relance 1 sur 3\)/);
  assert.equal(store.dev.get(r.id)!.auto_continues, 3);
});

test("pilote automatique : version verte acceptée seule ; rouge, il s'arrête et dit pourquoi ; groupe réuni seul", async () => {
  // Tâche seule, tests verts : acceptée sans l'utilisateur (la PR ne peut pas s'ouvrir ici : pas d'origin, il le dit).
  const dir = repo("pilote");
  const { hub, store, conversation } = setup((cwd) => {
    writeFileSync(join(cwd, "app.txt"), "ligne 1\nok\n");
    return {};
  });
  const p = (await addProject(hub, { name: "pilote", path: dir, testCommand: "grep -q ok app.txt" })) as any;
  const a = startDevTask(hub, { projectId: p.id, instruction: "Ajoute la ligne ok dans app.txt" }) as any;
  store.dev.update(a.id, { autopilot: 1 });
  await until(() => store.dev.get(a.id)!.status === "accepted" && Boolean(store.dev.get(a.id)!.commit));
  await until(() => conversation.recent(OWNER_CHAT).some((m) => /Pilote automatique : Tâche dev #\d+ accepté, mais la PR n'a pas pu s'ouvrir/.test(m.text)));

  // Tests rouges même après les corrections : rien n'est gardé, la main revient à l'utilisateur.
  const dir2 = repo("pilote-rouge");
  const red = setup((cwd) => {
    writeFileSync(join(cwd, "app.txt"), "ligne 1\n");
    return {};
  });
  const p2 = (await addProject(red.hub, { name: "pilote-rouge", path: dir2, testCommand: "grep -q ok app.txt" })) as any;
  const b = startDevTask(red.hub, { projectId: p2.id, instruction: "Ajoute la ligne ok dans app.txt" }) as any;
  red.store.dev.update(b.id, { autopilot: 1 });
  await until(() => red.conversation.recent(OWNER_CHAT).some((m) => /Pilote automatique arrêté sur #\d+ .*les tests sont rouges/.test(m.text)));
  assert.equal(red.store.dev.get(b.id)!.status, "review", "pas acceptée : tu décides");
});

test("pilote automatique : groupe — sous-tâches vertes acceptées, puis réunies sur une branche, sans toi", async () => {
  const dir = repo("pilote-groupe");
  const plan = { tasks: [{ title: "A", instruction: "Écris le fichier a.txt avec A", files: ["a.txt"] }, { title: "B", instruction: "Écris le fichier b.txt avec B", files: ["b.txt"] }] };
  const { store, hub } = groupSetup(plan, (cwd, prompt) => {
    const f = prompt.match(/fichier (\w\.txt) avec (\w)/);
    if (f) writeFileSync(join(cwd, f[1]), `${f[2]}\n`);
  });
  const p = (await addProject(hub, { name: "pilote-groupe", path: dir, testCommand: "true" })) as any;
  const g = startDevGroup(hub, { projectId: p.id, instruction: "Ajoute deux fichiers au projet" }) as any;
  store.dev.updateGroup(g.id, { autopilot: 1 });
  await until(() => store.dev.group(g.id)!.status === "integrated", 30_000);
  const grp = store.dev.group(g.id)!;
  assert.ok(store.dev.groupTasks(g.id).every((t) => t.status === "accepted"));
  assert.equal(sh(dir, "show", `${grp.branch}:a.txt`), "A");
  assert.equal(sh(dir, "show", `${grp.branch}:b.txt`), "B");
});

test("agent bloqué (« BILAN : bloqué — … ») : Clark montre ce qu'il attend, « Autoriser et reprendre » relance avec ton accord", async () => {
  const dir = repo("bloque");
  let turn = 0;
  const { hub, store, conversation, runs } = setup((cwd) => {
    turn++;
    writeFileSync(join(cwd, "a.txt"), `tour ${turn}\n`);
    return turn === 1 ? { result: "Fait en partie.\nBILAN : bloqué — accord de Charles pour modifier src/index.ts" } : { result: "Tout est branché.\nBILAN : réussi" };
  });
  const p = (await addProject(hub, { name: "bloque", path: dir })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Branche le mode vision" }) as any;
  await until(() => store.dev.get(r.id)!.status === "failed");
  assert.equal(store.dev.get(r.id)!.blocked_on, "accord de Charles pour modifier src/index.ts");
  // Une tâche bloquée avant la colonne blocked_on : ce qu'attend l'agent est relu dans l'erreur au démarrage.
  store.dev.update(r.id, { blocked_on: null });
  new DevStore(store.db);
  assert.equal(store.dev.get(r.id)!.blocked_on, "accord de Charles pour modifier src/index.ts");
  assert.match(conversation.messagesOf(conversation.current(1)).map((m) => m.text).join("\n"), /en pause .*Autoriser et reprendre/);

  const before = runs.length;
  assert.equal(unblockDevTask(hub, r.id), "done");
  await until(() => runs.length > before);
  assert.match(runs.at(-1)!.prompt, /Charles donne son accord pour : modifier src\/index\.ts\. C'est autorisé, même hors des fichiers prévus/);
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.equal(store.dev.get(r.id)!.blocked_on, null);
  assert.equal(store.dev.get(r.id)!.error, null);
  assert.equal(unblockDevTask(hub, r.id), "already", "plus rien à autoriser");
});


test("binôme : le relecteur reçoit les vrais tests de Clark et les règles du projet (AGENTS.md)", async () => {
  const { crossReviewPrompt, testsForReview, planCritiquePrompt } = await import("../src/dev/binome.ts");
  const { devPrompt } = await import("../src/dev/runner.ts");
  const base = { id: 7, title: "Vision", instruction: "Branche la vision", summary: null, worktree: "/w", rounds: 2 };
  assert.match(testsForReview({ tests: JSON.stringify({ ok: true, round: 2 }), rounds: 2 }), /tous verts/);
  assert.match(testsForReview({ tests: JSON.stringify({ ok: false, output: "✖ adresse interne", round: 2 }), rounds: 2 }), /EN ÉCHEC[\s\S]*adresse interne/);
  assert.match(testsForReview({ tests: JSON.stringify({ ok: true, round: 1 }), rounds: 2 }), /pas lancés par Clark sur cette version/, "tests d'une version précédente");
  assert.match(testsForReview({ tests: null, rounds: 2 }), /Ne prends pas pour acquis/);

  const prompt = crossReviewPrompt({ ...base, tests: JSON.stringify({ ok: false, output: "boom", round: 2 }) }, "diff", "claude", 1, []);
  assert.match(prompt, /AGENTS\.md[\s\S]*point bloquant/);
  assert.match(prompt, /EN ÉCHEC/);
  assert.match(prompt, /appelants de ce qui change/);
  assert.match(planCritiquePrompt("clark", "/w", "x", "{}", "claude"), /AGENTS\.md/);
  const author = devPrompt({ ...base, branch: "b" } as any, "clark", "main", "npm test");
  assert.match(author, /AGENTS\.md/);
  assert.match(author, /modifie-le et signale-le/);
});

test("veille de la machine : le temps où le Mac dormait n'est pas du silence ; « Reprendre » relance une tâche arrêtée", async () => {
  const { createSleepWatch } = await import("../src/core/sleep.ts");
  const { resumeDevTask } = await import("../src/dev/runner.ts");
  // Le minuteur voit un trou de 10 min : une veille ; des battements réguliers n'en sont pas.
  let now = 1_000_000;
  const watch = createSleepWatch({ now: () => now, timer: false });
  now += 15_000;
  watch.tick();
  now += 10 * 60_000;
  watch.tick();
  assert.equal(watch.sleptBetween(0, now), 10 * 60_000 + 0);
  assert.equal(watch.sleptBetween(now - 60_000, now), 60_000, "seule la part de veille dans l'intervalle compte");

  // Agent silencieux depuis 2 min, mais la machine a dormi tout ce temps : pas signalé.
  process.env.CLARK_STALL_MINUTES = "1";
  try {
    const store = new Store(":memory:");
    const journal = new TaskJournal(store.db);
    const conversation = new Conversation(store.db);
    const slept = { tick() {}, sleptBetween: (from: number, to: number) => to - from, stop() {} };
    const execute = (async (deps: any, taskId: number) => {
      deps.journal.setStatus(taskId, "running");
      await new Promise<void>((r) => onStop(taskId, r));
      deps.journal.finish(taskId, "failed", "Arrêté", 0);
      return { text: "Arrêté", costUsd: 0, status: "failed" };
    }) as unknown as typeof executeTask;
    const hub = createHub({ config, store, journal, conversation }, { execute, sleepWatch: slept });
    void hub.enqueue(OWNER_CHAT, "Une tâche pendant que le Mac dort", "chat", "web");
    await until(() => journal.unfinished().some((t) => t.status === "running"));
    const task = journal.unfinished()[0];
    store.db.prepare("UPDATE tasks SET updated_at = datetime('now', '-2 minutes') WHERE id = ?").run(task.id);
    hub.checkStalls();
    assert.equal(hub.stalled().length, 0, "la machine dormait");
    assert.ok(hub.sleptSinceActivity(task.id) >= 110_000);
    assert.equal(conversation.recent(OWNER_CHAT).filter((m) => /ne donne plus signe de vie/.test(m.text)).length, 0);
    hub.stopTask(task.id);
  } finally {
    delete process.env.CLARK_STALL_MINUTES;
  }

  // « Reprendre » : une tâche dev arrêtée repart dans sa copie, avec la consigne de finir.
  const dir = repo("reprise");
  let turn = 0;
  const { hub, store, runs } = setup((cwd) => {
    turn++;
    writeFileSync(join(cwd, "a.txt"), `tour ${turn}\n`);
    return turn === 1 ? { status: "failed" } : {};
  });
  const p = (await addProject(hub, { name: "reprise", path: dir })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Ajoute a.txt proprement" }) as any;
  await until(() => store.dev.get(r.id)!.status === "failed");
  const before = runs.length;
  assert.equal(await resumeDevTask(hub, r.id), "done");
  await until(() => runs.length > before);
  assert.match(runs.at(-1)!.prompt, /Reprends où tu en étais/);
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.equal(await resumeDevTask(hub, r.id), "already");
});

test("binôme en désaccord : Clark résume, dit qui a raison, propose une retouche ; elle repart d'un clic", async () => {
  const { arbiterPrompt, parseArbiter, arbitrate, arbiterOf } = await import("../src/dev/binome.ts");
  assert.equal(parseArbiter("pas de json"), null);
  assert.equal(parseArbiter('{"summary": "", "recommendation": "accepter"}'), null);
  const parsed = parseArbiter('{"summary":"Reste la fenêtre du journal.","recommendation":"retoucher","retouch":"Suis le journal par position de lecture.","points":[{"point":"Fenêtre de 400 ko","side":"relecteur","why":"fausses récurrences"},{"point":"x","side":"???","why":""}]}');
  assert.equal(parsed?.recommendation, "retoucher");
  assert.deepEqual(parsed?.points.map((p) => p.side), ["relecteur", "entre les deux"]);
  assert.equal(parseArbiter('{"summary":"ok","recommendation":"accepter","retouch":"inutile"}')?.retouch, "", "pas de retouche si on accepte");

  const prompt = arbiterPrompt({ title: "Détection", instruction: "Fais la détection", summary: "DÉSACCORD : je garde les exemples", tests: JSON.stringify({ ok: true, round: 3 }), rounds: 3 }, [{ round: 3, approve: false, summary: "Reste un point", issues: [{ file: "src/core/improve.ts", problem: "texte libre persisté", fix: "libellés", severity: "bloquant" }], reviewer: "codex", at: "" }], "claude");
  assert.match(prompt, /DÉSACCORD : je garde les exemples/);
  assert.match(prompt, /\[bloquant\] src\/core\/improve\.ts : texte libre persisté/);
  assert.match(prompt, /tous verts/);

  // Une vraie tâche en désaccord : l'avis est rangé, puis effacé par la retouche lancée.
  const dir = repo("arbitre");
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const runs: string[] = [];
  const fake = (async (deps: any, taskId: number, opts: RunOptions) => {
    runs.push(opts.prompt);
    writeFileSync(join(opts.cwd!, "a.txt"), `v${runs.length}\n`);
    deps.journal.finish(taskId, "done", "Fait.\nBILAN : réussi", 0);
    return { text: "fini", costUsd: 0, status: "done" };
  }) as unknown as typeof executeTask;
  const asked: string[] = [];
  const judge = async (p: string) => {
    asked.push(p);
    return '{"summary":"Claude a raison sur les exemples, Codex sur la fenêtre du journal.","recommendation":"retoucher","retouch":"Suis le journal par position de lecture et teste le passage de minuit.","points":[{"point":"Fenêtre de 400 ko","side":"relecteur","why":"fausses récurrences"}]}';
  };
  const hub = createHub({ config, store, journal, conversation }, { execute: fake, executors: { claude: fake, codex: fake }, judge });
  const p = (await addProject(hub, { name: "arbitre", path: dir })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Ajoute a.txt" }) as any;
  await until(() => store.dev.get(r.id)!.status === "review");
  store.dev.update(r.id, { reviewer: "codex", review_state: "disagree", review_rounds: 3 });
  assert.equal(await arbitrate(hub, r.id), true);
  const a = arbiterOf(store.dev.get(r.id)!);
  assert.equal(a?.recommendation, "retoucher");
  assert.match(a?.retouch ?? "", /position de lecture/);
  assert.equal(asked.length, 1);

  assert.equal(retouchDevTask(hub, r.id, a!.retouch), "done");
  assert.equal(store.dev.get(r.id)!.arbiter, null, "nouvel essai : l'ancien avis disparaît");
  await until(() => runs.length >= 2);
  assert.match(runs.at(-1)!, /Suis le journal par position de lecture/);
  // Plus en désaccord : pas d'avis possible.
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.equal(await arbitrate(hub, r.id), false);
});

test("tâche arrêtée avant que sa copie soit prête : « Reprendre » la relance depuis le début, avec sa consigne", async () => {
  const { resumeDevTask } = await import("../src/dev/runner.ts");
  const dir = repo("sans-copie");
  const { hub, store, runs } = setup((cwd) => {
    writeFileSync(join(cwd, "a.txt"), "fait\n");
    return {};
  });
  const p = (await addProject(hub, { name: "sans-copie", path: dir })) as any;
  const r = startDevTask(hub, { projectId: p.id, instruction: "Ajoute a.txt avec le mot fait" }) as any;
  await until(() => store.dev.get(r.id)!.status === "review");
  // Comme la sous-tâche #20 : arrêtée sans point de départ (préparation interrompue).
  store.dev.update(r.id, { status: "failed", base_commit: null, error: "Copie du dépôt impossible : interrompue" });
  assert.match((retouchDevTask(hub, r.id, "reprends") as any).error, /jamais été préparée/, "une retouche sur rien est refusée");
  const before = runs.length;
  assert.equal(await resumeDevTask(hub, r.id), "done");
  await until(() => runs.length > before);
  assert.match(runs.at(-1)!.prompt, /Consigne de Charles : Ajoute a\.txt avec le mot fait/, "l'agent reçoit sa consigne");
  assert.doesNotMatch(runs.at(-1)!.prompt, /Reprends où tu en étais/);
  await until(() => store.dev.get(r.id)!.status === "review");
  assert.ok(store.dev.get(r.id)!.base_commit, "copie recréée, avec son point de départ");
});
