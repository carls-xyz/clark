// ── Réglages : automatisations, mémoire, réseaux sociaux, moteurs par rôle ──

// ── Commandes perso et skills ──

let commandFormOpen = false;
const modeNames = { chat: "message", team: "équipe", goal: "objectif" };

function renderCommands(list) {
  const rows = list
    .map(
      (c) => `<div class="card command" data-command="${esc(c.name)}">
        <div class="goal-head"><p class="card-title"><code>/${esc(c.name)}</code></p><span class="tag">${modeNames[c.mode] ?? c.mode}</span></div>
        ${c.description ? `<p class="card-note">${esc(c.description)}</p>` : ""}
        <details class="goal-log"><summary>Consigne</summary><pre class="command-prompt">${esc(c.prompt)}</pre></details>
        <form class="command-run" data-command-run>
          <label class="visually-hidden" for="cmd-args-${esc(c.name)}">Précisions pour /${esc(c.name)}</label>
          <input id="cmd-args-${esc(c.name)}" name="args" type="text" autocomplete="off" placeholder="${c.prompt.includes("$ARGUMENTS") ? "Ce qui remplace $ARGUMENTS" : "Précisions (facultatif)"}" />
          <button type="submit" class="btn primary">Lancer</button>
          ${c.plugin ? `<span class="quiet">plugin ${esc(c.plugin)}</span>` : `<button type="button" class="btn ghost" data-command-delete>Supprimer</button>`}
        </form>
      </div>`,
    )
    .join("");
  const form = commandFormOpen
    ? `<form class="card auto-form" id="command-form" novalidate>
        <p class="card-title">Nouvelle commande</p>
        <label for="cf-name">Nom</label>
        <input id="cf-name" name="name" type="text" maxlength="48" autocomplete="off" placeholder="relances" />
        <label for="cf-desc">Description <span class="optional">(facultatif)</span></label>
        <input id="cf-desc" name="description" type="text" maxlength="200" autocomplete="off" />
        <label for="cf-mode">Mode</label>
        <select id="cf-mode" name="mode"><option value="chat">Message : un tour</option><option value="team">Équipe d'agents</option><option value="goal">Objectif : plusieurs tours</option></select>
        <label for="cf-prompt">Consigne</label>
        <textarea id="cf-prompt" name="prompt" rows="5" aria-describedby="cf-hint"></textarea>
        <p class="quiet field-hint" id="cf-hint">$ARGUMENTS est remplacé par ce que tu écris après la commande : « /relances Studio Pixel ».</p>
        <p class="inline-error" id="cf-error" role="alert" hidden></p>
        <div class="card-actions"><button type="submit" class="btn primary">Créer</button><button type="button" class="btn ghost" data-command-cancel>Annuler</button></div>
      </form>`
    : `<button type="button" class="btn secondary mcp-new" data-command-new>Nouvelle commande</button>`;
  return section(
    "commands",
    "Commandes",
    list.length || "",
    `${list.length ? rows : `<p class="quiet">Aucune commande. Une commande est une consigne que tu relances souvent : tape « /nom » dans la conversation ou sur Telegram.</p>`}${form}`,
  );
}

function renderSkills(list) {
  const src = { clark: "skills/ de Clark", claude: "tes skills Claude Code", plugin: "plugin" };
  return section(
    "skills",
    "Skills",
    list.length || "",
    list.length
      ? `<p class="quiet">Clark voit ces méthodes et lit celle qui correspond à ta demande. Il ne les modifie pas.</p>
        <dl class="tools skills">${list.map((k) => `<dt>${esc(k.name)}</dt><dd>${esc(k.description || "(sans description)")} <span class="skill-src">${k.plugin ? `plugin ${esc(k.plugin)}` : (src[k.source] ?? k.source)}</span></dd>`).join("")}</dl>`
      : `<p class="quiet">Aucun skill trouvé. Clark lit les dossiers skills/ (le sien) et ~/.claude/skills (les tiens).</p>`,
  );
}

side.addEventListener("click", async (e) => {
  if (e.target.closest("[data-command-new]")) {
    commandFormOpen = true;
    renderSettings();
    $("#cf-name")?.focus();
    return;
  }
  if (e.target.closest("[data-command-cancel]")) {
    commandFormOpen = false;
    renderSettings();
    $("[data-command-new]")?.focus();
    return;
  }
  const del = e.target.closest("[data-command-delete]");
  if (!del) return;
  const name = del.closest("[data-command]").dataset.command;
  if (!(await ask(`Supprimer la commande /${name} ?`, "Son fichier dans commands/ est supprimé.", "Supprimer"))) return;
  try {
    await post(`/api/commands/${name}`, { action: "delete" });
  } catch (err) {
    del.insertAdjacentHTML("afterend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

side.addEventListener("submit", async (e) => {
  const run = e.target.closest("[data-command-run]");
  if (run) {
    e.preventDefault();
    const name = run.closest("[data-command]").dataset.command;
    const args = run.elements.args.value.trim();
    run.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
    try {
      const r = await post("/api/messages", { text: `/${name}${args ? ` ${args}` : ""}` });
      location.hash = r.kind === "goal" ? "activite" : "conversation";
    } catch (err) {
      run.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    } finally {
      run.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
    }
    return;
  }
  const form = e.target.closest("#command-form");
  if (!form) return;
  e.preventDefault();
  const f = form.elements;
  const error = form.querySelector("#cf-error");
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  try {
    const res = await fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: f.name.value.trim(), description: f.description.value.trim(), mode: f.mode.value, prompt: f.prompt.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.textContent = data.error || `Erreur ${res.status}`;
      error.hidden = false;
      const field = data.field && f[data.field];
      if (field?.focus) {
        field.insertAdjacentElement("afterend", error);
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby", "cf-error");
        field.focus();
      }
      return;
    }
    commandFormOpen = false;
    renderSettings();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

let personalityDirty = false;
// « Flo (Français (Canada)) » → « Flo · Canada » ; les voix de France gardent leur prénom seul.
const voiceLabel = (n) => n.replace(/ \(Français \(France\)\)$/, "").replace(/ \(Français \((.+)\)\)$/, " · $1");
function renderPersonalityVoice() {
  const p = state.personality ?? { text: "", custom: false, limit: 4000 };
  const v = state.voice ?? { ready: false, canSpeak: false, problem: null, mode: "voice", voice: "", voices: [] };
  let html = section(
    "personality",
    "Personnalité",
    p.custom ? "" : "par défaut",
    `<form class="card auto-form" id="personality-form" novalidate>
      <p class="quiet">Le ton de Clark, écrit par toi : son humour, sa façon de parler, ce qu'il évite. Il règle le style, jamais ses limites ni les validations.</p>
      <label class="visually-hidden" for="pf-text">Personnalité de Clark</label>
      <textarea id="pf-text" name="text" rows="8" maxlength="${p.limit}" aria-describedby="pf-count">${esc(p.text)}</textarea>
      <p class="quiet field-hint" id="pf-count">${p.text.length} / ${p.limit} caractères</p>
      <p class="inline-error" id="pf-error" role="alert" hidden></p>
      <div class="card-actions">
        <button type="submit" class="btn primary">Enregistrer</button>
        ${p.custom ? `<button type="button" class="btn ghost" data-personality-reset>Revenir au texte par défaut</button>` : ""}
      </div>
    </form>`,
  );
  const modes = [
    ["never", "Jamais", "Il comprend tes vocaux mais répond par écrit."],
    ["voice", "Quand tu lui envoies un vocal", "Vocal reçu sur Telegram : réponse écrite et en vocal."],
    ["always", "Toujours", "Chaque réponse sur Telegram arrive aussi en vocal."],
  ];
  const body = v.ready || v.canSpeak
    ? `<p class="quiet">Tes vocaux sont transcrits sur ton Mac (whisper.cpp) : rien ne part sur Internet. Sur Telegram, envoie un vocal ; ici, le micro du champ de message.${v.ready ? "" : ` La transcription n'est pas prête : ${esc(v.problem ?? "")}.`}</p>
      <fieldset class="voice-modes">
        <legend>Répondre en vocal</legend>
        ${modes
          .map(
            ([key, label, hint]) => `<label class="radio"><input type="radio" name="voice-mode" value="${key}"${v.mode === key ? " checked" : ""} data-voice-mode /> <span>${label}<small>${hint}</small></span></label>`,
          )
          .join("")}
      </fieldset>
      <label for="voice-name">Voix</label>
      <div class="voice-pick">
        <select id="voice-name" data-voice-name>${(v.voices.length ? v.voices : [v.voice]).map((n) => `<option value="${esc(n)}"${n === v.voice ? " selected" : ""}>${esc(voiceLabel(n))}</option>`).join("")}</select>
        <button type="button" class="btn secondary" data-voice-sample>Écouter</button>
      </div>
      <p class="quiet field-hint">Les voix françaises de macOS. D'autres, plus naturelles, s'ajoutent dans Réglages Système › Accessibilité › Contenu énoncé.</p>
      <label for="voice-vocab">Tes mots</label>
      <input id="voice-vocab" type="text" maxlength="600" autocomplete="off" value="${esc(v.vocabulary ?? "")}" placeholder="Julie Moreau, Studio Pixel, IIM" data-voice-vocab aria-describedby="voice-vocab-hint" />
      <p class="quiet field-hint" id="voice-vocab-hint">Noms de personnes, de projets, mots rares : la transcription les écrira juste. Enregistré quand tu quittes le champ.</p>
      <p class="inline-error" id="voice-error" role="alert" hidden></p>`
    : `<p class="quiet">La voix n'est pas disponible : ${esc(v.problem ?? "outil manquant")}.</p>`;
  html += section("voice", "Voix", v.ready ? "" : "à installer", `<div class="card auto-form" data-setting-row="voice">${body}</div>`);
  return html;
}

// ── Plugins : relire avant d'installer ──

let pluginReview = null; // la relecture en cours (renvoyée par le serveur, hors du flux)
let pluginBusy = null; // « review » | « install » | nom du plugin en vérification
let pluginError = "";
let catalogFilter = "";

function buildPluginsSection() {
  const list = state.plugins ?? [];
  const installed = list.length
    ? list
        .map(
          (p) => `<div class="card" data-plugin="${esc(p.name)}">
        <div class="goal-head"><p class="card-title">${esc(p.name)}${p.version ? ` <span class="quiet">${esc(p.version)}</span>` : ""}</p><span class="tag">${p.enabled ? "activé" : "coupé"}</span></div>
        ${p.description ? `<p class="card-note">${esc(p.description)}</p>` : ""}
        <p class="quiet plugin-parts">${[
          p.commands.length ? `${p.commands.length} commande${p.commands.length > 1 ? "s" : ""} : ${p.commands.map((c) => `/${esc(c.name)}`).join(", ")}` : "",
          p.skills.length ? `${p.skills.length} skill${p.skills.length > 1 ? "s" : ""}` : "",
          p.mcp.length ? `${p.mcp.length} serveur${p.mcp.length > 1 ? "s" : ""} MCP` : "",
        ]
          .filter(Boolean)
          .join(" · ")}</p>
        <p class="quiet plugin-src"><code>${esc(p.source)}</code>${p.subdir ? ` › <code>${esc(p.subdir)}</code>` : ""} · <code>${esc(p.commit.slice(0, 10))}</code></p>
        <div class="card-actions">
          <button type="button" class="btn secondary" data-plugin-action="${p.enabled ? "disable" : "enable"}">${p.enabled ? "Couper" : "Activer"}</button>
          <button type="button" class="btn ghost" data-plugin-action="check"${pluginBusy ? " disabled" : ""}>${pluginBusy === p.name ? "Vérification…" : "Vérifier une mise à jour"}</button>
          <button type="button" class="btn ghost" data-plugin-action="uninstall">Désinstaller</button>
        </div>
      </div>`,
        )
        .join("")
    : `<p class="quiet plugins-none">Aucun plugin installé.</p>`;
  const form = `<form class="card auto-form" id="plugin-form" novalidate>
      <p class="card-title">Ajouter un plugin</p>
      <label for="pl-source">Adresse git (https) ou dossier de ton Mac</label>
      <input id="pl-source" name="source" type="text" autocomplete="off" spellcheck="false" placeholder="https://github.com/…" value="${esc(state.clark.demoPlugin ?? "")}" />
      ${state.clark.demoCatalog ? `<p class="quiet">Démo : un plugin d'exemple est déjà indiqué. <button type="button" class="link" data-demo-catalog>Essayer plutôt le catalogue d'exemple</button></p>` : ""}
      <label for="pl-subdir">Sous-dossier <span class="optional">(facultatif, si le dépôt contient plusieurs plugins)</span></label>
      <input id="pl-subdir" name="subdir" type="text" autocomplete="off" spellcheck="false" placeholder="plugins/mon-plugin" />
      <p class="inline-error" id="pl-error" role="alert"${pluginError ? "" : " hidden"}>${esc(pluginError)}</p>
      <div class="card-actions"><button type="submit" class="btn primary"${pluginBusy ? " disabled" : ""}>${pluginBusy === "review" ? "Récupération…" : "Relire avant d'installer"}</button></div>
    </form>`;
  return section(
    "plugins",
    "Plugins",
    list.length || "",
    `<p class="quiet">Un plugin apporte des commandes, des skills et des serveurs MCP, au format des plugins Claude Code. Clark le récupère à part et te montre tout ce qu'il contient ; rien n'est installé ni lancé avant ton accord. Les crochets (hooks) et les agents ne sont pas repris.</p>
    ${installed}
    ${pluginReview ? renderPluginReview(pluginReview) : form}`,
  );
}

const catalogCount = (hits, total, searching) =>
  hits > 40 ? `Les 40 premiers sur ${hits}${searching ? " qui correspondent" : ""} ; cherche pour affiner.` : searching ? `${hits} sur ${total}.` : "";

/** Un catalogue (marketplace.json) : ses plugins, avec une recherche, à relire en un clic. */
function renderCatalog(r) {
  const q = catalogFilter.trim();
  const all = r.catalog;
  const hits = q ? all.filter((e) => matchesQuery(`${e.name} ${e.description}`, q)) : all;
  const shown = hits.slice(0, 40);
  return `<section class="card plugin-review" id="plugin-review" data-token="${esc(r.token)}" aria-labelledby="pr-title">
    <p class="card-title" id="pr-title" tabindex="-1">Catalogue : ${all.length} plugins</p>
    <p class="quiet plugin-src"><code>${esc(r.source)}</code></p>
    <label class="visually-hidden" for="catalog-filter">Chercher un plugin</label>
    <input id="catalog-filter" class="catalog-filter" type="search" placeholder="Chercher (ex. commit, github)" value="${esc(catalogFilter)}" autocomplete="off" />
    <ul class="catalog-list" id="catalog-list">
      ${shown
        .map(
          (e, i) => `<li>
          <div><strong>${esc(e.name)}</strong><span class="quiet">${esc(e.description)}</span>${e.supported ? "" : `<span class="quiet"> · ${esc(e.why ?? "")}</span>`}</div>
          ${e.supported ? `<button type="button" class="btn secondary" data-catalog-pick="${all.indexOf(e)}"${pluginBusy ? " disabled" : ""}>Relire</button>` : ""}
        </li>`,
        )
        .join("")}
      ${shown.length ? "" : `<li class="quiet">Aucun plugin ne correspond.</li>`}
    </ul>
    <p class="quiet" id="catalog-count" aria-live="polite">${catalogCount(hits.length, all.length, Boolean(q))}</p>
    <p class="inline-error" id="pr-error" role="alert"${pluginError ? "" : " hidden"}>${esc(pluginError)}</p>
    <div class="card-actions"><button type="button" class="btn ghost" data-plugin-cancel>Fermer</button></div>
  </section>`;
}

side.addEventListener("input", (e) => {
  if (e.target.id !== "catalog-filter") return;
  catalogFilter = e.target.value;
  const pos = e.target.selectionStart;
  const box = $("#plugin-review");
  const fresh = document.createElement("div");
  fresh.innerHTML = renderCatalog(pluginReview);
  box.querySelector("#catalog-list").replaceWith(fresh.querySelector("#catalog-list"));
  // Texte changé sur place : la zone annoncée reste la même, le lecteur d'écran dit le nouveau compte.
  box.querySelector("#catalog-count").textContent = fresh.querySelector("#catalog-count").textContent;
  e.target.setSelectionRange(pos, pos);
});

side.addEventListener("click", (e) => {
  if (!e.target.closest("[data-demo-catalog]")) return;
  $("#pl-source").value = state.clark.demoCatalog;
  $("#pl-subdir").value = "";
  $("#pl-source").focus();
});

side.addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-catalog-pick]");
  if (!pick) return;
  const entry = pluginReview.catalog[Number(pick.dataset.catalogPick)];
  const token = pluginReview.token;
  pluginBusy = "review";
  pluginError = "";
  renderSettings();
  try {
    const next = await post("/api/plugins/review", { source: entry.source, subdir: entry.subdir ?? "", ref: entry.ref ?? "" });
    post("/api/plugins/cancel", { token }).catch(() => {});
    pluginReview = next;
    catalogFilter = "";
  } catch (err) {
    pluginError = err.message;
  } finally {
    pluginBusy = null;
    renderSettings();
    $("#pr-title")?.focus?.();
  }
});

/** Lancé sur le Mac (stdio) ou appelé en ligne (http) : la phrase dit ce qui se passe vraiment. */
function mcpKindText(servers) {
  const local = servers.some((m) => m.transport === "stdio");
  const remote = servers.some((m) => m.transport !== "stdio");
  if (local && remote) return "Ces serveurs MCP sont des programmes que Clark lancera sur ton Mac ou des services en ligne qu'il appellera, pour ses agents.";
  if (remote) return `${servers.length > 1 ? "Ces serveurs MCP sont des services en ligne" : "Ce serveur MCP est un service en ligne"} que Clark appellera pour ses agents.`;
  return `${servers.length > 1 ? "Ces serveurs MCP sont des programmes" : "Ce serveur MCP est un programme"} que Clark lancera sur ton Mac pour ses agents.`;
}

function renderPluginReview(r) {
  const h = (title, n) => `<h3 class="review-h">${title}${n !== undefined ? ` <span class="quiet">${n}</span>` : ""}</h3>`;
  const blocked = r.errors.length > 0;
  if (r.catalog) return renderCatalog(r);
  return `<section class="card plugin-review" id="plugin-review" data-token="${esc(r.token)}" aria-labelledby="pr-title">
    <p class="card-title" id="pr-title" tabindex="-1">${r.update ? "Mise à jour de" : "À relire :"} ${esc(r.name || "(sans nom)")}${r.version ? ` ${esc(r.version)}` : ""}</p>
    ${r.description ? `<p class="card-note">${esc(r.description)}${r.author ? ` · ${esc(r.author)}` : ""}</p>` : ""}
    <p class="quiet plugin-src"><code>${esc(r.source)}</code>${r.subdir ? ` › <code>${esc(r.subdir)}</code>` : ""} · version <code>${esc(r.commit.slice(0, 10))}</code></p>
    ${blocked ? `<div class="notice warn"><strong>Installation impossible.</strong><ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
    ${
      r.update
        ? `${h("Ce qui change", r.update.changes.length)}${
            r.update.changes.length
              ? `<ul class="review-list">${r.update.changes.map((c) => `<li><span class="tag">${c.kind}</span> <code>${esc(c.path)}</code></li>`).join("")}</ul>`
              : `<p class="quiet">Rien : c'est la version installée.</p>`
          }`
        : ""
    }
    ${h("Commandes", r.commands.length)}
    ${
      r.commands.length
        ? r.commands
            .map(
              (c) => `<details class="review-item"><summary><code>/${esc(c.name)}</code>${c.renamed ? ` <span class="tag">renommée</span>` : ""} ${esc(c.description)}</summary><p class="quiet">Consigne envoyée à Clark quand tu tapes /${esc(c.name)} :</p><pre class="command-prompt">${esc(c.prompt)}</pre>${
                c.shell.length
                  ? `<p class="quiet">Dans Claude Code, ces commandes shell tournent avant la consigne : ${c.shell.map((x) => `<code>${esc(x)}</code>`).join(", ")}. Clark ne les lance pas ; l'agent devra les lancer lui-même, avec ton accord.</p>`
                  : ""
              }${c.allowedTools ? `<p class="quiet">Outils autorisés d'office par le plugin (<code>${esc(c.allowedTools)}</code>) : ignoré, les règles de Clark s'appliquent.</p>` : ""}</details>`,
            )
            .join("")
        : `<p class="quiet">Aucune.</p>`
    }
    ${h("Skills", r.skills.length)}
    ${
      r.skills.length
        ? r.skills
            .map(
              (k) => `<details class="review-item"><summary><strong>${esc(k.name)}</strong>${k.hidden ? ` <span class="tag">caché</span>` : ""} ${esc(k.description)}</summary>
              <p class="quiet">Méthode lue par Clark quand une demande correspond :</p><pre class="command-prompt">${esc(k.text)}</pre>
              ${
                k.files.length
                  ? `<p class="quiet">Autres fichiers :</p><ul class="review-list">${k.files.map((f) => `<li><code>${esc(f.path)}</code>${f.script ? ` <span class="tag warn-tag">script</span>` : ""}</li>`).join("")}</ul>${
                      k.files.some((f) => f.script) ? `<p class="quiet">Clark ne lance jamais un script de lui-même : un agent ne peut le faire que par le shell, avec ton accord.</p>` : ""
                    }`
                  : ""
              }</details>`,
            )
            .join("")
        : `<p class="quiet">Aucun.</p>`
    }
    ${h("Serveurs MCP", r.mcp.length)}
    ${
      r.mcp.length
        ? `<p class="quiet">${mcpKindText(r.mcp)} Chaque appel de ses outils te demandera ton accord ; tu pourras le régler dans Serveurs MCP.</p>${r.mcp
            .map(
              (m) => `<div class="review-item">
              <p class="review-mcp-name"><strong>${esc(m.name)}</strong> <span class="quiet">${m.transport === "stdio" ? "programme local" : "service en ligne"}</span>${m.name !== m.original ? ` <span class="quiet">(« ${esc(m.original)} » dans le plugin)</span>` : ""}</p>
              <pre class="command-prompt">${m.transport === "stdio" ? esc([m.command, ...(m.args ?? [])].join(" ")) : esc(m.url ?? "")}</pre>
              ${
                (m.vars ?? []).length
                  ? `<p class="quiet">Variables : ${m.vars.map((v) => `<code>${esc(v.name)}</code> ${v.set ? "renseignée" : "à mettre dans .env"}`).join(", ")}</p>`
                  : ""
              }
              ${m.fixed.map((f) => `<p class="quiet">${esc(f)}</p>`).join("")}
            </div>`,
            )
            .join("")}`
        : `<p class="quiet">Aucun.</p>`
    }
    ${
      r.otherFiles.length
        ? `${h("Autres fichiers", r.otherFiles.length)}<p class="quiet">Copiés avec le plugin, jamais utilisés ni lancés par Clark.</p><ul class="review-list">${r.otherFiles
            .slice(0, 40)
            .map((f) => `<li><code>${esc(f.path)}</code>${f.script ? ` <span class="tag warn-tag">script</span>` : ""}</li>`)
            .join("")}${r.otherFiles.length > 40 ? `<li class="quiet">et ${r.otherFiles.length - 40} autres</li>` : ""}</ul>`
        : ""
    }
    ${r.ignored.length ? `${h("Non repris")}<ul class="review-list">${r.ignored.map((i) => `<li><strong>${esc(i.what)}</strong> : ${esc(i.why)}</li>`).join("")}</ul>` : ""}
    ${r.warnings.length ? `${h("À savoir")}<ul class="review-list">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    <p class="inline-error" id="pr-error" role="alert"${pluginError ? "" : " hidden"}>${esc(pluginError)}</p>
    <div class="card-actions">
      <button type="button" class="btn primary" data-plugin-install${blocked || pluginBusy ? " disabled" : ""}>${pluginBusy === "install" ? "Installation…" : r.update ? "Mettre à jour" : "Installer"}</button>
      <button type="button" class="btn ghost" data-plugin-cancel>Annuler</button>
    </div>
  </section>`;
}

side.addEventListener("submit", async (e) => {
  if (e.target.id !== "plugin-form") return;
  e.preventDefault();
  const f = e.target.elements;
  pluginBusy = "review";
  pluginError = "";
  const source = f.source.value;
  const subdir = f.subdir.value;
  renderSettings();
  try {
    pluginReview = await post("/api/plugins/review", { source, subdir });
    // Un autre catalogue s'ouvre : la recherche tapée dans le précédent n'a plus de sens.
    catalogFilter = "";
  } catch (err) {
    pluginError = err.message;
  } finally {
    pluginBusy = null;
    renderSettings();
    if (pluginReview) $("#pr-title")?.focus?.();
    if (pluginError) {
      const s = $("#pl-source");
      if (s) {
        s.value = source;
        $("#pl-subdir").value = subdir;
        s.focus();
      }
    }
  }
});

side.addEventListener("click", async (e) => {
  if (e.target.closest("[data-plugin-cancel]")) {
    const token = pluginReview?.token;
    pluginReview = null;
    pluginError = "";
    catalogFilter = "";
    renderSettings();
    if (token) post("/api/plugins/cancel", { token }).catch(() => {});
    return;
  }
  if (e.target.closest("[data-plugin-install]")) {
    pluginBusy = "install";
    pluginError = "";
    renderSettings();
    try {
      const p = await post("/api/plugins/install", { token: pluginReview.token });
      pluginReview = null;
      $("#announce").textContent = `Plugin ${p.name} installé`;
    } catch (err) {
      pluginError = err.message;
    } finally {
      pluginBusy = null;
      renderSettings();
    }
    return;
  }
  const b = e.target.closest("[data-plugin-action]");
  if (!b) return;
  const name = b.closest("[data-plugin]").dataset.plugin;
  const action = b.dataset.pluginAction;
  if (action === "uninstall" && !(await ask(`Désinstaller ${name} ?`, "Ses commandes, skills et serveurs MCP sont retirés, et son dossier supprimé.", "Désinstaller"))) return;
  if (action === "check") {
    pluginBusy = name;
    pluginError = "";
    renderSettings();
    try {
      pluginReview = await post(`/api/plugins/${name}`, { action });
    } catch (err) {
      pluginError = err.message;
    } finally {
      pluginBusy = null;
      renderSettings();
    }
    return;
  }
  b.disabled = true;
  try {
    await post(`/api/plugins/${name}`, { action });
  } catch (err) {
    pluginError = err.message;
    renderSettings();
  }
});

function buildSettings() {
  const { clark, budget, memory } = state;
  let html = renderPersonalityVoice() + buildPluginsSection() + renderCommands(state.commands ?? []) + renderSkills(state.skills ?? []);
  html += renderAutomations(state.automations);
  html += section(
    "memory",
    "Mémoire",
    `${memory.count} souvenir${memory.count > 1 ? "s" : ""}`,
    memory.top.length
      ? `<ul class="memories">${memory.top.map(renderMemory).join("")}</ul>`
      : `<p class="quiet">Rien encore. Clark te propose ce qui mérite d'être retenu, et n'utilise que ce que tu as confirmé.</p>`,
  );
  html += renderPublished(state.published) || section("publish", "Prêts à publier", "", `<p class="quiet">Aucun contenu validé pour l'instant.</p>`);

  if (clark.engine.name === "demo" || clark.engine.account === "clé API") {
    const ratio = budget.max > 0 ? Math.min(1, budget.spent / budget.max) : 0;
    html += section(
      "budget",
      "Dépense du jour",
      "",
      `<div class="figure">${usd(budget.spent)} <small>sur ${usd(budget.max)}</small></div>
      <div class="bar${ratio >= 1 ? " full" : ""}" role="progressbar" aria-label="Part du budget du jour utilisée" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}"><span data-ratio="${ratio}"></span></div>
      <p class="quiet">Au plus ${usd(budget.perTask)} par tâche. Remis à zéro à minuit.</p>`,
    );
  }
  return html;
}

