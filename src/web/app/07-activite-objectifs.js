// ── Pages : Activité, Plugins, Réglages, et le bas du menu ──────────────

/**
 * Remplace le contenu d'une page sans perdre ce que tu es en train de faire : les nœuds
 * listés (formulaire ouvert, correction en cours, menu de moteur) sont gardés tels quels,
 * le focus et le curseur reviennent où ils étaient.
 */
function swap(root, html, keep = []) {
  const active = root.contains(document.activeElement) ? document.activeElement : null;
  const caret = hasCaret(active) ? [active.selectionStart, active.selectionEnd] : null;
  const key = focusKey(root);
  const kept = keep.map((sel) => [sel, root.querySelector(sel)]).filter(([, node]) => node);
  root.innerHTML = html;
  for (const [sel, node] of kept) root.querySelector(sel)?.replaceWith(node);
  if (active && root.contains(active)) {
    active.focus({ preventScroll: true });
    if (caret) active.setSelectionRange(caret[0], caret[1]);
  } else restoreFocus(root, key);
  // La CSP interdit les styles en ligne dans le HTML ; la largeur passe par le CSSOM.
  root.querySelectorAll("[data-ratio]").forEach((el) => (el.style.width = `${Number(el.dataset.ratio) * 100}%`));
  placeEffort(root);
}

/** Un menu de moteur qui a le focus n'est pas reconstruit sous le doigt (sauf pendant un envoi). */
function engineKeep(root) {
  // Seul un champ en cours de réglage fige le bloc ; un bouton (Connecter, Annuler) le laisse se mettre à jour.
  const active = document.activeElement;
  const box = active?.matches?.("select, input") ? active.closest("[data-engine]") : null;
  // Un menu figé par un envoi se reconstruit (il revient actif) ; le curseur, lui, reste tel quel.
  return box && root.contains(box) && !box.querySelector("select:disabled") ? [`[data-engine="${box.dataset.engine}"]`] : [];
}

/** Un genre de chose à traiter (accords, à vérifier…) : un petit intitulé, sous le grand titre. */
const sub = (id, title, count, body) =>
  `<section class="activity-sub-block" aria-labelledby="h-${id}"><h3 class="activity-sub" id="h-${id}">${title}${count ? ` <span class="block-count">${count}</span>` : ""}</h3>${body}</section>`;

const section = (id, title, count, body, extra = "") =>
  `<section class="block" aria-labelledby="h-${id}">
    <div class="block-head"><h2 class="block-title" id="h-${id}">${title}</h2>${count ? `<span class="block-count">${count}</span>` : ""}${extra}</div>
    ${body}
  </section>`;

function renderFoot() {
  const e = (state.engines ?? []).find((x) => x.main);
  const engine = state.clark.engine;
  const pop = $("#engine-pop");
  let html;
  if (e) html = renderEngine(e, { compact: true, idp: "pop-" });
  else if (engine.name === "demo") html = `<div class="engine compact"><div class="engine-head"><span class="engine-name">Démo</span><span class="engine-plan">faux agent</span></div></div>`;
  else html = `<div class="engine compact"><div class="engine-head"><span class="engine-name">${engine.name === "codex" ? "Codex" : "Claude"}</span><span class="engine-plan">${esc(engine.account ?? "non connecté")}</span></div></div>`;
  swap(pop, `${html}<a class="link pop-more" href="#reglages/moteurs">Tous les moteurs</a>`, engineKeep(pop));
  // Bas de la barre latérale : le même réglage (modèle, puis effort), synchronisé par l'état du serveur.
  const sideBox = $("#engine-side");
  swap(sideBox, e ? renderEngine(e, { bare: true, idp: "side-" }) : "", engineKeep(sideBox));
  // Le bouton dit ce qui tournera : moteur, modèle, effort.
  const name = e ? ENGINE_NAMES[e.name] : engine.name === "demo" ? "Démo" : engine.name === "codex" ? "Codex" : "Claude";
  const model = e?.choice.model ? (e.models.find((m) => m.id === e.choice.model)?.name ?? e.choice.model) : null;
  const effort = e?.choice.effort ? EFFORT_LABELS[e.choice.effort] ?? e.choice.effort : null;
  $("#engine-chip").innerHTML = `${esc(model ?? name)}<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" /></svg>`;
  $("#engine-chip").setAttribute("aria-label", `Moteur : ${[name, model, effort].filter(Boolean).join(", ")}. Changer le modèle ou l'effort`);
  // En bas de la barre : le quota le plus entamé.
  const q = e?.quota?.windows?.length ? e.quota.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)) : null;
  $("#engine-mini").textContent = q ? `${name} · ${Math.round(q.usedPercent)} % (${q.label.replace(/^Fenêtre de /, "")})` : name;
}

// La fenêtre du moteur s'ouvre au-dessus de son bouton.
$("#engine-pop").addEventListener("toggle", (e) => {
  if (e.newState !== "open") return;
  const r = $("#engine-chip").getBoundingClientRect();
  const pop = $("#engine-pop");
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.bottom = `${innerHeight - r.top + 8}px`;
});

// ── Activité : à traiter, en cours, historique ──

function renderChecks(checks) {
  return checks
    .map(
      (c) => `<div class="card" data-check="${c.id}">
        <span class="tag warn">${c.team ? "équipe coupée en pleine écriture" : "coupé en pleine écriture"}</span>
        <p class="card-title">${esc(c.prompt)}</p>
        ${c.team ? renderTeam(c.team) : ""}
        ${c.uncertain.length ? renderSteps(c.uncertain.map((text, i) => ({ id: i, effect: "write", status: "unknown", text }))) : ""}
        <p class="card-note">Cette écriture a peut-être déjà eu lieu. Clark ne la refait pas sans toi : s'il reprend, il vérifie d'abord.</p>
        <div class="card-actions">
          <button type="button" class="btn primary" data-check-action="resume">Reprendre</button>
          <button type="button" class="btn secondary" data-check-action="drop">Abandonner</button>
        </div>
      </div>`,
    )
    .join("");
}

function renderRunning(running) {
  if (!running.length) return `<p class="quiet">Rien en cours.</p>`;
  return (
    running
      .map(
        (t) => `<div class="card">
          <p class="card-title">${esc(t.label === "brief" ? "Brief du matin" : t.prompt)}</p>
          ${t.checkpoint && !t.team ? `<p class="checkpoint solo">${esc(t.checkpoint)}</p>` : ""}
          ${
            t.team
              ? renderTeam(t.team)
              : t.steps.length
                ? renderSteps(t.steps)
                : `<p class="quiet">${t.status === "queued" ? "En file d'attente" : "Réfléchit, pas encore d'action"}</p>`
          }
        </div>`,
      )
      .join("") +
    (running.some((t) => !t.team && t.steps.length)
      ? `<div class="legend"><span><span class="effect read"></span>lecture</span><span><span class="effect write"></span>écriture</span></div>`
      : "")
  );
}

// Historique : lu à la demande (pas dans le flux en direct), par pages de 40.
const history = { tasks: [], more: false, cursor: null, q: "", loaded: false, loading: false, error: null, open: new Set(), details: new Map() };
let historyTimer = null;

async function loadHistory({ append = false } = {}) {
  if (history.loading) return;
  history.loading = true;
  // Filtre tapé dans l'Activité : le serveur cherche dans tout l'historique, pas seulement la page chargée.
  const q = activityFilter;
  const fresh = q !== history.q;
  try {
    const params = new URLSearchParams();
    if (append && !fresh && history.cursor) params.set("before", String(history.cursor));
    if (q) params.set("q", q);
    const res = await fetch(`/api/activity${params.size ? `?${params}` : ""}`);
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const data = await res.json();
    if (append && !fresh) history.tasks = [...history.tasks, ...data.tasks];
    else if (fresh || q) history.tasks = data.tasks;
    else history.tasks = data.tasks.concat(history.tasks.filter((t) => t.id < (data.tasks.at(-1)?.id ?? 0)));
    // Une relecture de la première page ne recule pas le curseur des pages déjà affichées.
    if (append || fresh || q || !history.cursor || (data.cursor ?? 0) < history.cursor) history.cursor = data.cursor ?? null;
    history.more = data.more;
    history.q = q;
    history.error = null;
  } catch (err) {
    history.error = err.message;
  } finally {
    history.loaded = true;
    history.loading = false;
    if (view === "inbox") renderView();
    // Le filtre a changé pendant la requête : on relit avec le bon.
    if (history.q !== activityFilter) void loadHistory();
  }
}

/** Relit l'historique quand l'état change, sans le faire à chaque étape (2 s au plus souvent). */
function scheduleHistory() {
  if (historyTimer) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    void loadHistory();
    for (const id of history.open) void loadDetail(id);
  }, 2000);
}

async function loadDetail(id) {
  try {
    const res = await fetch(`/api/tasks/${id}`);
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    history.details.set(id, await res.json());
  } catch (err) {
    history.details.set(id, { error: err.message });
  }
  if (view === "inbox") renderView();
}

const statusLabel = { queued: "en file", running: "en cours", done: "faite", failed: "échec", needs_check: "à vérifier", abandoned: "abandonnée" };

function renderDetail(d) {
  if (!d) return `<p class="quiet">Chargement…</p>`;
  if (d.error) return `<p class="inline-error">Détail indisponible : ${esc(d.error)}</p>`;
  return `${d.team ? renderTeam(d.team) : d.steps.length ? renderSteps(d.steps) : `<p class="quiet">Aucune étape enregistrée.</p>`}
    ${d.result ? `<div class="hist-result"><p class="field-label">Résultat</p><div class="prose">${md(d.result)}</div></div>` : ""}`;
}

let activityFilter = "";
/** Minuscules, sans accents : « tache » trouve « Tâche ». */
const foldText = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
/** Chaque mot cherché apparaît, dans n'importe quel ordre ; un pluriel trouve aussi le singulier. */
function matchesQuery(text, query) {
  const hay = foldText(text);
  return foldText(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w) || (w.length > 3 && w.endsWith("s") && hay.includes(w.slice(0, -1))));
}
const matches = (...texts) => !activityFilter || matchesQuery(texts.join(" "), activityFilter);

function renderHistory() {
  if (!history.loaded) return `<p class="quiet">Chargement…</p>`;
  if (history.error && !history.tasks.length) return `<p class="inline-error">Historique indisponible : ${esc(history.error)}</p>`;
  if (!history.tasks.length) return `<p class="quiet">Rien encore. Chaque demande, automatisation et tour de veille apparaîtra ici.</p>`;
  if (history.q !== activityFilter) return `<p class="quiet">Recherche…</p>`;
  const matching = history.tasks.filter((t) => matches(t.prompt, t.origin));
  // Les tours de veille sans suite font du bruit : masqués, sauf demande (ou recherche).
  const beats = matching.filter((t) => t.origin === "Tour de veille");
  const tasks = showBeats || activityFilter ? matching : matching.filter((t) => t.origin !== "Tour de veille");
  const beatsToggle = beats.length && !activityFilter ? `<p class="quiet hist-beats"><button type="button" class="link" data-show-beats>${showBeats ? "Masquer les tours de veille" : `Afficher les tours de veille (${beats.length})`}</button></p>` : "";
  const more = history.more ? `<button type="button" class="btn secondary hist-more" data-history-more>Chercher plus ancien</button>` : "";
  if (!tasks.length) return activityFilter ? `<p class="quiet">Rien ne correspond à « ${esc(activityFilter)} »${history.more ? " dans l'historique récent" : ""}.</p>${more}` : `${beatsToggle}<p class="quiet">Seulement des tours de veille.</p>${more}`;
  let html = beatsToggle;
  let lastDay = null;
  for (const t of tasks) {
    const d = parseDate(t.at);
    if (!lastDay || !sameDay(d, lastDay)) {
      if (lastDay) html += "</ol>";
      html += `<h3 class="hist-day">${dayLabel(d)}</h3><ol class="hist">`;
      lastDay = d;
    }
    const meta = [
      esc(t.origin),
      t.team ? "équipe" : null,
      t.steps ? `${t.steps} étape${t.steps > 1 ? "s" : ""}` : null,
      t.engine ? esc(ENGINE_NAMES[t.engine] ?? t.engine) : null,
    ].filter(Boolean);
    html += `<li class="hist-item" data-status="${esc(t.status)}">
      <details data-task="${t.id}"${history.open.has(t.id) ? " open" : ""}>
        <summary>
          <span class="hist-time">${time(d)}</span>
          <span class="hist-main"><span class="hist-title">${esc(t.prompt)}</span><span class="hist-meta">${meta.join(" · ")}</span></span>
          <span class="hist-status">${statusLabel[t.status] ?? esc(t.status)}</span>
        </summary>
        <div class="hist-detail">${history.open.has(t.id) ? renderDetail(history.details.get(t.id)) : ""}</div>
      </details>
    </li>`;
  }
  html += "</ol>";
  if (history.more) html += activityFilter ? more : `<button type="button" class="btn secondary hist-more" data-history-more>Afficher plus ancien</button>`;
  return html;
}

/** « À toi » : tout ce qui attend ta décision, au même endroit. */
function waitingCount() {
  const dev = state.dev ?? { tasks: [], groups: [] };
  return (
    state.approvals.length +
    state.questions.length +
    state.posts.length +
    (state.mails ?? []).length +
    state.checks.length +
    state.proposals.length +
    (state.initiatives ?? []).length +
    (state.improvements ?? []).length +
    (state.goals ?? []).filter((g) => g.status === "waiting").length +
    (state.gates ?? []).length +
    (state.stalled ?? []).length +
    [...dev.tasks, ...(dev.groups ?? []).flatMap((g) => g.tasks)].filter((t) => t.status === "review").length +
    dev.tasks.filter((t) => t.status === "failed").length
  );
}

const DECISION_KINDS = { veille: "Veille", lancer: "Mission", souvenir: "Souvenir" };
// Décisions dépliées (leur raison, le bouton Annuler) : gardées ouvertes quand la page se redessine.
const decOpen = new Set();
let decOlderOpen = false;
let showBeats = false;

function decisionRow(d) {
  const undone = d.status === "undone";
  return `<li class="dec-row${undone ? " undone" : ""}" data-decision="${d.id}">
    <details data-dec="${d.id}"${decOpen.has(d.id) ? " open" : ""}>
      <summary>
        <span class="dec-time">${esc(time(parseDate(d.created_at)))}</span>
        <span class="dec-title">${esc(d.title)}</span>
        <span class="tag">${esc(DECISION_KINDS[d.kind] ?? d.kind)}</span>
        ${undone ? `<span class="dec-state">annulée</span>` : ""}
      </summary>
      <div class="dec-detail">
        <p class="card-note">${esc(d.reason)}</p>
        ${undone ? `<p class="quiet">Annulée${d.undo_note ? ` : ${esc(d.undo_note)}` : ""}.</p>` : `<div class="card-actions"><button type="button" class="btn ghost" data-undo-decision="${d.id}">Annuler cette décision</button></div>`}
        <p class="inline-error" role="alert" hidden></p>
      </div>
    </details>
  </li>`;
}

/** Ce que Clark a décidé seul : aujourd'hui en lignes courtes (un clic pour le pourquoi), le reste replié. */
function renderDecisions() {
  const all = (state.decisions ?? []).filter((d) => matches(d.title, d.reason, DECISION_KINDS[d.kind]));
  const a = state.autonomy;
  const now = new Date();
  const today = all.filter((d) => sameDay(parseDate(d.created_at), now));
  const older = all.filter((d) => !sameDay(parseDate(d.created_at), now));
  const autonomy = a
    ? `<p class="quiet activity-meta">${a.veille || a.lancer || a.souvenir ? `${a.today} décision${a.today > 1 ? "s" : ""} sur ${a.max} permises aujourd'hui${a.now?.ok === false ? ` · ${esc(a.now.why)}` : ""}` : "Clark ne décide rien seul"} · <a class="link" href="#reglages/general">Régler l'autonomie</a></p>`
    : "";
  const body = `${today.length ? `<ol class="dec-list">${today.map(decisionRow).join("")}</ol>` : `<p class="quiet">Rien décidé seul aujourd'hui.</p>`}
    ${older.length ? `<details class="dec-older"${decOlderOpen ? " open" : ""}><summary>Avant aujourd'hui <span class="block-count">${older.length}</span></summary><ol class="dec-list">${older.map(decisionRow).join("")}</ol></details>` : ""}
    ${heartbeatLine(state.heartbeat)}`;
  return `<h2 class="activity-group" id="h-decisions">Décisions de Clark${today.length ? ` <span class="block-count">${today.length} aujourd'hui</span>` : ""}</h2>${autonomy}${body}`;
}

$("#inbox").addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (d.matches?.("[data-dec]")) {
      const id = Number(d.dataset.dec);
      if (d.open) decOpen.add(id);
      else decOpen.delete(id);
    } else if (d.matches?.(".dec-older")) decOlderOpen = d.open;
  },
  true,
);

$("#inbox").addEventListener("click", (e) => {
  if (!e.target.closest("[data-show-beats]")) return;
  showBeats = !showBeats;
  renderView();
});

side.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-undo-decision]");
  if (!btn) return;
  const card = btn.closest("[data-decision]");
  const error = card.querySelector(".inline-error");
  btn.disabled = true;
  try {
    await post(`/api/decisions/${btn.dataset.undoDecision}/undo`, {});
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    btn.disabled = false;
  }
});

function improvementCards(list) {
  return list.map((i) => `<div class="card" data-improvement="${i.id}" data-proposed-at="${esc(i.proposedAt)}">
    <p class="card-title">${esc(i.title)}</p>
    ${i.example ? `<p class="card-note">${esc(i.example)}</p>` : ""}
    <p class="card-note">${esc(i.measurement)}</p>
    ${i.status === "merged" ? `<p class="card-note">PR fusionnée${i.prUrl ? ` · <a href="${esc(i.prUrl)}" target="_blank" rel="noreferrer">voir la PR</a>` : ""}. Le déploiement redémarre Clark, puis j'observe 2 h (retour arrière automatique en cas de régression).</p>` : ""}
    <div class="card-actions">
      ${i.status === "merged"
        ? `<button type="button" class="btn primary" data-improvement-action="deploy">Déployer</button>`
        : `<button type="button" class="btn primary" data-improvement-action="launch">Lancer</button>
      <button type="button" class="btn ghost" data-improvement-action="snooze">Pas maintenant</button>
      <button type="button" class="btn ghost" data-improvement-action="dismiss">Ignorer</button>`}
    </div>
    <p class="inline-error" role="alert" hidden></p>
  </div>`).join("");
}

$("#inbox").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-improvement-action]");
  if (!button || button.disabled) return;
  const card = button.closest("[data-improvement]");
  const buttons = card.querySelectorAll("button");
  const error = card.querySelector(".inline-error");
  error.hidden = true;
  buttons.forEach((b) => (b.disabled = true));
  try {
    await post(`/api/improvements/${card.dataset.improvement}`, {
      action: button.dataset.improvementAction,
      proposedAt: card.dataset.proposedAt,
    });
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  }
});

function renderInbox() {
  const { checks, proposals } = state;
  const dev = state.dev ?? { tasks: [], groups: [] };
  const allReview = [...dev.tasks, ...(dev.groups ?? []).flatMap((g) => g.tasks)].filter((t) => t.status === "review");
  const review = allReview.filter((t) => matches(t.title, t.project));
  const goals = (state.goals ?? []).filter((g) => g.status === "waiting");
  const asks = [...state.approvals.map(renderApproval), ...state.questions.map(renderQuestion), ...(state.mails ?? []).map(renderMailCard), ...state.posts.map(renderPost)];
  let html = "";
  if (asks.length) html += sub("asks", "Accords et questions", asks.length, `<div class="stack">${asks.join("")}</div>`);
  const gates = state.gates ?? [];
  if (gates.length) html += sub("gates", "Décisions pour le dev", gates.length, `<div class="stack">${gates.map((x) => renderGate({ ...x, resolution: null }, x.groupTitle)).join("")}</div>`);
  const stalled = state.stalled ?? [];
  if (stalled.length)
    html += sub(
      "stalled",
      "Agents silencieux",
      stalled.length,
      `<div class="stack">${stalled
        .map(
          (x) => `<div class="card" data-stalled="${x.taskId}">
          <p class="card-title">${esc(x.title || "Tâche")}</p>
          <p class="quiet">Aucune activité depuis ${minutesSince(x.since)} min. Il réfléchit peut-être encore, ou il est bloqué.</p>
          <div class="card-actions">
            ${x.stoppable ? `<button type="button" class="btn secondary" data-stop-task="${x.taskId}">Arrêter l'agent</button>` : ""}
            ${x.dev ? `<a class="btn ghost" href="#dev/${x.dev}">Voir la tâche</a>` : ""}
          </div>
        </div>`,
        )
        .join("")}</div>`,
    );
  if (review.length)
    html += sub(
      "review",
      "Tâches dev à relire",
      review.length,
      `<ul class="link-list">${review.map((t) => `<li><a href="#dev/${t.id}"><span class="dot" data-s="review"></span><span class="ll-label">${esc(t.title)}</span><span class="quiet">${esc(t.project)}</span></a></li>`).join("")}</ul>`,
    );
  const allStopped = dev.tasks.filter((t) => t.status === "failed");
  const stopped = allStopped.filter((t) => matches(t.title, t.project));
  if (stopped.length)
    html += sub(
      "dev-stopped",
      "Tâches dev arrêtées",
      stopped.length,
      `<ul class="link-list">${stopped.map((t) => `<li><a href="#dev/${t.id}"><span class="dot" data-s="wait"></span><span class="ll-label">${esc(t.title)}</span><span class="quiet">${esc(t.project)} · à relancer ou jeter</span></a></li>`).join("")}</ul>`,
    );
  if (goals.length) html += sub("goals-wait", "Objectifs qui t'attendent", goals.length, goals.map(renderGoal).join(""));
  if (checks.length) html += sub("checks", "Coupées en pleine écriture", checks.length, renderChecks(checks));
  if (proposals.length) html += sub("proposals", "Souvenirs à confirmer", proposals.length, proposals.map(renderProposal).join(""));
  const initiatives = state.initiatives ?? [];
  if (initiatives.length) html += sub("initiatives", "Propositions de Clark", initiatives.length, initiativeCards(initiatives));
  const improvements = state.improvements ?? [];
  if (improvements.length) html += sub("improvements", "Auto-amélioration", improvements.length, improvementCards(improvements));
  const toRate = state.initiativeLoop?.feedback ?? [];
  if (toRate.length) html += sub("initiatives-feedback", "C'était utile ?", toRate.length, feedbackCards(toRate));
  // Le filtre écarte des tâches dev : le compte suit ce qui est affiché.
  const shown = waitingCount() - (allReview.length - review.length) - (allStopped.length - stopped.length);
  if (!waitingCount()) html = `<p class="empty-note">Rien ne t'attend. Les accords, questions, propositions et relectures arrivent ici.</p>${html}`;
  else if (!shown) html = `<p class="quiet">Rien ne correspond à « ${esc(activityFilter)} ».</p>${html}`;
  html = `<h2 class="activity-group" id="h-waiting">À traiter${shown ? ` <span class="block-count is-hot">${shown}</span>` : ""}</h2>${html}`;
  const allLive = liveRows().filter((r) => r.s !== "review" && r.s !== "wait");
  const live = allLive.filter((r) => matches(r.label, r.meta));
  html += `<h2 class="activity-group" id="h-live">En cours${live.length ? ` <span class="block-count">${live.length}</span>` : ""}</h2>${
    live.length ? `<ul class="link-list">${live.map((r) => `<li><a href="${r.href}"><span class="dot" data-s="${r.s}"></span><span class="ll-label">${esc(r.label)}</span><span class="quiet">${esc(r.meta)}</span></a></li>`).join("")}</ul>` : `<p class="quiet">${allLive.length ? `Rien ne correspond à « ${esc(activityFilter)} ».` : "Aucun agent ne travaille."}</p>`
  }`;
  html += renderNotes();
  html += renderInitiativeBilan();
  html += renderDecisions();
  html += `<h2 class="activity-group" id="h-history">Historique</h2>${renderHistory()}`;
  // Sommaire en tête : où en est chaque partie, d'un coup d'œil (et un clic pour y aller).
  const todayDecisions = (state.decisions ?? []).filter((d) => sameDay(parseDate(d.created_at), new Date())).length;
  html = `<nav class="activity-summary" aria-label="Parties de l'activité">
    <a href="#h-waiting" data-jump class="${shown ? "is-hot" : ""}"><strong>${shown}</strong> à traiter</a>
    <a href="#h-live" data-jump><strong>${live.length}</strong> en cours</a>
    <a href="#h-notes" data-jump class="${newNotesCount() ? "is-hot" : ""}"><strong>${newNotesCount()}</strong> nouvelle${newNotesCount() > 1 ? "s" : ""} note${newNotesCount() > 1 ? "s" : ""}</a>
    <a href="#h-decisions" data-jump><strong>${todayDecisions}</strong> décision${todayDecisions > 1 ? "s" : ""} aujourd'hui</a>
    <a href="#h-history" data-jump>Historique</a>
  </nav>${html}`;
  const root = $("#inbox");
  const keepQuestions = [...root.querySelectorAll("[data-question]")].filter((c) => {
    const i = c.querySelector("input");
    return i && (i.value || c.contains(document.activeElement));
  });
  const typing = [...root.querySelectorAll("[data-goal-answer]")].filter((f) => f.elements.note.value || f.contains(document.activeElement));
  swap(root, html, [
    ...(editing !== null ? [`[data-memory="${editing}"]`] : []),
    ...typing.map((f) => `[data-goal="${f.closest("[data-goal]").dataset.goal}"] [data-goal-answer]`),
    ...keepQuestions.map((c) => `[data-question="${c.dataset.question}"]`),
    ...[...root.querySelectorAll("[data-gate-form]")].filter((f) => f.elements.resolution.value || f.contains(document.activeElement)).map((f) => `[data-gate="${f.closest("[data-gate]").dataset.gate}"]`),
  ]);
  if (editing !== null && !document.querySelector(`[data-memory="${editing}"]`)) editing = null;
}

let filterTimer = null;
$("#activity-filter").addEventListener("input", (e) => {
  activityFilter = e.target.value.trim().slice(0, 200);
  renderView();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => void loadHistory(), 250);
});

/** Ce qui tourne ou attend une relecture : objectifs, groupes, tâches dev ouverts. */
function liveRows() {
  const dev = state.dev ?? { tasks: [], groups: [] };
  const rows = [];
  for (const g of state.goals ?? [])
    if (["active", "waiting", "paused"].includes(g.status)) rows.push({ href: `#objectif/${g.id}`, label: g.objective, meta: `objectif · ${goalStatus[g.status] ?? g.status}`, s: statusGlyph[g.running && g.status === "active" ? "running" : g.status] ?? "idle", at: g.updated ?? g.at });
  for (const g of dev.groups ?? [])
    if (g.status === "planning" || g.status === "running") rows.push({ href: `#groupe/${g.id}`, label: g.title, meta: `groupe · ${g.project}`, s: "running", at: g.at });
  for (const t of dev.tasks)
    if (["preparing", "working", "review", "failed"].includes(t.status)) rows.push({ href: `#dev/${t.id}`, label: t.title, meta: `${t.project} · ${devStatus[t.status] ?? t.status}`, s: statusGlyph[t.status] ?? "idle", at: t.at });
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ── Objectifs (mode objectif) ──

const goalStatus = { active: "en cours", waiting: "attend ta réponse", paused: "en pause", done: "atteint", stopped: "arrêté" };

function renderGoal(g) {
  const reports = g.events.filter((e) => e.kind === "progress" || e.kind === "blocked" || e.kind === "done");
  const last = reports.at(-1);
  const live = g.status === "active" || g.status === "waiting" || g.status === "paused";
  const journal = g.events.length
    ? `<details class="goal-log goal-journal"><summary>Journal des tours</summary><ol>${g.events
        .map(
          (e) =>
            `<li data-kind="${e.kind}"><span class="goal-turn">${e.kind === "note" ? "toi" : e.kind === "system" ? "·" : `tour ${e.turn}`}</span><span>${esc(e.text)}${e.next ? `<br><span class="quiet">Ensuite : ${esc(e.next)}</span>` : ""}</span></li>`,
        )
        .join("")}</ol></details>`
    : "";
  const actions =
    g.status === "waiting"
      ? `<form class="goal-answer" data-goal-answer>
          <label for="goal-note-${g.id}">Ta réponse <span class="optional">(facultatif)</span></label>
          <textarea id="goal-note-${g.id}" name="note" rows="2" maxlength="2000"></textarea>
          <div class="card-actions">
            <button type="submit" class="btn primary">Reprendre</button>
            <button type="button" class="btn ghost" data-goal-action="stop">Arrêter</button>
          </div>
        </form>`
      : g.status === "active"
        ? `<div class="card-actions"><button type="button" class="btn secondary" data-goal-action="pause">Mettre en pause</button><button type="button" class="btn ghost" data-goal-action="stop">Arrêter</button></div>`
        : g.status === "paused"
          ? `<div class="card-actions"><button type="button" class="btn primary" data-goal-action="resume">Reprendre</button><button type="button" class="btn ghost" data-goal-action="stop">Arrêter</button></div>`
          : "";
  return `<div class="card goal" data-goal="${g.id}" data-status="${g.status}">
    <div class="goal-head">
      <span class="kind-line">Objectif #${g.id} · tour ${g.turns} sur ${g.maxTurns}</span>
      <span class="tag goal-${g.status}">${g.running && g.status === "active" ? `${sprite("clark", { walking: true, size: 14 })}en cours` : goalStatus[g.status] ?? g.status}</span>
    </div>
    <p class="card-title">${esc(g.objective)}</p>
    ${g.status === "waiting" && g.reason ? `<p class="goal-reason">${esc(g.reason)}</p>` : ""}
    ${g.status === "done" && g.summary ? `<div class="prose goal-summary">${md(g.summary)}</div>` : last && live && !(g.status === "waiting" && g.reason?.includes(last.text)) ? `<p class="card-note">${last.kind === "blocked" ? "Question" : "Dernier tour"} : ${esc(last.text)}${last.next ? `<br>Ensuite : ${esc(last.next)}` : ""}</p>` : ""}
    ${journal}
    ${actions}
  </div>`;
}

function renderGoals(goals) {
  const live = goals.filter((g) => g.status === "active" || g.status === "waiting" || g.status === "paused");
  const past = goals.filter((g) => !live.includes(g)).slice(0, 3);
  if (!goals.length) return section("goals", "Objectifs", "", `<p class="quiet">Aucun objectif. Pour en lancer un, choisis « Objectif » sous le champ de la conversation : Clark enchaîne les tours jusqu'à l'atteindre, et te demande quand il bloque.</p>`);
  return section("goals", "Objectifs", live.length || "", [...live, ...past].map(renderGoal).join(""));
}

side.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-goal-action]");
  if (!button) return;
  const card = button.closest("[data-goal]");
  if (button.dataset.goalAction === "stop" && !(await ask("Arrêter cet objectif ?", "Clark ne lancera plus de tour. Le travail déjà fait reste.", "Arrêter"))) return;
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/goals/${card.dataset.goal}`, { action: button.dataset.goalAction });
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

side.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-goal-answer]");
  if (!form) return;
  e.preventDefault();
  const card = form.closest("[data-goal]");
  form.querySelectorAll("button, textarea").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/goals/${card.dataset.goal}`, { action: "resume", note: form.elements.note.value.trim() });
  } catch (err) {
    form.querySelectorAll("button, textarea").forEach((b) => (b.disabled = false));
    form.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});


// Sommaire de l'Activité : un clic descend à la partie (sans changer d'adresse, qui sert à la navigation).
$("#inbox").addEventListener("click", (e) => {
  const a = e.target.closest("[data-jump]");
  if (!a) return;
  e.preventDefault();
  const target = document.querySelector(a.getAttribute("href"));
  target?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  target?.setAttribute("tabindex", "-1");
  target?.focus({ preventScroll: true });
});
