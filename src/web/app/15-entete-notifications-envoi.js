// ── En-tête et bandeaux ─────────────────────────────────────────────────

function renderChrome() {
  const { clark, checks, approvals, proposals } = state;
  const engine = clark.engine;
  const notices = [];
  if (clark.demo) notices.push(`<p class="notice"><strong>Démo.</strong> Faux agent et données fictives : rien n'est réellement lu, écrit ni envoyé.</p>`);
  if (engine.problem) {
    // La commande éventuelle est isolée dans un bloc copiable.
    const [lead, command] = engine.problem.split(/ : (?=(?:CODEX_HOME|CLAUDE_CONFIG_DIR)=)/);
    notices.push(
      `<div class="notice warn"><strong>Clark ne peut pas répondre.</strong> ${esc(lead)}${command ? ` :<pre class="notice-cmd">${esc(command)}</pre>Puis relance <code>npm start</code>.` : ""}</div>`,
    );
  }
  $("#notices").innerHTML = notices.join("");

  // Le nombre d'éléments qui t'attendent, visible dans l'onglet même en arrière-plan.
  const titleCount = approvals.length + state.questions.length + checks.length + state.posts.length + (state.mails ?? []).length;

  const base = approvals.length || (state.mails ?? []).length ? "Clark · accord demandé" : state.questions.length ? "Clark · question pour toi" : "Clark";
  document.title = titleCount ? `(${titleCount}) ${base}` : base;
}

// ── Notifications (idée reprise d'Orca : être prévenu quand un agent finit ou attend) ──

const notifySupported = "Notification" in window;
let notifyOn = false;
try {
  notifyOn = notifySupported && Notification.permission === "granted" && localStorage.getItem("clark-notify") !== "off";
} catch {}
let known = null; // ce qui était déjà là au dernier rendu : seuls les nouveaux événements notifient

function eventsOf(s) {
  return {
    approvals: new Set(s.approvals.map((a) => a.id)),
    questions: new Set(s.questions.map((q) => q.id)),
    checks: new Set(s.checks.map((c) => c.id)),
    initiatives: new Set((s.initiatives ?? []).map((i) => i.id)),
    mails: new Set((s.mails ?? []).map((m) => m.id)),
    posts: new Set((s.posts ?? []).map((p) => p.id)),
    lastReply: s.messages.filter((m) => m.role === "clark").at(-1)?.id ?? 0,
  };
}

/** Lecteur d'écran : on annonce seulement ce qui vient d'arriver, pas tout le fil. */
function announceNew(before, now) {
  const lines = [];
  if (state.approvals.some((x) => !before.approvals.has(x.id))) lines.push("Clark demande ton accord.");
  if (state.questions.some((x) => !before.questions.has(x.id))) lines.push("Une question t'attend.");
  if ((state.mails ?? []).some((x) => !before.mails.has(x.id))) lines.push("Un mail attend ton accord.");
  if (now.lastReply > before.lastReply) lines.push("Clark a répondu.");
  if (lines.length) $("#announce").textContent = lines.join(" ");
}

/** Heures calmes, heure de Paris (même règle que le serveur). */
function quietNow(prefs) {
  if (!prefs.quiet.on) return false;
  const [h, m] = new Date().toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number);
  const t = h * 60 + m;
  const at = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
  const a = at(prefs.quiet.from);
  const b = at(prefs.quiet.to);
  return a === b ? false : a < b ? t >= a && t < b : t >= a || t < b;
}

function notifyNew() {
  const now = eventsOf(state);
  const before = known;
  known = now;
  if (before) announceNew(before, now);
  if (!before || !notifyOn || !document.hidden) return;
  // Réglages › Notifications : ce genre part-il sur le navigateur, et pas pendant les heures calmes ?
  const prefs = state.notify?.prefs;
  const wants = (kind) => {
    if (!prefs) return true;
    const route = kind === "alert" ? "health" : kind;
    if (!prefs.routes[route]?.browser) return false;
    return !(quietNow(prefs) && !((kind === "approval" && prefs.quiet.approvals) || (kind === "alert" && prefs.quiet.alerts !== false)));
  };
  const show = (title, body, tag, kind = "approval") => {
    if (!wants(kind)) return;
    try {
      const n = new Notification(title, { body: body.slice(0, 180), tag, icon: "/favicon.svg" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {}
  };
  for (const q of state.questions) if (!before.questions.has(q.id)) show(`${q.agent ? `Le ${q.agent}` : "Clark"} te pose une question`, q.question, `q${q.id}`);
  for (const a of state.approvals) if (!before.approvals.has(a.id)) show(`${a.agent ? `Le ${a.agent}` : "Clark"} demande ton accord`, a.summary, `a${a.id}`);
  for (const c of state.checks) if (!before.checks.has(c.id)) show("Tâche à vérifier", c.prompt, `c${c.id}`);
  for (const p of state.posts ?? []) if (!before.posts.has(p.id)) show("Contenu à valider", p.title, `p${p.id}`);
  for (const m of state.mails ?? []) if (!before.mails.has(m.id)) show(`Mail à valider pour ${m.to}`, m.subject, `m${m.id}`);
  for (const i of state.initiatives ?? []) if (!before.initiatives.has(i.id)) show(`Clark te propose : ${i.title}`, i.why, `i${i.id}`, "proposals");
  if (now.lastReply > before.lastReply) {
    const m = state.messages.find((x) => x.id === now.lastReply);
    if (m) show("Clark a répondu", m.text.replace(/[*`]/g, ""), "reply", "reply");
  }
}

async function toggleNotifications() {
  if (!notifySupported) return;
  if (notifyOn) {
    notifyOn = false;
    try {
      localStorage.setItem("clark-notify", "off");
    } catch {}
  } else {
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    notifyOn = permission === "granted";
    try {
      localStorage.setItem("clark-notify", notifyOn ? "on" : "off");
    } catch {}
  }
  render();
}

function notifyControl() {
  if (!notifySupported) return `<p class="channels">Notifications : non prises en charge par ce navigateur</p>`;
  if (Notification.permission === "denied")
    return `<p class="channels">Notifications : bloquées par le navigateur (à autoriser dans les réglages du site)</p>`;
  return `<p class="channels">Notifications du navigateur : ${notifyOn ? "activées" : "désactivées"} <button type="button" class="link" id="notify-toggle">${notifyOn ? "Désactiver" : "Activer"}</button></p>`;
}

function render() {
  renderChrome();
  renderMic();
  renderMascot();
  renderBrowserLive();
  renderCommandItems();
  renderProjectOptions();
  renderThread();
  renderThreads();
  renderFoot();
  renderTermCount();
  renderIdeasCount();
  renderHealthCount();
  renderMacOnly();
  renderCalendarCount();
  renderView();
  if (view === "inbox") scheduleHistory();
  notifyNew();
  firstRender = false;
}

// Les délais des validations se mettent à jour sans attendre un changement.
setInterval(() => {
  document.querySelectorAll("[data-expires]").forEach((el) => (el.textContent = expiresIn(Number(el.dataset.expires))));
}, 30_000);

// Le logo : Clark lui-même.
$(".mark").outerHTML = `<span class="mark" aria-hidden="true">${sprite("clark", { size: 20 })}</span>`;

// ── Envoi ───────────────────────────────────────────────────────────────

const autosize = () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight + 2, 220)}px`;
};

// « / » au début du message : les commandes perso, dans l'Autocomplete de ui-sdk (flèches,
// Entrée pour choisir, Échap pour fermer, annoncé aux lecteurs d'écran). Toutes commencent
// par « / » : un message ordinaire n'ouvre jamais la liste.
let commandItemsKey = "";
function renderCommandItems() {
  const list = $("#command-list");
  const commands = state?.commands ?? [];
  const key = commands.map((c) => `${c.name}|${c.description}|${c.mode}`).join("\n");
  if (!list || key === commandItemsKey) return;
  commandItemsKey = key;
  list.innerHTML = commands
    .map(
      (c) => `<ui-autocomplete-item value="/${esc(c.name)} " label="/${esc(c.name)}">
        <code>/${esc(c.name)}</code> <span data-slot="hint">${esc(c.description || modeNames[c.mode])}</span>
      </ui-autocomplete-item>`,
    )
    .join("");
}
// Sans suggestion qui correspond, le composant reste « ouvert » mais vide : ça ne compte pas.
const commandListOpen = () =>
  Boolean($("#command-ac ui-autocomplete-content")?.hasAttribute("data-open") && $("#command-list ui-autocomplete-item:not([hidden])"));

input.addEventListener("input", () => {
  autosize();
  send.disabled = !input.value.trim();
  sendError.hidden = true;
});

input.addEventListener("keydown", (e) => {
  // Liste des commandes ouverte : Entrée choisit la suggestion, elle n'envoie pas le message.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.defaultPrevented && !commandListOpen()) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

let sending = false;
$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = input.value;
  const text = raw.trim();
  if (!text || sending) return; // Entrée maintenue ou double clic : un seul envoi
  sending = true;
  send.disabled = true;
  try {
    const mode = $("#mode").value;
    if (mode === "dev" || mode === "dev-split" || mode === "dev-compare" || mode === "dev-binome") {
      const projectId = Number($("#dev-project").value);
      if (!projectId) throw new Error("Ajoute d'abord un projet dans Réglages › Projets dev.");
      const compare = mode === "dev-compare" ? comparePairs().find((x) => x.value === $("#compare-pair").value)?.sides : undefined;
      if (mode === "dev-compare" && !compare) throw new Error("Choisis les deux agents à comparer.");
      const autopilot = mode !== "dev-compare" && $("#dev-autopilot").checked;
      const r = await post("/api/dev/tasks", { projectId, instruction: text, engine: "", split: mode === "dev-split", binome: mode === "dev-binome", autopilot, ...(compare ? { compare } : {}) });
      location.hash = mode === "dev-split" || mode === "dev-binome" ? `#groupe/${r.id}` : `#dev/${r.id}`;
    } else {
      // Écrire dans une conversation passée la reprend : elle redevient l'ouverte, avec son fil.
      if (pastId) {
        await post(`/api/conversations/${pastId}/open`, {});
        location.hash = "#conversation";
      }
      const r = await post("/api/messages", { text, mode, ...(attachments.length ? { attachments: attachments.map((a) => a.path) } : {}) });
      attachments = [];
      renderAttachments();
      if (r.kind === "goal" && r.id) location.hash = `#objectif/${r.id}`;
    }
    // Objectif ou tâche dev : une demande à part ; on revient au message simple.
    if (mode !== "chat" && mode !== "team") setMode("chat");
    // Ce qui a été tapé pendant l'envoi reste dans le champ.
    if (input.value === raw) input.value = "";
    autosize();
    thread.scrollTop = thread.scrollHeight;
  } catch (err) {
    sendError.textContent = `Message non envoyé : ${err.message}`;
    sendError.hidden = false;
  } finally {
    sending = false;
    send.disabled = !input.value.trim();
  }
});

// Dans une conversation avec un agent : en commencer une autre avec lui.
$("#head-new").addEventListener("click", async (e) => {
  const agent = e.currentTarget.dataset.agent || null;
  try {
    if (pastId) location.hash = "#conversation";
    await post("/api/conversation/new", { agent });
    location.hash = "#conversation";
    input.focus();
  } catch (err) {
    sendError.textContent = `Nouvelle conversation impossible : ${err.message}`;
    sendError.hidden = false;
  }
});

$("#conv-search").addEventListener("input", (e) => {
  listQuery = e.target.value;
  if (state) renderThreads();
});

// La conversation en cours n'est pas perdue : elle reste dans la barre de gauche, prête à être reprise.
$("#new-conversation").addEventListener("click", async () => {
  try {
    await post("/api/conversation/new", {});
    location.hash = "#conversation";
    input.focus();
  } catch (err) {
    sendError.textContent = `Nouvelle conversation impossible : ${err.message}`;
    sendError.hidden = false;
  }
});

// Le choix du projet n'apparaît que pour une tâche dev.
const MODE_NAMES = { team: "Équipe", goal: "Objectif", dev: "Tâche de code", "dev-split": "Code en parallèle", "dev-compare": "Comparer deux agents", "dev-binome": "Binôme Claude + Codex" };
// Tâche de code en cours de saisie : Clark prépare la copie du projet pendant que tu tapes.
const prewarmAt = new Map();
function prewarm() {
  if (!$("#mode").value.startsWith("dev")) return;
  const id = Number($("#dev-project").value);
  if (!id || Date.now() - (prewarmAt.get(id) ?? 0) < 4 * 60_000) return;
  prewarmAt.set(id, Date.now());
  void post("/api/dev/prewarm", { projectId: id }).catch(() => prewarmAt.delete(id));
}
$("#dev-project").addEventListener("change", prewarm);
input.addEventListener("input", () => {
  if (input.value.length > 8) prewarm();
});

function setMode(mode) {
  $("#mode").value = mode;
  $("#dev-project").hidden = !mode.startsWith("dev");
  $("#compare-pair").hidden = mode !== "dev-compare";
  // Pilote automatique : pour une tâche de code, du code en parallèle ou un binôme (pas une comparaison, où tu choisis).
  $("#autopilot-chip").hidden = !mode.startsWith("dev") || mode === "dev-compare";
  $("#mode-chip").hidden = mode === "chat";
  $("#mode-chip-label").textContent = MODE_NAMES[mode] ?? "";
  input.placeholder = mode === "dev-binome" ? "Une longue tâche : Claude planifie, Codex relit le plan ; chacun écrit et relit l'autre" : mode.startsWith("dev") ? "Consigne pour l'agent de code, ou #12 pour une issue GitHub" : mode === "goal" ? "L'objectif à atteindre" : `Écrire à ${state ? contactOf(threadAgent).name : "Clark"}`;
}
$("#mode-menu").addEventListener("action", (e) => {
  const value = String(e.detail.value);
  if (value === "attach-file" || value === "attach-folder") return void attachFromMac(value === "attach-folder" ? "folder" : "file");
  setMode(value);
  setTimeout(() => input.focus(), 0);
});

// ── Pièces jointes : un fichier ou un dossier du Mac, choisi dans la fenêtre du Finder ──
let attachments = [];
const baseName = (p) => p.replace(/\/$/, "").split("/").pop() || p;

function renderAttachments() {
  const row = $("#attach-row");
  row.hidden = !attachments.length;
  row.innerHTML = attachments
    .map(
      (a, i) => `<span class="attach-chip" title="${esc(a.path)}">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">${a.kind === "folder" ? '<path d="M2 4.5h4l1.3 1.5H14v6.5H2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none" />' : '<path d="M4 2h5l3 3v9H4zM9 2v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none" />'}</svg>
        <span class="attach-name">${esc(baseName(a.path))}</span>
        <button type="button" class="attach-x" data-attach-remove="${i}" aria-label="Retirer ${esc(baseName(a.path))}"><svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg></button>
      </span>`,
    )
    .join("");
}

async function attachFromMac(kind) {
  sendError.hidden = true;
  if (attachments.length >= 5) {
    sendError.textContent = "5 pièces jointes au plus.";
    sendError.hidden = false;
    return;
  }
  try {
    const r = await post("/api/pick", { kind });
    if (r.path && !attachments.some((a) => a.path === r.path)) attachments.push({ path: r.path, kind });
    renderAttachments();
  } catch (err) {
    sendError.textContent = err.message;
    sendError.hidden = false;
  }
  input.focus();
}

$("#attach-row").addEventListener("click", (e) => {
  const x = e.target.closest("[data-attach-remove]");
  if (!x) return;
  attachments.splice(Number(x.dataset.attachRemove), 1);
  renderAttachments();
  input.focus();
});
$("#mode-chip-x").addEventListener("click", () => {
  setMode("chat");
  input.focus();
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-start-mode]");
  if (!b) return;
  setMode(b.dataset.startMode);
  input.focus();
});



/** Hors Mac (un VPS) : pas de fenêtre de choix de fichier, ses entrées disparaissent. */
function renderMacOnly() {
  const mac = state?.system?.mac !== false;
  for (const el of document.querySelectorAll('[value="attach-file"], [value="attach-folder"], [data-pick-folder]')) el.hidden = !mac;
}
