// ── Dev : projets, tâches dans leurs copies, relecture du diff ──

let projectFormOpen = false;
const devPatches = new Map(); // id → { rounds, patch } : le diff complet, chargé à la demande
// Le diff change à chaque tour, et quand on revient à un tour précédent.
const patchKey = (t) => `${t.rounds}:${t.atRound ?? ""}`;
const devStatus = { waiting: "en attente", preparing: "préparation de la copie", working: "en cours", review: "à relire", accepted: "acceptée", discarded: "jetée", failed: "arrêtée" };
const fileStatusMark = { ajouté: "A", modifié: "M", supprimé: "D", renommé: "R" };

/** Les fichiers d'un patch, ligne par ligne, avec leurs numéros (ancien et nouveau côté). */
function parsePatch(patch) {
  const files = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      files.push({ name: line.replace(/^diff --git a\/.* b\//, ""), rows: [] });
      continue;
    }
    if (!files.length || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(line)) continue;
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      files.at(-1).rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) files.at(-1).rows.push({ kind: "add", text: line.slice(1), n: n++ });
    else if (line.startsWith("-")) files.at(-1).rows.push({ kind: "del", text: line.slice(1), o: o++ });
    else if (line.length || files.at(-1).rows.length) files.at(-1).rows.push({ kind: "ctx", text: line.slice(1), o: o++, n: n++ });
  }
  return files;
}

let commentDraft = null; // { task, file, side, start, end, snippet } : le commentaire en cours d'écriture
let diffWrap = (() => {
  try {
    return localStorage.getItem("clark.diffWrap") === "1";
  } catch {
    return false;
  }
})();

/** Où se place un commentaire : sa dernière ligne, retrouvée par son texte si le diff a bougé. */
function anchorOf(c, file) {
  const last = c.snippet.split("\n").at(-1) ?? "";
  const num = (r) => (c.side === "old" ? r.o : r.n);
  const usable = (r) => r.kind !== "hunk" && (c.side === "old" ? r.kind !== "add" : r.kind !== "del");
  const exact = file.rows.findIndex((r) => usable(r) && num(r) === c.end && r.text === last);
  if (exact >= 0) return exact;
  return file.rows.findIndex((r) => usable(r) && r.text === last && last.trim() !== "");
}

function renderComment(c) {
  const lines = c.start === c.end ? `ligne ${c.start}` : `lignes ${c.start} à ${c.end}`;
  const state = c.status === "resolved" ? "résolu" : c.sent ? `envoyé au tour ${c.sent}` : "pas encore envoyé";
  if (c.status === "resolved")
    return `<div class="dc resolved" data-comment="${c.id}"><span class="quiet">Résolu · ${lines} : ${esc(c.body.split("\n")[0].slice(0, 120))}</span> <button type="button" class="link" data-comment-act="reopen">Rouvrir</button></div>`;
  return `<div class="dc" data-comment="${c.id}">
    <p class="dc-head">${lines} · ${state}</p>
    <div class="prose">${md(c.body)}</div>
    <div class="dc-actions">${c.sent ? `<button type="button" class="link" data-comment-act="resolve">Résoudre</button>` : `<button type="button" class="link" data-comment-act="delete">Retirer</button>`}</div>
  </div>`;
}

function renderCommentForm(d) {
  const lines = d.start === d.end ? `ligne ${d.start}` : `lignes ${d.start} à ${d.end}`;
  return `<form class="dc dc-form" data-comment-form>
    <label class="dc-head" for="comment-text">Commentaire sur ${esc(d.file)}, ${lines}${d.side === "old" ? " (retirée)" : ""} <span class="quiet">· Maj+clic sur une autre ligne pour étendre</span></label>
    <textarea id="comment-text" name="body" rows="3" maxlength="4000" placeholder="Ce qu'il faut changer ici"></textarea>
    <div class="dc-actions"><button type="submit" class="btn primary">Enregistrer</button><button type="button" class="btn ghost" data-comment-cancel>Annuler</button><span class="quiet">Entrée pour enregistrer, Maj+Entrée pour aller à la ligne, Échap pour annuler</span></div>
  </form>`;
}

/** Le diff complet d'une tâche : lignes numérotées, commentaires de l'utilisateur posés dessus. */
function renderPatch(patch, t) {
  if (!patch) return `<p class="quiet">Chargement du diff…</p>`;
  if (!patch.trim()) return `<p class="quiet">Aucun changement.</p>`;
  if (patch.startsWith("Diff indisponible")) return `<p class="goal-reason">${esc(patch)}</p>`;
  const files = parsePatch(patch);
  const comments = t?.comments ?? [];
  const placed = new Set();
  const canComment = t && (t.status === "review" || t.status === "failed");
  const open = comments.filter((c) => c.status === "open");
  const html = files
    .map((f, fi) => {
      const byRow = new Map();
      for (const c of comments.filter((c) => c.file === f.name)) {
        const at = anchorOf(c, f);
        if (at < 0) continue;
        placed.add(c.id);
        byRow.set(at, [...(byRow.get(at) ?? []), c]);
      }
      const d = commentDraft && commentDraft.task === t?.id && commentDraft.file === f.name ? commentDraft : null;
      const rows = f.rows
        .map((r, i) => {
          if (r.kind === "hunk") return `<div class="dl d-hunk">${esc(r.text)}</div>`;
          const side = r.kind === "del" ? "old" : "new";
          const num = side === "old" ? r.o : r.n;
          const sel = d && d.side === side && num >= d.start && num <= d.end ? " dl-sel" : "";
          const formHere = d && d.side === side && num === d.end;
          return `<div class="dl ${r.kind === "add" ? "d-add" : r.kind === "del" ? "d-del" : ""}${sel}" data-file="${fi}" data-side="${side}" data-line="${num}" tabindex="-1">${
            canComment ? `<button type="button" class="dl-add" tabindex="-1" aria-label="Commenter la ligne ${num}" data-comment-line>+</button>` : `<span class="dl-add" aria-hidden="true"></span>`
          }<span class="dl-no">${num}</span><span class="dl-text">${esc(r.text) || " "}</span></div>${(byRow.get(i) ?? []).map(renderComment).join("")}${formHere ? renderCommentForm(d) : ""}`;
        })
        .join("");
      return `<p class="diff-file" id="df-${t?.id}-${fi}" tabindex="-1">${esc(f.name)}</p><div class="diff${diffWrap ? " wrap" : ""}" data-diff-file="${esc(f.name)}">${rows}</div>`;
    })
    .join("");
  const loose = comments.filter((c) => !placed.has(c.id) && c.status === "open");
  const tools = t
    ? `<div class="diff-tools">
        ${canComment ? `<button type="button" class="btn primary" data-diff-send${open.length ? "" : " disabled"}>Envoyer ${open.length || ""} commentaire${open.length > 1 ? "s" : ""} à l'agent</button>` : ""}
        <label class="radio"><input type="checkbox" data-diff-wrap${diffWrap ? " checked" : ""} /> Retour à la ligne</label>
        <span class="quiet diff-keys"><kbd>j</kbd>/<kbd>k</kbd> fichiers · <kbd>n</kbd>/<kbd>p</kbd> changements${canComment ? " · <kbd>c</kbd> commenter" : ""}</span>
      </div>`
    : "";
  const detached = loose.length
    ? `<div class="dc-loose"><p class="dc-head">Lignes qui ont bougé depuis le commentaire</p>${loose.map((c) => `<p class="quiet"><code>${esc(c.file)}</code></p>${renderComment(c)}`).join("")}</div>`
    : "";
  return tools + html + detached;
}

/** PR : le lien si elle existe ; sinon le bouton, puis le formulaire avec le titre et le texte à relire. */
const prForms = new Map(); // "tasks:1" → { title, body, error } pendant que le formulaire est ouvert
const prStateText = { OPEN: "ouverte", MERGED: "mergée", CLOSED: "fermée" };
const reviewText = { APPROVED: "approuvée", CHANGES_REQUESTED: "changements demandés", REVIEW_REQUIRED: "relecture demandée" };

/** Une PR ouverte : son état, sa CI, ses reviews, et de quoi les traiter. */
function renderPrStatus(kind, id, url, st, followUps = []) {
  const link = `<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(url.replace(/^https:\/\/github\.com\//, ""))}</a>`;
  if (!st) return `<div class="pr-box" data-pr="${kind}:${id}"><p class="card-note">Pull request : ${link} · <span class="quiet">état pas encore lu</span> <button type="button" class="link" data-pr-act="pr-refresh">Lire</button></p></div>`;
  const fail = st.checks.filter((c) => c.state === "failure");
  const pend = st.checks.filter((c) => c.state === "pending");
  const ok = st.checks.filter((c) => c.state === "success");
  const ci = !st.checks.length
    ? "pas de CI"
    : fail.length
      ? `CI en échec : ${fail.map((c) => (c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noreferrer noopener">${esc(c.name)}</a>` : esc(c.name))).join(", ")}${ok.length ? ` · ${ok.length} réussi${ok.length > 1 ? "s" : ""}` : ""}`
      : pend.length
        ? `CI en cours (${pend.length})${ok.length ? ` · ${ok.length} réussi${ok.length > 1 ? "s" : ""}` : ""}`
        : `CI au vert (${ok.length})`;
  const open = st.state === "OPEN";
  const busy = followUps.some((f) => ["waiting", "preparing", "working", "review"].includes(f.status));
  return `<div class="pr-box" data-pr="${kind}:${id}" data-state="${st.state}">
    <p class="card-note">Pull request ${link} · <strong>${prStateText[st.state] ?? st.state}</strong>${st.draft ? " · brouillon" : ""}${st.reviewDecision && reviewText[st.reviewDecision] ? ` · ${reviewText[st.reviewDecision]}` : ""}</p>
    ${open ? `<p class="pr-ci${fail.length ? " bad" : ""}">${ci}</p>` : ""}
    ${st.error ? `<p class="quiet">Dernière lecture en échec : ${esc(st.error)}</p>` : ""}
    ${
      st.comments.length
        ? `<details class="goal-log pr-comments" data-pr-comments><summary>${st.comments.length} commentaire${st.comments.length > 1 ? "s" : ""} de review${st.fresh ? ` · <strong>${st.fresh} nouveau${st.fresh > 1 ? "x" : ""}</strong>` : ""}</summary>${st.comments
            .map((c) => `<div class="dc"><p class="dc-head">${esc(c.author)}${c.path ? ` · <code>${esc(c.path)}${c.line ? `:${c.line}` : ""}</code>` : ""}${c.state === "CHANGES_REQUESTED" ? " · changements demandés" : ""}</p><div class="prose">${md(c.body || "(sans texte)")}</div></div>`)
            .join("")}</details>`
        : ""
    }
    ${followUps.length ? `<ul class="link-list pr-follow">${followUps.map((f) => `<li><a href="#dev/${f.id}"><span class="dot" data-s="${f.status === "review" ? "review" : f.status === "accepted" ? "done" : "wait"}"></span><span class="ll-label">${esc(f.title)}</span><span class="quiet">${devStatus[f.status] ?? f.status}</span></a></li>`).join("")}</ul>` : ""}
    <div class="card-actions">
      ${open && fail.length ? `<button type="button" class="btn secondary" data-pr-act="pr-ci"${busy ? " disabled" : ""}>Corriger la CI</button>` : ""}
      ${open && st.comments.length ? `<button type="button" class="btn secondary" data-pr-act="pr-review"${busy ? " disabled" : ""}>Traiter les commentaires</button>` : ""}
      ${open ? `<button type="button" class="btn ghost" data-pr-act="pr-refresh">Actualiser</button>` : ""}
      <span class="quiet">lu à ${time(new Date(st.readAt))}</span>
    </div>
  </div>`;
}

side.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pr-act]");
  if (!b) return;
  const box = b.closest("[data-pr]");
  const [kind, id] = box.dataset.pr.split(":");
  b.disabled = true;
  try {
    const r = await post(`/api/dev/${kind === "task" ? "tasks" : "groups"}/${id}`, { action: b.dataset.prAct });
    if (r.id) location.hash = `#dev/${r.id}`;
  } catch (err) {
    box.querySelector(".inline-error")?.remove();
    box.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  } finally {
    b.disabled = false;
  }
});

side.addEventListener(
  "toggle",
  (e) => {
    const d = e.target.closest?.("[data-pr-comments]");
    if (!d?.open || !d.querySelector("strong")) return;
    const [kind, id] = d.closest("[data-pr]").dataset.pr.split(":");
    post(`/api/dev/${kind === "task" ? "tasks" : "groups"}/${id}`, { action: "pr-seen" }).catch(() => {});
  },
  true,
);

function renderPr(kind, id, url, st = null, followUps = []) {
  if (url) return renderPrStatus(kind === "tasks" ? "task" : "group", id, url, st, followUps);
  const key = `${kind}:${id}`;
  const f = prForms.get(key);
  if (!f) return `<div class="card-actions"><button type="button" class="btn secondary" data-pr-open="${key}">Ouvrir une pull request</button></div>`;
  return `<form class="card auto-form pr-form" data-pr-form="${key}" novalidate>
    <p class="card-title">Pull request vers <code>${esc(f.base ?? "")}</code></p>
    <p class="quiet field-hint">Clark envoie la branche <code>${esc(f.branch ?? "")}</code> sur GitHub et ouvre la PR avec ce titre et ce texte. Relis-les avant.</p>
    <label for="pr-title-${key}">Titre</label>
    <input id="pr-title-${key}" name="title" type="text" maxlength="200" value="${esc(f.title ?? "")}" />
    <label for="pr-body-${key}">Texte</label>
    <textarea id="pr-body-${key}" name="body" rows="6">${esc(f.body ?? "")}</textarea>
    ${f.error ? `<p class="inline-error" role="alert">${esc(f.error)}</p>` : ""}
    <div class="card-actions"><button type="submit" class="btn primary"${f.sending ? " disabled" : ""}>${f.sending ? "Envoi…" : "Ouvrir la PR"}</button><button type="button" class="btn ghost" data-pr-cancel="${key}">Annuler</button></div>
  </form>`;
}

function renderDevGroup(g) {
  const decided = g.tasks.length && g.tasks.every((t) => t.status === "accepted" || t.status === "discarded");
  const accepted = g.tasks.filter((t) => t.status === "accepted" && t.commit).length;
  const status = { planning: "plan en cours", running: decided ? "à réunir" : "en cours", integrated: "réuni", failed: "arrêté", discarded: "jeté" }[g.status] ?? g.status;
  return `<div class="card dev-group" data-dev-group="${g.id}" data-status="${g.status}">
    <div class="goal-head">
      <span class="kind-line">${g.mode === "binome" ? `Binôme #${g.id} · ${esc(g.project)} · Claude + Codex` : `Groupe #${g.id} · ${esc(g.project)}${g.engine ? ` · ${esc(ENGINE_NAMES[g.engine] ?? g.engine)}` : ""}`}${g.tasks.length ? ` · ${g.tasks.length} sous-tâche${g.tasks.length > 1 ? "s" : ""}` : ""}</span>
      ${g.autopilot ? `<span class="tag" title="Clark accepte seul les versions vertes, réunit et ouvre la PR">pilote auto</span>` : ""}
      <span class="tag dev-${g.status === "running" && decided ? "review" : g.status === "planning" ? "working" : g.status}">${g.status === "planning" ? `${sprite("clark", { walking: true, size: 14 })}` : ""}${status}</span>
    </div>
    ${g.status === "planning" ? `<p class="quiet">${g.mode === "binome" ? "Claude lit le projet et découpe la tâche ; Codex critique le plan, puis Claude le corrige." : "Un agent lit le projet et découpe la consigne en sous-tâches indépendantes."}</p>` : ""}
    ${g.planNote ? `<details class="goal-log"><summary>Critique du plan par Codex</summary><div class="prose">${md(g.planNote)}</div></details>` : ""}
    ${g.error ? `<p class="goal-reason">${esc(g.error)}</p>` : ""}
    ${(g.gates ?? []).map((x) => renderGate(x, "")).join("")}
    ${g.tasks.length ? `<div class="dev-subtasks">${g.tasks.map((t) => renderDevTask(t, true)).join("")}</div>` : ""}
    ${g.status === "running" && decided ? `<div class="card-actions"><button type="button" class="btn primary" data-group-action="integrate"${accepted ? "" : " disabled"}>Réunir les ${accepted} sous-tâche${accepted > 1 ? "s" : ""} acceptée${accepted > 1 ? "s" : ""}</button><button type="button" class="btn ghost" data-group-action="discard">Jeter le groupe</button></div>` : ""}
    ${g.status === "integrated" ? `<p class="card-note">Réunies sur <code>${esc(g.branch)}</code> (commit <code>${esc((g.commit ?? "").slice(0, 7))}</code>).</p>${renderPr("groups", g.id, g.pr, g.prStatus, g.followUps)}` : ""}
  </div>`;
}

const minutesSince = (ms) => Math.max(1, Math.round((Date.now() - ms) / 60_000));
const groupOf = (t) => (state.dev?.groups ?? []).find((g) => g.tasks.some((x) => x.id === t.id)) ?? null;

/** Ce qu'une sous-tâche attend : celles dont elle dépend, et les décisions qui la concernent. */
function waitingFor(t) {
  const g = groupOf(t);
  if (!g) return "";
  const deps = t.dependsOn
    .map((id) => g.tasks.find((x) => x.id === id))
    .filter((d) => d && d.status !== "accepted")
    .map((d) => `#${d.id} « ${esc(d.title)} » (${devStatus[d.status] ?? d.status})`);
  const gates = (g.gates ?? []).filter((x) => x.resolution === null && x.tasks.includes(t.id));
  const parts = [];
  if (deps.length) parts.push(`d'avoir accepté ${deps.join(", ")}`);
  if (gates.length) parts.push(`ta décision : « ${esc(gates[0].question)} »`);
  return parts.length ? `<p class="quiet dev-wait">Attend ${parts.join(", et ")}.</p>` : "";
}

/** Une décision demandée par le plan : options en un clic, ou ta réponse à toi. */
function renderGate(x, groupTitle) {
  if (x.resolution !== null) return `<p class="card-note dev-gate-done">Décision : ${esc(x.question)} → <strong>${esc(x.resolution)}</strong></p>`;
  return `<div class="card dev-gate" data-gate="${x.id}">
    <p class="card-title">${esc(x.question)}</p>
    ${groupTitle ? `<p class="quiet">Groupe dev « ${esc(groupTitle)} » : ${x.tasks.length} sous-tâche${x.tasks.length > 1 ? "s" : ""} attend${x.tasks.length > 1 ? "ent" : ""} ta réponse.</p>` : ""}
    <div class="card-actions">${x.options.map((o) => `<button type="button" class="btn secondary" data-gate-pick="${esc(o)}">${esc(o)}</button>`).join("")}</div>
    <form class="command-run" data-gate-form>
      <label class="visually-hidden" for="gate-${x.id}">Autre réponse</label>
      <input id="gate-${x.id}" name="resolution" type="text" autocomplete="off" maxlength="1000" placeholder="Autre chose : écris ta décision" />
      <button type="submit" class="btn secondary">Décider</button>
    </form>
  </div>`;
}

/** Les points de reprise : un par tour de l'agent ; on peut revenir à n'importe lequel. */
function renderCheckpoints(t) {
  const list = t.checkpoints ?? [];
  if (list.length < 2) return "";
  const current = t.atRound ?? list.at(-1).round;
  return `<details class="goal-log dev-rounds"><summary>Tours de l'agent (${list.length})${t.atRound ? ` · copie revenue au tour ${t.atRound}` : ""}</summary>
    <ol class="dev-round-list">${list
      .map(
        (c) => `<li${c.round === current ? ' aria-current="true"' : ""}>
        <span><strong>Tour ${c.round}</strong>${c.diff ? ` <span class="quiet">+${c.diff.added} −${c.diff.removed}</span>` : ""}${c.summary ? ` · ${esc(c.summary)}` : ""}</span>
        ${c.round === current ? `<span class="tag">état actuel</span>` : `<button type="button" class="btn ghost" data-dev-restore="${c.round}">Revenir à ce tour</button>`}
      </li>`,
      )
      .join("")}</ol>
    <p class="quiet">Revenir à un tour remet la copie dans son état d'alors ; les autres tours restent disponibles. L'agent en est prévenu à sa prochaine retouche.</p>
  </details>`;
}

side.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dev-restore]");
  if (!b) return;
  const card = b.closest("[data-dev]");
  if (!(await ask(`Revenir au tour ${b.dataset.devRestore} ?`, "La copie reprend l'état de ce tour. Les tours suivants restent disponibles, tu peux y revenir.", "Revenir"))) return;
  b.disabled = true;
  try {
    await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "restore", round: Number(b.dataset.devRestore) });
  } catch (err) {
    b.disabled = false;
    b.insertAdjacentHTML("afterend", ` <span class="inline-error" role="alert">${esc(err.message)}</span>`);
  }
});

/** Réessayer de zéro, avec un autre moteur, modèle ou effort. */
function renderRetry(t) {
  const engines = (state.engines ?? []).filter((e) => e.ready !== false);
  const opts = engines
    .map((e) => {
      const models = e.models ?? [];
      return `<optgroup label="${esc(ENGINE_NAMES[e.name] ?? e.name)}">
        <option value="${e.name}|">${esc(ENGINE_NAMES[e.name] ?? e.name)} · modèle des réglages</option>
        ${models.map((m) => `<option value="${e.name}|${esc(m.id)}">${esc(ENGINE_NAMES[e.name] ?? e.name)} · ${esc(m.name)}</option>`).join("")}
      </optgroup>`;
    })
    .join("");
  const efforts = [...new Set(engines.flatMap((e) => (e.models ?? []).flatMap((m) => m.efforts ?? [])))];
  return `<details class="goal-log dev-retry"><summary>Réessayer de zéro${t.attempts > 1 ? ` (tentative ${t.attempts + 1})` : ""}</summary>
    <form class="dev-retry-form" data-dev-retry>
      <p class="quiet">Nouvelle copie, nouvelle conversation : l'agent repart de la consigne, sans ce qui a été fait.</p>
      <label for="retry-engine-${t.id}">Moteur et modèle</label>
      <select id="retry-engine-${t.id}" name="engine"><option value="|">Moteur principal, réglages actuels</option>${opts}</select>
      <label for="retry-effort-${t.id}">Effort</label>
      <select id="retry-effort-${t.id}" name="effort"><option value="">Celui des réglages</option>${efforts.map((x) => `<option value="${x}">${esc(EFFORT_LABELS[x] ?? x)}</option>`).join("")}</select>
      <div class="card-actions"><button type="submit" class="btn secondary">Réessayer</button></div>
    </form>
  </details>`;
}

// Le reste des actions d'une tâche, rangé dans « … » ; un choix ouvre son panneau sous la carte.
let devPanel = null; // { id, panel: "rounds" | "retry" | "compare" | "info" }

function renderDevMore(t, project, nested) {
  const items = [
    project?.test ? `<ui-menu-item value="test"${t.tests?.running ? " disabled" : ""}>Lancer les tests</ui-menu-item>` : "",
    (t.checkpoints ?? []).length >= 2 ? `<ui-menu-item value="rounds">Tours de l'agent (${t.checkpoints.length})</ui-menu-item>` : "",
    !nested && !t.compareWith && !t.prOf && !t.onPrBranch ? `<ui-menu-item value="compare">Comparer avec un autre agent…</ui-menu-item>` : "",
    `<ui-menu-item value="retry">Réessayer de zéro…</ui-menu-item>`,
    `<ui-menu-item value="info">Détails (branche, moteur, tours)</ui-menu-item>`,
    `<ui-menu-separator></ui-menu-separator>`,
    `<ui-menu-item value="discard" class="danger">Jeter</ui-menu-item>`,
  ];
  return `<ui-menu data-dev-more="${t.id}">
    <ui-menu-trigger><button type="button" class="btn ghost more-btn" aria-label="Plus d'actions pour la tâche #${t.id}"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><circle cx="12.5" cy="8" r="1.3" fill="currentColor" /></svg></button></ui-menu-trigger>
    <ui-menu-content class="menu-more" align="start">${items.join("")}</ui-menu-content>
  </ui-menu>`;
}

function renderDevPanel(t) {
  const close = `<button type="button" class="link dev-panel-close" data-dev-panel-close>Fermer</button>`;
  if (devPanel.panel === "rounds") return renderCheckpoints(t).replace("<details ", "<details open ") + close;
  if (devPanel.panel === "retry") return renderRetry(t).replace("<details ", "<details open ") + close;
  if (devPanel.panel === "compare") return renderCompareForm(t).replace("<details ", "<details open ") + close;
  return `<dl class="dev-info">
    <dt>Tâche</dt><dd>#${t.id}${t.attempts > 1 ? `, tentative ${t.attempts}` : ""}</dd>
    <dt>Branche</dt><dd><code>${esc(t.branch)}</code></dd>
    <dt>Agent</dt><dd>${esc(sideLabel(t))}</dd>
    <dt>Tours</dt><dd>${t.rounds}</dd>
  </dl>${close}`;
}

document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-dev-panel-close]")) return;
  devPanel = null;
  renderView();
});

document.addEventListener("action", (e) => {
  const menu = e.target.closest?.("[data-dev-more]");
  if (!menu) return;
  const id = Number(menu.dataset.devMore);
  const value = String(e.detail.value);
  if (["rounds", "retry", "compare", "info"].includes(value)) {
    devPanel = devPanel?.id === id && devPanel.panel === value ? null : { id, panel: value };
    renderView();
    return;
  }
  // Tests et Jeter passent par les mêmes chemins que les anciens boutons.
  const card = menu.closest("[data-dev]");
  const proxy = document.createElement("button");
  proxy.type = "button";
  proxy.hidden = true;
  proxy.dataset.devAction = value;
  card.querySelector(".card-actions").append(proxy);
  proxy.click();
  proxy.remove();
}, true);

/** Qui fait cette version : moteur (le principal si rien n'est choisi), modèle, effort. */
function sideLabel(t) {
  const engine = t.engine ?? (state.engines ?? []).find((e) => e.main)?.name ?? state.clark.engine.name;
  return [ENGINE_NAMES[engine] ?? engine, t.model, t.effort ? `effort ${EFFORT_M[t.effort] ?? t.effort}` : null].filter(Boolean).join(" · ");
}

/** Depuis une tâche seule : la même consigne, à un autre agent, dans sa propre copie. */
function renderCompareForm(t) {
  const engines = (state.engines ?? []).filter((e) => e.ready !== false);
  const opts = engines
    .map((e) => `<optgroup label="${esc(ENGINE_NAMES[e.name] ?? e.name)}">
        <option value="${e.name}|">${esc(ENGINE_NAMES[e.name] ?? e.name)} · modèle des réglages</option>
        ${(e.models ?? []).map((m) => `<option value="${e.name}|${esc(m.id)}">${esc(ENGINE_NAMES[e.name] ?? e.name)} · ${esc(m.name)}</option>`).join("")}
      </optgroup>`)
    .join("");
  const efforts = [...new Set(engines.flatMap((e) => (e.models ?? []).flatMap((m) => m.efforts ?? [])))];
  const other = (t.engine ?? (state.engines ?? []).find((e) => e.main)?.name) === "codex" ? "claude" : "codex";
  return `<details class="goal-log dev-compare-open"><summary>Comparer avec un autre agent</summary>
    <form class="dev-retry-form" data-dev-compare>
      <p class="quiet">La même consigne, dans une autre copie. Tu compares les deux et tu gardes celle que tu préfères ; celle-ci reste telle quelle.</p>
      <label for="compare-engine-${t.id}">Moteur et modèle</label>
      <select id="compare-engine-${t.id}" name="engine">${opts.replace(`value="${other}|"`, `value="${other}|" selected`)}</select>
      <label for="compare-effort-${t.id}">Effort</label>
      <select id="compare-effort-${t.id}" name="effort"><option value="">Celui des réglages</option>${efforts.map((x) => `<option value="${x}">${esc(EFFORT_LABELS[x] ?? x)}</option>`).join("")}</select>
      <div class="card-actions"><button type="submit" class="btn secondary">Lancer l'autre version</button></div>
    </form>
  </details>`;
}

/**
 * Comparaison : les deux versions côte à côte (qui, où elles en sont, ce qu'elles ont touché),
 * les fichiers touchés par les deux, puis « Garder celle-ci ».
 */
function renderCompare(t) {
  const all = allDevTasks();
  const o = all.find((x) => x.id === t.compareWith);
  if (!o) return "";
  const [a, b] = t.id < o.id ? [t, o] : [o, t];
  const paths = (x) => (x.diff?.files ?? []).map((f) => f.path);
  const finished = (x) => ["review", "failed", "accepted", "discarded"].includes(x.status);
  const decided = [a, b].find((x) => x.status === "accepted");
  const col = (x) => {
    const files = x.diff?.files ?? [];
    const here = x.id === t.id;
    return `<div class="compare-side" data-compare-side="${x.id}"${here ? ' aria-current="true"' : ""}>
      <div class="goal-head">
        <span class="compare-who">${esc(sideLabel(x))}</span>
        <span class="tag dev-${x.status}">${x.status === "working" ? sprite("clark", { walking: true, size: 14 }) : ""}${devStatus[x.status] ?? x.status}</span>
      </div>
      <p class="quiet">#${x.id}${here ? " · cette page" : ` · <a href="#dev/${x.id}">ouvrir</a>`}${x.rounds > 1 ? ` · ${x.rounds} tours` : ""}</p>
      ${
        x.status === "working"
          ? `<p class="quiet">${x.waiting ? "En attente d'un agent libre." : esc(x.checkpoint ?? "L'agent travaille.")}</p>`
          : files.length
            ? `<p class="compare-stat">${files.length} fichier${files.length > 1 ? "s" : ""} · <span class="d-add">+${x.diff.added}</span> <span class="d-del">−${x.diff.removed}</span></p>`
            : finished(x)
              ? `<p class="quiet">Aucun fichier changé.</p>`
              : ""
      }
      ${x.tests && !x.tests.running ? `<p class="quiet">Tests : ${x.tests.ok ? "réussis" : "en échec"}</p>` : ""}
      ${x.summary && finished(x) ? `<p class="compare-summary">${esc(x.summary.split("\n").find((l) => l.trim())?.slice(0, 220) ?? "")}</p>` : ""}
      ${!decided && x.status === "review" ? `<div class="card-actions"><button type="button" class="btn ${here ? "primary" : "secondary"}" data-dev-keep="${x.id}">Garder celle-ci</button></div>` : ""}
    </div>`;
  };
  let converge = "";
  if (decided) converge = `<p class="card-note">Tranchée : #${decided.id} (${esc(sideLabel(decided))}) gardée.</p>`;
  else if (!finished(a) || !finished(b)) converge = `<p class="quiet">Les fichiers touchés par les deux s'afficheront quand les deux auront fini.</p>`;
  else {
    const pa = paths(a);
    const pb = paths(b);
    const both = pa.filter((p) => pb.includes(p));
    const onlyA = pa.filter((p) => !pb.includes(p));
    const onlyB = pb.filter((p) => !pa.includes(p));
    const list = (xs) => xs.map((p) => `<code>${esc(p)}</code>`).join(", ");
    converge = `<dl class="compare-converge">
      <dt>Touchés par les deux</dt><dd>${both.length ? list(both) : "aucun"}</dd>
      ${onlyA.length ? `<dt>Seulement ${esc(sideLabel(a))}</dt><dd>${list(onlyA)}</dd>` : ""}
      ${onlyB.length ? `<dt>Seulement ${esc(sideLabel(b))}</dt><dd>${list(onlyB)}</dd>` : ""}
    </dl>`;
  }
  return `<section class="card compare" aria-labelledby="compare-title-${t.id}">
    <p class="card-title" id="compare-title-${t.id}">Comparaison</p>
    <div class="compare-grid">${col(a)}${col(b)}</div>
    ${converge}
  </section>`;
}

/** Désaccord du binôme : les points encore ouverts de la dernière relecture, pour la confirmation d'« Accepter ». */
function openPointsAttrs(t) {
  if (t.reviewState !== "disagree") return "";
  const issues = (t.reviewNotes ?? []).at(-1)?.issues ?? [];
  if (!issues.length) return "";
  const blocking = issues.filter((i) => i.severity === "bloquant").length;
  const list = issues.slice(0, 4).map((i) => `• ${i.file ? `${i.file} : ` : ""}${i.problem.length > 140 ? `${i.problem.slice(0, 139)}…` : i.problem}`).join("\n");
  return ` data-open-points="${issues.length}" data-open-blocking="${blocking}" data-open-list="${esc(list)}"`;
}

/** Désaccord : l'avis de Clark (résumé, qui a raison, recommandation) et la retouche prête à lancer. */
const ARBITER_SIDE = { auteur: "l'auteur a raison", relecteur: "le relecteur a raison", "entre les deux": "entre les deux" };
function renderArbiter(t) {
  const a = t.arbiter;
  if (!a) {
    return t.canArbitrate && t.status === "review"
      ? `<div class="card-actions"><button type="button" class="btn secondary" data-dev-action="arbitrate">Demander l'avis de Clark</button></div>`
      : "";
  }
  const points = a.points.length
    ? `<ul class="review-issues">${a.points.map((p) => `<li><p class="review-issue-head"><span class="tag">${esc(ARBITER_SIDE[p.side] ?? p.side)}</span></p><p>${esc(p.point)}</p>${p.why ? `<p class="quiet">${esc(p.why)}</p>` : ""}</li>`).join("")}</ul>`
    : "";
  const retouch =
    a.retouch && t.status === "review"
      ? `<form class="dev-arbiter-retouch" data-dev-arbiter>
          <label for="dev-arbiter-${t.id}">Retouche proposée (modifiable)</label>
          <textarea id="dev-arbiter-${t.id}" name="instruction" rows="5">${esc(a.retouch)}</textarea>
          <div class="card-actions"><button type="submit" class="btn primary">Lancer cette retouche</button></div>
        </form>`
      : "";
  return `<section class="dev-arbiter" aria-label="Avis de Clark">
    <p><strong>Avis de Clark</strong> · recommande : <strong>${esc(a.recommendation)}</strong></p>
    <p>${esc(a.summary)}</p>
    ${points}
    ${retouch}
  </section>`;
}

/** Binôme : qui écrit, qui relit, où en est la relecture, et ce qui s'est dit à chaque tour. */
const SEVERITY = { bloquant: "bloquant", important: "important", mineur: "mineur" };
function renderCrossReview(t) {
  const author = ENGINE_NAMES[t.engine] ?? t.engine ?? "?";
  const reviewer = ENGINE_NAMES[t.reviewer] ?? t.reviewer;
  const state =
    t.reviewing
      ? `${reviewer} relit cette version (tour ${t.reviewRounds + 1} sur 3).`
      : t.reviewState === "approved"
        ? `Approuvée par ${reviewer}${t.reviewRounds > 1 ? ` après ${t.reviewRounds} tours` : ""}.`
        : t.reviewState === "disagree"
          ? `${author} et ${reviewer} ne sont pas d'accord après ${t.reviewRounds} tours : lis leurs arguments et tranche (accepter, retoucher ou jeter).`
          : t.reviewState === "skipped"
            ? `La relecture de ${reviewer} n'a pas abouti : relis-la toi-même.`
            : t.status === "working" && t.reviewRounds
              ? `${author} corrige après la relecture de ${reviewer} (tour ${t.reviewRounds} sur 3).`
              : `${reviewer} relira chaque version avant toi.`;
  const notes = (t.reviewNotes ?? [])
    .map(
      (n) => `<li><p class="review-round"><strong>Tour ${n.round}</strong> · ${n.approve ? "approuvé" : `${n.issues.length} point${n.issues.length > 1 ? "s" : ""}`} — ${esc(n.summary)}</p>${
        n.issues.length
          ? `<ul class="review-issues">${n.issues
              .map(
                (i) => `<li><p class="review-issue-head"><span class="tag${i.severity === "bloquant" ? " warn" : ""}">${SEVERITY[i.severity] ?? i.severity}</span>${i.file ? `<code>${esc(i.file)}</code>` : ""}</p><p>${esc(i.problem)}</p>${i.fix ? `<p class="quiet">→ ${esc(i.fix)}</p>` : ""}</li>`,
              )
              .join("")}</ul>`
          : ""
      }</li>`,
    )
    .join("");
  return `<div class="dev-binome${t.reviewState === "disagree" ? " is-disagree" : ""}">
    <p class="quiet">Écrite par <strong>${esc(author)}</strong> · relue par <strong>${esc(reviewer)}</strong></p>
    <p class="${t.reviewState === "disagree" ? "dev-stalled" : "quiet"}" role="status">${esc(state)}</p>
    ${t.reviewState === "disagree" ? renderArbiter(t) : ""}
    ${notes ? `<details class="goal-log"${t.reviewState === "disagree" && !t.arbiter ? " open" : ""}><summary>Relectures (${t.reviewNotes.length})</summary><ol class="dev-review-notes">${notes}</ol></details>` : ""}
  </div>`;
}

function renderDevTask(t, nested = false) {
  const files = t.diff?.files ?? [];
  const open = t.status === "review" || t.status === "failed";
  const tests = t.tests;
  const project = (state.dev?.projects ?? []).find((p) => p.name === t.project);
  const testBlock = !open
    ? ""
    : tests?.running
      ? `<p class="quiet">Tests en cours…</p>`
      : tests
        ? `<details class="goal-log dev-tests" data-ok="${tests.ok}"><summary>Tests : ${tests.ok ? "réussis" : tests.timedOut ? "trop longs, arrêtés" : `échec (code ${tests.code ?? "?"})`} · ${time(new Date(tests.at))}</summary><pre class="command-prompt">${esc(tests.output || "(aucune sortie)")}</pre></details>`
        : "";
  return `<div class="card dev-task${nested ? " nested" : ""}" data-dev="${t.id}" data-status="${t.status}">
    <div class="goal-head">
      <span class="kind-line">${esc(nested ? `Sous-tâche · ${sideLabel(t)}` : `${t.project} · ${sideLabel(t)}`)}</span>
      ${t.autopilot && !nested ? `<span class="tag" title="Clark accepte seul si les tests sont verts, puis ouvre la PR">pilote auto</span>` : ""}
      <span class="tag dev-${t.status}">${t.status === "working" ? `${sprite("clark", { walking: true, size: 14 })}` : ""}${devStatus[t.status] ?? t.status}</span>
    </div>
    ${nested ? `<p class="card-title">${esc(t.title)}</p>` : ""}
    ${
      t.setup && (!t.setup.ok || t.setup.dirty?.length)
        ? `<details class="goal-log dev-tests" data-ok="false"><summary>${!t.setup.ok ? `Préparation de la copie en échec (<code>${esc(t.setup.command)}</code>)` : `La préparation a créé ou changé ${t.setup.dirty.length} fichier(s) suivi(s) par git : ils sont dans le diff`}</summary>${
            t.setup.dirty?.length ? `<p class="quiet">${t.setup.dirty.map((f) => `<code>${esc(f)}</code>`).join(", ")}. Ajoute-les au .gitignore du projet, ou jette-les avant d'accepter.</p>` : ""
          }${t.setup.output ? `<pre class="command-prompt">${esc(t.setup.output)}</pre>` : ""}</details>`
        : ""
    }
    ${t.issue ? `<p class="quiet">Depuis l'issue <a href="${esc(t.issue.url)}" target="_blank" rel="noreferrer noopener">#${t.issue.number}</a> : la PR la fermera.</p>` : ""}
    ${t.prOf ? `<p class="quiet">Suivi de la PR${t.pr ? ` <a href="${esc(t.pr)}" target="_blank" rel="noreferrer noopener">${esc(t.pr.replace(/^.*\/pull\//, "#"))}</a>` : ""}, sur sa branche : accepter met la PR à jour (sans forcer).</p>` : ""}
    ${t.status === "waiting" ? waitingFor(t) : t.dependsOn?.length ? `<p class="quiet">Part du travail de ${t.dependsOn.map((d) => `#${d}`).join(", ")}.</p>` : ""}
    ${t.reviewer ? renderCrossReview(t) : ""}
    ${
      t.stalledSince
        ? `<p class="dev-stalled" role="status">Silencieux depuis ${minutesSince(t.stalledSince)} min : l'agent est peut-être bloqué.</p>`
        : t.sleptMinutes
          ? `<p class="quiet" role="status">Le Mac était en veille (${t.sleptMinutes} min) : l'agent reprend à son réveil, rien à faire.</p>`
          : ""
    }
    ${t.status === "working" && t.stoppable ? `<div class="card-actions"><button type="button" class="btn ghost" data-dev-action="stop"${t.waiting ? " data-waiting" : ""}>${t.waiting ? "Annuler" : "Arrêter l'agent"}</button></div>` : ""}
    ${t.status === "working" ? (t.waiting ? `<p class="quiet">En attente d'un agent libre (${state.dev?.parallel ?? 2} en même temps au plus).</p>` : `${t.checkpoint ? `<p class="checkpoint solo">${esc(t.checkpoint)}</p>` : ""}${t.steps.length ? renderSteps(t.steps) : `<p class="quiet">L'agent lit le projet.</p>`}`) : ""}
    ${
      t.blockedOn
        ? `<div class="dev-blocked" role="status"><p><strong>L'agent attend ton accord</strong> : ${esc(t.blockedOn)}</p><div class="card-actions"><button type="button" class="btn primary" data-dev-action="unblock">Autoriser et reprendre</button><button type="button" class="btn ghost" data-dev-action="discard">Jeter</button></div><p class="quiet">Ou écris une autre consigne dans le champ Retouche.</p></div>`
        : t.error
          ? `<p class="goal-reason">${esc(t.error)}</p>${t.status === "failed" ? `<div class="card-actions"><button type="button" class="btn primary" data-dev-action="resume">Reprendre</button></div>` : ""}`
          : ""
    }
    ${/* Les actions en haut, sous l'état : sur une longue tâche, elles ne se perdent plus sous le résumé et le diff. */ ""}
    ${
      open
        ? `<div class="card-actions">
            ${t.status === "review" ? (t.compareWith ? `<button type="button" class="btn primary" data-dev-keep="${t.id}">Garder celle-ci</button>` : `<button type="button" class="btn primary" data-dev-action="accept"${openPointsAttrs(t)}>${t.prOf ? "Accepter et mettre à jour la PR" : "Accepter"}</button>`) : ""}
            ${state.dev?.preview?.taskId === t.id ? "" : `<button type="button" class="btn secondary" data-design-open>Aperçu</button>`}
            ${renderDevMore(t, project, nested)}
          </div>
          ${designPick?.taskId === t.id ? renderDesignPick(designPick) : ""}
          <form class="command-run dev-retouch" data-dev-retouch>
            <label class="visually-hidden" for="dev-retouch-${t.id}">Retouche pour la tâche #${t.id}</label>
            <input id="dev-retouch-${t.id}" name="instruction" type="text" autocomplete="off" placeholder="${designPick?.taskId === t.id ? "Retouche pour cet élément : ce qu'il faut changer" : "Retouche : ce qu'il faut changer"}" />
            <button type="submit" class="btn secondary">Retoucher</button>
          </form>
          ${devPanel?.id === t.id ? renderDevPanel(t) : ""}`
        : t.status === "waiting"
          ? `<div class="card-actions"><button type="button" class="btn ghost" data-dev-action="discard">Jeter</button></div>`
          : ""
    }

    ${open && t.summary ? `<div class="prose dev-summary">${md(t.summary)}</div>` : ""}
    ${
      open && files.length
        ? `<ul class="dev-files">${files
            .map((f, i) => `<li><span class="dev-mark" title="${f.status}">${fileStatusMark[f.status] ?? "M"}</span><button type="button" class="link dev-file-go" data-diff-goto="${i}"><code>${esc(f.path)}</code></button><span class="dev-count">${f.binary ? "binaire" : `<span class="d-add">+${f.added}</span> <span class="d-del">−${f.removed}</span>`}</span></li>`)
            .join("")}</ul>
          <details class="goal-log dev-diff" data-dev-diff><summary>Voir le diff (+${t.diff.added} −${t.diff.removed})</summary>${devPatches.get(t.id)?.rounds === patchKey(t) ? renderPatch(devPatches.get(t.id).patch, t) : `<p class="quiet">Chargement du diff…</p>`}</details>`
        : open
          ? `<p class="quiet">Aucun fichier changé.</p>`
          : ""
    }
    ${testBlock}
    ${t.status === "accepted" ? `<p class="card-note">${t.commit ? `Commit <code>${esc(t.commit.slice(0, 7))}</code> sur <code>${esc(t.branch)}</code>.` : "Acceptée, sans changement."}</p>` : ""}
    ${t.status === "accepted" && t.commit && !nested && !t.prOf ? renderPr("tasks", t.id, t.pr, t.prStatus, t.followUps) : ""}
  </div>`;
}

function renderProjectForm() {
  return `<form class="card auto-form" id="project-form" novalidate>
    <p class="card-title">Nouveau projet</p>
    <label for="pf-name">Nom</label>
    <input id="pf-name" name="name" type="text" maxlength="40" autocomplete="off" placeholder="portfolio" />
    <label for="pf-path">Dossier du dépôt git</label>
    <div class="voice-pick"><input id="pf-path" name="path" type="text" autocomplete="off" placeholder="/Users/charles/Developer/portfolio" /><button type="button" class="btn secondary" data-pick-folder="pf-path">Parcourir…</button></div>
    <label for="pf-base">Branche de base <span class="optional">(facultatif : celle du dépôt par défaut)</span></label>
    <input id="pf-base" name="baseBranch" type="text" autocomplete="off" placeholder="main" />
    <label for="pf-test">Commande de test <span class="optional">(facultatif)</span></label>
    <input id="pf-test" name="testCommand" type="text" autocomplete="off" placeholder="npm test" aria-describedby="pf-test-hint" />
    <p class="quiet field-hint" id="pf-test-hint">Lancée sur ton clic, dans la copie de la tâche, hors du bac à sable : les tests ont souvent besoin du réseau et des dépendances.</p>
    <p class="inline-error" id="pf-error" role="alert" hidden></p>
    <div class="card-actions"><button type="submit" class="btn primary">Ajouter</button><button type="button" class="btn ghost" data-project-cancel>Annuler</button></div>
  </form>`;
}

// Issues GitHub d'un projet : chargées sur demande, une tâche (ou un groupe) en un clic.
const issueLists = new Map(); // projet → { loading, issues, error }

function renderIssues(pid) {
  const l = issueLists.get(pid);
  if (!l) return "";
  if (l.loading) return `<p class="quiet">Lecture des issues…</p>`;
  if (l.error) return `<p class="inline-error" role="alert">${esc(l.error)}</p>`;
  if (!l.issues.length) return `<p class="quiet">Aucune issue ouverte.</p>`;
  return `<ul class="issue-list">${l.issues
    .map(
      (i) => `<li data-issue="${i.number}">
      <div><a href="${esc(i.url)}" target="_blank" rel="noreferrer noopener">#${i.number}</a> ${esc(i.title)}${i.labels.length ? ` <span class="quiet">${i.labels.map(esc).join(", ")}</span>` : ""}</div>
      <div class="card-actions"><button type="button" class="btn secondary" data-issue-start="task">Tâche dev</button><button type="button" class="btn ghost" data-issue-start="split">En parallèle</button></div>
    </li>`,
    )
    .join("")}</ul>`;
}

side.addEventListener("click", async (e) => {
  const load = e.target.closest("[data-issues-load]");
  const start = e.target.closest("[data-issue-start]");
  if (load) {
    const pid = Number(load.closest("[data-project]").dataset.project);
    issueLists.set(pid, { loading: true });
    renderView();
    try {
      const res = await fetch(`/api/dev/projects/${pid}/issues?fresh=1`);
      const data = await res.json();
      issueLists.set(pid, res.ok ? { issues: data.issues } : { error: data.error });
    } catch (err) {
      issueLists.set(pid, { error: err.message });
    }
    renderView();
  } else if (start) {
    const pid = Number(start.closest("[data-project]").dataset.project);
    const n = Number(start.closest("[data-issue]").dataset.issue);
    start.disabled = true;
    try {
      const r = await post("/api/dev/tasks", { projectId: pid, issue: n, instruction: "", engine: "", split: start.dataset.issueStart === "split" });
      location.hash = start.dataset.issueStart === "split" ? `#groupe/${r.id}` : `#dev/${r.id}`;
    } catch (err) {
      start.disabled = false;
      start.closest("li").insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
  }
});

/** Réglages d'un projet : moteur, modèle et effort par défaut ; préparation de chaque copie. */
function renderProjectSettings(p) {
  const engines = state.engines ?? [];
  const models = (engines.find((e) => e.name === p.engine)?.models ?? []);
  const efforts = models.find((m) => m.id === p.model)?.efforts ?? [...new Set(models.flatMap((m) => m.efforts ?? []))];
  const summary = [p.engine ? `${ENGINE_NAMES[p.engine]}${p.model ? ` · ${p.model}` : ""}${p.effort ? ` · ${EFFORT_LABELS[p.effort] ?? p.effort}` : ""}` : "moteur principal", p.setup ? "préparation" : "", p.copy.length ? `${p.copy.length} fichier(s) copiés` : ""].filter(Boolean).join(" · ");
  return `<details class="goal-log project-settings"><summary>Réglages du projet <span class="quiet">${esc(summary)}</span></summary>
    <form class="auto-form" data-project-settings="${p.id}" novalidate>
      <label for="ps-engine-${p.id}">Moteur par défaut</label>
      <select id="ps-engine-${p.id}" name="engine"><option value="">Moteur principal</option>${["claude", "codex"].map((e) => `<option value="${e}"${p.engine === e ? " selected" : ""}>${ENGINE_NAMES[e]}</option>`).join("")}</select>
      <label for="ps-model-${p.id}">Modèle</label>
      <select id="ps-model-${p.id}" name="model"${p.engine ? "" : " disabled"}><option value="">Celui des réglages du moteur</option>${models.map((m) => `<option value="${esc(m.id)}"${p.model === m.id ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
      <label for="ps-effort-${p.id}">Effort</label>
      <select id="ps-effort-${p.id}" name="effort"${p.engine ? "" : " disabled"}><option value="">Celui des réglages du moteur</option>${efforts.map((x) => `<option value="${x}"${p.effort === x ? " selected" : ""}>${esc(EFFORT_LABELS[x] ?? x)}</option>`).join("")}</select>
      <label for="ps-test-${p.id}">Commande de test</label>
      <input id="ps-test-${p.id}" name="testCommand" type="text" autocomplete="off" value="${esc(p.test ?? "")}" placeholder="npm test" />
      <label for="ps-setup-${p.id}">Préparation de chaque copie <span class="optional">(facultatif)</span></label>
      <input id="ps-setup-${p.id}" name="setupCommand" type="text" autocomplete="off" value="${esc(p.setup ?? "")}" placeholder="npm ci" aria-describedby="ps-setup-hint-${p.id}" />
      <p class="quiet field-hint" id="ps-setup-hint-${p.id}">Lancée dans chaque nouvelle copie, avant l'agent, hors du bac à sable (souvent besoin du réseau), 10 minutes au plus.</p>
      <label for="ps-copy-${p.id}">Fichiers ignorés par git à copier dans chaque copie <span class="optional">(un par ligne)</span></label>
      <textarea id="ps-copy-${p.id}" name="copyPaths" rows="3" placeholder="config/local.json" aria-describedby="ps-copy-hint-${p.id}">${esc(p.copy.join("\n"))}</textarea>
      <p class="quiet field-hint" id="ps-copy-hint-${p.id}">Jamais de secret : .env, clés et identifiants sont refusés, car l'agent lit sa copie.</p>
      <label for="ps-pcmd-${p.id}">Aperçu (mode design) : serveur de dev <span class="optional">(facultatif)</span></label>
      <input id="ps-pcmd-${p.id}" name="previewCommand" type="text" autocomplete="off" value="${esc(p.preview?.command ?? "")}" placeholder="npm run dev -- --port $PORT" aria-describedby="ps-pcmd-hint-${p.id}" />
      <p class="quiet field-hint" id="ps-pcmd-hint-${p.id}">Lancée dans la copie quand tu ouvres l'aperçu, avec le port à utiliser dans $PORT. Vide : Clark montre les fichiers de la copie tels quels.</p>
      <label for="ps-ppath-${p.id}">Page ouverte par l'aperçu <span class="optional">(facultatif)</span></label>
      <input id="ps-ppath-${p.id}" name="previewPath" type="text" autocomplete="off" value="${esc(p.preview?.path ?? "")}" placeholder="index.html" />
      <p class="inline-error" role="alert" hidden></p>
      <div class="card-actions"><button type="submit" class="btn primary">Enregistrer</button></div>
    </form>
  </details>`;
}

side.addEventListener("input", (e) => {
  const f = e.target.closest("[data-project-settings]");
  if (f) f.dataset.dirty = "1";
});

side.addEventListener("change", (e) => {
  // Changer de moteur change la liste des modèles : on rafraîchit le formulaire sans perdre le reste.
  const f = e.target.closest("[data-project-settings]");
  if (!f || e.target.name !== "engine") return;
  const p = (state.dev?.projects ?? []).find((x) => x.id === Number(f.dataset.projectSettings));
  if (!p) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = renderProjectSettings({ ...p, engine: e.target.value || null, model: null, effort: null });
  const fresh = tmp.querySelector("form");
  for (const name of ["testCommand", "setupCommand", "copyPaths", "previewCommand", "previewPath"]) fresh.elements[name].value = f.elements[name].value;
  fresh.dataset.dirty = "1";
  f.replaceWith(fresh);
  fresh.elements.engine.focus();
});

side.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-project-settings]");
  if (!f) return;
  e.preventDefault();
  const err = f.querySelector(".inline-error");
  const el = f.elements;
  try {
    await post(`/api/dev/projects/${f.dataset.projectSettings}`, {
      action: "settings",
      engine: el.engine.value,
      model: el.model.value,
      effort: el.effort.value,
      testCommand: el.testCommand.value,
      setupCommand: el.setupCommand.value,
      copyPaths: el.copyPaths.value.split("\n").map((x) => x.trim()).filter(Boolean),
      previewCommand: el.previewCommand.value,
      previewPath: el.previewPath.value,
    });
    delete f.dataset.dirty;
    err.hidden = true;
    $("#announce").textContent = "Réglages du projet enregistrés";
    renderSettings();
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  }
});

// La fenêtre des raccourcis est hors de #app : son bouton, et un clic à côté, la ferment.
$("#shortcuts").addEventListener("click", (e) => {
  if (e.target.closest("[data-shortcuts-close]") || e.target === e.currentTarget) $("#shortcuts").close();
});

function buildProjects() {
  const projects = (state.dev ?? { projects: [] }).projects;
  return section(
    "projects",
    "Projets",
    projects.length || "",
    `${
      projects.length
        ? `<ul class="memories">${projects
            .map(
              (p) => `<li data-project="${p.id}"><span class="kind">${esc(p.name)} · ${esc(p.base)}</span><code class="dev-path">${esc(p.path)}</code><span class="origin">${p.test ? `tests : <code>${esc(p.test)}</code>` : "pas de commande de test"} · <button type="button" class="link" data-issues-load>${issueLists.has(p.id) ? "Actualiser les issues" : "Issues GitHub"}</button> · <button type="button" class="link" data-project-delete>Retirer</button></span>${renderProjectSettings(p)}${renderIssues(p.id)}</li>`,
            )
            .join("")}</ul>`
        : `<p class="quiet">Ajoute un dépôt git : Clark y fera travailler ses agents, chacun dans sa propre copie, sans toucher à ta branche. Ensuite, choisis « Tâche dev » sous le champ de message.</p>`
    }${projectFormOpen ? renderProjectForm() : `<button type="button" class="btn secondary mcp-new" data-project-new>Ajouter un projet</button>`}`,
  );
}

const allDevTasks = () => [...(state.dev?.tasks ?? []), ...(state.dev?.groups ?? []).flatMap((g) => g.tasks)];

const patchLoading = new Set();
const openDiffTasks = new Set(); // tâches dont le diff est ouvert (ids, en texte)

async function loadPatch(id) {
  const t = allDevTasks().find((x) => x.id === id);
  patchLoading.add(id);
  try {
    const res = await fetch(`/api/dev/tasks/${id}/diff`);
    const data = await res.json();
    devPatches.set(id, { rounds: t ? patchKey(t) : undefined, patch: res.ok ? data.patch : `Diff indisponible : ${data.error}` });
  } catch (err) {
    devPatches.set(id, { rounds: t ? patchKey(t) : undefined, patch: `Diff indisponible : ${err.message}` });
  } finally {
    patchLoading.delete(id);
  }
  if (view === "detail") renderView();
}

side.addEventListener(
  "toggle",
  (e) => {
    const d = e.target.closest?.("[data-dev-diff]");
    if (!d) return;
    // Un diff ouvert le reste pendant le tour de l'agent (il disparaît le temps du tour) : on s'en souvient.
    if (d.open) openDiffTasks.add(d.closest("[data-dev]").dataset.dev);
    else openDiffTasks.delete(d.closest("[data-dev]").dataset.dev);
    if (!d.open) return;
    const id = Number(d.closest("[data-dev]").dataset.dev);
    const t = allDevTasks().find((x) => x.id === id);
    if (devPatches.get(id)?.rounds !== (t ? patchKey(t) : undefined)) void loadPatch(id);
  },
  true,
);



// « Parcourir… » : la fenêtre du Finder choisit le dossier (le nom du projet suit s'il est vide).
side.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-pick-folder]");
  if (!btn) return;
  const field = document.getElementById(btn.dataset.pickFolder);
  btn.disabled = true;
  try {
    const r = await post("/api/pick", { kind: "folder" });
    if (r.path && field) {
      field.value = r.path;
      const name = field.form?.elements.name;
      if (name && !name.value.trim()) name.value = r.path.split("/").pop().slice(0, 40);
    }
  } catch (err) {
    const error = btn.closest("form")?.querySelector(".inline-error");
    if (error) {
      error.textContent = err.message;
      error.hidden = false;
    }
  } finally {
    btn.disabled = false;
    field?.focus();
  }
});
