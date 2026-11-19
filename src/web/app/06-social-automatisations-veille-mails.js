// ── Réseaux sociaux : contenus validés, prêts à publier ─────────────────

function renderPublished(list) {
  if (!list.length) return "";
  return `<section class="block" aria-labelledby="h-publish">
    <div class="block-head"><h2 class="block-title" id="h-publish">Prêts à publier</h2><span class="block-count">${list.length}</span></div>
    <ul class="memories">${list
      .map(
        (p) => `<li>
          <span class="kind">${esc(p.platform)} · validé ${p.at ? shortDate(p.at) : ""}</span>
          <span>${esc(p.title)}</span>
          <span class="origin"><a href="${esc(p.media)}" download>Télécharger la vidéo</a> · ${esc((p.file ?? "").split("/workspace/")[1] ?? "")}</span>
        </li>`,
      )
      .join("")}</ul>
  </section>`;
}

// ── Automatisations planifiées ───────────────────────────────────────────

let autoFormOpen = false;
const lastStatus = { queued: "en file", running: "en cours", done: "faite", failed: "échec", needs_check: "à vérifier", abandoned: "abandonnée" };

function renderAutomationForm() {
  return `<form class="card auto-form" id="auto-form" novalidate>
    <label for="af-name">Nom</label>
    <input id="af-name" name="name" type="text" maxlength="80" placeholder="Point candidatures" />
    <label for="af-prompt">Consigne</label>
    <textarea id="af-prompt" name="prompt" rows="3" maxlength="4000" placeholder="Fais le point sur mes candidatures et propose les relances du jour"></textarea>
    <div class="auto-when">
      <div>
        <label for="af-frequency">Fréquence</label>
        <select id="af-frequency" name="frequency">
          <option value="daily">Chaque jour</option>
          <option value="weekdays" selected>En semaine</option>
          <option value="weekly">Chaque semaine</option>
          <option value="hourly">Chaque heure</option>
        </select>
      </div>
      <div class="af-weekday" hidden>
        <label for="af-weekday">Jour</label>
        <select id="af-weekday" name="weekday">
          ${["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"].map((d, i) => `<option value="${i + 1}">${d}</option>`).join("")}
        </select>
      </div>
      <div>
        <label for="af-time">Heure</label>
        <input id="af-time" name="time" type="time" value="09:00" />
      </div>
    </div>
    <label for="af-kind">Ce qu'elle lance</label>
    <select id="af-kind" name="kind">
      <option value="chat">Un message à Clark</option>
      <option value="team">L'équipe d'agents</option>
      <option value="dev"${(state.dev?.projects ?? []).length ? "" : " disabled"}>Une tâche dev, à relire</option>
    </select>
    <div class="af-project" hidden>
      <label for="af-project">Projet</label>
      <select id="af-project" name="projectId">${(state.dev?.projects ?? []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>
    </div>
    <div class="af-thread">
      <label for="af-thread">Où</label>
      <select id="af-thread" name="thread">
        <option value="main">Dans ta conversation</option>
        <option value="own">Dans son propre fil (le résultat t'est annoncé)</option>
      </select>
    </div>
    <label for="af-engine">Moteur et modèle</label>
    <select id="af-engine" name="engine"><option value="|">Moteur principal, réglages actuels</option>${(state.engines ?? [])
      .filter((e) => e.ready !== false)
      .map(
        (e) => `<optgroup label="${esc(ENGINE_NAMES[e.name] ?? e.name)}"><option value="${e.name}|">${esc(ENGINE_NAMES[e.name] ?? e.name)} · modèle des réglages</option>${(e.models ?? [])
          .map((m) => `<option value="${e.name}|${esc(m.id)}">${esc(ENGINE_NAMES[e.name] ?? e.name)} · ${esc(m.name)}</option>`)
          .join("")}</optgroup>`,
      )
      .join("")}</select>
    <label for="af-effort">Effort</label>
    <select id="af-effort" name="effort"><option value="">Celui des réglages</option>${[...new Set((state.engines ?? []).flatMap((e) => (e.models ?? []).flatMap((m) => m.efforts ?? [])))]
      .map((x) => `<option value="${x}">${esc(EFFORT_LABELS[x] ?? x)}</option>`)
      .join("")}</select>
    <label for="af-precheck">Pré-vérification <span class="optional">(facultatif)</span></label>
    <input id="af-precheck" name="precheck" type="text" maxlength="300" autocomplete="off" spellcheck="false" placeholder="gh pr list --state open | grep -q ." aria-describedby="af-precheck-hint" />
    <p class="quiet field-hint" id="af-precheck-hint">Une commande lancée juste avant : si elle échoue, l'occurrence est sautée et rien n'est consommé. Exemple : seulement s'il y a des PR ouvertes.</p>
    <label class="team-toggle" for="af-paused"><input type="checkbox" id="af-paused" name="paused" /> Créer en pause, pour l'essayer avec « Lancer maintenant » d'abord</label>
    <p class="inline-error" id="af-error" role="alert" hidden></p>
    <div class="card-actions">
      <button type="submit" class="btn primary">Créer</button>
      <button type="button" class="btn ghost" data-auto="cancel">Annuler</button>
    </div>
  </form>`;
}

function renderAutomations(list) {
  const items = list
    .map(
      (a) => `<div class="card auto${a.enabled ? "" : " off"}" data-automation="${a.id}">
        <p class="card-title">${esc(a.name)}${a.kind === "team" ? ` <span class="kind-line inline">équipe</span>` : a.kind === "dev" ? ` <span class="kind-line inline">tâche dev · ${esc(a.project ?? "?")}</span>` : ""}${a.thread === "own" ? ` <span class="kind-line inline">fil à part</span>` : ""}</p>
        <p class="auto-meta">${esc(a.schedule)} · prochaine : ${esc(a.next)}${a.engine ? ` · ${esc(ENGINE_NAMES[a.engine] ?? a.engine)}${a.model ? ` ${esc(a.model)}` : ""}${a.effort ? `, effort ${esc(EFFORT_LABELS[a.effort] ?? a.effort)}` : ""}` : ""}</p>
        ${a.precheck ? `<p class="auto-meta">Seulement si <code>${esc(a.precheck)}</code> réussit</p>` : ""}
        <p class="auto-prompt" title="${esc(a.prompt)}">${esc(a.prompt)}</p>
        ${
          a.runs?.length
            ? `<details class="goal-log auto-runs"><summary>Dernières exécutions (${a.runs.length})</summary><ul class="auto-run-list">${a.runs
                .map((r) => {
                  const when = `${shortDate(r.at)} ${time(parseDate(r.at))}${r.manual ? " · à la main" : ""}`;
                  const what =
                    r.status === "skipped"
                      ? `sautée${r.note ? ` : ${esc(r.note)}` : ""}`
                      : r.status === "failed"
                        ? `en échec : ${esc(r.note ?? "")}`
                        : r.dev
                          ? `<a href="#dev/${r.dev.id}">tâche dev #${r.dev.id}</a> · ${devStatus[r.dev.status] ?? esc(r.dev.status ?? "?")}`
                          : r.task
                            ? lastStatus[r.task] ?? esc(r.task)
                            : "lancée";
                  return `<li><span class="quiet">${when}</span><span>${what}</span></li>`;
                })
                .join("")}</ul></details>`
            : ""
        }
        <div class="card-actions">
          <button type="button" class="btn secondary" data-auto="run">Lancer maintenant</button>
          <button type="button" class="btn ghost" data-auto="${a.enabled ? "disable" : "enable"}">${a.enabled ? "Couper" : "Réactiver"}</button>
          <button type="button" class="btn ghost" data-auto="delete">Supprimer</button>
        </div>
      </div>`,
    )
    .join("");
  return `<section class="block" aria-labelledby="h-auto">
    <div class="block-head"><h2 class="block-title" id="h-auto">Automatisations</h2>${list.length ? `<span class="block-count">${list.length}</span>` : ""}</div>
    ${list.length ? items : autoFormOpen ? "" : `<p class="quiet">Aucune. Une automatisation lance une consigne toute seule, à heure fixe (heure de Paris).</p>`}
    ${autoFormOpen ? renderAutomationForm() : `<button type="button" class="btn secondary auto-new" data-auto="new">Nouvelle automatisation</button>`}
  </section>`;
}

side.addEventListener("change", (e) => {
  if (e.target.id === "af-frequency") side.querySelector(".af-weekday").hidden = e.target.value !== "weekly";
  if (e.target.id === "af-kind") {
    side.querySelector(".af-project").hidden = e.target.value !== "dev";
    side.querySelector(".af-thread").hidden = e.target.value === "dev";
  }
});

side.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-auto]");
  if (!button) return;
  const action = button.dataset.auto;
  if (action === "new") {
    autoFormOpen = true;
    render();
    side.querySelector("#af-name")?.focus();
    return;
  }
  if (action === "cancel") {
    autoFormOpen = false;
    render();
    return;
  }
  const card = button.closest("[data-automation]");
  if (action === "delete" && !(await ask("Supprimer cette automatisation ?", "Elle ne se lancera plus. Les tâches déjà faites restent dans l'historique.", "Supprimer"))) return;
  button.disabled = true;
  try {
    await post(`/api/automations/${card.dataset.automation}`, { action });
  } catch (err) {
    button.disabled = false;
    card.querySelector(".inline-error")?.remove();
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

side.addEventListener("submit", async (e) => {
  const form = e.target.closest("#auto-form");
  if (!form) return;
  e.preventDefault();
  const f = form.elements;
  const error = form.querySelector("#af-error");
  const body = {
    name: f.name.value.trim(),
    prompt: f.prompt.value.trim(),
    frequency: f.frequency.value,
    time: f.time.value,
    weekday: Number(f.weekday.value),
    kind: f.kind.value,
    projectId: f.kind.value === "dev" ? Number(f.projectId.value) : null,
    thread: f.thread.value,
    engine: f.engine.value.split("|")[0],
    model: f.engine.value.split("|")[1] ?? "",
    effort: f.engine.value.split("|")[0] ? f.effort.value : "",
    precheck: f.precheck.value.trim(),
    enabled: !f.paused.checked,
  };
  // Vérifié aussi par le serveur ; ici, pour placer le message à côté du bon champ.
  const fail = (msg, field) => {
    error.textContent = msg;
    error.hidden = false;
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", "af-error");
      field.focus();
    }
  };
  if (body.name.length < 2) return fail("Donne un nom (2 caractères au moins)", f.name);
  if (body.prompt.length < 5) return fail("Écris la consigne (5 caractères au moins)", f.prompt);
  if (!/^\d\d:\d\d$/.test(body.time)) return fail("Choisis une heure", f.time);
  if (form.dataset.busy) return; // double clic, ou Entrée deux fois : une seule création
  form.dataset.busy = "1";
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    await post("/api/automations", body);
    autoFormOpen = false;
    render();
  } catch (err) {
    fail(err.message);
  } finally {
    delete form.dataset.busy;
    if (submit) submit.disabled = false;
  }
});

const teamStatus = {
  waiting: "en attente",
  queued: "en file",
  running: "en cours",
  done: "fait",
  needs_check: "à vérifier",
  failed: "échec",
  abandoned: "abandonné",
};

const engineNames = { claude: "Claude", codex: "Codex" };
const roleNames = { plan: "Plan", chercheur: "Chercheur", contenu: "Contenu", redacteur: "Rédacteur", relecteur: "Relecteur", temporaire: "Temporaires", synthese: "Synthèse" };

/** Moteur par rôle : affiché seulement quand il diffère du moteur principal, ou qu'il manque. */
function renderRoleEngines(clark) {
  const special = (clark.roleEngines ?? []).filter((r) => r.special);
  if (!special.length) return "";
  const items = special.map(
    (r) =>
      `${roleNames[r.role] ?? r.role} → ${engineNames[r.actual] ?? r.actual}${r.actual !== r.wanted ? ` (${engineNames[r.wanted] ?? r.wanted} indisponible)` : ""}`,
  );
  return `<p class="channels">Moteurs par rôle : ${esc(items.join(" · "))}</p>`;
}

/** Arbre de l'équipe : Plan → Chercheur → Rédacteur → Relecteur, avec le statut de chacun. */
function renderTeam(team) {
  // Le moteur de chaque agent n'est affiché que si l'équipe en mélange plusieurs (regard croisé).
  const mixed = new Set(team.agents.map((a) => a.engine).filter(Boolean)).size > 1;
  return `<div class="team">
    <p class="team-plan"><span>Plan</span> ${esc(team.plan)}</p>
    <ol class="team-agents">${team.agents
      .map(
        (a) => `<li data-status="${a.status}">
          <span class="dot" aria-hidden="true"></span>
          <span class="who">${sprite(a.temporary ? "temporaire" : a.role ?? roleOfName(a.name), { walking: a.status === "running" })}${esc(a.name)}${a.round && a.round > 1 ? ` <span class="round">v${a.round}</span>` : ""}${a.temporary ? ` <span class="round">temporaire</span>` : ""}${mixed && a.engine ? ` <span class="round">${esc(engineNames[a.engine] ?? a.engine)}</span>` : ""}</span>
          <span class="state">${teamStatus[a.status] ?? esc(a.status)}</span>
          ${a.after ? `<span class="detail wrap">${esc(a.after)}</span>` : ""}
          ${a.checkpoint ? `<span class="checkpoint" title="Point d'étape de l'agent">${esc(a.checkpoint)}</span>` : ""}
          ${a.detail ? `<span class="detail" title="${esc(a.detail)}">${esc(a.detail)}</span>` : ""}
        </li>`,
      )
      .join("")}</ol>
  </div>`;
}

// ── Tour de veille : propositions de Clark ──────────────────────────────

function heartbeatLine(h) {
  if (!h || h.minutes <= 0) return `<p class="quiet">Tour de veille coupé.</p>`;
  const next = h.next ? new Date(h.next).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : null;
  const when = h.why === "prochain tour" && next ? `prochain tour à ${next}` : h.why === "maintenant" ? "tour en cours de lancement" : h.why;
  return `<p class="quiet">Tour de veille toutes les ${h.minutes} min, de 8 h à 22 h : ${esc(when)}. <button type="button" class="link" data-heartbeat="run">Faire un tour maintenant</button></p>`;
}

function renderInitiatives(list, heartbeat) {
  const cards = list
    .map(
      (i) => `<div class="card" data-initiative="${i.id}">
        <p class="card-title">${esc(i.title)}</p>
        <p class="card-note">${esc(i.why)}</p>
        ${i.source ? `<p class="auto-meta">source : ${esc(i.source)}</p>` : ""}
        <p class="auto-prompt" title="${esc(i.action)}">Si tu acceptes : ${esc(i.action)}</p>
        <div class="card-actions">
          <button type="button" class="btn primary" data-initiative-action="accept">Accepter</button>
          <button type="button" class="btn ghost" data-initiative-action="decline">Refuser</button>
        </div>
      </div>`,
    )
    .join("");
  return `<section class="block" aria-labelledby="h-initiatives">
    <div class="block-head"><h2 class="block-title" id="h-initiatives">Propositions de Clark</h2>${list.length ? `<span class="block-count">${list.length}</span>` : ""}</div>
    ${cards || `<p class="quiet">Aucune pour l'instant.</p>`}
    ${heartbeatLine(heartbeat)}
  </section>`;
}

// ── Mails : chaque envoi attend ton accord, sur le texte exact ─────────────

/** Mail à valider : dans le fil, comme une demande d'accord, avec le texte exact. */
function renderMailCard(m) {
  return `<section class="ask" data-mail="${m.id}" aria-label="Mail à valider">
    <div class="ask-head"><h2 class="ask-title">${sprite("clark", { size: 18 })}${m.reply ? "Clark veut répondre à un mail" : "Clark veut envoyer un mail"}</h2></div>
    <p class="ask-why">Il part tel quel si tu cliques sur Envoyer. Rien ne part sans toi.</p>
    <dl class="mail-head">
      <dt>À</dt><dd>${esc(m.to)}</dd>
      ${m.cc ? `<dt>Cc</dt><dd>${esc(m.cc)}</dd>` : ""}
      <dt>Objet</dt><dd>${esc(m.subject)}</dd>
    </dl>
    <pre class="mail-body">${esc(m.body)}</pre>
    <div class="ask-actions">
      <button type="button" class="btn primary" data-mail-action="send">Envoyer</button>
      <button type="button" class="btn secondary" data-mail-action="refuse">Refuser</button>
    </div>
  </section>`;
}

side.addEventListener("click", async (e) => {
  const mailButton = e.target.closest("[data-mail-action]");
  if (mailButton) {
    const card = mailButton.closest("[data-mail]");
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await post(`/api/mails/${card.dataset.mail}`, { action: mailButton.dataset.mailAction });
    } catch (err) {
      card.querySelectorAll("button").forEach((b) => (b.disabled = false));
      card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const run = e.target.closest("[data-heartbeat]");
  if (run) {
    run.disabled = true;
    try {
      await post("/api/heartbeat/run", {});
      run.textContent = "Tour lancé";
    } catch (err) {
      run.disabled = false;
      run.insertAdjacentHTML("afterend", `<span class="inline-error" role="alert"> ${esc(err.message)}</span>`);
    }
    return;
  }
  const button = e.target.closest("[data-initiative-action]");
  if (!button) return;
  const card = button.closest("[data-initiative]");
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/initiatives/${card.dataset.initiative}`, { action: button.dataset.initiativeAction });
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

