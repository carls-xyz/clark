// ── Fil de la conversation ──────────────────────────────────────────────

function renderMessage(m, cont = false) {
  const d = parseDate(m.at);
  const fresh = !firstRender && !seen.has(m.id) ? " is-new" : "";
  if (m.role === "user") {
    const via = m.source === "telegram" ? " · Telegram" : m.source === "imessage" ? " · iMessage" : m.source === "cli" ? " · terminal" : "";
    return `<div class="msg user${fresh}"><div class="bubble">${esc(m.text)}</div><div class="meta">${time(d)}${via}</div></div>`;
  }
  if (m.role === "clark") {
    const v = state.voice;
    const listen =
      v?.canSpeak && v.mode !== "never"
        ? `<button type="button" class="listen" data-listen="${m.id}" aria-pressed="${listening?.id === m.id}">${listening?.id === m.id ? (listening.phase === "loading" ? "Préparation…" : "Arrêter") : "Écouter"}</button>`
        : "";
    // L'agent de la conversation répond (Clark, ou un agent de l'équipe écrit directement).
    // Dans « Toute l'équipe », chaque réponse est signée par son agent.
    const author = m.agent ?? threadAgent;
    const who = contactOf(author);
    return `<article class="msg clark${cont ? " cont" : ""}${fresh}"><span class="msg-avatar" aria-hidden="true">${cont ? "" : sprite(agentRole(author), { size: 26 })}</span><div class="msg-body"><div class="meta"><span class="msg-name">${esc(who.name)}</span><time datetime="${d.toISOString()}">${time(d)}</time>${listen}</div><div class="prose">${md(m.text)}</div></div></article>`;
  }
  return `<div class="log${fresh}" title="${time(d)}"><span class="body">${esc(m.text)}</span></div>`;
}

function expiresIn(ms) {
  const min = Math.max(0, Math.ceil((ms - Date.now()) / 60000));
  return min <= 1 ? "expire dans moins d'une minute" : `expire dans ${min} min`;
}

function renderApproval(a) {
  return `<section class="ask" data-approval="${esc(a.id)}" aria-label="Demande de validation">
    <div class="ask-head">
      <h2 class="ask-title">${a.agent?.startsWith("Objectif") ? `${esc(a.agent)} : Clark demande ton accord` : a.agent ? `Le ${esc(a.agent)} demande ton accord` : "Clark demande ton accord"}</h2>
      <span class="ask-expiry" data-expires="${a.expiresAt}">${expiresIn(a.expiresAt)}</span>
    </div>
    <p class="ask-why">Cette action sort de son dossier ou peut avoir un effet. Rien n'est fait sans ta réponse ; sans réponse, c'est refusé.</p>
    <pre class="ask-what">${esc(a.summary)}</pre>
    <div class="ask-actions">
      <button type="button" class="btn primary" data-answer="ok">Valider</button>
      <button type="button" class="btn secondary" data-answer="no">Refuser</button>
    </div>
  </section>`;
}

/** Question d'un agent : boutons pour les réponses proposées, et une réponse libre. */
function renderQuestion(q) {
  return `<section class="ask question" data-question="${q.id}" aria-label="Question de ${esc(q.agent ?? "Clark")}">
    <div class="ask-head">
      <h2 class="ask-title">${sprite(roleOfName(q.agent), { size: 18 })}${q.agent ? `Le ${esc(q.agent)} te pose une question` : "Clark te pose une question"}</h2>
      <span class="ask-expiry">sans réponse en 30 min, il continue sans</span>
    </div>
    <p class="question-text">${esc(q.question)}</p>
    ${
      q.options.length
        ? `<div class="ask-actions">${q.options.map((o, i) => `<button type="button" class="btn secondary" data-option="${i}">${esc(o)}</button>`).join("")}</div>`
        : ""
    }
    <form class="question-free" novalidate>
      <label class="visually-hidden" for="qf-${q.id}">${q.options.length ? "Autre réponse" : "Ta réponse"}</label>
      <input id="qf-${q.id}" name="answer" type="text" maxlength="2000" autocomplete="off" placeholder="${q.options.length ? "Autre réponse" : "Ta réponse"}" />
      <button type="submit" class="btn primary">Répondre</button>
    </form>
  </section>`;
}

/** Brouillon de publication (Réseaux sociaux) : la vidéo, la légende, les vérifications, la décision. */
function renderPost(p) {
  const mark = { règle: "règle", conseil: "conseil", rappel: "rappel" };
  return `<section class="ask post" data-post="${p.id}" aria-label="Contenu ${esc(p.platform)} à valider">
    <div class="ask-head">
      <h2 class="ask-title">Contenu ${esc(p.platform)} à valider</h2>
      <span class="ask-expiry">${Math.round(p.duration)} s · vertical</span>
    </div>
    <div class="post-body">
      <video class="post-video" src="${esc(p.media)}" controls playsinline preload="metadata" aria-label="Aperçu de la vidéo"></video>
      <div class="post-meta">
        <p class="card-title">${esc(p.title)}</p>
        <p class="post-caption">${esc(p.caption)}</p>
        ${p.hashtags.length ? `<p class="post-tags">${p.hashtags.map((h) => `#${esc(h)}`).join(" ")}</p>` : ""}
        <ul class="post-checks">${p.checks
          .map((c) => `<li data-ok="${c.ok}" data-kind="${c.kind}"><span class="post-check-kind">${c.ok ? mark[c.kind] : "à revoir"}</span><span>${esc(c.text)}</span></li>`)
          .join("")}</ul>
      </div>
    </div>
    <div class="ask-actions">
      <button type="button" class="btn primary" data-post-action="approve">Valider</button>
      <button type="button" class="btn secondary" data-post-action="redo-open">Refaire</button>
      <button type="button" class="btn ghost" data-post-action="reject">Jeter</button>
    </div>
    <form class="question-free post-redo" hidden novalidate>
      <label class="visually-hidden" for="redo-${p.id}">Ce qu'il faut retoucher</label>
      <input id="redo-${p.id}" name="feedback" type="text" maxlength="1000" autocomplete="off" placeholder="Ce qu'il faut retoucher (ex. texte d'ouverture plus court)" />
      <button type="submit" class="btn primary">Envoyer la retouche</button>
    </form>
    <p class="post-note">Valider range la vidéo et sa légende dans <code>workspace/social/a-publier/</code>. Tu publies ou programmes ensuite dans ${esc(p.platform)}.</p>
  </section>`;
}

async function decidePost(card, body) {
  card.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  try {
    await post(`/api/posts/${card.dataset.post}`, body);
  } catch (err) {
    card.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
    card.querySelector(":scope > .inline-error")?.remove();
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
}

side.addEventListener("click", (e) => {
  const button = e.target.closest("[data-post-action]");
  if (!button) return;
  const card = button.closest("[data-post]");
  const action = button.dataset.postAction;
  if (action === "redo-open") {
    const form = card.querySelector(".post-redo");
    form.hidden = false;
    form.elements.feedback.focus();
    return;
  }
  void decidePost(card, { action });
});

side.addEventListener("submit", (e) => {
  const form = e.target.closest(".post-redo");
  if (!form) return;
  e.preventDefault();
  const feedback = form.elements.feedback.value.trim();
  if (!feedback) {
    form.elements.feedback.setAttribute("aria-invalid", "true");
    form.elements.feedback.focus();
    return;
  }
  void decidePost(form.closest("[data-post]"), { action: "redo", feedback });
});

