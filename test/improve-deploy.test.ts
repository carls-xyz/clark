import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHub } from "../src/core/hub.ts";
import { Conversation } from "../src/core/conversation.ts";
import {
  AMELIORE_BILAN_CHAT,
  AMELIORE_BILAN_LABEL,
  advanceWatching,
  bilanOutcome,
  deployImprovement,
  detectMerges,
  realGit,
  realService,
  regression,
  resumeDeploying,
  resumeReverting,
  type ImproveDeployOptions,
  type RegressionBefore,
  type RegressionDuring,
  type RunGit,
  type RunService,
  type SnapshotReader,
} from "../src/core/improve-deploy.ts";
import { improvementProposal, isRateGuarded, IMPROVE_RATE_GUARD_DAYS, refreshFiches } from "../src/core/improve.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";
import type { Config } from "../src/config.ts";

const NOW = new Date("2026-11-25T10:00:00Z");
const DEPLOY = new Date("2026-11-25T11:00:00Z");

function setup() {
  const store = new Store(":memory:");
  const config: Config = {
    telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false,
    heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null,
  };
  const hub = createHub({ store, config, journal: new TaskJournal(store.db), conversation: new Conversation(store.db) });
  return { hub, store };
}

/**
 * Faux dépôt + service, avec DEUX versions qui suivent les commandes : `head` (ce qu'il y a sur le disque) et
 * `running` (ce que l'INSTANCE exécute vraiment). Un redémarrage réussi fait adopter le disque par l'instance
 * (running ← head) ; un redémarrage refusé laisse l'instance sur son ancienne version. Rien de réel n'est
 * déployé ni redémarré.
 */
function fakeRepo(init: { head: string; mainTip: string; running?: string; branch?: string | null; upstream?: string | null; contained?: string[] }) {
  const state = {
    head: init.head,
    mainTip: init.mainTip,
    running: init.running ?? init.head,
    // Branche courante (null = HEAD détachée) et amont suivi. Au départ, on suppose une HEAD détachée : le
    // déploiement commence toujours par `git switch main`, qui replace la branche.
    branch: init.branch === undefined ? null : init.branch,
    upstream: init.upstream === undefined ? "origin/main" : init.upstream,
    // Commits considérés comme présents dans la version candidate (pour `merge-base --is-ancestor`).
    contained: new Set<string>(init.contained ?? [init.mainTip, init.head]),
    switchDetachOk: true,
    switchMainOk: true,
    pullOk: true,
    restartOk: true,
    healthBad: false,
    watchdogMarker: null as string | null,
    // Le script de secours a-t-il été figé dans data/ ? Persiste d'un passage de rollback à l'autre (reprise).
    rollbackScriptPinned: false,
    markOk: true,
    pending: null as { recovery: string; target: string } | null,
  };
  const gitCalls: string[][] = [];
  const serviceCalls: string[] = [];
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const fail = (stderr: string) => ({ ok: false, stdout: "", stderr });
  const git: RunGit = async (args) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse" && args.includes("--abbrev-ref") && args.includes("@{upstream}")) {
      return state.upstream ? ok(`${state.upstream}\n`) : fail("no upstream");
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return ok(`${state.branch ?? "HEAD"}\n`);
    if (args[0] === "rev-parse") return ok(`${state.head}\n`);
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") return state.contained.has(args[2]) ? ok() : fail("pas un ancêtre");
    if (args[0] === "switch" && args[1] === "main") { if (!state.switchMainOk) return fail("switch main refusé"); state.head = state.mainTip; state.branch = "main"; return ok(); }
    if (args[0] === "switch" && args[1] === "--detach") { if (!state.switchDetachOk) return fail("switch --detach refusé"); state.head = args[2]; state.branch = null; return ok(); }
    if (args[0] === "pull") { if (!state.pullOk) return fail("pull refusé"); state.head = state.mainTip; return ok(); }
    return ok();
  };
  const service: RunService = async (cmd) => {
    serviceCalls.push(cmd);
    if (!state.restartOk) return fail("restart en échec");
    state.running = state.head; // un redémarrage réussi fait tourner l'instance sur la version du disque
    return ok();
  };
  const snapshot: SnapshotReader = () => ({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: state.healthBad });
  const runningCommit = () => state.running;
  // Commits notés « dernière bonne version » (data/last-good-commit), sans toucher au disque.
  const goodCalls: string[] = [];
  const recordGood = (c: string) => {
    goodCalls.push(c);
    return true;
  };
  // Fige le service.sh de retour arrière (no-op en test : toujours « réussi »). Marque le script comme présent.
  let pinned = 0;
  const pinRollbackScript = () => {
    pinned++;
    state.rollbackScriptPinned = true;
    return true;
  };
  // Le script figé est présent s'il a été figé (ou pré-positionné via state.rollbackScriptPinned).
  const rollbackScriptReady = () => state.rollbackScriptPinned;
  // Filet de la surveillance locale (data/deploy-pending), simulé : null = aucun marqueur.
  const markPending = (recovery: string, target: string) => {
    if (!state.markOk) return false;
    state.pending = { recovery, target };
    return true;
  };
  const clearPending = () => {
    state.pending = null;
  };
  return { git, service, snapshot, runningCommit, recordGood, pinRollbackScript, rollbackScriptReady, markPending, clearPending, gitCalls, serviceCalls, goodCalls, get pinned() { return pinned; }, state };
}

/** Options de déploiement branchées sur un faux dépôt (avec runningCommit injecté). */
function optsFor(repo: ReturnType<typeof fakeRepo>, over: Partial<ImproveDeployOptions> = {}): ImproveDeployOptions {
  return { root: "/clark", git: repo.git, service: repo.service, snapshot: repo.snapshot, runningCommit: repo.runningCommit, recordGood: repo.recordGood, pinRollbackScript: repo.pinRollbackScript, rollbackScriptReady: repo.rollbackScriptReady, markPending: repo.markPending, clearPending: repo.clearPending, now: () => DEPLOY, watchMinutes: 120, ...over };
}

/** Amène une fiche jusqu'à 'merged' (PR fusionnée), prête à être déployée. Renvoie son id. */
function mergedFiche(hub: ReturnType<typeof createHub>, signature: string, beforeTotal = 7, mergeCommit: string | null = "new111"): number {
  const store = hub.deps.store;
  store.improve.upsertFiche({
    signature, source: "error", title: `Correctif ${signature}`, examples: ["timeout"],
    before: { days: [{ day: "2026-11-24", count: beforeTotal }], total: beforeTotal }, status: "proposed",
  });
  const fid = store.improve.fiche("error", signature)!.id;
  const projectId = store.dev.addProject({ name: `clark-${signature}`, path: `/clark-${signature}`, baseBranch: "main" });
  const groupId = store.dev.createGroup({ projectId, title: `Auto-amélioration : ${signature}`, instruction: "x", engine: "claude", planWorktree: "/plan" });
  const pr: Record<string, unknown> = { state: "MERGED" };
  if (mergeCommit) pr.mergeCommit = mergeCommit;
  store.dev.updateGroup(groupId, { pr_status: JSON.stringify(pr), pr_url: "https://github.com/x/y/pull/9" });
  store.improve.decide(fid, "launched", NOW, groupId);
  detectMerges(hub, NOW); // passe launched → merged
  return fid;
}

test("regression : chaque signe pris isolément, et le cas « tout va bien »", () => {
  const before: RegressionBefore = { signatures: ["a", "b"], taskFailures: 1, watchdogMarker: "2026-11-20 08:00:00", healthBad: false, deployDay: "2026-11-25", targetFromDeployDay: 0 };
  const base: RegressionDuring = { targetSinceDeploy: 0, signatures: ["a", "b"], taskFailures: 1, watchdogMarker: "2026-11-20 08:00:00", healthBad: false };

  assert.deepEqual(regression(before, base), [], "tout va bien : aucun signe");
  assert.deepEqual(regression(before, { ...base, targetSinceDeploy: 2 }).map((s) => s.code), ["signature-visee"]);
  assert.deepEqual(regression(before, { ...base, signatures: ["a", "b", "c"] }).map((s) => s.code), ["nouvelles-erreurs"]);
  assert.deepEqual(regression(before, { ...base, taskFailures: 2 }).map((s) => s.code), ["echecs-taches"]);
  assert.deepEqual(regression(before, { ...base, watchdogMarker: "2026-11-25 10:05:00" }).map((s) => s.code), ["watchdog"]);
  assert.deepEqual(regression(before, { ...base, healthBad: true }).map((s) => s.code), ["sante-degradee"]);
  assert.deepEqual(regression(before, { ...base, taskFailures: 0 }), []);
  assert.deepEqual(regression({ ...before, healthBad: true }, { ...base, healthBad: true }), []);
  const detail = regression(before, { ...base, signatures: ["a", "b", "secret-token-xyz"] })[0].detail;
  assert.doesNotMatch(detail, /secret-token-xyz/);
});

test("bilanOutcome : atteint / partiel / raté selon le rythme par jour", () => {
  assert.equal(bilanOutcome(1, 0, 0), "atteint");
  assert.equal(bilanOutcome(2, 3, 1), "partiel");
  assert.equal(bilanOutcome(2, 9, 3), "rate");
  assert.equal(bilanOutcome(0, 2, 0.66), "rate");
});

test("watchedPrs : une PR fusionnée reste suivie tant qu'une fiche d'amélioration liée attend son commit de fusion", () => {
  const { hub, store } = setup();
  // Fiche 'merged' SANS commit de fusion : ancien statut MERGED enregistré avant le champ mergeCommit. Le
  // déploiement est bloqué (« commit de fusion inconnu ») tant que le statut de la PR n'est pas rafraîchi — mais
  // watchedPrs() exclurait d'ordinaire les PR MERGED, qui ne seraient donc jamais relues. On la garde en suivi.
  const legacy = mergedFiche(hub, "legacy", 7, null);
  assert.equal(store.improve.get(legacy)!.merge_commit, null, "le cas de départ : pas de commit de fusion");
  const legacyGroup = store.improve.get(legacy)!.group_id!;

  // Fiche 'merged' AVEC son commit de fusion : sa PR fusionnée n'a plus à être suivie.
  const done = mergedFiche(hub, "done", 7, "sha-done");
  const doneGroup = store.improve.get(done)!.group_id!;

  const watched = store.dev.watchedPrs();
  assert.ok(watched.some((p) => p.kind === "group" && p.id === legacyGroup), "PR fusionnée sans commit de fusion : gardée en suivi (sera relue, mergeCommit récupéré)");
  assert.ok(!watched.some((p) => p.kind === "group" && p.id === doneGroup), "PR fusionnée dont la fiche a déjà son commit : plus suivie");
});

test("une fiche fusionnée expose le bouton « Déployer » et son action atteint le déploiement injecté", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "timeout");

  // Ce que l'interface lit pour afficher le bouton : status 'merged' + lien de la PR.
  const payload = improvementProposal(store.improve.get(fid)!);
  assert.equal(payload.status, "merged");
  assert.equal(payload.prUrl, "https://github.com/x/y/pull/9");

  // La route POST /api/improvements/:id appelle hub.decideImprovement(id, "deploy") : sans déploiement
  // branché, l'action est refusée proprement...
  assert.deepEqual(await hub.decideImprovement(fid, "deploy"), { error: "Le déploiement n'est pas disponible pour l'instant." });

  // ...et une fois branché, la même action atteint bien le déploiement injecté.
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  let reached = 0;
  hub.setImproveDeploy((id) => { reached++; return deployImprovement(hub, id, optsFor(repo)); });
  assert.equal(await hub.decideImprovement(fid, "deploy"), "done");
  assert.equal(reached, 1);
  assert.equal(store.improve.get(fid)!.status, "watching");
});

test("déploiement : se replace sur main, récupère la version, puis observe", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "fuite");
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });

  assert.equal(await deployImprovement(hub, fid, optsFor(repo)), "done");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "watching");
  assert.equal(f.deploy_commit, "old000", "le commit de secours est la version d'AVANT le déploiement");
  assert.equal(f.deploy_target, "new111", "la cible figée est la version récupérée");
  assert.ok(repo.gitCalls.some((a) => a[0] === "switch" && a[1] === "main"), "se replace sur main avant de tirer");
  assert.ok(repo.gitCalls.some((a) => a[0] === "pull" && a[1] === "--ff-only"));
  assert.deepEqual(repo.serviceCalls, ["restart"]);
});

test("filet de la surveillance : posé avant le redémarrage (secours + cible), retiré une fois le démarrage confirmé", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "filet");
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  let atRestart: { recovery: string; target: string } | null = null;
  const service: RunService = async (cmd) => {
    atRestart = repo.state.pending ? { ...repo.state.pending } : null;
    return repo.service(cmd);
  };
  assert.equal(await deployImprovement(hub, fid, optsFor(repo, { service })), "done");
  assert.deepEqual(atRestart, { recovery: "old000", target: "new111" }, "le marqueur existe au moment du redémarrage");
  assert.equal(store.improve.get(fid)!.status, "watching");
  assert.equal(repo.state.pending, null, "démarrage confirmé : marqueur retiré");
});

test("filet impossible à poser : aucun redémarrage, dépôt remis sur la version d'avant", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "filet-ko");
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  repo.state.markOk = false;
  assert.deepEqual(await deployImprovement(hub, fid, optsFor(repo)), { error: "filet de déploiement impossible" });
  assert.deepEqual(repo.serviceCalls, [], "pas de déploiement sans filet");
  assert.equal(repo.state.head, "old000");
  assert.equal(store.improve.get(fid)!.status, "merged");
});

test("redémarrage sans effet : le marqueur est retiré avec la remise du dépôt", async () => {
  const { hub } = setup();
  const fid = mergedFiche(hub, "filet-sans-effet");
  const repo = fakeRepo({ head: "old000", mainTip: "new111", running: "old000" });
  repo.state.restartOk = false;
  await deployImprovement(hub, fid, optsFor(repo));
  assert.equal(repo.state.pending, null);
});

test("redémarrage refusé : l'ancien processus tourne encore → retour à 'merged', pas d'observation", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "refus-restart");
  // Le pull met bien le disque à jour, mais le redémarrage échoue : l'instance reste sur l'ancienne version.
  const repo = fakeRepo({ head: "old000", mainTip: "new111", running: "old000" });
  repo.state.restartOk = false;

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "déploiement sans effet" });
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "merged", "une version qui ne tourne pas n'est jamais passée en observation");
  assert.equal(f.outcome, null);
  assert.deepEqual(repo.serviceCalls, ["restart"], "le redémarrage a bien été tenté");
});

test("pull en échec après le switch main : le dépôt est remis sur la version d'avant", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "pull-ko");
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  repo.state.pullOk = false;

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "git pull --ff-only impossible" });
  assert.equal(repo.state.head, "old000", "HEAD est revenue à la version de départ (pas restée sur main)");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "merged", "le bouton « Déployer » reste");
  assert.equal(f.deploy_commit, null);
  assert.ok(repo.serviceCalls.length === 0, "aucun redémarrage : rien n'a été déployé");
});

test("reprise après un redémarrage qui a interrompu la finalisation", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "boucle");
  // On fige une fiche restée 'deploying' (le restart a remplacé Clark avant la finalisation).
  store.improve.setDeploying(fid, "old000", JSON.stringify({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: false, deployDay: "2026-11-25", targetFromDeployDay: 0 }), DEPLOY);
  store.improve.setDeployTarget(fid, "new111", DEPLOY);
  // La nouvelle instance tourne bien sur la nouvelle version, santé OK.
  const repo = fakeRepo({ head: "new111", mainTip: "new111", running: "new111" });
  await resumeDeploying(hub, optsFor(repo));
  assert.equal(store.improve.get(fid)!.status, "watching", "l'observation démarre à la reprise");
});

test("redémarrage sans effet (service revenu à l'ancienne version) : retour à 'merged', pas de 'raté'", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "refus");
  store.improve.setDeploying(fid, "old000", JSON.stringify({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: false, deployDay: "2026-11-25", targetFromDeployDay: 0 }), DEPLOY);
  store.improve.setDeployTarget(fid, "new111", DEPLOY);
  // L'instance est restée sur l'ancien commit : le nouveau code ne tourne pas.
  const repo = fakeRepo({ head: "old000", mainTip: "new111", running: "old000" });
  await resumeDeploying(hub, optsFor(repo));
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "merged", "un déploiement sans effet n'est pas un raté");
  assert.equal(f.outcome, null);
});

async function watchingReady(hub: ReturnType<typeof createHub>, signature: string, repo: ReturnType<typeof fakeRepo>) {
  const fid = mergedFiche(hub, signature);
  const opts = optsFor(repo);
  assert.equal(await deployImprovement(hub, fid, opts), "done");
  return { fid, opts };
}

test("régression pendant la fenêtre : retour arrière vérifié, fiche 'raté'", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "timeout", repo);

  repo.state.healthBad = true; // la santé passe au rouge
  const WITHIN = new Date(DEPLOY.getTime() + 10 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);

  assert.ok(repo.gitCalls.some((a) => a[0] === "switch" && a[1] === "--detach" && a[2] === "old000"), "détache le commit d'avant");
  assert.equal(repo.state.running, "old000", "l'instance est revenue à la version d'avant");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "done");
  assert.equal(f.outcome, "rate");
});

test("retour arrière dont le git switch échoue : fiche laissée 'reverting' (reprenable), pas de 'raté'", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "timeout", repo);

  repo.state.healthBad = true;
  repo.state.switchDetachOk = false; // le changement de commit échoue
  const WITHIN = new Date(DEPLOY.getTime() + 10 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);

  const f = store.improve.get(fid)!;
  assert.equal(f.status, "reverting", "l'intention de revenir est persistée : la boucle retentera");
  assert.equal(f.outcome, null);
  assert.ok(f.revert_signs, "les signes de régression sont figés");
});

test("un retour arrière interrompu est repris, et finit par confirmer le 'raté'", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "reprise-revert", repo);

  // Régression, mais le git switch échoue : la fiche reste 'reverting'.
  repo.state.healthBad = true;
  repo.state.switchDetachOk = false;
  const WITHIN = new Date(DEPLOY.getTime() + 10 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);
  assert.equal(store.improve.get(fid)!.status, "reverting");

  // La santé se rétablit ET la fenêtre expire : une fiche 'reverting' n'est JAMAIS clôturée 'atteint'.
  repo.state.healthBad = false;
  const AFTER = new Date(DEPLOY.getTime() + 3 * 86_400_000 + 60_000);
  await advanceWatching(hub, { ...opts, now: () => AFTER }, AFTER);
  const mid = store.improve.get(fid)!;
  assert.equal(mid.status, "reverting", "ni bilan, ni 'atteint' tant que le retour arrière n'est pas confirmé");
  assert.equal(mid.outcome, null);

  // Le git switch redevient possible : la reprise confirme le retour arrière.
  repo.state.switchDetachOk = true;
  await resumeReverting(hub, { ...opts, now: () => AFTER });
  const done = store.improve.get(fid)!;
  assert.equal(done.status, "done");
  assert.equal(done.outcome, "rate");
  assert.equal(repo.state.running, "old000", "l'instance tourne à nouveau sur la version d'avant");
});

test("retour arrière dont le disque est remis mais le redémarrage n'est PAS confirmé : fiche laissée 'reverting' (reprenable), disque + last-good sûrs", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "timeout", repo);

  repo.state.healthBad = true;
  repo.state.restartOk = false; // git switch réussit (disque sur le secours), mais le redémarrage échoue → l'instance tourne encore sur new111
  const WITHIN = new Date(DEPLOY.getTime() + 10 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);

  // On distingue la remise du disque (faite et sûre : last-good noté) de la confirmation du redémarrage (PAS
  // confirmée : l'instance tourne toujours sur la version en régression). Tant que ce n'est pas confirmé, on ne
  // clôt PAS — sinon la version en régression resterait active avec une fiche close. La fiche reste 'reverting',
  // la boucle (resumeReverting) retentera.
  assert.equal(repo.state.head, "old000", "disque remis sur le commit de secours");
  assert.deepEqual(repo.goodCalls, ["old000"], "le commit de secours est noté comme bonne version avant le redémarrage");
  assert.ok(repo.pinned >= 1, "le script de redémarrage de secours a été figé avant le redémarrage");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "reverting", "redémarrage non confirmé : la fiche n'est pas clôturée");
  assert.equal(f.outcome, null);
  assert.equal(f.deploy_phase, "rollback_pending");
});

test("une seule amélioration à la fois : un déploiement est refusé si une autre est en observation", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  await watchingReady(hub, "aaa", repo); // aaa est en observation

  const second = mergedFiche(hub, "bbb");
  const res = await deployImprovement(hub, second, optsFor(repo));
  assert.deepEqual(res, { error: "Une autre amélioration est déjà en observation." });
  assert.equal(store.improve.get(second)!.status, "merged", "la seconde reste déployable plus tard");
});

test("mesure des récidives : une occurrence ancienne qui sort de la fenêtre ne masque pas une récidive", () => {
  const { hub, store } = setup();
  // Beaucoup d'occurrences 5 jours AVANT le déploiement (elles sortiront de la fenêtre glissante à J+3).
  store.improve.record("2026-11-20", "error", "lente", 10, "timeout");
  const fid = mergedFiche(hub, "lente", 10);
  // Fiche en observation, déployée le 2026-11-25, rien compté ce jour-là ni après au déploiement.
  store.improve.setDeploying(fid, "old000", JSON.stringify({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: false, deployDay: "2026-11-25", targetFromDeployDay: 0 }), DEPLOY);
  store.improve.setDeployTarget(fid, "new111", DEPLOY);
  store.improve.setWatching(fid, DEPLOY);
  // Une récidive APRÈS le déploiement.
  store.improve.record("2026-11-26", "error", "lente", 1, "timeout");

  // À J+3, une soustraction de totaux glissants aurait vu le total baisser (le paquet du 20 sort) et conclu
  // à tort « atteint ». Ici on compte depuis le jour du déploiement : la récidive est bien vue.
  const AFTER = new Date(DEPLOY.getTime() + 3 * 86_400_000 + 60_000);
  const opts: ImproveDeployOptions = { root: "/clark", snapshot: () => ({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: false }), now: () => AFTER, watchMinutes: 120 };
  // git/service ne doivent pas être appelés ici (processus absent toute la fenêtre : on va droit au bilan).
  return advanceWatching(hub, opts, AFTER).then(() => {
    const f = store.improve.get(fid)!;
    assert.equal(f.status, "done");
    assert.notEqual(f.outcome, "atteint", "la récidive n'est pas masquée");
  });
});

test("fenêtre : échéance FIGÉE — un événement JUSTE AVANT l'échéance déclenche le retour arrière", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "avant", repo);
  // L'échéance a bien été figée au démarrage confirmé (watch_at + 120 min).
  const f0 = store.improve.get(fid)!;
  assert.ok(f0.watch_deadline, "l'échéance d'observation est figée");

  // Récidive de la signature visée, vue à un tick JUSTE avant l'échéance (119 min < 120).
  store.improve.record("2026-11-25", "error", "avant", 1, "timeout");
  const JUST_BEFORE = new Date(DEPLOY.getTime() + 119 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => JUST_BEFORE }, JUST_BEFORE);

  assert.ok(repo.gitCalls.some((a) => a[0] === "switch" && a[1] === "--detach" && a[2] === "old000"), "retour arrière déclenché dans la fenêtre");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "done");
  assert.equal(f.outcome, "rate");
  assert.equal(f.deploy_phase, "rollback_done", "la phase fine est 'rollback_done'");
});

test("fenêtre : une récidive de signature relevée seulement APRÈS l'échéance ne déclenche plus le retour arrière auto (comptée au jour, non horodatable) — elle part au bilan", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "tardif", repo);

  // Récidive sur le JOUR de l'échéance (2026-11-25), vue seulement au premier passage APRÈS l'échéance. Les
  // comptes de signatures sont au JOUR : impossible de dire si elle a eu lieu avant ou après l'échéance (2 h).
  // Déclencher un retour arrière là-dessus risquerait d'annuler sur une récidive POSTÉRIEURE à la fenêtre : on
  // ne le fait plus. La récidive sera prise en compte par le bilan J+3, pas par le retour arrière auto.
  store.improve.record("2026-11-25", "error", "tardif", 1, "timeout");
  const JUST_AFTER = new Date(DEPLOY.getTime() + 125 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => JUST_AFTER }, JUST_AFTER);

  assert.ok(!repo.gitCalls.some((a) => a[0] === "switch" && a[1] === "--detach"), "pas de retour arrière auto sur une récidive au jour relevée après l'échéance");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "watching", "la fenêtre se clôt, on attend le bilan J+3");
  assert.ok(f.watch_closed_at);
  assert.equal(f.outcome, null);
});

test("fenêtre : un redémarrage de la surveillance locale HORODATÉ dans la fenêtre, relevé après l'échéance, déclenche le retour arrière (marqueur ISO avec Z)", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  // Au déploiement, aucun redémarrage du watchdog. Le marqueur apparaît ensuite, au format RÉEL du watchdog
  // (scripts/watchdog.sh : `date -u +%FT%TZ`, donc ISO finissant par Z), horodaté à 12:30Z — DANS la fenêtre
  // (déploiement 11:00Z, échéance 13:00Z). Il n'est relevé qu'au premier passage à 125 min (après l'échéance).
  const { fid, opts } = await watchingReady(hub, "wd-tardif", repo);
  repo.state.watchdogMarker = "2026-11-25T12:30:00Z";
  // Branche un snapshot qui renvoie ce marqueur (le faux repo de base renvoie toujours null).
  const snapshot: SnapshotReader = () => ({ signatures: [], taskFailures: 0, watchdogMarker: repo.state.watchdogMarker, healthBad: false });
  const JUST_AFTER = new Date(DEPLOY.getTime() + 125 * 60_000);
  await advanceWatching(hub, { ...opts, snapshot, now: () => JUST_AFTER }, JUST_AFTER);

  assert.ok(repo.gitCalls.some((a) => a[0] === "switch" && a[1] === "--detach" && a[2] === "old000"), "retour arrière sur un redémarrage du watchdog horodaté dans la fenêtre");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "done");
  assert.equal(f.outcome, "rate");
});

test("fenêtre : un redémarrage de la surveillance locale horodaté APRÈS l'échéance est ignoré", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "wd-apres", repo);
  // Marqueur horodaté à 13:30Z, soit APRÈS l'échéance (13:00Z) : hors fenêtre, il ne déclenche rien.
  repo.state.watchdogMarker = "2026-11-25T13:30:00Z";
  const snapshot: SnapshotReader = () => ({ signatures: [], taskFailures: 0, watchdogMarker: repo.state.watchdogMarker, healthBad: false });
  const JUST_AFTER = new Date(DEPLOY.getTime() + 125 * 60_000);
  await advanceWatching(hub, { ...opts, snapshot, now: () => JUST_AFTER }, JUST_AFTER);

  assert.ok(!repo.gitCalls.some((a) => a[0] === "switch" && a[1] === "--detach"), "aucun retour arrière sur un redémarrage postérieur à l'échéance");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "watching");
  assert.ok(f.watch_closed_at);
});

test("fenêtre : un relevé POSTÉRIEUR à l'échéance est ignoré — pas de retour arrière, la fenêtre se clôt", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "apres", repo);

  // Récidive vue seulement APRÈS l'échéance (premier passage à 125 min) : elle ne doit PAS déclencher le retour.
  store.improve.record("2026-11-26", "error", "apres", 1, "timeout");
  const JUST_AFTER = new Date(DEPLOY.getTime() + 125 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => JUST_AFTER }, JUST_AFTER);

  assert.ok(!repo.gitCalls.some((a) => a[0] === "switch" && a[1] === "--detach"), "aucun retour arrière après l'échéance");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "watching", "la fiche reste en observation jusqu'au bilan J+3");
  assert.ok(f.watch_closed_at, "la fenêtre serrée est close à l'échéance");
  assert.equal(f.outcome, null);
});

test("sans régression, le bilan J+3 'atteint' range une tâche sur le chat/label du Calendrier", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "disparue", repo);

  const AFTER = new Date(DEPLOY.getTime() + 3 * 86_400_000 + 60_000);
  await advanceWatching(hub, { ...opts, now: () => AFTER }, AFTER);

  const done = store.improve.get(fid)!;
  assert.equal(done.status, "done");
  assert.equal(done.outcome, "atteint");
  assert.ok(done.bilan_at);
  const task = hub.deps.journal.lastByLabel(AMELIORE_BILAN_LABEL);
  assert.ok(task);
  assert.equal(task!.chat_id, AMELIORE_BILAN_CHAT);
  assert.equal(task!.status, "done");
});

test("un 'rate' n'est pas reproposé tant que la garde n'est pas écoulée", () => {
  const { store } = setup();
  store.improve.record("2026-11-23", "error", "fuite", 3, "fuite memoire");
  store.improve.record("2026-11-24", "error", "fuite", 3, "fuite memoire");
  assert.deepEqual(refreshFiches(store.improve, NOW).map((d) => d.signature), ["fuite"]);

  const fid = store.improve.fiche("error", "fuite")!.id;
  store.db.prepare("UPDATE improvements SET status = 'done', outcome = 'rate', bilan_at = ? WHERE id = ?").run("2026-11-25 09:00:00", fid);

  assert.equal(isRateGuarded(store.improve.get(fid)!, NOW), true);
  assert.deepEqual(refreshFiches(store.improve, NOW), []);
  assert.equal(store.improve.get(fid)!.status, "done");

  const later = new Date(NOW.getTime() + (IMPROVE_RATE_GUARD_DAYS + 1) * 86_400_000);
  assert.equal(isRateGuarded(store.improve.get(fid)!, later), false);
});

test("restart en échec avec HEAD avancée : le disque est remis sur la version qui tourne, références gardées, phase 'failed'", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "head-avancee");
  // Le pull avance le disque vers new111, mais le redémarrage échoue : l'instance reste sur old000.
  const repo = fakeRepo({ head: "old000", mainTip: "new111", running: "old000" });
  repo.state.restartOk = false;

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "déploiement sans effet" });
  assert.equal(repo.state.head, "old000", "le disque est remis sur la version que l'instance exécute (pas laissé sur new111)");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "merged");
  assert.equal(f.deploy_phase, "failed", "phase fine 'failed'");
  assert.equal(f.deploy_commit, "old000", "la référence de récupération n'est PAS effacée");
  assert.equal(f.outcome, null);
});

test("interruption AVANT le changement de HEAD : à la reprise, rien n'a démarré, retour à 'merged'", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "avant-head");
  // Fiche restée 'deploying' sans cible figée : le crash est survenu avant le pull. Le `switch main` avait
  // toutefois déjà avancé le disque sur new111, alors que l'instance tourne toujours sur old000.
  store.improve.setDeploying(fid, "old000", JSON.stringify({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: false, deployDay: "2026-11-25", targetFromDeployDay: 0 }), DEPLOY);
  const repo = fakeRepo({ head: "new111", mainTip: "new111", running: "old000" });

  await resumeDeploying(hub, optsFor(repo));
  assert.equal(repo.state.head, "old000", "le disque est remis sur la version qui tourne");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "merged", "aucune version déployée : retour au bouton « Déployer »");
  assert.equal(f.deploy_phase, "failed");
  assert.equal(f.outcome, null);
});

test("interruption PENDANT le redémarrage (disque déjà sur la cible, instance restée en arrière) : disque remis, 'merged'", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "pendant-restart");
  store.improve.setDeploying(fid, "old000", JSON.stringify({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: false, deployDay: "2026-11-25", targetFromDeployDay: 0 }), DEPLOY);
  store.improve.setDeployTarget(fid, "new111", DEPLOY);
  // Le disque est sur la cible (pull fait), mais l'instance tourne encore sur l'ancienne version (restart sans effet).
  const repo = fakeRepo({ head: "new111", mainTip: "new111", running: "old000" });

  await resumeDeploying(hub, optsFor(repo));
  assert.equal(repo.state.head, "old000", "le disque est ramené sur la version qui tourne, pas laissé sur la cible");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "merged");
  assert.equal(f.deploy_phase, "failed");
  assert.equal(f.deploy_commit, "old000", "référence de récupération gardée");
});

test("candidate sans le commit de fusion : déploiement refusé, dépôt remis sur la version d'avant", async () => {
  const { hub, store } = setup();
  // La PR annonce un commit de fusion que la version candidate (new111) ne contient PAS.
  const fid = mergedFiche(hub, "sans-fusion", 7, "merge999");
  assert.equal(store.improve.get(fid)!.merge_commit, "merge999", "le commit de fusion est bien retenu au merge");
  const repo = fakeRepo({ head: "old000", mainTip: "new111", contained: ["new111", "old000"] }); // merge999 absent

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "commit de fusion absent de la cible" });
  assert.equal(repo.state.head, "old000", "le dépôt est remis sur la version d'avant");
  assert.equal(repo.serviceCalls.length, 0, "aucun redémarrage : on n'a pas déployé un main incomplet");
  assert.equal(store.improve.get(fid)!.status, "merged");
});

test("candidate QUI contient le commit de fusion : déploiement accepté", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "avec-fusion", 7, "merge999");
  const repo = fakeRepo({ head: "old000", mainTip: "new111", contained: ["new111", "old000", "merge999"] });

  assert.equal(await deployImprovement(hub, fid, optsFor(repo)), "done");
  assert.equal(store.improve.get(fid)!.status, "watching");
});

test("fiche fusionnée sans commit de fusion connu : déploiement refusé (rien touché), puis accepté après réactualisation de la métadonnée", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "legacy", 7, null); // fusionnée, mais commit de fusion inconnu
  assert.equal(store.improve.get(fid)!.merge_commit, null);
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "commit de fusion inconnu" });
  assert.equal(repo.gitCalls.length, 0, "aucune opération git tant que le commit de fusion n'est pas vérifiable");
  assert.equal(repo.serviceCalls.length, 0);
  assert.equal(store.improve.get(fid)!.status, "merged", "la fiche reste fusionnée (déployable plus tard)");

  // Le statut de PR du groupe fournit ensuite le commit de fusion : detectMerges le réactualise (sans réseau).
  const gid = store.improve.get(fid)!.group_id!;
  store.dev.updateGroup(gid, { pr_status: JSON.stringify({ state: "MERGED", mergeCommit: "new111" }) });
  detectMerges(hub, NOW);
  assert.equal(store.improve.get(fid)!.merge_commit, "new111", "le commit de fusion est réactualisé depuis le statut de PR");

  assert.equal(await deployImprovement(hub, fid, optsFor(repo)), "done", "le déploiement est désormais accepté");
  assert.equal(store.improve.get(fid)!.status, "watching");
});

test("retour arrière : le redémarrage passe en mode --rollback (jamais de retour au last-good en régression)", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { opts } = await watchingReady(hub, "mode-rollback", repo);

  repo.state.healthBad = true;
  const WITHIN = new Date(DEPLOY.getTime() + 10 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);

  assert.ok(repo.serviceCalls.includes("restart --rollback"), "le retour arrière redémarre en mode --rollback");
  assert.ok(!repo.serviceCalls.slice(1).includes("restart"), "le retour arrière n'utilise pas le restart ordinaire (qui pourrait revenir au last-good en régression)");
});

test("branche suivie incorrecte (pas main) : déploiement refusé", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "mauvaise-branche");
  // `git switch main` est simulé en échec (reste sur une autre branche) : la garde refuse de tirer.
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  repo.state.switchMainOk = false;

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "git switch main impossible" });
  assert.equal(repo.serviceCalls.length, 0);
  assert.equal(store.improve.get(fid)!.status, "merged");
});

test("amont inattendu (pas origin/main) : déploiement refusé, pas de pull", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "amont-inattendu");
  // La branche est bien main après le switch, mais son amont suivi n'est pas origin/main (ex. un fork).
  const repo = fakeRepo({ head: "old000", mainTip: "new111", upstream: "fork/main" });

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "branche suivie incorrecte" });
  assert.ok(!repo.gitCalls.some((a) => a[0] === "pull"), "aucun pull depuis un amont non vérifié");
  assert.equal(repo.serviceCalls.length, 0);
  assert.equal(store.improve.get(fid)!.status, "merged");
});

test("amont illisible : déploiement refusé (on ne devine pas la source)", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "amont-illisible");
  const repo = fakeRepo({ head: "old000", mainTip: "new111", upstream: null });

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "branche suivie incorrecte" });
  assert.ok(!repo.gitCalls.some((a) => a[0] === "pull"), "aucun pull quand l'amont n'est pas vérifiable");
  assert.equal(store.improve.get(fid)!.status, "merged");
});

test("échec du pull PUIS échec de la remise : fiche laissée 'deploying' (références gardées), nouveau déploiement bloqué", async () => {
  const { hub, store } = setup();
  const fid = mergedFiche(hub, "pull-et-remise-ko");
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  repo.state.pullOk = false; // le pull échoue après le switch main (HEAD déjà avancée sur new111)
  repo.state.switchDetachOk = false; // ...et la remise sur le commit de secours échoue aussi

  const res = await deployImprovement(hub, fid, optsFor(repo));
  assert.deepEqual(res, { error: "git pull --ff-only impossible" });
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "deploying", "remise NON confirmée : la fiche reste 'deploying', pas rendue au bouton");
  assert.equal(f.deploy_phase, "failed");
  assert.equal(f.deploy_commit, "old000", "la référence de secours est GARDÉE (backToMerged ne l'a pas effacée)");

  // Un nouveau déploiement d'une autre fiche est bloqué tant que celle-ci n'est pas remise en état.
  const other = mergedFiche(hub, "autre");
  const res2 = await deployImprovement(hub, other, optsFor(fakeRepo({ head: "zzz", mainTip: "www" })));
  assert.deepEqual(res2, { error: "Une autre amélioration est déjà en observation." });
});

test("retour arrière : commit de secours noté 'bon' et script figé AVANT le redémarrage, fiche close une fois le redémarrage CONFIRMÉ", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "secours-ancien", repo);

  // Régression : avant de redémarrer, le commit de secours est noté « bonne version » et le service.sh courant
  // est figé (pour ne pas dépendre d'un service.sh ancien embarqué dans le commit de secours). La fiche n'est
  // clôturée qu'une fois le redémarrage confirmé (ici le faux service fait adopter old000 par l'instance).
  repo.state.healthBad = true;
  const WITHIN = new Date(DEPLOY.getTime() + 5 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);

  assert.deepEqual(repo.goodCalls, ["old000"], "le commit de secours (jamais celui en régression) est noté bon");
  assert.ok(repo.pinned >= 1, "le service.sh de secours est figé avant le redémarrage");
  assert.ok(repo.serviceCalls.includes("restart --rollback"), "redémarrage en mode retour arrière");
  assert.equal(repo.state.running, "old000", "l'instance tourne bien sur le commit de secours (redémarrage confirmé)");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "done", "la fiche est clôturée après confirmation");
  assert.equal(f.outcome, "rate");
  assert.equal(f.deploy_phase, "rollback_done");
});

test("retour arrière : script de secours figé absent (rollbackScriptReady faux) → aucun redémarrage auto, fiche laissée 'reverting'", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "secours-absent", repo);

  // Régression : le disque est bien remis sur le secours et noté « bon », mais le script de secours figé est
  // introuvable. On NE redémarre PAS tout seul (on ne retombe pas sur un service.sh de secours peut-être trop
  // ancien, qui ignorerait --rollback). La fiche reste 'reverting' (reprenable), on alerte.
  repo.state.healthBad = true;
  const WITHIN = new Date(DEPLOY.getTime() + 5 * 60_000);
  await advanceWatching(hub, { ...opts, rollbackScriptReady: () => false, now: () => WITHIN }, WITHIN);

  assert.deepEqual(repo.goodCalls, ["old000"], "le secours est noté bon avant la garde");
  assert.ok(!repo.serviceCalls.includes("restart --rollback"), "pas de redémarrage de secours sans script figé");
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "reverting", "laissée reprenable, jamais clôturée");
  assert.equal(f.outcome, null);
});

test("retour arrière confirmé par la reprise quand la version de secours ignore la reprise : clôture sans downgrade au déploiement suivant", async () => {
  const { hub, store } = setup();
  const repo = fakeRepo({ head: "old000", mainTip: "new111" });
  const { fid, opts } = await watchingReady(hub, "secours-sans-reprise", repo);

  // Régression, mais le redémarrage ne confirme pas (comme si la version de secours, antérieure à cette
  // fonctionnalité, ne « reprenait » pas la fiche) : elle reste 'reverting'.
  repo.state.healthBad = true;
  repo.state.restartOk = false;
  const WITHIN = new Date(DEPLOY.getTime() + 5 * 60_000);
  await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);
  assert.equal(store.improve.get(fid)!.status, "reverting", "non confirmé : laissée 'reverting'");

  // Plus tard, une AUTRE version est installée (ni la régressée new111, ni le secours old000) : la reprise ne
  // doit PAS « downgrader » vers le secours — elle clôt la fiche, la confirmation survit au remplacement.
  repo.state.running = "future9";
  repo.state.head = "future9";
  await resumeReverting(hub, { ...opts, now: () => new Date(DEPLOY.getTime() + 20 * 60_000) });
  const f = store.improve.get(fid)!;
  assert.equal(f.status, "done", "la fiche est enfin clôturée");
  assert.equal(f.outcome, "rate");
  assert.equal(repo.state.head, "future9", "aucun downgrade : le dépôt n'est pas ramené sur le secours");
});

test("realService : un redémarrage lancé par Clark porte le drapeau anti-installation de surveillance", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "clark-svc-"));
  try {
    const script = join(tmp, "scripts");
    execFileSync("mkdir", ["-p", script]);
    const sh = join(script, "service.sh");
    writeFileSync(sh, "#!/bin/bash\necho \"cmd=$1 flag=${CLARK_RESTART_NO_INSTALL:-absent}\"\n");
    chmodSync(sh, 0o755);
    const res = await realService(tmp)("restart");
    assert.equal(res.ok, true);
    // Le flag empêche service.sh d'installer la surveillance locale au passage (aucun ajout silencieux).
    assert.match(res.stdout, /cmd=restart flag=1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("realService : « restart --rollback » exécute le script FIGÉ (data/), pas le scripts/service.sh du checkout (qui pourrait être ancien et installer la surveillance)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "clark-pin-"));
  try {
    execFileSync("mkdir", ["-p", join(tmp, "scripts"), join(tmp, "data")]);
    // Le service.sh du checkout simule une version ANCIENNE : il « installerait la surveillance ».
    const checkout = join(tmp, "scripts", "service.sh");
    writeFileSync(checkout, "#!/bin/bash\necho install-watchdog-checkout\n");
    chmodSync(checkout, 0o755);
    // Le script figé (version actuelle, gère --rollback sans rien installer).
    const pinned = join(tmp, "data", "clark-rollback-service.sh");
    writeFileSync(pinned, "#!/bin/bash\necho pinned-rollback-no-install\n");
    chmodSync(pinned, 0o755);

    const rollback = await realService(tmp)("restart --rollback");
    assert.match(rollback.stdout, /pinned-rollback-no-install/, "le retour arrière passe par le script figé");
    assert.doesNotMatch(rollback.stdout, /install-watchdog-checkout/, "jamais le service.sh (ancien) du checkout");

    // Un redémarrage ORDINAIRE reste sur le service.sh du checkout (version en place sur le disque).
    const normal = await realService(tmp)("restart");
    assert.match(normal.stdout, /install-watchdog-checkout/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sur un vrai dépôt git temporaire : déploiement par pull, retour arrière, puis redéploiement après retour arrière", async (t) => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const tmp = mkdtempSync(join(tmpdir(), "clark-deploy-"));
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  // realGit() hérite de process.env : on neutralise la config git globale/système (le bac à sable interdit
  // la lecture de ~/.gitconfig) et on coupe toute invite git (GIT_TERMINAL_PROMPT=0) pour qu'un git qui
  // demanderait une saisie échoue net au lieu de bloquer le test. En production, realGit lit la vraie config.
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;
  const savedPrompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  process.env.GIT_TERMINAL_PROMPT = "0";
  try {
    const origin = join(tmp, "origin.git");
    const dev = join(tmp, "dev");
    const work = join(tmp, "work");
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { env, stdio: "ignore" });
    execFileSync("git", ["clone", origin, dev], { env, stdio: "ignore" });
    g(dev, "config", "user.email", "t@t.t"); g(dev, "config", "user.name", "t");
    writeFileSync(join(dev, "a.txt"), "v1");
    g(dev, "add", "a.txt"); g(dev, "commit", "-m", "v1"); g(dev, "push", "-u", "origin", "main");
    // Le poste « en service » clone à la v1 (il tourne donc sur l'ancienne version).
    execFileSync("git", ["clone", origin, work], { env, stdio: "ignore" });
    g(work, "config", "user.email", "t@t.t"); g(work, "config", "user.name", "t");
    const v1 = g(work, "rev-parse", "HEAD");
    // La PR est fusionnée : une v2 arrive sur origin/main.
    writeFileSync(join(dev, "a.txt"), "v2");
    g(dev, "add", "a.txt"); g(dev, "commit", "-m", "v2"); g(dev, "push", "origin", "main");
    const v2 = g(dev, "rev-parse", "HEAD");

    const { hub, store } = setup();
    const repoHealth = { bad: false };
    const service: RunService = async () => ({ ok: true, stdout: "", stderr: "" }); // aucun redémarrage réel
    const snapshot: SnapshotReader = () => ({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: repoHealth.bad });
    // Pas de vrai processus : on simule « l'instance tourne sur ce qu'il y a sur le disque » (le service est
    // un no-op qui n'échange pas le code). runningCommit lit donc le HEAD réel du dépôt de travail.
    const runningCommit = () => g(work, "rev-parse", "HEAD");
    // recordGood/pinRollbackScript injectés en no-op : le dépôt de test n'a ni data/ ni scripts/service.sh.
    const opts: ImproveDeployOptions = { root: work, git: realGit(work), service, snapshot, runningCommit, recordGood: () => true, pinRollbackScript: () => true, rollbackScriptReady: () => true, markPending: () => true, clearPending: () => {}, now: () => DEPLOY, watchMinutes: 120 };

    // Déploiement : switch main + pull --ff-only fait réellement passer le poste de v1 à v2.
    const fid = mergedFiche(hub, "reelle", 7, v2);
    assert.equal(await deployImprovement(hub, fid, opts), "done");
    assert.equal(g(work, "rev-parse", "HEAD"), v2, "le dépôt est passé à la v2");
    assert.equal(store.improve.get(fid)!.deploy_commit, v1, "le commit de secours est la v1");
    assert.equal(store.improve.get(fid)!.deploy_target, v2, "la cible figée est la v2");

    // Régression : retour arrière réel en HEAD détachée sur la v1.
    repoHealth.bad = true;
    const WITHIN = new Date(DEPLOY.getTime() + 10 * 60_000);
    await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);
    assert.equal(g(work, "rev-parse", "HEAD"), v1, "retour arrière réel à la v1");
    assert.equal(store.improve.get(fid)!.outcome, "rate");

    // Nouveau clic après le retour arrière (HEAD détachée) : le déploiement se replace sur main et repart.
    repoHealth.bad = false;
    const fid2 = mergedFiche(hub, "reelle2", 7, v2);
    assert.equal(await deployImprovement(hub, fid2, opts), "done");
    assert.equal(g(work, "rev-parse", "HEAD"), v2, "le redéploiement remonte à la v2 malgré la HEAD détachée");
  } catch (err) {
    if (err instanceof Error && /ENOENT|not found|git:/.test(err.message)) return t.skip("git indisponible");
    throw err;
  } finally {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    if (savedPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT; else process.env.GIT_TERMINAL_PROMPT = savedPrompt;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("retour arrière réel : le script figé (data/) porte la version CANDIDATE de service.sh, pas celle du commit de secours (copie AVANT le git switch)", async (t) => {
  // Deux versions du script dans un vrai dépôt, un faux service : on vérifie l'ENCHAÎNEMENT réel. Le script de
  // secours figé doit porter la version QUI GÈRE --rollback (celle du disque AVANT le retour arrière), jamais
  // celle, peut-être ancienne, embarquée dans le commit de secours (qui serait sur le disque APRÈS le switch).
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const tmp = mkdtempSync(join(tmpdir(), "clark-pin-ordre-"));
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;
  const savedPrompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  process.env.GIT_TERMINAL_PROMPT = "0";
  try {
    const origin = join(tmp, "origin.git");
    const dev = join(tmp, "dev");
    const work = join(tmp, "work");
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { env, stdio: "ignore" });
    execFileSync("git", ["clone", origin, dev], { env, stdio: "ignore" });
    g(dev, "config", "user.email", "t@t.t"); g(dev, "config", "user.name", "t");
    // v1 : service.sh ANCIEN (ignorerait --rollback). Il est suivi par git, donc il change au fil des commits.
    mkdirSync(join(dev, "scripts"));
    writeFileSync(join(dev, "scripts", "service.sh"), "#!/bin/bash\necho V1-OLD-would-install\n"); chmodSync(join(dev, "scripts", "service.sh"), 0o755);
    writeFileSync(join(dev, "a.txt"), "v1");
    g(dev, "add", "-A"); g(dev, "commit", "-m", "v1"); g(dev, "push", "-u", "origin", "main");
    // Le poste « en service » clone à la v1.
    execFileSync("git", ["clone", origin, work], { env, stdio: "ignore" });
    g(work, "config", "user.email", "t@t.t"); g(work, "config", "user.name", "t");
    const v1 = g(work, "rev-parse", "HEAD");
    mkdirSync(join(work, "data")); // les copies réelles (recordGood, pin) écrivent dans data/
    // v2 : service.sh NOUVEAU (gère --rollback sans rien installer).
    writeFileSync(join(dev, "scripts", "service.sh"), "#!/bin/bash\necho V2-NEW-handles-rollback\n"); chmodSync(join(dev, "scripts", "service.sh"), 0o755);
    writeFileSync(join(dev, "a.txt"), "v2");
    g(dev, "add", "-A"); g(dev, "commit", "-m", "v2"); g(dev, "push", "origin", "main");
    const v2 = g(dev, "rev-parse", "HEAD");

    const { hub, store } = setup();
    const repoHealth = { bad: false };
    const service: RunService = async () => ({ ok: true, stdout: "", stderr: "" }); // aucun redémarrage réel
    const snapshot: SnapshotReader = () => ({ signatures: [], taskFailures: 0, watchdogMarker: null, healthBad: repoHealth.bad });
    const runningCommit = () => g(work, "rev-parse", "HEAD");
    // DÉFAUTS réels pour recordGood / pinRollbackScript / rollbackScriptReady (root = work) : c'est précisément
    // ce que ce test exerce. On ne les injecte donc PAS.
    const opts: ImproveDeployOptions = { root: work, git: realGit(work), service, snapshot, runningCommit, now: () => DEPLOY, watchMinutes: 120 };

    const fid = mergedFiche(hub, "pin-ordre", 7, v2);
    assert.equal(await deployImprovement(hub, fid, opts), "done");
    assert.equal(g(work, "rev-parse", "HEAD"), v2, "le dépôt est passé à la v2");
    assert.match(readFileSync(join(work, "scripts", "service.sh"), "utf8"), /V2-NEW/, "le disque porte bien la v2 du script avant le retour arrière");

    // Régression → retour arrière réel : pin AVANT le switch, puis switch détaché sur v1.
    repoHealth.bad = true;
    const WITHIN = new Date(DEPLOY.getTime() + 10 * 60_000);
    await advanceWatching(hub, { ...opts, now: () => WITHIN }, WITHIN);
    assert.equal(g(work, "rev-parse", "HEAD"), v1, "retour arrière réel à la v1");
    assert.match(readFileSync(join(work, "scripts", "service.sh"), "utf8"), /V1-OLD/, "après le switch, le checkout porte le service.sh ANCIEN");

    // Le cœur du test : le script figé a capturé la version NOUVELLE (copie faite AVANT le switch).
    const pinnedPath = join(work, "data", "clark-rollback-service.sh");
    assert.ok(existsSync(pinnedPath), "le script de secours a été figé");
    const pinnedContent = readFileSync(pinnedPath, "utf8");
    assert.match(pinnedContent, /V2-NEW/, "le script figé porte la version candidate (qui gère --rollback)");
    assert.doesNotMatch(pinnedContent, /V1-OLD/, "jamais la version du commit de secours");
    assert.ok((statSync(pinnedPath).mode & 0o111) !== 0, "le script figé est exécutable");
    assert.match(readFileSync(join(work, "data", "last-good-commit"), "utf8"), new RegExp(v1), "last-good noté sur le secours");
    assert.equal(store.improve.get(fid)!.outcome, "rate");
  } catch (err) {
    if (err instanceof Error && /ENOENT|not found|git:/.test(err.message)) return t.skip("git indisponible");
    throw err;
  } finally {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    if (savedPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT; else process.env.GIT_TERMINAL_PROMPT = savedPrompt;
    rmSync(tmp, { recursive: true, force: true });
  }
});
