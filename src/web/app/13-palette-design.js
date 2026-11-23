// ── Palette ⌘K : aller à un fil, une rubrique des réglages, ou lancer une action ──
// Command de ui-sdk dans un Dialog : le filtre, les flèches et Entrée viennent du composant ;
// la liste est refaite à chaque ouverture, depuis l'état du moment.

const SETTINGS_KEYWORDS = {
  general: "apparence thème sombre clair mascotte personnalité ton voix dictée whisper vocabulaire notifications telegram imessage heures calmes éveillé",
  moteurs: "claude codex modèle effort quota",
  connexions: "google gmail agenda telegram imessage navigateur mcp serveur outil plugins catalogue",
  projets: "dépôt git worktree copie aperçu design",
  automatisations: "planifier cron chaque jour",
  avance: "veille brief dépense budget bac à sable commandes slash skills mémoire souvenirs publier sauvegarde exporter importer vps",
};

function paletteItem(value, label, meta = "", keywords = "") {
  // La ligne grise (projet, état, description d'une commande) se cherche aussi.
  keywords = `${keywords} ${meta}`.trim();
  return `<ui-command-item value="${esc(value)}" label="${esc(label)}"${keywords ? ` keywords="${esc(keywords.replace(/[\s,]+/g, ","))}"` : ""}>
    <ui-command-item-text>${esc(label)}</ui-command-item-text>${meta ? `<span class="palette-meta">${esc(meta)}</span>` : ""}
  </ui-command-item>`;
}

function paletteGroup(label, items) {
  return items.length ? `<ui-command-group><ui-command-group-label>${esc(label)}</ui-command-group-label>${items.join("")}</ui-command-group>` : "";
}

function renderPalette() {
  if (!state) return;
  const dev = state.dev ?? { tasks: [], groups: [] };
  const waiting = waitingCount();
  const threads = [
    paletteItem("go:#idees", "Idées", "", "idées projets scroll tour inspiration creuser"),
    paletteItem("go:#calendrier", "Calendrier", "", "calendrier veilles veille du soir comptes rendus automatisations jour"),
    paletteItem("go:#sante", "Santé", "", "santé état erreurs quotas sauvegarde version disque journal"),
    paletteItem("go:#activite", "Activité", waiting ? `${waiting} t'attendent` : "", "à toi inbox accords questions historique relire"),
    paletteItem("go:#conversation", "Conversation", "", "chat message"),
  ];
  const work = [];
  const byDate = (a, b) => String(b.updated ?? b.at).localeCompare(String(a.updated ?? a.at));
  for (const g of [...(state.goals ?? [])].sort(byDate)) work.push(paletteItem(`go:#objectif/${g.id}`, g.objective, `objectif · ${goalStatus[g.status] ?? g.status}`, "objectif"));
  for (const g of [...(dev.groups ?? [])].sort(byDate)) work.push(paletteItem(`go:#groupe/${g.id}`, g.title, `groupe · ${g.tasks.length} tâches`, "dev parallèle"));
  for (const t of [...dev.tasks].sort(byDate).slice(0, 60)) work.push(paletteItem(`go:#dev/${t.id}`, t.title, `${t.project} · ${devStatus[t.status] ?? t.status}`, `dev ${t.branch ?? ""}`));
  const actions = [
    paletteItem("act:new", "Nouvelle conversation", "", "oublier recommencer"),
    paletteItem("act:dev", "Nouvelle tâche dev", "", "code agent projet"),
    paletteItem("act:dev-split", "Tâche dev en parallèle", "", "groupe plusieurs agents"),
    paletteItem("act:dev-compare", "Comparer deux agents", "", "claude codex effort versions"),
    paletteItem("act:goal", "Nouvel objectif", "", "plusieurs tours"),
    paletteItem("act:team", "Demander à l'équipe", "", "agents spécialisés"),
    ...($("#mic").hidden ? [] : [paletteItem("act:dictate", "Dicter un message", "", "micro voix")]),
    paletteItem("act:heartbeat", "Faire un tour de veille", "", "heartbeat vérifier"),
    paletteItem("act:shortcuts", "Raccourcis clavier", "?", "touches aide"),
  ];
  const settings = SETTINGS_TABS.map(([key, label]) => paletteItem(`go:#reglages/${key}`, label, "réglages", `réglages ${SETTINGS_KEYWORDS[key] ?? ""}`));
  const commands = (state.commands ?? []).map((c) => paletteItem(`cmd:${c.name}`, `/${c.name}`, c.description || modeNames[c.mode] || "", "commande"));
  $("#palette-list").innerHTML = [
    paletteGroup("Fils", threads),
    paletteGroup("En cours et récents", work),
    paletteGroup("Actions", actions),
    paletteGroup("Commandes", commands),
    paletteGroup("Réglages", settings),
  ].join("");
}

const palette = $("#palette");
// Même règle que les autres recherches : chaque mot, dans n'importe quel ordre, sans accents.
$("#palette-command").filter = (item, query) => matchesQuery(`${item.label ?? ""} ${(item.keywords ?? []).join(" ")}`, query);
function openPalette() {
  renderPalette();
  $("#palette-command").query = "";
  $("#app").removeAttribute("data-drawer");
  palette.open = true;
}
$("#palette-open").addEventListener("click", openPalette);
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $(".side-search-keys").textContent = "Ctrl K";
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (palette.open) palette.open = false;
    else openPalette();
  }
});

// La fenêtre rend le focus à son bouton en se fermant : l'action passe juste après, pour garder le sien.
$("#palette-command").addEventListener("action", (e) => {
  const [kind, ...rest] = String(e.detail.value).split(":");
  palette.open = false;
  setTimeout(() => void runPalette(kind, rest.join(":")), 0);
});

async function runPalette(kind, arg) {
  if (kind === "go") {
    location.hash = arg;
    // La vue s'affiche au changement d'adresse : on place le focus ensuite.
    setTimeout(() => (arg.startsWith("#reglages") ? $("#settings-search") : arg === "#conversation" ? input : $(".view:not([hidden]) .view-title"))?.focus(), 50);
    return;
  }
  if (kind === "cmd") {
    location.hash = "#conversation";
    setMode("chat");
    input.value = `/${arg} `;
    input.dispatchEvent(new Event("input"));
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 50);
    return;
  }
  if (arg === "new") return void $("#new-conversation").click();
  if (arg === "shortcuts") return void $("#shortcuts").showModal();
  if (arg === "heartbeat") {
    try {
      await post("/api/heartbeat/run", {});
      $("#announce").textContent = "Tour de veille lancé.";
      mascotSay("Je fais un tour, je te dis s'il y a quelque chose.");
    } catch (err) {
      sendError.textContent = `Tour de veille impossible : ${err.message}`;
      sendError.hidden = false;
    }
    return;
  }
  location.hash = "#conversation";
  if (["dev", "dev-split", "dev-compare", "goal", "team"].includes(arg)) setMode(arg);
  setTimeout(() => (arg === "dictate" ? $("#mic").click() : input.focus()), 50);
}

// ── Mode design : l'aperçu d'une copie, et un élément choisi joint à la retouche ──
// L'aperçu vient d'une autre origine (le serveur d'aperçu de Clark) : il ne parle à l'interface
// que par messages, vérifiés (origine et cadre). Ce qu'il envoie est de la donnée.

let designPick = null; // { taskId, selector, tag, text, html, css, page, width, shot }
let designPicking = false;
let designWidth = 1280;
let designKey = "";
const DESIGN_HEIGHT = 640;

const designFrame = () => $("#design .design-frame");

function renderDesignPick(d) {
  const shot = d.shot?.file
    ? `<img class="design-shot" src="/api/dev/design/${d.taskId}/${esc(d.shot.file)}" alt="Capture de l'élément choisi" />`
    : d.shot?.error
      ? `<span class="inline-error">${esc(d.shot.error)}</span>`
      : `<span class="quiet">Capture…</span>`;
  return `<div class="design-pick" role="group" aria-label="Élément joint à la retouche">
    <div class="design-pick-shot">${shot}</div>
    <div class="design-pick-what">
      <p><code>${esc(d.selector)}</code></p>
      <p class="quiet">&lt;${esc(d.tag)}&gt;${d.text ? ` · ${esc(d.text.slice(0, 80))}` : ""} · ${Object.keys(d.css).length} styles · page ${esc(d.page)}, ${d.width} px</p>
    </div>
    <button type="button" class="link" data-design-unpick>Retirer</button>
  </div>`;
}

function fitDesign() {
  const stage = $("#design .design-stage");
  const frame = designFrame();
  if (!stage || !frame) return;
  const scale = Math.min(1, stage.clientWidth / designWidth);
  frame.style.width = `${designWidth}px`;
  frame.style.height = `${Math.round(DESIGN_HEIGHT / scale)}px`;
  frame.style.transform = scale < 1 ? `scale(${scale})` : "";
  stage.style.height = `${DESIGN_HEIGHT}px`;
}
new ResizeObserver(() => fitDesign()).observe($("#design"));

function setPicking(on) {
  const p = state.dev?.preview;
  const frame = designFrame();
  designPicking = Boolean(on && p && frame);
  if (p && frame) frame.contentWindow.postMessage({ type: "clark-pick", on: designPicking }, p.origin);
  const b = $("#design [data-design-pick]");
  if (b) {
    b.setAttribute("aria-pressed", String(designPicking));
    b.textContent = designPicking ? "Clique un élément…" : "Choisir un élément";
  }
  const hint = $("#design-hint");
  if (hint) hint.textContent = designPicking ? "Clique un élément dans l'aperçu ; Échap pour annuler." : "Choisis un élément : son HTML, ses styles et sa capture iront avec ta retouche.";
}

function renderDesign() {
  const host = $("#design");
  const p = state?.dev?.preview;
  const show = view === "detail" && detail?.kind === "dev" && p && p.taskId === detail.id;
  if (!show) {
    if (designKey) host.innerHTML = "";
    designKey = "";
    designPicking = false;
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const key = `${p.taskId}|${p.status}|${p.url}`;
  if (key === designKey) return;
  designKey = key;
  designPicking = false;
  const ready = p.status === "ready";
  host.innerHTML = `<section class="card design" aria-labelledby="design-title">
    <div class="design-bar">
      <p class="design-title" id="design-title">Aperçu de la copie #${p.taskId}${p.kind === "server" ? " · serveur de dev" : ""}</p>
      ${
        ready
          ? `<button type="button" class="btn secondary" data-design-pick aria-pressed="false">Choisir un élément</button>
        <label class="visually-hidden" for="design-width">Largeur de l'aperçu</label>
        <select id="design-width" class="chip-select" data-design-width autocomplete="off">
          ${[[1280, "Ordinateur · 1280"], [768, "Tablette · 768"], [390, "Mobile · 390"]].map(([w, l]) => `<option value="${w}"${w === designWidth ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        <button type="button" class="btn ghost" data-design-reload>Recharger</button>
        <a class="link" href="${esc(p.url)}" target="_blank" rel="noreferrer noopener">Ouvrir dans un onglet</a>`
          : ""
      }
      <button type="button" class="btn ghost" data-design-close>Fermer</button>
    </div>
    ${
      p.status === "starting"
        ? `<p class="quiet">Démarrage du serveur de dev…</p>`
        : p.status === "failed"
          ? `<p class="goal-reason">${esc(p.error ?? "L'aperçu a échoué.")}</p>${p.log ? `<pre class="command-prompt">${esc(p.log)}</pre>` : ""}`
          : `<div class="design-stage"><iframe class="design-frame" src="${esc(p.url)}" title="Aperçu de la copie de la tâche #${p.taskId}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups"></iframe></div>
        <p class="quiet design-hint" id="design-hint">Choisis un élément : son HTML, ses styles et sa capture iront avec ta retouche.</p>`
    }
  </section>`;
  fitDesign();
}

window.addEventListener("message", (e) => {
  const p = state?.dev?.preview;
  const frame = designFrame();
  if (!p || !frame || e.source !== frame.contentWindow || (e.origin !== p.origin && e.origin !== p.origin.replace("127.0.0.1", "localhost"))) return;
  const d = e.data ?? {};
  if (d.type === "clark-preview-ready") {
    if (designPicking) setPicking(true);
    return;
  }
  if (d.type === "clark-pick-cancel") return setPicking(false);
  if (d.type !== "clark-picked" || typeof d.selector !== "string") return;
  const css = {};
  for (const [k, v] of Object.entries(d.css && typeof d.css === "object" ? d.css : {}).slice(0, 40)) if (/^[a-z-]{1,40}$/.test(k)) css[k] = String(v).slice(0, 300);
  const taskId = p.taskId;
  designPick = {
    taskId,
    selector: d.selector.slice(0, 500),
    tag: String(d.tag ?? "").slice(0, 20),
    text: String(d.text ?? "").slice(0, 160),
    html: String(d.html ?? "").slice(0, 6000),
    css,
    page: String(d.page ?? "/").slice(0, 300),
    width: Math.round(Number(d.width) || designWidth),
    shot: null,
  };
  const pick = designPick;
  setPicking(false);
  renderView();
  $(`#dev-retouch-${taskId}`)?.focus();
  $("#announce").textContent = `Élément choisi : ${pick.tag}. Écris la retouche.`;
  post(`/api/dev/tasks/${taskId}`, { action: "design-shot", selector: pick.selector, width: pick.width, page: pick.page })
    .then((r) => (pick.shot = { file: r.file }))
    .catch((err) => (pick.shot = { error: err.message }))
    .finally(() => designPick === pick && renderView());
});

document.addEventListener("change", (e) => {
  if (!e.target.matches?.("[data-design-width]")) return;
  designWidth = Number(e.target.value) || 1280;
  fitDesign();
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-design-open], [data-design-pick], [data-design-reload], [data-design-close], [data-design-unpick]");
  if (!b) return;
  const p = state.dev?.preview;
  if (b.matches("[data-design-pick]")) return setPicking(!designPicking);
  if (b.matches("[data-design-reload]")) {
    const frame = designFrame();
    if (frame) frame.src = p.url;
    return;
  }
  if (b.matches("[data-design-unpick]")) {
    designPick = null;
    renderView();
    return;
  }
  if (b.matches("[data-design-close]")) {
    await post(`/api/dev/tasks/${p.taskId}`, { action: "preview-close" }).catch(() => {});
    return;
  }
  const card = b.closest("[data-dev]");
  b.disabled = true;
  b.textContent = "Ouverture…";
  try {
    await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "preview" });
    $("#design").scrollIntoView?.({ block: "start" });
  } catch (err) {
    b.disabled = false;
    b.textContent = "Aperçu";
    b.insertAdjacentHTML("afterend", ` <span class="inline-error" role="alert">${esc(err.message)}</span>`);
  }
});

// « Garder celle-ci » : cette version est acceptée, l'autre est jetée (arrêtée d'abord si elle travaille).
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dev-keep]");
  if (!b) return;
  const id = Number(b.dataset.devKeep);
  const t = allDevTasks().find((x) => x.id === id);
  const o = t && allDevTasks().find((x) => x.id === t.compareWith);
  const busy = o && ["working", "preparing", "waiting"].includes(o.status);
  if (!(await ask(`Garder #${id} (${t ? sideLabel(t) : ""}) ?`, `Elle est acceptée : commit sur sa branche. L'autre version${o ? ` (#${o.id})` : ""} est jetée, avec sa copie${busy ? ", après avoir arrêté son agent" : ""}.`, "Garder celle-ci"))) return;
  document.querySelectorAll(`[data-dev-keep]`).forEach((x) => (x.disabled = true));
  try {
    await post(`/api/dev/tasks/${id}`, { action: "keep" });
    if (detail?.kind === "dev" && detail.id !== id) location.hash = `#dev/${id}`;
  } catch (err) {
    document.querySelectorAll(`[data-dev-keep]`).forEach((x) => (x.disabled = false));
    b.insertAdjacentHTML("afterend", ` <span class="inline-error" role="alert">${esc(err.message)}</span>`);
  }
});

