// ── Le fil ouvert : un objectif, une tâche dev ou un groupe ──

let detail = null; // { kind: "goal" | "dev" | "group", id }

function renderDetailView() {
  const root = $("#detail");
  const dev = state.dev ?? { tasks: [], groups: [] };
  let title = "";
  let html = "";
  if (detail?.kind === "goal") {
    const g = (state.goals ?? []).find((x) => x.id === detail.id);
    title = g ? `Objectif #${g.id}` : "Objectif introuvable";
    html = g ? renderGoal(g) : `<p class="quiet">Cet objectif n'existe plus.</p>`;
  } else if (detail?.kind === "dev") {
    const t = [...dev.tasks, ...(dev.groups ?? []).flatMap((g) => g.tasks)].find((x) => x.id === detail.id);
    title = t ? t.title : "Tâche introuvable";
    html = t ? (t.compareWith ? renderCompare(t) : "") + renderDevTask(t) : `<p class="quiet">Cette tâche n'existe plus.</p>`;
  } else if (detail?.kind === "group") {
    const g = (dev.groups ?? []).find((x) => x.id === detail.id);
    title = g ? g.title : "Groupe introuvable";
    html = g ? renderDevGroup(g) : `<p class="quiet">Ce groupe n'existe plus.</p>`;
  }
  $("#t-detail").textContent = title;
  for (const form of root.querySelectorAll("[data-pr-form]")) {
    const f = prForms.get(form.dataset.prForm);
    if (f) Object.assign(f, { title: form.elements.title.value, body: form.elements.body.value });
  }
  const keep = [
    ...[...root.querySelectorAll("[data-dev-retouch]")].filter((f) => f.elements.instruction.value || f.contains(document.activeElement)).map((f) => `[data-dev="${f.closest("[data-dev]").dataset.dev}"] [data-dev-retouch]`),
    ...[...root.querySelectorAll("[data-goal-answer]")].filter((f) => f.elements.note.value || f.contains(document.activeElement)).map((f) => `[data-goal="${f.closest("[data-goal]").dataset.goal}"] [data-goal-answer]`),
    // Un commentaire en cours d'écriture, un « Réessayer » ouvert, une décision en cours : gardés tels quels.
    ...(commentDraft && root.querySelector("[data-comment-form]") ? [`[data-dev="${commentDraft.task}"] [data-comment-form]`] : []),
    ...[...root.querySelectorAll(".dev-retry[open]")].map((d) => `[data-dev="${d.closest("[data-dev]").dataset.dev}"] .dev-retry`),
    ...[...root.querySelectorAll(".dev-compare-open[open]")].map((d) => `[data-dev="${d.closest("[data-dev]").dataset.dev}"] .dev-compare-open`),
    ...[...root.querySelectorAll("[data-gate-form]")].filter((f) => f.elements.resolution.value || f.contains(document.activeElement)).map((f) => `[data-gate="${f.closest("[data-gate]").dataset.gate}"]`),
  ];
  for (const d of root.querySelectorAll("[data-dev-diff][open]")) openDiffTasks.add(d.closest("[data-dev]").dataset.dev);
  const openDiffs = [...openDiffTasks];
  swap(root, html, keep);
  for (const id of openDiffs) root.querySelector(`[data-dev="${id}"] [data-dev-diff]`)?.setAttribute("open", "");
  // Un diff ouvert dont l'agent vient de finir un nouveau tour : on le recharge.
  for (const d of root.querySelectorAll("[data-dev-diff][open]")) {
    const id = Number(d.closest("[data-dev]").dataset.dev);
    const t = allDevTasks().find((x) => x.id === id);
    if (t && devPatches.get(id)?.rounds !== patchKey(t) && !patchLoading.has(id)) void loadPatch(id);
  }
}

// ── La barre de gauche : tes fils ──

const statusGlyph = {
  running: "running",
  active: "running",
  working: "running",
  preparing: "running",
  planning: "running",
  waiting: "wait",
  paused: "idle",
  review: "review",
  failed: "wait",
  done: "done",
  accepted: "done",
  integrated: "done",
  stopped: "idle",
  discarded: "idle",
};

function threadItem(href, label, status, meta = "") {
  const current = location.hash === href || (href === "#conversation" && view === "chat");
  const s = statusGlyph[status] ?? "idle";
  return `<a class="thread-item" href="${href}" data-s="${s}" title="${esc(meta ? `${label} · ${meta}` : label)}"${current ? ' aria-current="page"' : ""}>
    ${s === "running" ? sprite("clark", { walking: true, size: 14 }) : `<span class="dot" data-s="${s}" aria-hidden="true"></span>`}
    <span class="thread-label">${esc(label)}</span>
    ${meta ? `<span class="thread-meta">${esc(meta)}</span>` : ""}
  </a>`;
}

/** « 14:02 » aujourd'hui, « hier », sinon « 12 nov. ». */
function convWhen(at) {
  const d = parseDate(at);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "hier";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

// L'agent d'une conversation (null : Clark) → son bonhomme et son nom.
const agentRole = (agent) => agent ?? "clark";
// Boulon (Code) n'a pas de conversation à lui : il travaille dans les tâches de code.
const EXTRA_CONTACTS = { code: { role: "code", name: "Boulon", badge: "Code" }, groupe: { role: "groupe", name: "Toute l'équipe", badge: "Avis croisés" } };
const contactOf = (agent) => (state.contacts ?? []).find((c) => c.role === (agent ?? null)) ?? EXTRA_CONTACTS[agent] ?? { role: null, name: "Clark", badge: "Chef d'orchestre" };
let listQuery = "";
let keptUnread = new Set();

/** L'agent ouvert travaille : son bonhomme marche dans la liste. */
const agentBusy = (agent) => (state.conversationAgent ?? null) === (agent ?? null) && state.running.some((t) => t.status === "running");

/** Un contact ou une conversation : avatar, nom, aperçu du dernier message, heure, non-lus. */
function listRow({ href, agent, title, badge, preview, previewRole, at, unread, current }) {
  const busy = agentBusy(agent);
  const who = previewRole === "user" ? "Toi : " : "";
  return `<a class="conv-row${unread ? " unread" : ""}" href="${href}"${current ? ' aria-current="page"' : ""}>
    <span class="conv-avatar" data-agent="${esc(agentRole(agent))}">${sprite(agentRole(agent), { walking: busy, size: 26 })}</span>
    <span class="conv-main">
      <span class="conv-top"><span class="conv-title">${esc(title)}</span>${badge ? `<span class="conv-badge">${esc(badge)}</span>` : ""}${at ? `<span class="conv-time">${esc(convWhen(at))}</span>` : ""}</span>
      <span class="conv-bottom"><span class="conv-preview">${busy ? "écrit…" : preview ? esc(who + preview) : "Pas encore de message"}</span>${unread ? `<span class="conv-unread" aria-label="${unread} non lu${unread > 1 ? "s" : ""}">${unread}</span>` : ""}</span>
    </span>
  </a>`;
}

const matchesList = (...texts) => !listQuery.trim() || texts.some((t) => t && matchesQuery(t, listQuery));

/** Les conversations : non lues d'abord, puis l'équipe (un contact par agent), puis toutes les autres. */
function renderConversationList() {
  const list = state.conversations ?? [];
  const byId = new Map(list.map((c) => [c.id, c]));
  // Affichée en ce moment (l'ouverte, ou une passée qu'on relit) : sa ligne est mise en avant, sans non-lus.
  const isCurrent = (c) => view === "chat" && (pastId ? pastId === c.id : c.id === state.conversationId);
  const viewing = (id) => view === "chat" && (pastId ? pastId === id : id === state.conversationId);
  const row = (c) =>
    listRow({
      href: c.id === state.conversationId ? "#conversation" : `#conversation/${c.id}`,
      agent: c.agent,
      title: c.title,
      badge: c.agent ? contactOf(c.agent).name : "",
      preview: c.preview,
      previewRole: c.preview_role,
      at: c.at,
      unread: isCurrent(c) ? 0 : c.unread,
      current: isCurrent(c),
    });
  // Une conversation qu'on lit garde sa place dans « Non lues » jusqu'à ce qu'on la quitte : la liste ne saute pas sous le doigt.
  const unread = list.filter((c) => (c.unread || (isCurrent(c) && keptUnread.has(c.id))) && matchesList(c.title, c.preview));
  keptUnread = new Set(unread.map((c) => c.id));
  const team = (state.contacts ?? [])
    .filter((ct) => matchesList(ct.name, ct.badge))
    .map((ct) => {
      const latest = ct.latest ? byId.get(ct.latest) : null;
      const open = ct.latest !== null && viewing(ct.latest);
      return listRow({
        href: `#agent/${ct.role ?? "clark"}`,
        agent: ct.role,
        title: ct.name,
        badge: ct.badge,
        preview: latest?.preview ?? null,
        previewRole: latest?.preview_role ?? null,
        at: latest?.at ?? null,
        unread: open ? 0 : (latest?.unread ?? 0),
        // L'agent dont la conversation est affichée : sa ligne est mise en avant.
        current: open,
      });
    })
    .join("");
  const unreadIds = new Set(unread.map((c) => c.id));
  // La conversation la plus récente de chaque agent est déjà sa ligne dans « Équipe » : pas deux fois.
  const shownByTeam = new Set((state.contacts ?? []).map((ct) => ct.latest).filter(Boolean));
  const rest = list.filter((c) => !unreadIds.has(c.id) && (listQuery.trim() || !shownByTeam.has(c.id)) && matchesList(c.title, c.preview, contactOf(c.agent).name));
  return `${unread.length ? `<p class="threads-title">Non lues <span class="threads-count">${unread.length}</span></p>${unread.map(row).join("")}` : ""}
    ${team ? `<p class="threads-title">Équipe</p>${team}` : ""}
    ${rest.length ? `<p class="threads-title">Plus anciennes</p>${rest.map(row).join("")}` : listQuery.trim() ? `<p class="threads-empty">Rien ne correspond.</p>` : ""}`;
}

function renderThreads() {
  const dev = state.dev ?? { tasks: [], groups: [] };
  const waiting = waitingCount();
  const live = [];
  for (const g of state.goals ?? []) {
    const item = { at: g.updated ?? g.at, html: threadItem(`#objectif/${g.id}`, g.objective, g.running && g.status === "active" ? "running" : g.status, g.status === "waiting" ? "t'attend" : `${g.turns}/${g.maxTurns}`) };
    if (["active", "waiting", "paused"].includes(g.status)) live.push(item);
  }
  for (const g of dev.groups ?? []) {
    const open = g.status === "planning" || g.status === "running";
    const toReview = g.tasks.filter((t) => t.status === "review").length;
    if (open) live.push({ at: g.at, html: threadItem(`#groupe/${g.id}`, g.title, g.status === "running" && toReview ? "review" : g.status, toReview ? `${toReview} à relire` : "groupe") });
  }
  for (const t of dev.tasks) {
    const open = ["preparing", "working", "review", "failed"].includes(t.status);
    const who = ENGINE_NAMES[t.engine ?? state.clark.engine.name] ?? "";
    const meta = t.compareWith ? `${who}${t.effort ? ` ${EFFORT_LABELS[t.effort] ?? t.effort}` : ""}` : t.status === "review" ? "à relire" : t.project;
    if (open) live.push({ at: t.at, html: threadItem(`#dev/${t.id}`, t.title, t.status, meta) });
  }
  const byDate = (a, b) => String(b.at).localeCompare(String(a.at));
  // Activité est dans la colonne d'icônes : son compteur y est affiché.
  const count = $("#rail-count");
  count.hidden = !waiting;
  count.textContent = waiting ? String(waiting) : "";
  count.setAttribute("aria-label", `${waiting} t'attendent`);
  const html = `
    ${live.length ? `<p class="threads-title">En cours</p>${live.sort(byDate).map((i) => i.html).join("")}` : ""}
    ${renderConversationList()}`;
  const nav = $("#threads");
  const key = focusKey(nav);
  nav.innerHTML = html;
  restoreFocus(nav, key);
}

// ── Navigation : l'adresse dit ce qui est ouvert (#conversation, #objectif/3, #dev/5…) ──

let view = "chat";
// Conversation passée ouverte (#conversation/12) : son id, et ses messages une fois chargés.
let pastId = null;
let pastConv = null;
let pastScrolled = null;
let jumpBottom = false;

async function loadPast(id) {
  try {
    const r = await fetch(`/api/conversations/${id}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Erreur ${r.status}`);
    const c = await r.json();
    if (pastId === id) {
      pastConv = c;
      renderThread();
    }
  } catch (err) {
    if (pastId === id) thread.innerHTML = `<p class="inline-error">Conversation impossible à ouvrir : ${esc(err.message)}</p>`;
  }
}

async function openAgentNav(role) {
  const r = await fetch(`/api/agents/${encodeURIComponent(role)}/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await r.json().catch(() => ({}));
  if (!location.hash.startsWith("#agent/")) return; // on est allé ailleurs entre-temps
  if (r.ok) return location.replace("#conversation");
  // Clark répond ailleurs : on relit la dernière conversation de l'agent, sans en changer.
  if (data.id) return location.replace(`#conversation/${data.id}`);
  location.replace("#conversation");
  sendError.textContent = data.error ?? "Conversation impossible à ouvrir.";
  sendError.hidden = false;
}

function route() {
  const [head, arg] = location.hash.slice(1).split("/");
  detail = null;
  if (head === "a-toi" || head === "activite" || head === "historique") view = "inbox";
  else if (head === "terminal") view = "terminal";
  else if (head === "reglages" || head === "plugins") {
    view = "settings";
    const key = SETTINGS_ALIASES[arg] ?? (head === "plugins" ? "connexions" : arg);
    const before = settingsTab;
    settingsTab = SETTINGS_TABS.some((t) => t[0] === key) ? key : settingsTab;
    if (settingsTab !== before) $("#view-settings").scrollTop = 0;
  } else if ((head === "objectif" || head === "dev" || head === "groupe") && Number(arg)) {
    view = "detail";
    detail = { kind: head === "objectif" ? "goal" : head === "dev" ? "dev" : "group", id: Number(arg) };
  } else if (head === "agent" && arg) {
    // Un contact de l'équipe : on ouvre sa conversation (la plus récente, ou une neuve).
    view = "chat";
    void openAgentNav(arg);
  } else {
    view = "chat";
    const id = head === "conversation" ? Number(arg) : 0;
    const before = pastId;
    // La conversation ouverte a son adresse courte (#conversation) ; les autres se relisent.
    pastId = id && state && id !== state.conversationId ? id : null;
    if (before && !pastId) jumpBottom = true;
    if (pastId && pastConv?.id !== pastId) {
      pastConv = null;
      void loadPast(pastId);
    }
  }
}

function renderView() {
  if (!state) return;
  if (view === "inbox") renderInbox();
  else if (view === "settings") renderSettingsPage();
  else if (view === "detail") renderDetailView();
  else if (view === "terminal") renderTerminal();
  renderDesign();
}
// Les formulaires et boutons appellent ces noms : tout passe par la vue ouverte.
const renderDev = () => renderView();
const renderPlugins = () => renderView();
const renderSettings = () => renderView();
const renderActivity = () => renderView();

function showView() {
  route();
  $("#app").dataset.view = view;
  for (const v of ["chat", "detail", "inbox", "settings", "terminal"]) $(`#view-${v}`).hidden = v !== view;
  // Colonne d'icônes : la section ouverte (Automatisations et Projets sont des rubriques des réglages).
  const railTab = view === "settings" && ["automatisations", "projets"].includes(settingsTab) ? settingsTab : null;
  for (const a of document.querySelectorAll(".rail-btn[data-view], .rail-btn[data-rail]")) {
    const on = a.dataset.rail ? a.dataset.rail === railTab : a.dataset.view === view && !railTab;
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("#app").removeAttribute("data-drawer");
  if (state) renderThreads();
  renderView();
  if (view === "inbox" && state) void loadHistory();
  // Passer d'une conversation à l'autre redessine le fil.
  if (view === "chat" && state) {
    pastScrolled = null;
    renderThread();
  }
  if (view === "chat" && !pastId) thread.scrollTop = thread.scrollHeight;
}

window.addEventListener("hashchange", () => {
  // Retour arrière pendant que la palette est ouverte : elle ne reste pas sur la nouvelle vue.
  if (palette.open) palette.open = false;
  showView();
});

// Barre de gauche. Grand écran : entière, réduite (les icônes) ou fermée, gardé sur cet appareil.
// Petit écran : un tiroir par-dessus la page, refermé dès qu'on choisit quelque chose dedans.
const narrow = () => matchMedia("(max-width: 900px)").matches;
function setNav(mode) {
  if (narrow()) {
    if (mode === "closed") $("#app").removeAttribute("data-drawer");
    return;
  }
  $("#app").dataset.nav = mode;
  try {
    localStorage.setItem("clark.nav", mode);
  } catch {}
}
try {
  const saved = localStorage.getItem("clark.nav");
  if (saved === "rail" || saved === "closed") $("#app").dataset.nav = saved;
} catch {}

document.addEventListener("click", (e) => {
  const set = e.target.closest("[data-nav-set]");
  if (set) return setNav(set.dataset.navSet);
  // Le bouton menu seulement : #app porte aussi data-drawer quand le tiroir est ouvert.
  if (e.target.closest("button[data-drawer]")) {
    // Grand écran, barre fermée : le bouton menu la rouvre en entier.
    if (!narrow()) return setNav("full");
    $("#app").setAttribute("data-drawer", "open");
    $("#threads a")?.focus();
  } else if (e.target.closest("[data-drawer-close]")) $("#app").removeAttribute("data-drawer");
  // Un lien ou une ligne choisi dans le tiroir le referme, même si l'adresse ne change pas.
  else if (narrow() && e.target.closest("#sidebar a, #sidebar .conv-row, #sidebar #palette-open")) $("#app").removeAttribute("data-drawer");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#app").hasAttribute("data-drawer")) $("#app").removeAttribute("data-drawer");
});

side.addEventListener("toggle", (e) => {
  const d = e.target.closest?.("details[data-task]");
  if (!d) return;
  const id = Number(d.dataset.task);
  // Un <details> recréé déjà ouvert déclenche aussi « toggle » : on ne recharge que sur une vraie ouverture.
  if (d.open && !history.open.has(id)) {
    history.open.add(id);
    void loadDetail(id);
  } else if (!d.open) history.open.delete(id);
}, true);

side.addEventListener("click", (e) => {
  if (e.target.closest("[data-history-more]")) void loadHistory({ append: true });
});

let editing = null; // id de la proposition en cours de correction

const shortDate = (at) => parseDate(at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
const isoToFr = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

function renderProposal(p) {
  const when = parseDate(p.at);
  const facts = [
    ["Source", esc(p.source ?? "non indiquée")],
    ["Proposé", `${shortDate(p.at)}, ${time(when)}${p.task && !(p.source ?? "").includes(p.task.replace(/…$/, "")) ? ` · pendant « ${esc(p.task)} »` : ""}`],
    ["Valable", p.expiresAt ? `jusqu'au ${isoToFr(p.expiresAt)}` : "sans limite"],
  ];
  return `<div class="card proposal" data-memory="${p.id}">
    <span class="kind-line">${esc(kindLabel[p.kind] ?? p.kind)}${p.replaces ? ` · correction du souvenir #${p.replaces.id}` : ""}</span>
    <p class="card-title">${esc(p.content)}</p>
    ${
      p.replaces
        ? `<p class="replaces"><span>Aujourd'hui :</span> ${esc(p.replaces.content ?? "")}<br><span>Reste en vigueur tant que tu n'as pas confirmé.</span></p>`
        : ""
    }
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="card-actions">
      <button type="button" class="btn primary" data-memory-action="confirm">Confirmer</button>
      <button type="button" class="btn secondary" data-memory-action="edit">Corriger</button>
      <button type="button" class="btn ghost" data-memory-action="ignore">Ignorer</button>
    </div>
  </div>`;
}

function correctionForm(card, p) {
  const id = `fix-${p.id}`;
  return `<form class="fix" novalidate>
    <label for="${id}-text">Ce que Clark doit retenir</label>
    <textarea id="${id}-text" name="content" rows="3" maxlength="1000" aria-describedby="${id}-err">${esc(p.content)}</textarea>
    <label for="${id}-date">Valable jusqu'au <span class="optional">facultatif</span></label>
    <input id="${id}-date" name="expiresAt" type="date" value="${esc(p.expiresAt ?? "")}" />
    <p class="inline-error" id="${id}-err" role="alert" hidden></p>
    <div class="card-actions">
      <button type="submit" class="btn primary">Confirmer la correction</button>
      <button type="button" class="btn ghost" data-memory-action="cancel">Annuler</button>
    </div>
  </form>`;
}

function renderMemory(m) {
  const origin = m.source ? `source : ${esc(m.source)}` : "provenance inconnue";
  const extra = [m.corrected ? "corrigé par toi" : "", m.confirmedAt ? `confirmé le ${shortDate(m.confirmedAt)}` : "", m.expiresAt ? `jusqu'au ${isoToFr(m.expiresAt)}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<li>
    <span class="kind">${esc(kindLabel[m.kind] ?? m.kind)}</span>
    <span>${esc(m.content)}</span>
    <span class="origin">${origin}${extra ? ` · ${extra}` : ""}</span>
  </li>`;
}

async function answerMemory(card, body) {
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/memories/${card.dataset.memory}`, body);
    if (editing === card.dataset.memory) editing = null;
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    const slot = card.querySelector(".fix .inline-error");
    if (slot) {
      slot.textContent = err.message;
      slot.hidden = false;
    } else {
      card.querySelector(":scope > .inline-error")?.remove();
      card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
  }
}

side.addEventListener("click", (e) => {
  const button = e.target.closest("[data-memory-action]");
  if (!button) return;
  const card = button.closest("[data-memory]");
  const action = button.dataset.memoryAction;
  const p = state.proposals.find((x) => String(x.id) === card.dataset.memory);
  if (action === "edit" && p) {
    editing = card.dataset.memory;
    card.querySelector(".card-actions").outerHTML = correctionForm(card, p);
    const field = card.querySelector("textarea");
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  } else if (action === "cancel") {
    editing = null;
    render();
  } else if (action === "confirm" || action === "ignore") {
    void answerMemory(card, { action });
  }
});

side.addEventListener("submit", (e) => {
  const form = e.target.closest(".fix");
  if (!form) return;
  e.preventDefault();
  const content = form.elements.content.value.trim();
  const error = form.querySelector(".inline-error");
  if (content.length < 3) {
    error.textContent = "Écris au moins 3 caractères.";
    error.hidden = false;
    form.elements.content.setAttribute("aria-invalid", "true");
    form.elements.content.focus();
    return;
  }
  form.elements.content.removeAttribute("aria-invalid");
  error.hidden = true;
  void answerMemory(form.closest("[data-memory]"), { action: "correct", content, expiresAt: form.elements.expiresAt.value || null });
});

const kindLabel = { fact: "fait", preference: "préférence", project: "projet", person: "personne", event: "événement", lesson: "leçon" };

side.addEventListener("click", (e) => {
  if (e.target.closest("#notify-toggle")) void toggleNotifications();
});

side.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-check-action]");
  if (!button) return;
  const card = button.closest("[data-check]");
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/tasks/${card.dataset.check}`, { action: button.dataset.checkAction });
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    card.querySelector(".inline-error")?.remove();
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

