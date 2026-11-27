// ── Réglages : une page à rubriques ──

const SETTINGS_TABS = [
  ["general", "Général", ["appearance", "autonomy", "personality", "voice", "notify"]],
  ["moteurs", "Moteurs", ["engines"]],
  ["connexions", "Connexions", ["connections", "mcp", "plugins"]],
  ["projets", "Projets dev", ["projects"]],
  ["automatisations", "Automatisations", ["auto"]],
  ["avance", "Avancé", ["general", "commands", "skills", "memory", "publish", "budget", "backup"]],
];
// Les anciennes adresses mènent à la rubrique qui contient maintenant la section.
const SETTINGS_ALIASES = { notifications: "general", voix: "general", mcp: "connexions", plugins: "connexions", commandes: "avance", skills: "avance", memoire: "avance", sauvegarde: "avance" };
let settingsTab = "general";
let settingsQuery = "";

function renderSettingsPage() {
  for (const id of [...mcpFirstTest]) if ((state.mcp ?? []).find((x) => x.id === id)?.check) mcpFirstTest.delete(id);
  const tab = SETTINGS_TABS.find((t) => t[0] === settingsTab) ?? SETTINGS_TABS[0];
  $("#settings-tabs").innerHTML = SETTINGS_TABS.map(
    ([key, label]) => `<a href="#reglages/${key}"${key === tab[0] ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("");
  const root = $("#settings");
  const typing = [...root.querySelectorAll("[data-command-run]")].filter((f) => f.elements.args.value || f.contains(document.activeElement));
  const editing = document.activeElement?.closest?.("[data-setting-row], [data-project-settings]");
  // Le rendu montre d'abord toutes les rubriques puis masque celles des autres onglets : sans
  // ça, la page saute en haut à chaque mise à jour (ex. après le choix d'une voix).
  const scroller = $("#view-settings");
  const scrolled = scroller.scrollTop;
  swap(root, buildGeneral() + buildAutonomy() + buildNotify() + buildPlugins() + buildSettings() + buildProjects() + buildBackup(), [
    // Un réglage en cours de saisie, un formulaire de projet ouvert et modifié : gardés tels quels.
    ...(editing?.dataset.settingRow ? [`[data-setting-row="${editing.dataset.settingRow}"]`] : []),
    ...[...root.querySelectorAll("[data-project-settings][data-dirty]")].map((f) => `[data-project-settings="${f.dataset.projectSettings}"]`),
    ...(importPlan ? ["#import-box"] : []),
    ...engineKeep(root),
    ...(mcpFormOpen ? ["#mcp-form"] : []),
    ...(autoFormOpen ? ["#auto-form"] : []),
    // Une automatisation dont le menu « … » est ouvert : sa carte reste, sinon le menu se ferme sous le doigt.
    ...[...root.querySelectorAll("[data-automation]:has([data-auto-more] [data-open])")].map((c) => `[data-automation="${c.dataset.automation}"]`),
    ...(commandFormOpen ? ["#command-form"] : []),
    ...(projectFormOpen ? ["#project-form"] : []),
    ...(personalityDirty ? ["#personality-form"] : []),
    // La relecture d'un plugin garde ses dépliants ouverts ; le formulaire garde ce que tu tapes.
    ...(pluginReview && !pluginBusy && !pluginError ? [`#plugin-review[data-token="${pluginReview.token}"]`] : []),
    ...(!pluginReview && !pluginBusy ? ["#plugin-form"] : []),
    ...typing.map((f) => `[data-command="${f.closest("[data-command]").dataset.command}"] [data-command-run]`),
  ]);
  for (const id of openAutoRuns) root.querySelector(`[data-automation="${id}"] .auto-runs`)?.setAttribute("open", "");
  applySettingsFilter(tab);
  scroller.scrollTop = scrolled;
}

// L'historique d'une automatisation reste ouvert d'un rendu à l'autre.
const openAutoRuns = new Set();
side.addEventListener(
  "toggle",
  (e) => {
    const d = e.target.closest?.(".auto-runs");
    if (!d) return;
    const id = d.closest("[data-automation]").dataset.automation;
    if (d.open) openAutoRuns.add(id);
    else openAutoRuns.delete(id);
  },
  true,
);

/** Les mots qu'on tape pour une section sans qu'ils soient écrits dedans. */
const SECTION_KEYWORDS = {
  appearance: "theme sombre clair couleur mode nuit mascotte",
  autonomy: "autonomie autonome decider seul decisions veille agir lancer equipe objectif souvenirs plafond resume soir",
  general: "veille heartbeat brief matin parallele agents silencieux sandbox bac a sable moteur principal",
  notify: "notifications alertes heures calmes silence telegram imessage",
  engines: "claude codex modele effort quota limite abonnement",
  connections: "google gmail agenda calendrier telegram imessage navigateur",
  mcp: "serveur outil mcp",
  plugins: "plugin catalogue marketplace extension",
  personality: "personnalite ton caractere style",
  voice: "voix dictee micro whisper lecture vocale",
  commands: "commande slash raccourci",
  skills: "skill competence",
  auto: "automatisation planifier cron horaire chaque jour",
  memory: "memoire souvenirs oublier",
  publish: "publier publication brouillon reseaux",
  budget: "budget depenses cout argent prix plafond cle api",
  projects: "projet depot git worktree copie apercu design tests",
  backup: "sauvegarde exporter importer configuration vps",
};

/** Recherche : toutes les rubriques, seulement ce qui correspond ; sinon la rubrique choisie. */
function applySettingsFilter(tab = SETTINGS_TABS.find((t) => t[0] === settingsTab) ?? SETTINGS_TABS[0]) {
  const root = $("#settings");
  const q = settingsQuery.trim();
  $("#settings-tabs").classList.toggle("searching", Boolean(q));
  let found = 0;
  for (const sec of root.querySelectorAll(":scope > section.block")) {
    if (!q) {
      sec.hidden = !tab[2].includes((sec.getAttribute("aria-labelledby") ?? "").slice(2));
      sec.querySelectorAll("[data-setting-row]").forEach((r) => (r.hidden = false));
      continue;
    }
    const rows = [...sec.querySelectorAll("[data-setting-row]")];
    const key = (sec.getAttribute("aria-labelledby") ?? "").slice(2);
    let hit = matchesQuery(`${sec.querySelector(".block-title")?.textContent ?? ""} ${SECTION_KEYWORDS[key] ?? ""}`, q);
    if (rows.length && !hit) {
      for (const r of rows) r.hidden = !matchesQuery(r.textContent, q);
      hit = rows.some((r) => !r.hidden);
    } else {
      rows.forEach((r) => (r.hidden = false));
      hit = hit || matchesQuery(sec.textContent, q);
    }
    sec.hidden = !hit;
    if (hit) found++;
  }
  root.querySelector(".settings-none")?.remove();
  if (q && !found) root.insertAdjacentHTML("afterbegin", `<p class="empty-note settings-none">Aucun réglage ne correspond à « ${esc(settingsQuery)} ».</p>`);
}

$("#settings-search").addEventListener("input", (e) => {
  settingsQuery = e.target.value;
  applySettingsFilter();
});

// ── Réglages › Général : apparence et réglages (sans secrets) ──

const readTheme = () => {
  try {
    return localStorage.getItem("clark.theme") || "system";
  } catch {
    return "system";
  }
};

function settingControl(x) {
  const id = `set-${x.key}`;
  if (x.type === "bool")
    return `<label class="radio"><input type="checkbox" id="${id}" data-setting="${x.key}"${x.value === "on" ? " checked" : ""} /> <span>Activé</span></label>`;
  if (x.type === "select")
    return `<select id="${id}" data-setting="${x.key}">${x.options.map(([k, l]) => `<option value="${esc(k)}"${k === x.value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  if (x.type === "roles") {
    const current = Object.fromEntries((x.value || "").split(",").filter(Boolean).map((p) => p.split("=").map((v) => v.trim())));
    return `<div class="roles-grid" id="${id}" data-setting-roles="${x.key}">${Object.keys(roleNames)
      .map(
        (r) => `<label><span>${esc(roleNames[r] ?? r)}</span><select data-role="${r}"><option value="">Moteur principal</option><option value="claude"${current[r] === "claude" ? " selected" : ""}>Claude</option><option value="codex"${current[r] === "codex" ? " selected" : ""}>Codex</option></select></label>`,
      )
      .join("")}</div>`;
  }
  return `<input id="${id}" data-setting="${x.key}" type="${x.type === "hour" ? "text" : "number"}" inputmode="numeric" value="${esc(x.value)}"${x.min !== undefined ? ` min="${x.min}"` : ""}${x.max !== undefined ? ` max="${x.max}"` : ""}${x.type === "number" ? ' step="0.5"' : ""} />`;
}

/** Réglages › Général › Autonomie : ce que Clark peut décider seul, type par type. */
function buildAutonomy() {
  const list = (state.settings ?? []).filter((x) => x.section === "Autonomie");
  if (!list.length) return "";
  const choice = (x) => `<div class="set-row auto-row" data-setting-row="${x.key}">
      <fieldset class="voice-modes"><legend>${esc(x.label)}</legend>
        ${x.options.map(([k, l]) => `<label class="radio"><input type="radio" name="set-${x.key}" value="${esc(k)}" data-setting="${x.key}"${k === x.value ? " checked" : ""} /> <span>${esc(l)}</span></label>`).join("")}
      </fieldset>
      <p class="quiet field-hint">${esc(x.hint)}</p>
      <p class="inline-error" role="alert" hidden></p>
    </div>`;
  const plain = (x) => `<div class="set-row" data-setting-row="${x.key}">
      <label for="set-${x.key}">${esc(x.label)}</label>
      ${settingControl(x)}
      <p class="quiet field-hint">${esc(x.hint)}</p>
      <p class="inline-error" role="alert" hidden></p>
    </div>`;
  const a = state.autonomy;
  return section(
    "autonomy",
    "Autonomie",
    a ? `${a.today}/${a.max} aujourd'hui` : "",
    `<p class="quiet">Ce que Clark peut décider seul. Quand il le fait, il te dit pourquoi dans la conversation, le note dans Activité avec un bouton Annuler, et te fait un résumé le soir.</p>
    <div class="card auto-form set-group">${list.filter((x) => x.type === "select").map(choice).join("")}</div>
    <div class="card auto-form set-group"><p class="card-title">Limites</p>${list.filter((x) => x.type !== "select").map(plain).join("")}
      <p class="quiet">Toujours demandé, quel que soit le réglage : la nuit (22 h – 8 h), tout envoi vers l'extérieur (mail, message, formulaire, publication), une correction de souvenir. Jamais : argent, mots de passe, suppression définitive.</p>
    </div>`,
  );
}

function buildGeneral() {
  const theme = readTheme();
  let html = section(
    "appearance",
    "Apparence",
    "",
    `<div class="card auto-form" data-setting-row="theme"><fieldset class="voice-modes"><legend>Thème</legend>${[
      ["system", "Comme le système"],
      ["light", "Clair"],
      ["dark", "Sombre"],
    ]
      .map(([k, l]) => `<label class="radio"><input type="radio" name="theme" value="${k}" data-theme-choice${theme === k ? " checked" : ""} /> <span>${l}</span></label>`)
      .join("")}</fieldset>
      <label class="radio"><input type="checkbox" data-mascot-show${mascotHidden() ? "" : " checked"} /> <span>Afficher Clark, la mascotte (en bas à droite)</span></label>
      <p class="quiet field-hint">Gardé sur cet appareil seulement.</p></div>`,
  );
  const list = (state.settings ?? []).filter((x) => x.section !== "Autonomie");
  if (!list.length) return html;
  const groups = [...new Set(list.map((x) => x.section))];
  html += section(
    "general",
    "Fonctionnement",
    "",
    `<p class="quiet">Ces réglages passent devant ceux de .env. Les secrets (clés, jetons) restent dans .env et n'apparaissent jamais ici.</p>
    ${groups
      .map(
        (g) => `<div class="card auto-form set-group"><p class="card-title">${esc(g)}</p>${list
          .filter((x) => x.section === g)
          .map(
            (x) => `<div class="set-row" data-setting-row="${x.key}">
              <label for="set-${x.key}">${esc(x.label)}</label>
              ${settingControl(x)}
              <p class="quiet field-hint">${esc(x.hint)} <span class="set-src">· ${x.source === "interface" ? `réglé ici <button type="button" class="link" data-setting-reset="${x.key}">revenir à ${esc(x.env)}</button>` : x.source === ".env" ? `depuis .env (${esc(x.env)})` : "par défaut"}${x.apply === "restart" ? " · au prochain redémarrage" : ""}</span></p>
              <p class="inline-error" role="alert" hidden></p>
            </div>`,
          )
          .join("")}</div>`,
      )
      .join("")}`,
  );
  return html;
}

async function saveSetting(key, value, row) {
  const err = row?.querySelector(".inline-error");
  try {
    const r = await post("/api/settings", { key, value });
    if (err) err.hidden = true;
    $("#announce").textContent = r.restart ? "Enregistré : pris en compte au prochain redémarrage de Clark" : "Enregistré";
  } catch (e) {
    if (err) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }
}

side.addEventListener("change", (e) => {
  const t = e.target;
  if (t.matches("[data-mascot-show]")) {
    try {
      if (t.checked) localStorage.removeItem("clark.mascot");
      else localStorage.setItem("clark.mascot", "off");
    } catch {}
    mascotKey = "";
    renderMascot();
    return;
  }
  if (t.matches("[data-theme-choice]")) {
    try {
      if (t.value === "system") localStorage.removeItem("clark.theme");
      else localStorage.setItem("clark.theme", t.value);
    } catch {}
    if (t.value === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t.value;
    return;
  }
  const row = t.closest("[data-setting-row]");
  if (t.matches("[data-setting]")) void saveSetting(t.dataset.setting, t.type === "checkbox" ? (t.checked ? "on" : "off") : t.value, row);
  else if (t.closest("[data-setting-roles]")) {
    const box = t.closest("[data-setting-roles]");
    const value = [...box.querySelectorAll("select[data-role]")]
      .filter((s) => s.value)
      .map((s) => `${s.dataset.role}=${s.value}`)
      .join(",");
    void saveSetting(box.dataset.settingRoles, value, row);
  }
});

side.addEventListener("click", (e) => {
  const reset = e.target.closest("[data-setting-reset]");
  if (reset) void saveSetting(reset.dataset.settingReset, null, reset.closest("[data-setting-row]"));
});

// ── Réglages › Notifications ──

const CHANNEL_NAMES = { telegram: "Telegram", imessage: "iMessage", browser: "Navigateur" };

function buildNotify() {
  const n = state.notify;
  if (!n) return "";
  const p = n.prefs;
  const live = { telegram: state.clark.telegram, imessage: state.imessage?.channel, browser: notifySupported && notifyOn };
  const grid = `<table class="notify-grid">
    <thead><tr><th scope="col">Quoi</th>${Object.keys(CHANNEL_NAMES).map((c) => `<th scope="col">${CHANNEL_NAMES[c]}${live[c] ? "" : `<span class="quiet notify-off">pas branché</span>`}</th>`).join("")}</tr></thead>
    <tbody>${n.kinds
      .map(
        ([k, label]) =>
          `<tr><th scope="row">${esc(label)}</th>${Object.keys(CHANNEL_NAMES)
            .map((c) => `<td><input type="checkbox" aria-label="${esc(label)} sur ${CHANNEL_NAMES[c]}" data-notify-route="${k}:${c}"${p.routes[k]?.[c] ? " checked" : ""} /></td>`)
            .join("")}</tr>`,
      )
      .join("")}</tbody>
  </table>`;
  return section(
    "notify",
    "Notifications",
    "",
    `<p class="quiet">Tout reste dans la conversation et dans Activité ; ici, tu choisis ce qui part en plus, et où.</p>
    <div class="card">${grid}</div>
    <div class="card auto-form" data-setting-row="quiet">
      <p class="card-title">Heures calmes</p>
      <label class="radio"><input type="checkbox" data-quiet="on"${p.quiet.on ? " checked" : ""} /> <span>Rien n'est envoyé pendant ces heures</span></label>
      <div class="quiet-hours"><label>De <input type="time" data-quiet="from" value="${esc(p.quiet.from)}" /></label><label>à <input type="time" data-quiet="to" value="${esc(p.quiet.to)}" /></label></div>
      <label class="radio"><input type="checkbox" data-quiet="approvals"${p.quiet.approvals ? " checked" : ""} /> <span>Sauf les accords et questions (une tâche t'attend)</span></label>
      <label class="radio"><input type="checkbox" data-quiet="alerts"${p.quiet.alerts !== false ? " checked" : ""} /> <span>Sauf les alertes urgentes de santé (moteur principal déconnecté, version de secours, disque plein)</span></label>
      <p class="quiet field-hint">À la fin des heures calmes, un seul message résume ce qui n'est pas parti${n.held ? ` (${n.held} en attente)` : ""}.</p>
    </div>
    <div class="card auto-form" data-setting-row="awake">
      <p class="card-title">Garder le Mac éveillé</p>
      <fieldset class="voice-modes"><legend class="visually-hidden">Garder le Mac éveillé</legend>${[
        ["agent", "Pendant qu'un agent travaille", "La mise en veille arrêterait Clark au milieu d'une tâche."],
        ["always", "Toujours", "Clark reste joignable tout le temps (sur secteur)."],
        ["never", "Jamais", "Le Mac se met en veille comme d'habitude."],
      ]
        .map(([k, l, h]) => `<label class="radio"><input type="radio" name="awake" value="${k}" data-awake${p.awake === k ? " checked" : ""} /> <span>${l}<small>${h}</small></span></label>`)
        .join("")}</fieldset>
      <p class="quiet field-hint">${n.awake ? "Le Mac est tenu éveillé en ce moment." : "Le Mac n'est pas tenu éveillé en ce moment."} Fermer l'écran le met quand même en veille.</p>
      <p class="inline-error" id="notify-error" role="alert" hidden></p>
    </div>`,
  );
}

async function saveNotify(change) {
  const prefs = structuredClone(state.notify.prefs);
  change(prefs);
  try {
    await post("/api/notify", { prefs });
    $("#notify-error") && ($("#notify-error").hidden = true);
  } catch (err) {
    const box = $("#notify-error");
    if (box) {
      box.textContent = err.message;
      box.hidden = false;
    }
  }
}

side.addEventListener("change", (e) => {
  const t = e.target;
  if (t.matches("[data-notify-route]")) {
    const [k, c] = t.dataset.notifyRoute.split(":");
    void saveNotify((p) => (p.routes[k][c] = t.checked));
  } else if (t.matches("[data-quiet]")) {
    const f = t.dataset.quiet;
    void saveNotify((p) => (p.quiet[f] = t.type === "checkbox" ? t.checked : t.value));
  } else if (t.matches("[data-awake]")) void saveNotify((p) => (p.awake = t.value));
});

// ── Réglages › Sauvegarde : exporter, importer ──

let importPlan = null; // { data, plan, result, error }

function buildBackup() {
  const ip = importPlan;
  const items = (list) =>
    list.length ? `<ul class="review-list">${list.map((i) => `<li>${esc(i.name)} <span class="tag">${esc(i.status)}</span>${i.note ? ` <span class="quiet">${esc(String(i.note).slice(0, 80))}</span>` : ""}</li>`).join("")}</ul>` : `<p class="quiet">Rien.</p>`;
  const planHtml = !ip
    ? ""
    : ip.error
      ? `<p class="inline-error" role="alert">${esc(ip.error)}</p>`
      : ip.result
        ? `<p class="card-note">Importé : ${ip.result.settings} réglage(s), ${ip.result.commands} commande(s), ${ip.result.automations} automatisation(s), ${ip.result.mcp} serveur(s) MCP, ${ip.result.projects} projet(s)${ip.result.memories ? `, ${ip.result.memories} souvenir(s)` : ""}${ip.result.personality ? ", la personnalité" : ""}.</p>${
            ip.result.skipped.length ? `<p class="quiet">Laissé de côté :</p><ul class="review-list">${ip.result.skipped.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""
          }${
            ip.plan.plugins.filter((x) => x.status === "à relire").length
              ? `<p class="quiet">Plugins à relire avant de les installer :</p><ul class="review-list">${ip.plan.plugins
                  .filter((x) => x.status === "à relire")
                  .map((x, i) => `<li>${esc(x.name)} <button type="button" class="link" data-import-plugin="${ip.plan.plugins.indexOf(x)}">Relire</button></li>`)
                  .join("")}</ul>`
              : ""
          }<div class="card-actions"><button type="button" class="btn ghost" data-import-close>Fermer</button></div>`
        : `<p class="card-title">Ce que ce fichier contient (exporté le ${esc(new Date(ip.plan.exportedAt).toLocaleString("fr-FR"))})</p>
          <details class="goal-log"><summary>Réglages (${ip.plan.settings.length})</summary>${items(ip.plan.settings)}</details>
          <details class="goal-log"><summary>Commandes (${ip.plan.commands.length})</summary>${items(ip.plan.commands)}</details>
          <details class="goal-log"><summary>Automatisations (${ip.plan.automations.length})</summary>${items(ip.plan.automations)}</details>
          <details class="goal-log"><summary>Serveurs MCP (${ip.plan.mcp.length})</summary>${items(ip.plan.mcp)}</details>
          <details class="goal-log"><summary>Projets dev (${ip.plan.projects.length})</summary>${items(ip.plan.projects)}</details>
          <details class="goal-log"><summary>Plugins (${ip.plan.plugins.length})</summary>${items(ip.plan.plugins)}<p class="quiet">Jamais installés d'office : tu les relis un par un après l'import.</p></details>
          <p class="quiet">Ce qui existe déjà ici reste tel quel. Les réglages et les notifications sont remplacés.</p>
          ${ip.plan.personality.differs ? `<label class="radio"><input type="checkbox" id="import-personality" /> <span>Remplacer ta personnalité par celle du fichier</span></label>` : ""}
          ${ip.plan.memories ? `<label class="radio"><input type="checkbox" id="import-memories" checked /> <span>Ajouter les souvenirs (${ip.plan.memories.fresh} nouveaux sur ${ip.plan.memories.total})</span></label>` : ""}
          <div class="card-actions"><button type="button" class="btn primary" data-import-apply>Importer</button><button type="button" class="btn ghost" data-import-close>Annuler</button></div>`;
  return section(
    "backup",
    "Sauvegarde",
    "",
    `<div class="card auto-form">
      <p class="card-title">Exporter la configuration</p>
      <p class="quiet">Un fichier avec tes réglages, notifications, personnalité, commandes, automatisations, serveurs MCP, plugins (leurs adresses) et projets. Jamais de secret : ni clés, ni jetons, ni connexions (Google, Telegram, moteurs) à refaire sur l'autre machine.</p>
      <label class="radio"><input type="checkbox" id="export-memory" /> <span>Inclure la mémoire (souvenirs confirmés)</span></label>
      <div class="card-actions"><button type="button" class="btn secondary" data-export>Exporter</button></div>
    </div>
    <div class="card auto-form" id="import-box">
      <p class="card-title">Importer une configuration</p>
      <label for="import-file">Fichier exporté par Clark</label>
      <input id="import-file" type="file" accept="application/json,.json" />
      ${planHtml}
    </div>`,
  );
}

side.addEventListener("click", async (e) => {
  if (e.target.closest("[data-export]")) {
    const a = document.createElement("a");
    a.href = `/api/config/export${$("#export-memory")?.checked ? "?memory=1" : ""}`;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
    return;
  }
  if (e.target.closest("[data-import-close]")) {
    importPlan = null;
    renderSettings();
    return;
  }
  if (e.target.closest("[data-import-apply]")) {
    const b = e.target.closest("[data-import-apply]");
    b.disabled = true;
    try {
      importPlan.result = await post("/api/config/import", { data: importPlan.data, personality: $("#import-personality")?.checked === true, memories: $("#import-memories")?.checked === true });
    } catch (err) {
      importPlan.error = err.message;
    }
    importPlan = { ...importPlan };
    renderSettings();
    return;
  }
  const plug = e.target.closest("[data-import-plugin]");
  if (plug) {
    const x = importPlan.plan.plugins[Number(plug.dataset.importPlugin)];
    plug.disabled = true;
    try {
      pluginReview = await post("/api/plugins/review", { source: x.source, subdir: x.subdir ?? "", ref: x.ref ?? "" });
      catalogFilter = "";
      location.hash = "#reglages/plugins";
    } catch (err) {
      plug.insertAdjacentHTML("afterend", ` <span class="inline-error" role="alert">${esc(err.message)}</span>`);
    }
  }
});

side.addEventListener("change", async (e) => {
  if (e.target.id !== "import-file") return;
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    importPlan = { data, plan: await post("/api/config/import/preview", { data }) };
  } catch (err) {
    importPlan = { error: err instanceof SyntaxError ? "Ce fichier n'est pas du JSON." : err.message };
  }
  importPlan = { ...importPlan };
  renderSettings();
});

// ── Raccourcis : ⌘, pour les réglages, ? pour la liste ──

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    location.hash = "#reglages";
    setTimeout(() => $("#settings-search")?.focus(), 50);
    return;
  }
  if (e.key === "?" && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    $("#shortcuts").showModal();
  }
});

