// ── Plugins : moteurs, connexions, serveurs MCP ──

function plugin(name, state_, what, how = "") {
  const tag = { on: ["branché", "on"], off: ["pas branché", "off"], built: ["intégré", "built"] }[state_];
  return `<div class="plugin">
    <div class="plugin-head"><h3 class="plugin-name">${name}</h3><span class="tag plugin-${tag[1]}">${tag[0]}</span></div>
    <p class="plugin-what">${what}</p>
    ${how}
  </div>`;
}

const TOOLS = [
  ["Mémoire", "recall, propose_memory, propose_correction, forget"],
  ["Questions et avancement", "ask_charles, report_progress"],
  ["Propositions", "propose_initiative"],
  ["Idées", "note_idea, idea_report"],
  ["Vidéos", "prepare_social_post"],
  ["Mail et agenda", "mail_search, mail_read, send_mail, calendar_events"],
  ["iMessage", "messages_recent, messages_read, send_imessage"],
  ["Navigateur", "browser_open, browser_read, browser_scroll, browser_back, browser_click, browser_type, browser_select"],
  ["Obsidian", "vault_search, vault_read, vault_write"],
  ["Terminal", "run_command"],
];

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

// « Écrire le journal du jour » : gardés ici, car render() reconstruit la page à chaque hub.touch().
let journalBusy = false;
let journalMsg = null; // { text, error }

/** Le jour (AAAA-MM-JJ) en toutes lettres : « 21 novembre ». */
const journalDayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "Europe/Paris" });

/** Obsidian : la mémoire de Clark en notes liées dans ton coffre, et sa recherche par le sens. */
function renderObsidianPlugin() {
  const o = state.obsidian ?? {};
  if (!o.vault)
    return plugin(
      "Obsidian",
      "off",
      "La mémoire de Clark en notes liées dans ton coffre : tu la vois en graphe, tu la corriges, il suit.",
      `<p class="quiet">Aucun coffre trouvé. Mets son chemin dans .env (CLARK_OBSIDIAN_VAULT=…), puis redémarre Clark.</p>`,
    );
  const when = o.lastSync ? new Date(o.lastSync).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : null;
  return plugin(
    "Obsidian",
    o.error ? "off" : "on",
    "La mémoire de Clark en notes liées dans ton coffre, dossier « Clark/Mémoire » : corrige une note, il reprend ton texte ; supprime-la, il oublie ; écris-en une, il l'apprend. Il cherche aussi dans tes notes, par mots et par le sens, et n'écrit que dans « Clark/ ».",
    `<p class="quiet">${esc(o.vault)} · ${o.notes} souvenir${o.notes > 1 ? "s" : ""} en notes${when ? ` · synchro à ${when}` : ""}</p>
     ${o.error ? `<p class="inline-error" role="alert">${esc(o.error)}</p>` : ""}
     <div class="card-actions">
       <button type="button" class="btn secondary" data-obsidian-sync>Synchroniser maintenant</button>
       <button type="button" class="btn secondary" data-obsidian-journal${journalBusy ? " disabled" : ""}>${journalBusy ? "Écriture…" : "Écrire le journal du jour"}</button>
     </div>
     ${journalMsg ? (journalMsg.error ? `<p class="inline-error" role="alert">${esc(journalMsg.text)}</p>` : `<p class="quiet" role="status">${esc(journalMsg.text)}</p>`) : ""}`,
  );
}

side.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-obsidian-sync]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Synchro…";
  try {
    await post("/api/obsidian/sync", {});
  } catch (err) {
    btn.insertAdjacentHTML("afterend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Synchroniser maintenant";
  }
});

side.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-obsidian-journal]");
  if (!btn || journalBusy) return;
  journalBusy = true;
  journalMsg = null;
  renderSettings();
  try {
    const r = await post("/api/obsidian/journal", {});
    journalMsg = r.empty ? { text: "Rien à écrire aujourd'hui : la journée est presque vide." } : { text: `Journal du ${journalDayLabel(r.day)} écrit` };
  } catch (err) {
    journalMsg = { text: err.message, error: true };
  } finally {
    journalBusy = false;
    renderSettings();
  }
});

/** iMessage : l'accès à la base de Messages, puis le canal (ta conversation avec toi-même). */
function renderIMessagePlugin() {
  const m = state.imessage;
  if (!m) return "";
  const what =
    "Clark lit tes conversations quand tu le demandes (et au tour de veille), et répond à tes contacts avec ton accord sur le texte exact. Si tu le règles, tu lui écris aussi depuis ton iPhone, dans ta conversation avec toi-même.";
  if (!m.access)
    return plugin(
      "iMessage",
      "off",
      what,
      `<ol class="how-steps">
        <li>Réglages Système › Confidentialité et sécurité › <strong>Accès complet au disque</strong> › bouton +.</li>
        <li>Cmd+Maj+G, colle <code>${esc(m.nodePath)}</code>, puis Ouvrir, et active-le.</li>
        <li>Redémarre Clark : <code>scripts/service.sh restart</code>.</li>
      </ol>
      <p class="quiet">C'est node qui lit la base de Messages. Après une mise à jour de node, son chemin change : il faudra le refaire.</p>`,
    );
  return plugin(
    "iMessage",
    "on",
    what,
    `${
      m.channel
        ? `<p class="quiet">Canal actif : écris-toi un message (ta conversation avec toi-même) depuis ton iPhone. Ses réponses commencent par « Clark : ». Pour un accord, réponds « oui A1F3 » ou « non A1F3 » ; pour une question, « R12 ta réponse ».</p>`
        : `<p class="quiet">Pour lui écrire par iMessage, mets <code>CLARK_IMESSAGE_SELF=</code> ton numéro ou ton adresse Apple dans .env, puis redémarre Clark.</p>`
    }
    <p class="quiet">Au premier envoi, macOS te demande d'autoriser Clark à piloter Messages : accepte.</p>
    ${m.error ? `<p class="inline-error" role="alert">Dernier envoi en échec : ${esc(m.error)}</p>` : ""}`,
  );
}

/** Le navigateur de Clark : son état, sa dernière capture, et de quoi l'afficher pour te connecter. */
function renderBrowserPlugin() {
  const b = state.browser;
  if (!b) return "";
  if (!b.available) return plugin("Navigateur de Clark", "off", "Clark ouvre des pages, remplit des formulaires et utilise tes comptes, dans un Chrome à lui.", `<p class="quiet">Google Chrome est introuvable sur ce Mac.</p>`);
  const where = b.running ? `${b.visible ? "Affiché" : "En arrière-plan"}${b.url && b.url !== "about:blank" ? ` · ${esc(hostOf(b.url))}` : ""}` : "Fermé (il s'ouvre quand Clark en a besoin)";
  const shot = b.running && b.shotAt ? `<img class="browser-shot" src="/api/browser/screenshot?t=${b.shotAt}" alt="Ce que voit le navigateur de Clark${b.title ? ` : ${esc(b.title)}` : ""}" />` : "";
  return plugin(
    "Navigateur de Clark",
    "built",
    "Un Chrome à lui, avec son propre profil. Lire, chercher, remplir un champ : libre. Tout ce qui envoie ou engage (formulaire, Envoyer, Payer, Se connecter…) attend ton accord. Il ne tape jamais de mot de passe ni de carte : pour qu'il utilise un compte, ouvre sa fenêtre et connecte-toi toi-même, la session reste.",
    `<p class="quiet browser-where">${where}</p>${shot}
    <div class="card-actions">
      ${b.visible ? `<button type="button" class="btn secondary" data-browser="hide">Masquer la fenêtre</button>` : `<button type="button" class="btn secondary" data-browser="show">Ouvrir le navigateur</button>`}
      ${b.running ? `<button type="button" class="btn ghost" data-browser="close">Fermer</button>` : ""}
      <button type="button" class="btn ghost" data-browser="forget">Effacer ses connexions</button>
    </div>
    <p class="inline-error" id="browser-error" role="alert" hidden></p>`,
  );
}

// Pendant qu'une tâche navigue : sa capture en direct au-dessus du fil (reconstruite seulement si elle change).
let browserLiveKey = "";
function renderBrowserLive() {
  const box = $("#browser-live");
  const b = state.browser;
  const live = b?.running && b.taskId && (state.running ?? []).some((t) => t.id === b.taskId) ? b : null;
  const key = live ? `${live.shotAt}|${live.visible}|${live.lastAction}` : "";
  if (key === browserLiveKey) return;
  browserLiveKey = key;
  box.hidden = !live;
  box.innerHTML = live
    ? `${live.shotAt ? `<img src="/api/browser/screenshot?t=${live.shotAt}" alt="Ce que voit Clark${live.title ? ` : ${esc(live.title)}` : ""}" />` : ""}
      <div class="browser-live-text">
        <p><strong>Clark navigue</strong>${live.url ? ` · ${esc(hostOf(live.url))}` : ""}</p>
        ${live.lastAction ? `<p class="quiet">Il ${esc(live.lastAction)}</p>` : ""}
        ${live.visible ? "" : `<button type="button" class="btn secondary" data-browser="show">Afficher la fenêtre</button>`}
      </div>`
    : "";
}

side.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-browser]");
  if (!b) return;
  const action = b.dataset.browser;
  if (action === "forget" && !(await ask("Effacer les connexions du navigateur de Clark ?", "Ses cookies et sessions sont supprimés : il n'est plus connecté à aucun site. Tes autres navigateurs ne changent pas.", "Effacer"))) return;
  b.disabled = true;
  try {
    await post("/api/browser", { action });
  } catch (err) {
    const error = $("#browser-error");
    if (error) {
      error.textContent = err.message;
      error.hidden = false;
    } else {
      sendError.textContent = `Navigateur : ${err.message}`;
      sendError.hidden = false;
    }
  } finally {
    b.disabled = false;
  }
});

function buildPlugins() {
  // Le premier test d'un serveur ajouté tourne côté Clark : fini dès que son résultat est dans l'état.
  for (const id of [...mcpFirstTest]) if ((state.mcp ?? []).find((x) => x.id === id)?.check) mcpFirstTest.delete(id);
  const { clark } = state;
  const engines = state.engines ?? [];
  let html = section(
    "engines",
    "Moteurs",
    "",
    engines.length
      ? `${engines.map((e) => renderEngine(e)).join("")}<p class="quiet engines-note">Un nouveau choix vaut pour les prochaines tâches ; celles en cours gardent le leur. Plus d’effort : réponses plus réfléchies, plus lentes, et plus de quota consommé.</p>`
      : `<p class="quiet">${clark.engine.name === "demo" ? "Démo : faux agent, aucun moteur réel." : "Les moteurs n'ont pas encore été lus."}</p>`,
    engines.length ? `<button type="button" class="link" data-engines-refresh>Actualiser</button>` : "",
  );

  const g = state.google;
  const googleHow = !g
    ? ""
    : g.connected
      ? `<p class="quiet">Compte : ${esc(g.email ?? "connecté")}${g.missingScopes ? ". Des autorisations manquent : relance <code>npm run google:login</code>." : ""}</p>`
      : g.configured
        ? `<p class="quiet">Pour le brancher, lance dans le dossier de Clark :</p><code class="engine-cmd">npm run google:login</code>`
        : `<p class="quiet">Crée d'abord un identifiant OAuth « application de bureau » (docs/GUIDE.md, « Mail et agenda »), puis mets GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env.</p>`;
  const notify = !notifySupported
    ? plugin("Notifications du navigateur", "off", "Ce navigateur ne les prend pas en charge.")
    : Notification.permission === "denied"
      ? plugin("Notifications du navigateur", "off", "Bloquées par le navigateur : autorise-les dans les réglages du site.")
      : plugin(
          "Notifications du navigateur",
          notifyOn ? "on" : "off",
          "Clark te prévient quand il répond ou attend ton accord, si cet onglet est en arrière-plan.",
          `<button type="button" class="btn secondary" id="notify-toggle">${notifyOn ? "Désactiver" : "Activer"}</button>`,
        );
  html += section(
    "connections",
    "Connexions",
    "",
    `<div class="plugins">
      ${plugin("Gmail et Google Agenda", g?.connected ? "on" : "off", "Clark lit tes mails et ton agenda. Il n'envoie un mail qu'après ton accord ; l'agenda reste en lecture seule.", googleHow)}
      ${plugin("Telegram", clark.telegram ? "on" : "off", "Clark sur ton téléphone : messages, accords, questions, vidéos et propositions.", clark.telegram ? "" : `<p class="quiet">Mets TELEGRAM_BOT_TOKEN et TELEGRAM_OWNER_ID dans .env, puis redémarre Clark.</p>`)}
      ${plugin(
        "Bac à sable des commandes",
        state.sandbox ? "on" : "off",
        "Les commandes shell de Clark ne lisent et n'écrivent que dans son dossier de travail, sans réseau, quel que soit le moteur. Ton dossier personnel, .env et les données de Clark restent fermés.",
        state.sandbox ? "" : `<p class="quiet">Coupé pour le moteur Claude (Réglages › Général › Sécurité). Codex garde le sien.</p>`,
      )}
      ${renderObsidianPlugin()}
      ${renderIMessagePlugin()}
      ${renderBrowserPlugin()}
      ${plugin("Réseaux sociaux", "built", "Clark monte des vidéos verticales pour TikTok à partir de tes clips, sur ton Mac. Tu publies toi-même dans TikTok.")}
      ${notify}
    </div>`,
  );

  html += section(
    "mcp",
    "Serveurs MCP",
    "",
    `<div class="plugins">
      <div class="plugin">
        <div class="plugin-head"><h3 class="plugin-name">Outils de Clark</h3><span class="tag plugin-built">intégré</span></div>
        <p class="plugin-what">Le serveur que Clark donne à ses agents, quel que soit le moteur.</p>
        <dl class="tools">${TOOLS.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      </div>
      ${(state.mcp ?? []).map(renderMcpServer).join("")}
    </div>
    ${mcpFormOpen ? renderMcpForm() : `<button type="button" class="btn secondary mcp-new" data-mcp-new>Ajouter un serveur MCP</button>`}`,
  );
  return html;
}

// ── Serveurs MCP ajoutés ──

let mcpFormOpen = false;
const mcpTesting = new Set(); // tests lancés depuis le bouton « Tester »
const mcpFirstTest = new Set(); // test automatique juste après l'ajout

function renderMcpServer(m) {
  const what = m.transport === "stdio" ? [m.command, ...m.args].join(" ") : m.url;
  const vars = m.vars.length
    ? `<ul class="mcp-vars">${m.vars
        .map((v) => `<li${v.set ? "" : ` class="missing"`}><code>${esc(v.name)}</code> ${v.set ? "renseignée dans .env" : "manquante dans .env"}${v.token ? " (jeton)" : ""}</li>`)
        .join("")}</ul>`
    : "";
  const c = m.check;
  const check = mcpTesting.has(m.id) || mcpFirstTest.has(m.id)
    ? `<p class="quiet">Test en cours…</p>`
    : !c
      ? `<p class="quiet">Pas encore testé.</p>`
      : c.ok
        ? `<details class="mcp-tools"><summary>${c.tools.length} outil${c.tools.length > 1 ? "s" : ""} · testé à ${time(new Date(c.at))}</summary><ul>${c.tools
            .map((t) => `<li><code>${esc(t.name)}</code>${t.description ? ` ${esc(t.description)}` : ""}</li>`)
            .join("")}</ul></details>`
        : `<p class="inline-error">Échec du test : ${esc(c.error ?? "erreur inconnue")}</p>`;
  return `<div class="plugin" data-mcp="${m.id}">
    <div class="plugin-head"><h3 class="plugin-name">${esc(m.name)}</h3><span class="tag ${m.enabled ? "plugin-on" : "plugin-off"}">${m.enabled ? "actif" : "coupé"}</span></div>
    <code class="engine-cmd">${esc(what)}</code>
    ${vars}
    <p class="plugin-what mcp-trust">${m.trust === "read" ? "Déclaré en lecture seule : ses outils passent sans te demander." : "Chaque appel de ses outils te demande ton accord."}</p>
    ${check}
    <div class="card-actions">
      <button type="button" class="btn secondary" data-mcp-action="test"${mcpTesting.has(m.id) ? " disabled" : ""}>Tester</button>
      <button type="button" class="btn ghost" data-mcp-action="${m.enabled ? "disable" : "enable"}">${m.enabled ? "Couper" : "Activer"}</button>
      <button type="button" class="btn ghost" data-mcp-action="${m.trust === "read" ? "trust-ask" : "trust-read"}">${m.trust === "read" ? "Demander à chaque appel" : "Passer en lecture seule"}</button>
      <button type="button" class="btn ghost" data-mcp-action="delete">Supprimer</button>
    </div>
  </div>`;
}

function renderMcpForm() {
  return `<form class="card auto-form mcp-form" id="mcp-form" novalidate>
    <p class="card-title">Nouveau serveur MCP</p>
    <label for="mcp-name">Nom</label>
    <input id="mcp-name" name="name" type="text" maxlength="32" autocomplete="off" placeholder="notion" aria-describedby="mcp-name-hint" />
    <p class="quiet field-hint" id="mcp-name-hint">Minuscules, chiffres, - ou _. Les outils s'appelleront mcp__nom__outil.</p>
    <fieldset class="mcp-type">
      <legend>Type</legend>
      <label class="radio"><input type="radio" name="transport" value="stdio" checked /> Commande lancée sur ce Mac</label>
      <label class="radio"><input type="radio" name="transport" value="http" /> Adresse web (HTTP)</label>
    </fieldset>
    <div data-mcp-for="stdio">
      <label for="mcp-command">Commande</label>
      <input id="mcp-command" name="command" type="text" autocomplete="off" placeholder="npx" />
      <label for="mcp-args">Arguments <span class="optional">(un par ligne)</span></label>
      <textarea id="mcp-args" name="args" rows="3"></textarea>
    </div>
    <div data-mcp-for="http" hidden>
      <label for="mcp-url">Adresse</label>
      <input id="mcp-url" name="url" type="url" autocomplete="off" placeholder="https://exemple.com/mcp" />
      <label for="mcp-token">Jeton <span class="optional">(nom de la variable dans .env, facultatif)</span></label>
      <input id="mcp-token" name="tokenVar" type="text" autocomplete="off" placeholder="EXEMPLE_TOKEN" />
    </div>
    <label for="mcp-env">Variables d'environnement <span class="optional">(noms séparés par des virgules, facultatif)</span></label>
    <input id="mcp-env" name="envVars" type="text" autocomplete="off" placeholder="NOTION_TOKEN" aria-describedby="mcp-env-hint" />
    <p class="quiet field-hint" id="mcp-env-hint">Seulement les noms. Tu mets les valeurs toi-même dans .env, puis tu redémarres Clark : elles ne passent jamais par cette page.</p>
    <fieldset class="mcp-type">
      <legend>Appels de ses outils</legend>
      <label class="radio"><input type="radio" name="trust" value="ask" checked /> Me demander mon accord à chaque appel</label>
      <label class="radio"><input type="radio" name="trust" value="read" /> Ses outils ne font que lire : sans demander</label>
    </fieldset>
    <p class="inline-error" id="mcp-error" role="alert" hidden></p>
    <div class="card-actions">
      <button type="submit" class="btn primary">Ajouter et tester</button>
      <button type="button" class="btn ghost" data-mcp-cancel>Annuler</button>
    </div>
  </form>`;
}

side.addEventListener("change", (e) => {
  const radio = e.target.closest('#mcp-form input[name="transport"]');
  if (!radio) return;
  const form = radio.form;
  form.querySelectorAll("[data-mcp-for]").forEach((el) => (el.hidden = el.dataset.mcpFor !== radio.value));
});

side.addEventListener("click", async (e) => {
  if (e.target.closest("[data-mcp-new]")) {
    mcpFormOpen = true;
    renderPlugins();
    $("#mcp-name")?.focus();
    return;
  }
  if (e.target.closest("[data-mcp-cancel]")) {
    mcpFormOpen = false;
    renderPlugins();
    $("[data-mcp-new]")?.focus();
    return;
  }
  const button = e.target.closest("[data-mcp-action]");
  if (!button) return;
  const card = button.closest("[data-mcp]");
  const id = Number(card.dataset.mcp);
  const action = button.dataset.mcpAction;
  const server = (state.mcp ?? []).find((m) => m.id === id);
  if (action === "delete" && !(await ask(`Supprimer le serveur MCP « ${server?.name ?? id} » ?`, "Ses outils ne seront plus proposés à Clark. Les variables de .env ne sont pas touchées.", "Supprimer"))) return;
  if (action === "test") {
    mcpTesting.add(id);
    renderPlugins();
  } else card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/mcp/${id}`, { action });
    // Carte supprimée : le focus va au bouton d'ajout plutôt que de retomber en haut de la page.
    if (action === "delete") setTimeout(() => (document.activeElement === document.body || !document.body.contains(document.activeElement)) && $("[data-mcp-new]")?.focus(), 300);
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    card.querySelector(":scope > .inline-error")?.remove();
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  } finally {
    if (mcpTesting.delete(id)) renderPlugins();
  }
});

side.addEventListener("submit", async (e) => {
  const form = e.target.closest("#mcp-form");
  if (!form) return;
  e.preventDefault();
  if (form.dataset.busy) return;
  const f = form.elements;
  const list = (v) => v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const body = {
    name: f.name.value.trim(),
    transport: form.querySelector('input[name="transport"]:checked').value,
    command: f.command.value.trim(),
    args: f.args.value.split("\n").map((x) => x.trim()).filter(Boolean),
    url: f.url.value.trim(),
    tokenVar: f.tokenVar.value.trim(),
    envVars: list(f.envVars.value),
    trust: form.querySelector('input[name="trust"]:checked').value,
  };
  const error = form.querySelector("#mcp-error");
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  form.dataset.busy = "1";
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const res = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.textContent = data.error || `Erreur ${res.status}`;
      error.hidden = false;
      const field = data.field && f[data.field];
      if (field && field.focus) {
        // Le message se place juste sous le champ concerné.
        field.insertAdjacentElement("afterend", error);
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby", "mcp-error");
        field.focus();
      }
      return;
    }
    mcpFormOpen = false;
    mcpFirstTest.add(data.id);
    renderPlugins();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    delete form.dataset.busy;
    submit.disabled = false;
  }
});



