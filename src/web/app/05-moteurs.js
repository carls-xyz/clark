// ── Moteurs : quota, modèle et niveau d’effort, pour Claude et Codex ──

const ENGINE_NAMES = { claude: "Claude", codex: "Codex" };
const EFFORT_LABELS = { none: "aucune", minimal: "minimale", low: "faible", medium: "moyenne", high: "élevée", xhigh: "très élevée", max: "maximale", ultra: "ultra" };
const claudePlans = { pro: "Claude Pro", max: "Claude Max", team: "Claude Team", enterprise: "Claude Enterprise" };

function quotaRows(q, name, compact = false) {
  return q.windows
    .map((w) => {
      const pct = Math.round(w.usedPercent);
      const level = q.reached || pct >= 100 ? " full" : pct >= 90 ? " near" : "";
      const label = compact ? w.label.replace(/^Fenêtre de /, "") : w.label;
      return `<div class="quota-row"${compact ? ` title="${esc(resetText(w.resetsAt))}"` : ""}>
        <div class="quota-line"><span>${esc(label)}</span><span class="quota-pct">${pct} %${compact ? "" : " utilisés"}</span></div>
        <div class="bar${level}" role="progressbar" aria-label="${esc(ENGINE_NAMES[name])}, ${esc(w.label)} : part du quota utilisée, ${esc(resetText(w.resetsAt))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span data-ratio="${pct / 100}"></span></div>
        ${compact ? "" : `<p class="quiet">${resetText(w.resetsAt)}</p>`}
      </div>`;
    })
    .join("");
}

/**
 * Effort : curseur à crans, d'après le « Sleek Effort Slider » de HorizonX. Les crans sont
 * les niveaux que le modèle propose ; la couleur d'accent monte à chaque cran. « Auto » est un
 * bouton à part : il rend le choix au moteur (son niveau par défaut). Un vrai
 * <input type="range"> : clavier, lecteur d'écran et tactile marchent tels quels.
 * Le même rendu sert à la barre latérale (compact) et à Plugins › Moteurs (complet).
 */
const effortLabel = (stop) => (stop ? (EFFORT_LABELS[stop] ?? stop) : "auto");
function effortSlider(e, current, idp, compact = false) {
  const efforts = current?.efforts ?? [];
  const id = `${idp}effort-${e.name}`;
  if (!current || !efforts.length) {
    return `<div class="effort is-off">
      <div class="effort-head"><span class="effort-title">Effort</span><span class="effort-value">auto</span></div>
      <p class="quiet effort-note">${!current ? "Choisis un modèle pour régler l'effort." : "Ce modèle n'a pas de niveaux d'effort."}</p>
    </div>`;
  }
  const chosen = e.choice.effort && efforts.includes(e.choice.effort) ? e.choice.effort : null;
  // En Auto, la poignée se pose sur le niveau par défaut du moteur s'il le donne, sinon au milieu.
  const autoAt = current.defaultEffort && efforts.includes(current.defaultEffort) ? efforts.indexOf(current.defaultEffort) : Math.floor((efforts.length - 1) / 2);
  const index = chosen ? efforts.indexOf(chosen) : autoAt;
  const rec = current.defaultEffort ? efforts.indexOf(current.defaultEffort) : -1;
  const last = efforts.length - 1;
  const pos = (i) => (last ? i / last : 0);
  const shown = chosen ? effortLabel(chosen) : "auto";
  return `<div class="effort${chosen ? "" : " is-auto"}${compact ? " is-compact" : ""}" data-effort-box data-pos="${pos(index)}">
    <div class="effort-head">
      <label class="effort-title" for="${id}">Effort</label>
      <span class="effort-value" data-effort-value aria-live="polite">${esc(shown)}</span>
      <button type="button" class="effort-auto" data-effort-auto aria-pressed="${chosen ? "false" : "true"}" title="Revenir au réglage par défaut du moteur">Auto</button>
    </div>
    ${compact ? "" : `<div class="effort-captions" aria-hidden="true"><span>Rapide</span><span>Réfléchi</span></div>`}
    <div class="effort-track">
      <span class="effort-rail" aria-hidden="true"></span>
      <span class="effort-fill" aria-hidden="true"></span>
      ${efforts.map((_, i) => `<span class="effort-tick${i <= index ? " is-on" : ""}" data-pos="${pos(i)}" aria-hidden="true"></span>`).join("")}
      <input type="range" id="${id}" data-engine-effort min="0" max="${last}" step="1" value="${index}"
        data-stops='${esc(JSON.stringify(efforts))}' aria-valuetext="${esc(shown)}" />
    </div>
    ${
      compact
        ? ""
        : `<div class="effort-levels" aria-hidden="true">${efforts
            .map((x, i) => `<span class="effort-level${i === rec ? " is-rec" : ""}" data-pos="${pos(i)}">${esc(effortLabel(x))}</span>`)
            .join("")}</div>${rec >= 0 ? `<p class="quiet effort-note">Souligné : le niveau par défaut de ${esc(current.name)}, celui qu'Auto utilise.</p>` : ""}`
    }
  </div>`;
}

/** Positions des crans et du remplissage : la CSP interdit le style en ligne, on passe par le CSSOM. */
function placeEffort(root) {
  root.querySelectorAll(".effort [data-pos], .effort[data-pos]").forEach((el) => el.style.setProperty("--p", el.dataset.pos));
}

/** Pendant le glissement : la valeur, la couleur et les crans suivent, sans attendre l'envoi. */
function showEffort(box, i, auto = false) {
  const range = box.querySelector("[data-engine-effort]");
  const stops = JSON.parse(range.dataset.stops);
  const p = stops.length > 1 ? i / (stops.length - 1) : 0;
  const label = auto ? "auto" : effortLabel(stops[i]);
  box.dataset.pos = String(p);
  box.style.setProperty("--p", String(p));
  box.classList.toggle("is-auto", auto);
  box.querySelector("[data-effort-auto]")?.setAttribute("aria-pressed", String(auto));
  const value = box.querySelector("[data-effort-value]");
  if (value.textContent !== label) {
    value.textContent = label;
    // Petit fondu du nom du niveau (rejoué à chaque changement).
    value.classList.remove("is-new");
    void value.offsetWidth;
    value.classList.add("is-new");
  }
  range.setAttribute("aria-valuetext", label);
  box.querySelectorAll(".effort-tick").forEach((t, k) => t.classList.toggle("is-on", k <= i));
}

side.addEventListener("input", (e) => {
  const range = e.target.closest?.('input[type="range"][data-engine-effort]');
  if (!range) return;
  showEffort(range.closest("[data-effort-box]"), Number(range.value));
});

/** Auto : on rend l'effort au moteur et la poignée revient sur son niveau par défaut. */
side.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-effort-auto]");
  if (!btn || btn.getAttribute("aria-pressed") === "true") return;
  const box = btn.closest("[data-engine]");
  const range = box.querySelector("[data-engine-effort]");
  const name = box.dataset.engine;
  const engine = (state.engines ?? []).find((x) => x.name === name);
  const m = engine?.models.find((x) => x.id === engine.choice.model);
  const stops = JSON.parse(range.dataset.stops);
  const at = m?.defaultEffort && stops.includes(m.defaultEffort) ? stops.indexOf(m.defaultEffort) : Math.floor((stops.length - 1) / 2);
  range.value = String(at);
  showEffort(range.closest("[data-effort-box]"), at, true);
  void saveEngineChoice(box, btn);
});

const LOGIN_SITES = { claude: "d'Anthropic", codex: "d'OpenAI" };
/** Connexion d'un moteur : un bouton, puis le suivi (lien, code à coller, redémarrage). */
function renderLogin(e) {
  const title = ENGINE_NAMES[e.name];
  const l = e.login;
  const cmd = /Lance une fois : /.test(e.problem ?? "") ? e.problem.split("Lance une fois : ")[1] : null;
  const terminal = cmd ? `<details class="engine-terminal"><summary>Ou dans un terminal</summary><code class="engine-cmd">${esc(cmd)}</code></details>` : "";
  if (e.ready && e.restartNeeded) {
    return `<div class="engine-login" data-engine-login-box>
      <p>Connecté. Clark s'en servira après un redémarrage.</p>
      ${e.canRestart ? `<div class="card-actions"><button type="button" class="btn primary" data-restart>Redémarrer Clark</button></div>` : `<p class="quiet">Redémarre Clark : <code>scripts/service.sh restart</code></p>`}
    </div>`;
  }
  if (e.ready) return "";
  if (!l || l.status === "failed") {
    return `<div class="engine-login" data-engine-login-box>
      ${l?.error ? `<p class="inline-error" role="alert">${esc(l.error)}</p>` : `<p class="quiet">Pas connecté.${e.problem && !cmd && e.problem !== "not_checked" ? ` ${esc(e.problem)}` : ""}</p>`}
      <div class="card-actions"><button type="button" class="btn primary" data-engine-login="start">${l ? "Réessayer" : `Connecter ${title}`}</button></div>
      ${terminal}
    </div>`;
  }
  if (l.status === "done") return `<div class="engine-login" data-engine-login-box><p class="quiet">Connecté, vérification…</p></div>`;
  const code = l.asksCode
    ? l.codeSent
      ? `<p class="quiet" role="status">Code envoyé, vérification…</p>`
      : `<form class="engine-code auto-form" data-login-code novalidate>
          <label for="login-code-${e.name}">Si la page affiche un code, colle-le ici</label>
          <div class="voice-pick"><input id="login-code-${e.name}" name="code" type="text" autocomplete="off" spellcheck="false" /><button type="submit" class="btn secondary">Valider</button></div>
        </form>`
    : "";
  return `<div class="engine-login" data-engine-login-box>
    <p role="status">Ton navigateur s'ouvre sur la page de connexion ${LOGIN_SITES[e.name]}. Connecte-toi, puis reviens ici.</p>
    ${l.url ? `<p><a class="link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Ouvrir la page de connexion</a></p>` : ""}
    ${code}
    <div class="card-actions"><button type="button" class="btn ghost" data-engine-login="cancel">Annuler</button></div>
  </div>`;
}

function loginError(box, message) {
  if (!box) return;
  box.querySelector(".login-error")?.remove();
  box.insertAdjacentHTML("afterbegin", `<p class="inline-error login-error" role="alert">${esc(message)}</p>`);
}

side.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-engine-login], [data-restart]");
  if (!btn) return;
  const box = btn.closest("[data-engine-login-box]");
  btn.blur(); // le bloc du moteur doit pouvoir se reconstruire (lien, champ du code)
  try {
    if (btn.matches("[data-restart]")) {
      btn.disabled = true;
      btn.textContent = "Redémarrage…";
      await post("/api/restart", {});
      return;
    }
    const engine = btn.closest("[data-engine]").dataset.engine;
    await post(`/api/engines/${engine}/login`, { action: btn.dataset.engineLogin });
  } catch (err) {
    loginError(box, err.message);
  }
});

side.addEventListener("submit", async (ev) => {
  const form = ev.target.closest("[data-login-code]");
  if (!form) return;
  ev.preventDefault();
  const input = form.elements.code;
  if (!input.value.trim()) return input.focus();
  input.blur();
  try {
    await post(`/api/engines/${form.closest("[data-engine]").dataset.engine}/login`, { action: "code", code: input.value });
  } catch (err) {
    loginError(form.closest("[data-engine-login-box]"), err.message);
  }
});

/**
 * Un moteur : complet dans Plugins, compact dans la fenêtre du moteur, « nu » en bas de la
 * barre latérale (modèle puis effort, sans quota). idp distingue les identifiants.
 */
function renderEngine(e, { compact = false, idp = "", bare = false } = {}) {
  if (bare) compact = true;
  const title = ENGINE_NAMES[e.name];
  const plan = e.quota?.plan ? (planNames[e.quota.plan] ?? claudePlans[e.quota.plan] ?? e.quota.plan) : e.account;
  const head = compact
    ? `<div class="engine-head"><span class="engine-name">${title}</span>${plan ? `<span class="engine-plan">${esc(plan)}</span>` : ""}</div>`
    : `<div class="engine-head"><h3 class="engine-name">${title}</h3>${e.main ? `<span class="tag">principal</span>` : ""}${plan ? `<span class="engine-plan">${esc(plan)}</span>` : ""}</div>`;
  const problem = e.ready === false && compact ? `<p class="quiet">Pas connecté : <a href="#reglages/moteurs">connecter ${title}</a>.</p>` : compact ? "" : renderLogin(e);

  let quota = "";
  if (e.quota && e.quota.windows.length) {
    const when = new Date(e.quota.readAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    quota = `${e.quota.reached ? `<p class="quota-alert">Limite atteinte : ${title} ne répondra plus avant la remise à zéro.</p>` : ""}${quotaRows(e.quota, e.name, compact)}${compact ? "" : `<p class="quota-read">lu à ${when}</p>`}`;
  } else if (e.ready && !compact) {
    quota = `<p class="quiet">Quota pas encore donné par ${title}.</p>`;
  }

  // Sélecteurs : seulement les modèles et niveaux que le moteur propose lui-même.
  const models = e.models ?? [];
  const current = models.find((m) => m.id === e.choice.model) ?? null;
  const fallback = compact ? "Par défaut" : e.fallbackModel ? `Par défaut (${esc(e.fallbackModel)})` : "Par défaut du moteur";
  const modelSelect = models.length
    ? `<label class="field-label" for="${idp}model-${e.name}">Modèle</label>
       <select id="${idp}model-${e.name}" data-engine-model>
         <option value="">${fallback}</option>
         ${models.map((m) => `<option value="${esc(m.id)}"${m.id === e.choice.model ? " selected" : ""}>${esc(m.name)}</option>`).join("")}
       </select>`
    : compact
      ? ""
      : `<p class="quiet">${e.modelsError ? `Liste des modèles indisponible : ${esc(e.modelsError)}` : "Liste des modèles pas encore lue."}</p>`;
  const about = !compact && current?.description ? `<p class="quiet engine-about">${esc(current.description)}</p>` : "";
  const effortSelect = models.length ? `${about}${effortSlider(e, current, idp, compact)}` : "";

  // Compact : réglages d'abord (ce qu'on change), quota ensuite (ce qu'on surveille).
  if (bare) return models.length ? `<div class="engine compact bare" data-engine="${e.name}"><div class="engine-fields">${modelSelect}${effortSelect}</div></div>` : "";
  return compact
    ? `<div class="engine compact" data-engine="${e.name}">${head}${problem}<div class="engine-fields">${modelSelect}${effortSelect}</div>${quota}</div>`
    : `<div class="engine" data-engine="${e.name}">${head}${problem}${quota}<div class="engine-fields">${modelSelect}${effortSelect}</div></div>`;
}

function renderEngines(list) {
  return `<section class="block" aria-labelledby="h-engines">
    <div class="block-head"><h2 class="block-title" id="h-engines">Moteurs</h2><button type="button" class="link" data-engines-refresh>Actualiser</button></div>
    ${list.map(renderEngine).join("")}
    <p class="quiet">Un nouveau choix vaut pour les prochaines tâches ; celles en cours gardent le leur. Plus d’effort : réponses plus réfléchies, plus lentes, et plus de quota consommé.</p>
  </section>`;
}

// Le curseur d'effort enregistre 300 ms après le dernier cran : au clavier ou en glissant,
// il reste actif (un curseur désactivé perdrait les flèches suivantes) et un seul envoi part.
const effortTimers = new WeakMap();
side.addEventListener("change", (e) => {
  const select = e.target.closest("[data-engine-model], [data-engine-effort]");
  if (!select) return;
  const box = select.closest("[data-engine]");
  if (select.type === "range") {
    clearTimeout(effortTimers.get(box));
    box.dataset.busy = "1"; // pas de reconstruction du bloc pendant le réglage
    effortTimers.set(box, setTimeout(() => void saveEngineChoice(box, select), 300));
    return;
  }
  void saveEngineChoice(box, select);
});

async function saveEngineChoice(box, select) {
  const name = box.dataset.engine;
  const engine = (state.engines ?? []).find((x) => x.name === name);
  const model = box.querySelector("[data-engine-model]").value || null;
  const effortEl = box.querySelector("[data-engine-effort]");
  let effort = effortEl ? (effortEl.type === "range" ? JSON.parse(effortEl.dataset.stops)[Number(effortEl.value)] || null : effortEl.value || null) : null;
  // Auto : l'effort revient au moteur.
  if (select.matches("[data-effort-auto]")) effort = null;
  // Nouveau modèle : on ne lit pas le curseur (il montre encore l'ancien) mais le choix enregistré.
  if (select.matches("[data-engine-model]")) effort = engine?.choice.effort ?? null;
  // Nouveau modèle : on garde l’effort seulement s'il la propose.
  const m = engine?.models.find((x) => x.id === model);
  if (select.matches("[data-engine-model]") && effort && !m?.efforts.includes(effort)) effort = null;
  if (!model) effort = null;
  box.querySelector(".inline-error")?.remove();
  box.dataset.busy = "1";
  // Un menu se fige pendant l'envoi ; le curseur reste utilisable (son focus aussi).
  if (select.tagName === "SELECT") box.querySelectorAll("select").forEach((s) => (s.disabled = true));
  try {
    await post(`/api/engines/${name}`, { model, effort });
    delete box.dataset.busy;
    if (select.tagName === "SELECT") select.blur();
  } catch (err) {
    delete box.dataset.busy;
    // Refusé : les menus reviennent au choix enregistré.
    if (engine) {
      box.querySelector("[data-engine-model]").value = engine.choice.model ?? "";
      const eff = box.querySelector("[data-engine-effort]");
      if (eff?.type === "range") {
        const stops = JSON.parse(eff.dataset.stops);
        const at = stops.indexOf(engine.choice.effort ?? "");
        if (at >= 0) eff.value = String(at);
        showEffort(eff.closest("[data-effort-box]"), Number(eff.value), at < 0); // crans et valeur reviennent aussi
      }
      else if (eff) eff.value = engine.choice.effort ?? "";
    }
    box.querySelectorAll("select, input").forEach((s) => (s.disabled = false));
    box.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
}

side.addEventListener("click", async (e) => {
  const refresh = e.target.closest("[data-engines-refresh]");
  if (!refresh) return;
  refresh.disabled = true;
  refresh.textContent = "Lecture…";
  try {
    await post("/api/engines/refresh", {});
  } catch (err) {
    refresh.disabled = false;
    refresh.textContent = "Actualiser";
    refresh.parentElement.querySelector(".inline-error")?.remove();
    refresh.insertAdjacentHTML("afterend", `<span class="inline-error" role="alert"> ${esc(err.message)}</span>`);
  }
});

