// Interface de Clark. Aucune dépendance : l'état arrive par un flux SSE
// (/api/events) à chaque changement, les actions partent en POST JSON.

const $ = (sel) => document.querySelector(sel);
const thread = $("#thread");
// Racine des clics délégués : toutes les pages (Activité, Plugins, Réglages, menu).
const side = $("#app");
const input = $("#input");
const send = $("#send");
const sendError = $("#send-error");
const status = $("#status");

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const setMotion = () => (document.documentElement.dataset.motion = reduced.matches ? "reduced" : "full");
setMotion();
reduced.addEventListener("change", setMotion);

let state = null;
let seen = new Set(); // messages déjà affichés : seuls les nouveaux ont une entrée animée
let firstRender = true;

// ── Utilitaires ─────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Dates SQLite en UTC (« AAAA-MM-JJ HH:MM:SS »). */
const parseDate = (at) => new Date(`${at.replace(" ", "T")}Z`);
const time = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const sameDay = (a, b) => a.toDateString() === b.toDateString();

function dayLabel(d) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return "Aujourd'hui";
  if (sameDay(d, yesterday)) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

const usd = (n) => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

/** Markdown léger et sûr : le texte est échappé d'abord, puis seules quelques formes sont reconnues. */
function md(src) {
  const blocks = [];
  const text = esc(src).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');

  const out = [];
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split("\n");
    const token = para.match(/^\u0000(\d+)\u0000$/);
    if (token) out.push(blocks[Number(token[1])]);
    else if (lines.every((l) => /^\s*[-*•] /.test(l))) out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•] /, ""))}</li>`).join("")}</ul>`);
    else if (lines.every((l) => /^\s*\d+[.)] /.test(l))) out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ""))}</li>`).join("")}</ol>`);
    else if (/^#{1,4} /.test(para) && lines.length === 1) out.push(`<p class="h">${inline(para.replace(/^#+ /, ""))}</p>`);
    else out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
  }
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

// Confirmations : la fenêtre d'alerte de ui-sdk (vraie fenêtre modale, focus sur Annuler,
// Échap pour annuler) ; celle du navigateur si le composant n'a pas pu se charger.
let uiConfirm = null;
import("/ui/web/alert-dialog.js")
  .then((m) => (uiConfirm = m.confirm))
  .catch(() => {});
async function ask(title, description, confirmLabel, cancelLabel = "Annuler") {
  if (!uiConfirm) return window.confirm(`${title}\n\n${description}`);
  return uiConfirm({ title, description, confirmLabel, cancelLabel });
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

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

// ── Les bonshommes pixelisés : un par agent, Clark en bleu ──────────────
// Formes et couleurs reprises du portfolio de Charles (12 × 9 pixels : X corps, O ombre,
// A détail, W blanc de l'œil, P pupille), plus deux teintes pour Contenu et les temporaires.

const SHAPES = {
  bleu: ["....XXXX....", "..XXXXXXXX..", ".XXXXXXXXXX.", "XXXXXXXXXXXX", "XXWWXXXXWWXX", "XXWPXXXXWPXX", "XXXXXXXXXXXX", "OXXXXXXXXXXO", ".OOOOOOOOOO."],
  mousse: ["......AA....", "....AAA.....", "...XXXXXX...", "..XXXXXXXX..", "..XWWXXWWX..", "..XWPXXWPX..", "..XXXXXXXX..", "..OXXXXXXO..", "...OOOOOO..."],
  braise: ["......A.....", ".....AXA....", "....XXXX.A..", "..XXXXXXXX..", ".XXWWXXWWXX.", ".XXWPXXWPXX.", ".XXXXXXXXXX.", "..OXXXXXXO..", "...OOOOOO..."],
  guimauve: ["..X......X..", "..XA....AX..", "..XXXXXXXX..", ".XXXXXXXXXX.", ".XWWXXXXWWX.", ".XWPXXXXWPX.", ".XXXXAAXXXX.", ".OXXXXXXXXO.", "..OOOOOOOO.."],
};
const CREATURES = {
  bleu: { shape: "bleu", X: "#61a7d5", O: "#4a86ad", A: "#4a86ad" },
  mousse: { shape: "mousse", X: "#7ebf7a", O: "#5a9a57", A: "#a8dc78" },
  braise: { shape: "braise", X: "#ee8a52", O: "#c4662f", A: "#f7d26a" },
  guimauve: { shape: "guimauve", X: "#e48cb0", O: "#c06890", A: "#b85583" },
  lilas: { shape: "mousse", X: "#a48bd8", O: "#7f68b3", A: "#c9b6f0" },
  galet: { shape: "bleu", X: "#a3abb4", O: "#7f8892", A: "#7f8892" },
};
const EYES = { W: "#f2f4f7", P: "#15222d" };
const ROLE_CREATURE = { clark: "bleu", plan: "bleu", synthese: "bleu", chercheur: "mousse", redacteur: "braise", relecteur: "guimauve", contenu: "lilas", temporaire: "galet", groupe: "galet", code: "galet" };
const NAME_ROLE = { Chercheur: "chercheur", "Rédacteur": "redacteur", Relecteur: "relecteur", "Spécialiste Contenu": "contenu" };

/** Une rangée de pixels en segments horizontaux : un rectangle par segment. */
function pixelRow(row, y, colors) {
  let out = "";
  for (let i = 0; i < row.length; ) {
    const k = row[i];
    let j = i;
    while (j < row.length && row[j] === k) j++;
    if (k !== ".") out += `<rect x="${i}" y="${y}" width="${j - i}" height="1" fill="${colors[k]}"/>`;
    i = j;
  }
  return out;
}

/** Le bonhomme d'un rôle. walking : il marche (l'agent travaille). */
function sprite(role, { walking = false, size = 16 } = {}) {
  const c = CREATURES[ROLE_CREATURE[role] ?? "galet"];
  const colors = { ...EYES, X: c.X, O: c.O, A: c.A };
  const body = SHAPES[c.shape].map((row, y) => pixelRow(row, y, colors)).join("");
  const legs = walking
    ? `<g class="step-a">${pixelRow("..OO....OO..", 9, colors)}</g><g class="step-b">${pixelRow("...OO..OO...", 9, colors)}</g>`
    : pixelRow("..OO....OO..", 9, colors);
  return `<svg class="sprite${walking ? " walking" : ""}" viewBox="0 0 12 10" width="${size}" height="${Math.round((size * 10) / 12)}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${body}${legs}</svg>`;
}

const roleOfName = (name) => NAME_ROLE[name] ?? (name?.startsWith("Spécialiste") ? "temporaire" : "clark");

// ── La scène : les agents qui travaillent, en grand ──────────────────────
// Chaque agent tient l'outil de son rôle (loupe, plume, feuille cochée) ; celui qui travaille
// marche, réfléchit (bulle) et s'en sert ; une feuille passe de l'agent fini au suivant.

const PROPS = {
  loupe: { rows: [".OOO....", "O...O...", "O.G.O...", "O...O...", ".OOO....", "....HH..", ".....HH.", "......HH"], colors: { O: "#cfd6de", G: "#9fd0ee", H: "#a07850" } },
  plume: { rows: ["......WW", ".....WWW", "....WWW.", "...WWW..", "..WWW...", "..WW....", ".K......", "K......."], colors: { W: "#f2f4f7", K: "#5b6b7a" } },
  coche: { rows: ["WWWWWWW", "W.....W", "W....GW", "W...G.W", "WG.G..W", "W.G...W", "W.....W", "WWWWWWW"], colors: { W: "#e9e4d8", G: "#7ebf7a" } },
  carte: { rows: ["WWWWWWW", "W.....W", "W.LLL.W", "W.....W", "W.LL..W", "W.....W", "W.LLL.W", "WWWWWWW"], colors: { W: "#e9e4d8", L: "#61a7d5" } },
};
const ROLE_PROP = { code: "plume", chercheur: "loupe", temporaire: "loupe", redacteur: "plume", contenu: "plume", synthese: "plume", relecteur: "coche", plan: "carte" };
const PAPER = `<svg class="paper" viewBox="0 0 5 6" width="15" height="18" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${["WWWW.", "WLLWW", "WWWWW", "WLLLW", "WWWWW", "WWWWW"].map((r, y) => pixelRow(r, y, { W: "#e9e4d8", L: "#a3abb4" })).join("")}</svg>`;
const THINK = `<svg class="think" viewBox="0 0 11 6" width="33" height="18" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect class="think-bg" x="0" y="0" width="11" height="5"/><rect class="think-tail think-bg" x="2" y="5" width="2" height="1"/><rect class="d1" x="2" y="2" width="1" height="1"/><rect class="d2" x="5" y="2" width="1" height="1"/><rect class="d3" x="8" y="2" width="1" height="1"/></svg>`;

function prop(name) {
  const p = PROPS[name];
  if (!p) return "";
  const w = p.rows[0].length;
  return `<svg class="prop prop-${name}" viewBox="0 0 ${w} 8" width="${w * 3}" height="24" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${p.rows.map((r, y) => pixelRow(r, y, p.colors)).join("")}</svg>`;
}

/** Un agent sur la scène : bulle quand il réfléchit, outil en main, nom et état dessous. */
function actor({ role, name, status, tool, tag = "" }) {
  const running = status === "running";
  return `<li class="actor" data-status="${status}">
    <div class="actor-fig">
      ${running ? THINK : status === "done" ? `<span class="actor-done" aria-hidden="true">✓</span>` : ""}
      ${sprite(role, { walking: running, size: 46 })}${tool && (running || status === "done") ? prop(tool) : ""}
    </div>
    <span class="actor-name">${esc(name)}${tag}</span>
    <span class="actor-state">${teamStatus[status] ?? esc(status)}</span>
  </li>`;
}

function renderWorking(running) {
  if (!running.length || state.approvals.length || state.questions.length || state.posts.length || (state.mails ?? []).length) return "";
  // La demande de Charles (pas une mission confiée à un agent), et les agents qui y travaillent.
  const task = running.find((t) => !t.parentId) ?? running[0];
  const helpers = running.filter((t) => t.parentId === task.id && !task.team && ROLE_CREATURE[t.label]);
  if (helpers.length) {
    const cells = [
      actor({ role: "clark", name: "Clark", status: "running", tool: "carte" }),
      ...helpers.map((h) => `<li class="handoff flowing" aria-hidden="true">${PAPER}</li>${actor({ role: h.label, name: contactOf(h.label).name, status: h.status === "queued" ? "queued" : "running", tool: ROLE_PROP[h.label] })}`),
    ].join("");
    const says = helpers
      .map((h) => {
        const last = h.steps[h.steps.length - 1];
        return `<p class="stage-say">${sprite(h.label, { size: 14 })}<strong>${esc(contactOf(h.label).name)}</strong><span>${esc(h.checkpoint || (last ? last.text : "réfléchit"))}</span></p>`;
      })
      .join("");
    return `<section class="stage" aria-label="Clark et son équipe au travail">
      <p class="stage-head"><strong>Clark a confié le travail</strong><span>${helpers.map((h) => esc(contactOf(h.label).name)).join(", ")}</span></p>
      <ol class="stage-row">${cells}</ol>${says}
    </section>`;
  }
  if (task.team) {
    const agents = task.team.agents;
    const busy = agents.filter((a) => a.status === "running");
    const cells = agents
      .map((a, i) => {
        const role = a.temporary ? "temporaire" : a.role ?? roleOfName(a.name);
        // Entre deux agents : la feuille part de celui qui a fini vers celui qui travaille.
        const prev = agents[i - 1];
        const link = i === 0 ? "" : `<li class="handoff${a.status === "running" && prev?.status === "done" ? " flowing" : ""}${prev?.status === "done" ? " passed" : ""}" aria-hidden="true">${PAPER}</li>`;
        const tag = a.round && a.round > 1 ? ` <span class="round">v${a.round}</span>` : "";
        // Les agents de l'équipe s'affichent sous leur petit nom (Mousse, Braise…).
        const name = (state.contacts ?? []).some((c) => c.role === role) ? contactOf(role).name : a.name;
        return link + actor({ role, name, status: a.status, tool: ROLE_PROP[role], tag });
      })
      .join("");
    // Ce que disent les agents qui travaillent (leur point d'étape), chacun avec son bonhomme.
    const says = busy
      .map((a) => `<p class="stage-say">${sprite(a.temporary ? "temporaire" : a.role ?? roleOfName(a.name), { size: 14 })}<strong>${esc(a.name)}</strong><span>${esc(a.checkpoint || a.detail || "réfléchit")}</span></p>`)
      .join("");
    return `<section class="stage" aria-label="L'équipe au travail">
      <p class="stage-head"><strong>L'équipe travaille</strong><span>${esc(task.team.plan)}</span></p>
      <ol class="stage-row">${cells}</ol>
      ${says || `<p class="stage-say">${sprite("clark", { size: 14 })}<strong>Clark</strong><span>prépare la suite</span></p>`}
    </section>`;
  }
  const last = task.steps[task.steps.length - 1];
  const what = task.checkpoint ? esc(task.checkpoint) : last ? esc(last.text) : task.status === "queued" ? "en file d'attente" : "réfléchit";
  // Seul : Clark lit (loupe) ou écrit (plume) selon sa dernière action.
  const tool = last ? (last.effect === "read" ? "loupe" : "plume") : null;
  return `<section class="stage solo" aria-label="Clark au travail">
    <ol class="stage-row">${actor({ role: "clark", name: "Clark", status: task.status === "queued" ? "queued" : "running", tool })}</ol>
    <p class="stage-say"><strong>Clark travaille</strong><span>${what}</span></p>
  </section>`;
}

/**
 * La conversation est redessinée à chaque mise à jour : sans ça, les animations de la scène
 * repartiraient de zéro à chaque étape. Calées sur l'horloge de la page, elles continuent.
 */
function syncStage(root) {
  const now = document.timeline.currentTime ?? 0;
  for (const a of root.querySelector(".stage")?.getAnimations({ subtree: true }) ?? []) a.currentTime = now;
}

// ── Focus à travers les mises à jour en direct ─────────────────────────
// Chaque mise à jour reconstruit le HTML : on retrouve l'élément qui avait le focus (même
// carte, même bouton) pour que le clavier ne retombe pas au début de la page.

const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password"]);
/** Seuls ces champs ont un curseur à remettre en place (pas une date, pas un bouton). */
const hasCaret = (el) => el?.tagName === "TEXTAREA" || (el?.tagName === "INPUT" && TEXT_INPUTS.has(el.type));
const HOSTS = ["approval", "question", "mail", "initiative", "memory", "check", "engine", "post", "automation"];
const ACTIONS = ["answer", "option", "mail-action", "initiative-action", "memory-action", "check-action", "post-action", "auto", "heartbeat"];

function focusKey(root) {
  const el = document.activeElement;
  if (!el || el === root || !root.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const host = HOSTS.find((h) => el.closest(`[data-${h}]`));
  const hostSel = host ? `[data-${host}="${CSS.escape(el.closest(`[data-${host}]`).dataset[host.replace(/-(\w)/g, (_, c) => c.toUpperCase())])}"] ` : "";
  const action = ACTIONS.find((a) => el.hasAttribute(`data-${a}`));
  if (action) return `${hostSel}[data-${action}="${CSS.escape(el.getAttribute(`data-${action}`))}"]`;
  if (el.name) return `${hostSel}[name="${CSS.escape(el.name)}"]`;
  if (el.matches("[data-engines-refresh]")) return "[data-engines-refresh]";
  return null;
}

function restoreFocus(root, key) {
  if (!key || root.contains(document.activeElement)) return;
  root.querySelector(key)?.focus({ preventScroll: true });
}

const openLogGroups = new Set();
side.addEventListener(
  "toggle",
  (e) => {
    const g = e.target.closest?.("[data-log-group]");
    if (!g) return;
    const key = Number(g.dataset.logGroup);
    if (g.open) openLogGroups.add(key);
    else openLogGroups.delete(key);
  },
  true,
);

// L'agent de la conversation affichée (null : Clark) : avatar et nom des réponses, en-tête, champ.
let threadAgent = null;

/** En-tête de la conversation : à qui tu parles, son rôle, et le sujet. */
function renderChatHead(agent, title) {
  const who = contactOf(agent);
  $("#t-chat").innerHTML = `${sprite(agentRole(agent), { size: 22 })}<span class="head-name">${esc(who.name)}</span>${who.badge ? `<span class="conv-badge">${esc(who.badge)}</span>` : ""}${title ? `<span class="head-sub">${esc(title)}</span>` : ""}`;
  const btn = $("#head-new");
  btn.hidden = !agent;
  btn.dataset.agent = agent ?? "";
  btn.setAttribute("aria-label", `Nouvelle conversation avec ${who.name}`);
  btn.title = `Nouvelle conversation avec ${who.name}`;
  if ($("#mode").value === "chat") input.placeholder = `Écrire à ${who.name}`;
}

// Conversation ouverte et visible : ses réponses sont lues (une seule demande par nouveau message).
let seenSent = "";
function markSeen() {
  if (pastId || view !== "chat" || document.visibilityState !== "visible" || !state) return;
  const c = (state.conversations ?? []).find((x) => x.id === state.conversationId);
  if (!c?.unread) return;
  const key = `${c.id}:${c.unread}:${c.at}`;
  if (key === seenSent) return;
  seenSent = key;
  void post(`/api/conversations/${c.id}/seen`, {}).catch(() => (seenSent = ""));
}
document.addEventListener("visibilitychange", markSeen);

function renderThread() {
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  threadAgent = pastId ? (pastConv?.agent ?? null) : (state.conversationAgent ?? null);
  const openConv = (state.conversations ?? []).find((c) => c.id === (pastId ?? state.conversationId));
  renderChatHead(threadAgent, pastId ? (pastConv?.title ?? openConv?.title) : openConv?.title);
  if (!pastId) markSeen();
  // Conversation passée : ses messages seulement (les cartes et le travail en cours restent dans l'ouverte).
  if (pastId) return renderPastThread();
  const { messages, approvals, running } = state;

  const empty = !messages.length && !approvals.length && !running.length && !state.posts.length && !state.questions.length && !(state.mails ?? []).length;
  // Conversation vide : le champ au milieu, comme une page blanche ; il descend au premier message.
  $("#view-chat").toggleAttribute("data-empty", empty);
  if (empty) {
    const waiting = waitingCount();
    const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    thread.innerHTML = `<div class="empty"><p class="empty-date">${esc(today)}</p></div>`;
    $("#empty-chips").innerHTML = `
      ${waiting ? `<a class="chip" href="#activite">${waiting} chose${waiting > 1 ? "s" : ""} t'attend${waiting > 1 ? "ent" : ""}</a>` : ""}
      <button type="button" class="chip" data-start-mode="dev">Tâche de code</button>
      <button type="button" class="chip" data-start-mode="goal">Objectif</button>`;
    $("#empty-chips").hidden = false;
    return;
  }
  $("#empty-chips").hidden = true;

  const html = messagesHtml(messages);
  return finishThread(html, messages, nearBottom, running, approvals);
}

/** Le fil d'une conversation passée, relu tel quel ; écrire dedans la reprend. */
function renderPastThread() {
  $("#empty-chips").hidden = true;
  $("#view-chat").removeAttribute("data-empty");
  if (!pastConv || pastConv.id !== pastId) {
    thread.innerHTML = `<p class="quiet past-loading">Chargement de la conversation…</p>`;
    return;
  }
  const when = parseDate(pastConv.at).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  thread.innerHTML = `<div class="past-banner" role="note"><strong>${esc(pastConv.title)}</strong><span>Conversation du ${esc(when)}. Écris ci-dessous pour la reprendre : Clark retrouve ce fil.</span></div>${messagesHtml(pastConv.messages)}`;
  for (const m of pastConv.messages) seen.add(m.id);
  if (pastScrolled !== pastId) {
    thread.scrollTop = thread.scrollHeight;
    pastScrolled = pastId;
  }
}

/** Les messages d'un fil : jours, notes du système regroupées, réponses de Clark. */
function messagesHtml(messages) {
  let html = "";
  let lastDay = null;
  let run = [];
  let prevRole = null;
  const flush = () => {
    if (run.length < 3) html += run.map((m) => renderMessage(m)).join("");
    else {
      const key = run[0].id;
      html += `<details class="log-group" data-log-group="${key}"${openLogGroups.has(key) ? " open" : ""}>
        <summary><span class="log-count">${run.length} événements</span><span class="body">${esc(run.at(-1).text)}</span></summary>
        ${run.map((m) => renderMessage(m)).join("")}
      </details>`;
    }
    run = [];
  };
  for (const m of messages) {
    const d = parseDate(m.at);
    if (!lastDay || !sameDay(d, lastDay)) {
      flush();
      html += `<div class="day">${dayLabel(d)}</div>`;
    }
    lastDay = d;
    if (m.role === "system") run.push(m);
    else {
      flush();
      html += renderMessage(m, m.role === "clark" && prevRole === `clark:${m.agent ?? ""}`);
    }
    prevRole = m.role === "system" ? prevRole : m.role === "clark" ? `clark:${m.agent ?? ""}` : m.role;
  }
  flush();
  return html;
}

function finishThread(html, messages, nearBottom, running, approvals) {
  html += state.posts.map(renderPost).join("");
  html += state.questions.map(renderQuestion).join("");
  html += approvals.map(renderApproval).join("");
  html += (state.mails ?? []).map(renderMailCard).join("");
  html += renderWorking(running);

  // Un aperçu vidéo n'est jamais redessiné : la lecture ne repart pas de zéro à chaque mise à jour.
  const keptPosts = [...thread.querySelectorAll("[data-post]")];
  // Une réponse libre en cours de saisie survit aux mises à jour en direct.
  const kept = [...thread.querySelectorAll("[data-question]")].filter((c) => {
    const input = c.querySelector("input");
    return input && (input.value || c.contains(document.activeElement));
  });
  const focused = kept.find((c) => c.contains(document.activeElement)) ? document.activeElement : null;
  const caret = hasCaret(focused) ? [focused.selectionStart, focused.selectionEnd] : null;
  const threadKey = focusKey(thread);
  thread.innerHTML = html;
  for (const card of kept) {
    const fresh = thread.querySelector(`[data-question="${card.dataset.question}"]`);
    if (fresh) fresh.replaceWith(card);
  }
  for (const card of keptPosts) {
    const fresh = thread.querySelector(`[data-post="${card.dataset.post}"]`);
    if (fresh) fresh.replaceWith(card);
  }
  if (focused && document.body.contains(focused)) {
    focused.focus({ preventScroll: true });
    if (caret) focused.setSelectionRange(caret[0], caret[1]);
  }
  restoreFocus(thread, threadKey);
  syncStage(thread);

  for (const m of messages) seen.add(m.id);
  if (nearBottom || firstRender || jumpBottom) thread.scrollTop = thread.scrollHeight;
  jumpBottom = false;
}

async function answerQuestion(card, answer) {
  card.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  try {
    await post(`/api/questions/${card.dataset.question}`, { answer });
  } catch (err) {
    card.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
    card.querySelector(".inline-error")?.remove();
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
}

side.addEventListener("click", (e) => {
  const option = e.target.closest("[data-option]");
  if (!option) return;
  const card = option.closest("[data-question]");
  const q = state.questions.find((x) => String(x.id) === card.dataset.question);
  if (q) void answerQuestion(card, q.options[Number(option.dataset.option)]);
});

side.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-question] .question-free");
  if (!form) return;
  e.preventDefault();
  const answer = form.elements.answer.value.trim();
  if (!answer) {
    form.elements.answer.focus();
    return;
  }
  void answerQuestion(form.closest("[data-question]"), answer);
});

side.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-answer]");
  if (!button) return;
  const card = button.closest("[data-approval]");
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/approvals/${card.dataset.approval}`, { ok: button.dataset.answer === "ok" });
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    card.querySelector(".inline-error")?.remove();
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

// ── Colonne : à vérifier, en cours, budget, mémoire ─────────────────────

function renderSteps(steps) {
  const label = { running: "en cours", done: "fait", error: "erreur", denied: "refusé", expired: "expiré", awaiting_approval: "attend ton accord", unknown: "sans résultat" };
  return `<ul class="steps">${steps
    .map(
      (s) => `<li data-status="${s.status}">
        <span class="effect ${s.effect}" title="${s.effect === "write" ? "écriture" : "lecture"}"></span>
        <span class="t" title="${esc(s.text)}">${esc(s.text)}</span>
        <span class="s">${label[s.status] ?? s.status}</span>
      </li>`,
    )
    .join("")}</ul>`;
}

const planNames = { plus: "ChatGPT Plus", pro: "ChatGPT Pro", free: "ChatGPT Free", team: "ChatGPT Team", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu" };

function resetText(ms) {
  if (!ms) return "remise à zéro : heure inconnue";
  const d = new Date(ms);
  const t = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return sameDay(d, new Date()) ? `remise à zéro à ${t}` : `remise à zéro le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} à ${t}`;
}

/** Quota de l'abonnement ChatGPT : chiffres donnés par Codex, rien d'estimé. */
function renderQuota(q, engine) {
  const head = `<div class="block-head"><h2 class="block-title" id="h-quota">Quota Codex</h2>${q?.plan ? `<span class="block-count">${esc(planNames[q.plan] ?? q.plan)}</span>` : ""}</div>`;
  if (!q || q.windows.length === 0) {
    const why = engine.ready === false ? "Inconnu tant que Clark n'est pas connecté à ChatGPT." : "Codex n'a pas encore donné de chiffres.";
    return `<section class="block" aria-labelledby="h-quota">${head}<p class="quiet">${why}</p></section>`;
  }
  const rows = q.windows
    .map((w) => {
      const pct = Math.round(w.usedPercent);
      const level = q.reached || pct >= 100 ? " full" : pct >= 90 ? " near" : "";
      return `<div class="quota-row">
        <div class="quota-line"><span>${esc(w.label)}</span><span class="quota-pct">${pct} % utilisés</span></div>
        <div class="bar${level}" role="progressbar" aria-label="${esc(w.label)} : part du quota utilisée" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span data-ratio="${pct / 100}"></span></div>
        <p class="quiet">${resetText(w.resetsAt)}</p>
      </div>`;
    })
    .join("");
  const alert = q.reached ? `<p class="quota-alert">Limite atteinte : Clark ne pourra plus répondre avant la remise à zéro.</p>` : "";
  const when = new Date(q.readAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `<section class="block" aria-labelledby="h-quota">${head}${alert}${rows}<p class="quota-read">lu à ${when}</p></section>`;
}

// ── Moteurs : quota, modèle et niveau d’effort, pour Claude et Codex ──

const ENGINE_NAMES = { claude: "Claude", codex: "Codex" };
const EFFORT_LABELS = { none: "aucune", minimal: "minimale", low: "faible", medium: "moyenne", high: "élevée", xhigh: "très élevée", max: "maximale" };
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
 * Effort : un curseur à crans (idée reprise du « Sleek Effort Slider »). Premier cran :
 * « Auto », le niveau par défaut du modèle ; puis ceux que le modèle propose. « Recommandé »
 * seulement si le moteur donne lui-même un niveau par défaut. Un vrai <input type="range"> :
 * clavier, lecteur d'écran et tactile marchent tels quels.
 */
const effortLabel = (stop) => (stop ? (EFFORT_LABELS[stop] ?? stop) : "auto");
function effortSlider(e, current, idp) {
  const efforts = current?.efforts ?? [];
  const id = `${idp}effort-${e.name}`;
  if (!current || !efforts.length) {
    return `<div class="effort is-off">
      <div class="effort-head"><span class="effort-title" id="${id}-t">Effort</span><span class="effort-value">auto</span></div>
      <p class="quiet effort-note">${!current ? "Choisis un modèle pour régler l'effort." : "Ce modèle n'a pas de niveaux d'effort."}</p>
    </div>`;
  }
  const stops = ["", ...efforts];
  const index = Math.max(0, stops.indexOf(e.choice.effort ?? ""));
  const rec = current.defaultEffort ? stops.indexOf(current.defaultEffort) : -1;
  const last = stops.length - 1;
  const pos = (i) => (last ? i / last : 0);
  return `<div class="effort" data-effort-box data-pos="${pos(index)}">
    <div class="effort-head">
      <label class="effort-title" for="${id}">Effort</label>
      <span class="effort-value" data-effort-value>${esc(effortLabel(stops[index]))}</span>
      <span class="effort-help" title="Plus d'effort : réponses plus réfléchies, plus lentes, et plus de quota consommé. « Auto » laisse le modèle choisir." aria-hidden="true">?</span>
    </div>
    <div class="effort-captions" aria-hidden="true"><span>Rapide</span><span>Réfléchi</span></div>
    <div class="effort-track">
      <span class="effort-rail" aria-hidden="true"></span>
      <span class="effort-fill" aria-hidden="true"></span>
      ${stops.map((_, i) => `<span class="effort-tick${i <= index ? " is-on" : ""}" data-pos="${pos(i)}" aria-hidden="true"></span>`).join("")}
      <input type="range" id="${id}" data-engine-effort min="0" max="${last}" step="1" value="${index}"
        data-stops='${esc(JSON.stringify(stops))}' aria-valuetext="${esc(effortLabel(stops[index]))}" />
    </div>
    ${rec >= 0 ? `<span class="effort-rec" data-pos="${pos(rec)}">Recommandé</span>` : ""}
  </div>`;
}

/** Positions des crans et du remplissage : la CSP interdit le style en ligne, on passe par le CSSOM. */
function placeEffort(root) {
  root.querySelectorAll(".effort [data-pos], .effort[data-pos]").forEach((el) => el.style.setProperty("--p", el.dataset.pos));
}

/** Pendant le glissement : la valeur, le remplissage et les crans suivent, sans attendre l'envoi. */
side.addEventListener("input", (e) => {
  const range = e.target.closest?.('input[type="range"][data-engine-effort]');
  if (!range) return;
  const box = range.closest("[data-effort-box]");
  const stops = JSON.parse(range.dataset.stops);
  const i = Number(range.value);
  const p = stops.length > 1 ? i / (stops.length - 1) : 0;
  box.dataset.pos = String(p);
  box.style.setProperty("--p", String(p));
  box.querySelector("[data-effort-value]").textContent = effortLabel(stops[i]);
  range.setAttribute("aria-valuetext", effortLabel(stops[i]));
  box.querySelectorAll(".effort-tick").forEach((t, k) => t.classList.toggle("is-on", k <= i));
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

/** Un moteur : complet dans Plugins, compact en bas du menu (idp distingue les identifiants). */
function renderEngine(e, { compact = false, idp = "" } = {}) {
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
         ${models.map((m) => `<option value="${esc(m.id)}"${m.id === e.choice.model ? " selected" : ""}>${esc(m.name)}${m.description && !compact ? ` — ${esc(m.description.slice(0, 60))}` : ""}</option>`).join("")}
       </select>`
    : compact
      ? ""
      : `<p class="quiet">${e.modelsError ? `Liste des modèles indisponible : ${esc(e.modelsError)}` : "Liste des modèles pas encore lue."}</p>`;
  const efforts = current?.efforts ?? [];
  const effortSelect = models.length ? effortSlider(e, current, idp) : "";

  // Compact : réglages d'abord (ce qu'on change), quota ensuite (ce qu'on surveille).
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
        eff.value = String(Math.max(0, JSON.parse(eff.dataset.stops).indexOf(engine.choice.effort ?? "")));
        eff.dispatchEvent(new Event("input", { bubbles: true })); // crans et valeur reviennent aussi
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
  const tasks = history.tasks.filter((t) => matches(t.prompt, t.origin));
  const more = history.more ? `<button type="button" class="btn secondary hist-more" data-history-more>Chercher plus ancien</button>` : "";
  if (!tasks.length) return `<p class="quiet">Rien ne correspond à « ${esc(activityFilter)} »${history.more ? " dans l'historique récent" : ""}.</p>${more}`;
  let html = "";
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
    (state.goals ?? []).filter((g) => g.status === "waiting").length +
    (state.gates ?? []).length +
    (state.stalled ?? []).length +
    [...dev.tasks, ...(dev.groups ?? []).flatMap((g) => g.tasks)].filter((t) => t.status === "review").length +
    dev.tasks.filter((t) => t.status === "failed").length
  );
}

const DECISION_KINDS = { veille: "Veille", lancer: "Mission", souvenir: "Souvenir" };

/** Ce que Clark a décidé seul : quoi, pourquoi, et de quoi annuler. */
function renderDecisions() {
  const list = state.decisions ?? [];
  const a = state.autonomy;
  if (!list.length && !(a && (a.veille || a.lancer || a.souvenir))) return "";
  const head = a ? `<p class="quiet">${a.today} sur ${a.max} aujourd'hui${a.now?.ok === false ? ` · ${esc(a.now.why)}` : ""}. <a class="link" href="#reglages/general">Régler l'autonomie</a></p>` : "";
  const rows = list
    .map((d) => {
      const undone = d.status === "undone";
      return `<div class="card decision${undone ? " undone" : ""}" data-decision="${d.id}">
        <div class="goal-head"><p class="card-title">${esc(d.title)}</p><span class="tag">${esc(DECISION_KINDS[d.kind] ?? d.kind)}</span></div>
        <p class="card-note">${esc(d.reason)}</p>
        <p class="quiet decision-meta">${esc(convWhen(d.created_at))}${undone ? ` · annulé (${esc(d.undo_note ?? "")})` : ""}</p>
        ${undone ? "" : `<div class="card-actions"><button type="button" class="btn ghost" data-undo-decision="${d.id}">Annuler</button></div>`}
        <p class="inline-error" role="alert" hidden></p>
      </div>`;
    })
    .join("");
  return `<h2 class="activity-group" id="h-decisions">Décidé par Clark${list.length ? ` <span class="block-count">${list.length}</span>` : ""}</h2>${head}<div class="stack">${rows || `<p class="quiet">Rien pour l'instant.</p>`}</div>`;
}

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

function renderInbox() {
  const { checks, proposals } = state;
  const dev = state.dev ?? { tasks: [], groups: [] };
  const allReview = [...dev.tasks, ...(dev.groups ?? []).flatMap((g) => g.tasks)].filter((t) => t.status === "review");
  const review = allReview.filter((t) => matches(t.title, t.project));
  const goals = (state.goals ?? []).filter((g) => g.status === "waiting");
  const asks = [...state.approvals.map(renderApproval), ...state.questions.map(renderQuestion), ...(state.mails ?? []).map(renderMailCard), ...state.posts.map(renderPost)];
  let html = "";
  if (asks.length) html += section("asks", "Accords et questions", asks.length, `<div class="stack">${asks.join("")}</div>`);
  const gates = state.gates ?? [];
  if (gates.length) html += section("gates", "Décisions pour le dev", gates.length, `<div class="stack">${gates.map((x) => renderGate({ ...x, resolution: null }, x.groupTitle)).join("")}</div>`);
  const stalled = state.stalled ?? [];
  if (stalled.length)
    html += section(
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
    html += section(
      "review",
      "Tâches dev à relire",
      review.length,
      `<ul class="link-list">${review.map((t) => `<li><a href="#dev/${t.id}"><span class="dot" data-s="review"></span><span class="ll-label">${esc(t.title)}</span><span class="quiet">${esc(t.project)}</span></a></li>`).join("")}</ul>`,
    );
  const allStopped = dev.tasks.filter((t) => t.status === "failed");
  const stopped = allStopped.filter((t) => matches(t.title, t.project));
  if (stopped.length)
    html += section(
      "dev-stopped",
      "Tâches dev arrêtées",
      stopped.length,
      `<ul class="link-list">${stopped.map((t) => `<li><a href="#dev/${t.id}"><span class="dot" data-s="wait"></span><span class="ll-label">${esc(t.title)}</span><span class="quiet">${esc(t.project)} · à relancer ou jeter</span></a></li>`).join("")}</ul>`,
    );
  if (goals.length) html += section("goals-wait", "Objectifs qui t'attendent", goals.length, goals.map(renderGoal).join(""));
  if (checks.length) html += section("checks", "À vérifier", checks.length, renderChecks(checks));
  if (proposals.length) html += section("proposals", "Souvenirs à confirmer", proposals.length, proposals.map(renderProposal).join(""));
  html += renderInitiatives(state.initiatives ?? [], state.heartbeat);
  // Le filtre écarte des tâches dev : le compte suit ce qui est affiché.
  const shown = waitingCount() - (allReview.length - review.length) - (allStopped.length - stopped.length);
  if (!waitingCount()) html = `<p class="empty-note">Rien ne t'attend. Les accords, questions et relectures arrivent ici.</p>${html}`;
  else if (!shown) html = `<p class="quiet">Rien ne correspond à « ${esc(activityFilter)} ».</p>${html}`;
  html = `<h2 class="activity-group" id="h-waiting">T'attend${shown ? ` <span class="block-count">${shown}</span>` : ""}</h2>${html}`;
  html += renderDecisions();
  const allLive = liveRows().filter((r) => r.s !== "review" && r.s !== "wait");
  const live = allLive.filter((r) => matches(r.label, r.meta));
  html += `<h2 class="activity-group">En cours${live.length ? ` <span class="block-count">${live.length}</span>` : ""}</h2>${
    live.length ? `<ul class="link-list">${live.map((r) => `<li><a href="${r.href}"><span class="dot" data-s="${r.s}"></span><span class="ll-label">${esc(r.label)}</span><span class="quiet">${esc(r.meta)}</span></a></li>`).join("")}</ul>` : `<p class="quiet">${allLive.length ? `Rien ne correspond à « ${esc(activityFilter)} ».` : "Aucun agent ne travaille."}</p>`
  }`;
  html += `<h2 class="activity-group">Fini</h2>${renderHistory()}`;
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
    ? `<details class="goal-log"><summary>Journal des tours</summary><ol>${g.events
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

// ── Dev : projets, tâches dans leurs copies, relecture du diff ──

let projectFormOpen = false;
const devPatches = new Map(); // id → { rounds, patch } : le diff complet, chargé à la demande
// Le diff change à chaque tour, et quand on revient à un tour précédent.
const patchKey = (t) => `${t.rounds}:${t.atRound ?? ""}`;
const devStatus = { waiting: "en attente", preparing: "préparation de la copie", working: "en cours", review: "à relire", accepted: "acceptée", discarded: "jetée", failed: "arrêtée" };
const fileStatusMark = { ajouté: "A", modifié: "M", supprimé: "D", renommé: "R" };

/** Les fichiers d'un patch, ligne par ligne, avec leurs numéros (ancien et nouveau côté). */
function parsePatch(patch) {
  const files = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      files.push({ name: line.replace(/^diff --git a\/.* b\//, ""), rows: [] });
      continue;
    }
    if (!files.length || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(line)) continue;
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      files.at(-1).rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) files.at(-1).rows.push({ kind: "add", text: line.slice(1), n: n++ });
    else if (line.startsWith("-")) files.at(-1).rows.push({ kind: "del", text: line.slice(1), o: o++ });
    else if (line.length || files.at(-1).rows.length) files.at(-1).rows.push({ kind: "ctx", text: line.slice(1), o: o++, n: n++ });
  }
  return files;
}

let commentDraft = null; // { task, file, side, start, end, snippet } : le commentaire en cours d'écriture
let diffWrap = (() => {
  try {
    return localStorage.getItem("clark.diffWrap") === "1";
  } catch {
    return false;
  }
})();

/** Où se place un commentaire : sa dernière ligne, retrouvée par son texte si le diff a bougé. */
function anchorOf(c, file) {
  const last = c.snippet.split("\n").at(-1) ?? "";
  const num = (r) => (c.side === "old" ? r.o : r.n);
  const usable = (r) => r.kind !== "hunk" && (c.side === "old" ? r.kind !== "add" : r.kind !== "del");
  const exact = file.rows.findIndex((r) => usable(r) && num(r) === c.end && r.text === last);
  if (exact >= 0) return exact;
  return file.rows.findIndex((r) => usable(r) && r.text === last && last.trim() !== "");
}

function renderComment(c) {
  const lines = c.start === c.end ? `ligne ${c.start}` : `lignes ${c.start} à ${c.end}`;
  const state = c.status === "resolved" ? "résolu" : c.sent ? `envoyé au tour ${c.sent}` : "pas encore envoyé";
  if (c.status === "resolved")
    return `<div class="dc resolved" data-comment="${c.id}"><span class="quiet">Résolu · ${lines} : ${esc(c.body.split("\n")[0].slice(0, 120))}</span> <button type="button" class="link" data-comment-act="reopen">Rouvrir</button></div>`;
  return `<div class="dc" data-comment="${c.id}">
    <p class="dc-head">${lines} · ${state}</p>
    <div class="prose">${md(c.body)}</div>
    <div class="dc-actions">${c.sent ? `<button type="button" class="link" data-comment-act="resolve">Résoudre</button>` : `<button type="button" class="link" data-comment-act="delete">Retirer</button>`}</div>
  </div>`;
}

function renderCommentForm(d) {
  const lines = d.start === d.end ? `ligne ${d.start}` : `lignes ${d.start} à ${d.end}`;
  return `<form class="dc dc-form" data-comment-form>
    <label class="dc-head" for="comment-text">Commentaire sur ${esc(d.file)}, ${lines}${d.side === "old" ? " (retirée)" : ""} <span class="quiet">· Maj+clic sur une autre ligne pour étendre</span></label>
    <textarea id="comment-text" name="body" rows="3" maxlength="4000" placeholder="Ce qu'il faut changer ici"></textarea>
    <div class="dc-actions"><button type="submit" class="btn primary">Enregistrer</button><button type="button" class="btn ghost" data-comment-cancel>Annuler</button><span class="quiet">Entrée pour enregistrer, Maj+Entrée pour aller à la ligne, Échap pour annuler</span></div>
  </form>`;
}

/** Le diff complet d'une tâche : lignes numérotées, commentaires de Charles posés dessus. */
function renderPatch(patch, t) {
  if (!patch) return `<p class="quiet">Chargement du diff…</p>`;
  if (!patch.trim()) return `<p class="quiet">Aucun changement.</p>`;
  if (patch.startsWith("Diff indisponible")) return `<p class="goal-reason">${esc(patch)}</p>`;
  const files = parsePatch(patch);
  const comments = t?.comments ?? [];
  const placed = new Set();
  const canComment = t && (t.status === "review" || t.status === "failed");
  const open = comments.filter((c) => c.status === "open");
  const html = files
    .map((f, fi) => {
      const byRow = new Map();
      for (const c of comments.filter((c) => c.file === f.name)) {
        const at = anchorOf(c, f);
        if (at < 0) continue;
        placed.add(c.id);
        byRow.set(at, [...(byRow.get(at) ?? []), c]);
      }
      const d = commentDraft && commentDraft.task === t?.id && commentDraft.file === f.name ? commentDraft : null;
      const rows = f.rows
        .map((r, i) => {
          if (r.kind === "hunk") return `<div class="dl d-hunk">${esc(r.text)}</div>`;
          const side = r.kind === "del" ? "old" : "new";
          const num = side === "old" ? r.o : r.n;
          const sel = d && d.side === side && num >= d.start && num <= d.end ? " dl-sel" : "";
          const formHere = d && d.side === side && num === d.end;
          return `<div class="dl ${r.kind === "add" ? "d-add" : r.kind === "del" ? "d-del" : ""}${sel}" data-file="${fi}" data-side="${side}" data-line="${num}" tabindex="-1">${
            canComment ? `<button type="button" class="dl-add" tabindex="-1" aria-label="Commenter la ligne ${num}" data-comment-line>+</button>` : `<span class="dl-add" aria-hidden="true"></span>`
          }<span class="dl-no">${num}</span><span class="dl-text">${esc(r.text) || " "}</span></div>${(byRow.get(i) ?? []).map(renderComment).join("")}${formHere ? renderCommentForm(d) : ""}`;
        })
        .join("");
      return `<p class="diff-file" id="df-${t?.id}-${fi}" tabindex="-1">${esc(f.name)}</p><div class="diff${diffWrap ? " wrap" : ""}" data-diff-file="${esc(f.name)}">${rows}</div>`;
    })
    .join("");
  const loose = comments.filter((c) => !placed.has(c.id) && c.status === "open");
  const tools = t
    ? `<div class="diff-tools">
        ${canComment ? `<button type="button" class="btn primary" data-diff-send${open.length ? "" : " disabled"}>Envoyer ${open.length || ""} commentaire${open.length > 1 ? "s" : ""} à l'agent</button>` : ""}
        <label class="radio"><input type="checkbox" data-diff-wrap${diffWrap ? " checked" : ""} /> Retour à la ligne</label>
        <span class="quiet diff-keys"><kbd>j</kbd>/<kbd>k</kbd> fichiers · <kbd>n</kbd>/<kbd>p</kbd> changements${canComment ? " · <kbd>c</kbd> commenter" : ""}</span>
      </div>`
    : "";
  const detached = loose.length
    ? `<div class="dc-loose"><p class="dc-head">Lignes qui ont bougé depuis le commentaire</p>${loose.map((c) => `<p class="quiet"><code>${esc(c.file)}</code></p>${renderComment(c)}`).join("")}</div>`
    : "";
  return tools + html + detached;
}

/** PR : le lien si elle existe ; sinon le bouton, puis le formulaire avec le titre et le texte à relire. */
const prForms = new Map(); // "tasks:1" → { title, body, error } pendant que le formulaire est ouvert
const prStateText = { OPEN: "ouverte", MERGED: "mergée", CLOSED: "fermée" };
const reviewText = { APPROVED: "approuvée", CHANGES_REQUESTED: "changements demandés", REVIEW_REQUIRED: "relecture demandée" };

/** Une PR ouverte : son état, sa CI, ses reviews, et de quoi les traiter. */
function renderPrStatus(kind, id, url, st, followUps = []) {
  const link = `<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(url.replace(/^https:\/\/github\.com\//, ""))}</a>`;
  if (!st) return `<div class="pr-box" data-pr="${kind}:${id}"><p class="card-note">Pull request : ${link} · <span class="quiet">état pas encore lu</span> <button type="button" class="link" data-pr-act="pr-refresh">Lire</button></p></div>`;
  const fail = st.checks.filter((c) => c.state === "failure");
  const pend = st.checks.filter((c) => c.state === "pending");
  const ok = st.checks.filter((c) => c.state === "success");
  const ci = !st.checks.length
    ? "pas de CI"
    : fail.length
      ? `CI en échec : ${fail.map((c) => (c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noreferrer noopener">${esc(c.name)}</a>` : esc(c.name))).join(", ")}${ok.length ? ` · ${ok.length} réussi${ok.length > 1 ? "s" : ""}` : ""}`
      : pend.length
        ? `CI en cours (${pend.length})${ok.length ? ` · ${ok.length} réussi${ok.length > 1 ? "s" : ""}` : ""}`
        : `CI au vert (${ok.length})`;
  const open = st.state === "OPEN";
  const busy = followUps.some((f) => ["waiting", "preparing", "working", "review"].includes(f.status));
  return `<div class="pr-box" data-pr="${kind}:${id}" data-state="${st.state}">
    <p class="card-note">Pull request ${link} · <strong>${prStateText[st.state] ?? st.state}</strong>${st.draft ? " · brouillon" : ""}${st.reviewDecision && reviewText[st.reviewDecision] ? ` · ${reviewText[st.reviewDecision]}` : ""}</p>
    ${open ? `<p class="pr-ci${fail.length ? " bad" : ""}">${ci}</p>` : ""}
    ${st.error ? `<p class="quiet">Dernière lecture en échec : ${esc(st.error)}</p>` : ""}
    ${
      st.comments.length
        ? `<details class="goal-log pr-comments" data-pr-comments><summary>${st.comments.length} commentaire${st.comments.length > 1 ? "s" : ""} de review${st.fresh ? ` · <strong>${st.fresh} nouveau${st.fresh > 1 ? "x" : ""}</strong>` : ""}</summary>${st.comments
            .map((c) => `<div class="dc"><p class="dc-head">${esc(c.author)}${c.path ? ` · <code>${esc(c.path)}${c.line ? `:${c.line}` : ""}</code>` : ""}${c.state === "CHANGES_REQUESTED" ? " · changements demandés" : ""}</p><div class="prose">${md(c.body || "(sans texte)")}</div></div>`)
            .join("")}</details>`
        : ""
    }
    ${followUps.length ? `<ul class="link-list pr-follow">${followUps.map((f) => `<li><a href="#dev/${f.id}"><span class="dot" data-s="${f.status === "review" ? "review" : f.status === "accepted" ? "done" : "wait"}"></span><span class="ll-label">${esc(f.title)}</span><span class="quiet">${devStatus[f.status] ?? f.status}</span></a></li>`).join("")}</ul>` : ""}
    <div class="card-actions">
      ${open && fail.length ? `<button type="button" class="btn secondary" data-pr-act="pr-ci"${busy ? " disabled" : ""}>Corriger la CI</button>` : ""}
      ${open && st.comments.length ? `<button type="button" class="btn secondary" data-pr-act="pr-review"${busy ? " disabled" : ""}>Traiter les commentaires</button>` : ""}
      ${open ? `<button type="button" class="btn ghost" data-pr-act="pr-refresh">Actualiser</button>` : ""}
      <span class="quiet">lu à ${time(new Date(st.readAt))}</span>
    </div>
  </div>`;
}

side.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pr-act]");
  if (!b) return;
  const box = b.closest("[data-pr]");
  const [kind, id] = box.dataset.pr.split(":");
  b.disabled = true;
  try {
    const r = await post(`/api/dev/${kind === "task" ? "tasks" : "groups"}/${id}`, { action: b.dataset.prAct });
    if (r.id) location.hash = `#dev/${r.id}`;
  } catch (err) {
    box.querySelector(".inline-error")?.remove();
    box.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  } finally {
    b.disabled = false;
  }
});

side.addEventListener(
  "toggle",
  (e) => {
    const d = e.target.closest?.("[data-pr-comments]");
    if (!d?.open || !d.querySelector("strong")) return;
    const [kind, id] = d.closest("[data-pr]").dataset.pr.split(":");
    post(`/api/dev/${kind === "task" ? "tasks" : "groups"}/${id}`, { action: "pr-seen" }).catch(() => {});
  },
  true,
);

function renderPr(kind, id, url, st = null, followUps = []) {
  if (url) return renderPrStatus(kind === "tasks" ? "task" : "group", id, url, st, followUps);
  const key = `${kind}:${id}`;
  const f = prForms.get(key);
  if (!f) return `<div class="card-actions"><button type="button" class="btn secondary" data-pr-open="${key}">Ouvrir une pull request</button></div>`;
  return `<form class="card auto-form pr-form" data-pr-form="${key}" novalidate>
    <p class="card-title">Pull request vers <code>${esc(f.base ?? "")}</code></p>
    <p class="quiet field-hint">Clark envoie la branche <code>${esc(f.branch ?? "")}</code> sur GitHub et ouvre la PR avec ce titre et ce texte. Relis-les avant.</p>
    <label for="pr-title-${key}">Titre</label>
    <input id="pr-title-${key}" name="title" type="text" maxlength="200" value="${esc(f.title ?? "")}" />
    <label for="pr-body-${key}">Texte</label>
    <textarea id="pr-body-${key}" name="body" rows="6">${esc(f.body ?? "")}</textarea>
    ${f.error ? `<p class="inline-error" role="alert">${esc(f.error)}</p>` : ""}
    <div class="card-actions"><button type="submit" class="btn primary"${f.sending ? " disabled" : ""}>${f.sending ? "Envoi…" : "Ouvrir la PR"}</button><button type="button" class="btn ghost" data-pr-cancel="${key}">Annuler</button></div>
  </form>`;
}

function renderDevGroup(g) {
  const decided = g.tasks.length && g.tasks.every((t) => t.status === "accepted" || t.status === "discarded");
  const accepted = g.tasks.filter((t) => t.status === "accepted" && t.commit).length;
  const status = { planning: "plan en cours", running: decided ? "à réunir" : "en cours", integrated: "réuni", failed: "arrêté", discarded: "jeté" }[g.status] ?? g.status;
  return `<div class="card dev-group" data-dev-group="${g.id}" data-status="${g.status}">
    <div class="goal-head">
      <span class="kind-line">Groupe #${g.id} · ${esc(g.project)}${g.engine ? ` · ${esc(ENGINE_NAMES[g.engine] ?? g.engine)}` : ""}${g.tasks.length ? ` · ${g.tasks.length} sous-tâche${g.tasks.length > 1 ? "s" : ""}` : ""}</span>
      <span class="tag dev-${g.status === "running" && decided ? "review" : g.status === "planning" ? "working" : g.status}">${g.status === "planning" ? `${sprite("clark", { walking: true, size: 14 })}` : ""}${status}</span>
    </div>
    ${g.status === "planning" ? `<p class="quiet">Un agent lit le projet et découpe la consigne en sous-tâches indépendantes.</p>` : ""}
    ${g.error ? `<p class="goal-reason">${esc(g.error)}</p>` : ""}
    ${(g.gates ?? []).map((x) => renderGate(x, "")).join("")}
    ${g.tasks.length ? `<div class="dev-subtasks">${g.tasks.map((t) => renderDevTask(t, true)).join("")}</div>` : ""}
    ${g.status === "running" && decided ? `<div class="card-actions"><button type="button" class="btn primary" data-group-action="integrate"${accepted ? "" : " disabled"}>Réunir les ${accepted} sous-tâche${accepted > 1 ? "s" : ""} acceptée${accepted > 1 ? "s" : ""}</button><button type="button" class="btn ghost" data-group-action="discard">Jeter le groupe</button></div>` : ""}
    ${g.status === "integrated" ? `<p class="card-note">Réunies sur <code>${esc(g.branch)}</code> (commit <code>${esc((g.commit ?? "").slice(0, 7))}</code>).</p>${renderPr("groups", g.id, g.pr, g.prStatus, g.followUps)}` : ""}
  </div>`;
}

const minutesSince = (ms) => Math.max(1, Math.round((Date.now() - ms) / 60_000));
const groupOf = (t) => (state.dev?.groups ?? []).find((g) => g.tasks.some((x) => x.id === t.id)) ?? null;

/** Ce qu'une sous-tâche attend : celles dont elle dépend, et les décisions qui la concernent. */
function waitingFor(t) {
  const g = groupOf(t);
  if (!g) return "";
  const deps = t.dependsOn
    .map((id) => g.tasks.find((x) => x.id === id))
    .filter((d) => d && d.status !== "accepted")
    .map((d) => `#${d.id} « ${esc(d.title)} » (${devStatus[d.status] ?? d.status})`);
  const gates = (g.gates ?? []).filter((x) => x.resolution === null && x.tasks.includes(t.id));
  const parts = [];
  if (deps.length) parts.push(`d'avoir accepté ${deps.join(", ")}`);
  if (gates.length) parts.push(`ta décision : « ${esc(gates[0].question)} »`);
  return parts.length ? `<p class="quiet dev-wait">Attend ${parts.join(", et ")}.</p>` : "";
}

/** Une décision demandée par le plan : options en un clic, ou ta réponse à toi. */
function renderGate(x, groupTitle) {
  if (x.resolution !== null) return `<p class="card-note dev-gate-done">Décision : ${esc(x.question)} → <strong>${esc(x.resolution)}</strong></p>`;
  return `<div class="card dev-gate" data-gate="${x.id}">
    <p class="card-title">${esc(x.question)}</p>
    ${groupTitle ? `<p class="quiet">Groupe dev « ${esc(groupTitle)} » : ${x.tasks.length} sous-tâche${x.tasks.length > 1 ? "s" : ""} attend${x.tasks.length > 1 ? "ent" : ""} ta réponse.</p>` : ""}
    <div class="card-actions">${x.options.map((o) => `<button type="button" class="btn secondary" data-gate-pick="${esc(o)}">${esc(o)}</button>`).join("")}</div>
    <form class="command-run" data-gate-form>
      <label class="visually-hidden" for="gate-${x.id}">Autre réponse</label>
      <input id="gate-${x.id}" name="resolution" type="text" autocomplete="off" maxlength="1000" placeholder="Autre chose : écris ta décision" />
      <button type="submit" class="btn secondary">Décider</button>
    </form>
  </div>`;
}

/** Les points de reprise : un par tour de l'agent ; on peut revenir à n'importe lequel. */
function renderCheckpoints(t) {
  const list = t.checkpoints ?? [];
  if (list.length < 2) return "";
  const current = t.atRound ?? list.at(-1).round;
  return `<details class="goal-log dev-rounds"><summary>Tours de l'agent (${list.length})${t.atRound ? ` · copie revenue au tour ${t.atRound}` : ""}</summary>
    <ol class="dev-round-list">${list
      .map(
        (c) => `<li${c.round === current ? ' aria-current="true"' : ""}>
        <span><strong>Tour ${c.round}</strong>${c.diff ? ` <span class="quiet">+${c.diff.added} −${c.diff.removed}</span>` : ""}${c.summary ? ` · ${esc(c.summary)}` : ""}</span>
        ${c.round === current ? `<span class="tag">état actuel</span>` : `<button type="button" class="btn ghost" data-dev-restore="${c.round}">Revenir à ce tour</button>`}
      </li>`,
      )
      .join("")}</ol>
    <p class="quiet">Revenir à un tour remet la copie dans son état d'alors ; les autres tours restent disponibles. L'agent en est prévenu à sa prochaine retouche.</p>
  </details>`;
}

side.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dev-restore]");
  if (!b) return;
  const card = b.closest("[data-dev]");
  if (!(await ask(`Revenir au tour ${b.dataset.devRestore} ?`, "La copie reprend l'état de ce tour. Les tours suivants restent disponibles, tu peux y revenir.", "Revenir"))) return;
  b.disabled = true;
  try {
    await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "restore", round: Number(b.dataset.devRestore) });
  } catch (err) {
    b.disabled = false;
    b.insertAdjacentHTML("afterend", ` <span class="inline-error" role="alert">${esc(err.message)}</span>`);
  }
});

/** Réessayer de zéro, avec un autre moteur, modèle ou effort. */
function renderRetry(t) {
  const engines = (state.engines ?? []).filter((e) => e.ready !== false);
  const opts = engines
    .map((e) => {
      const models = e.models ?? [];
      return `<optgroup label="${esc(ENGINE_NAMES[e.name] ?? e.name)}">
        <option value="${e.name}|">${esc(ENGINE_NAMES[e.name] ?? e.name)} · modèle des réglages</option>
        ${models.map((m) => `<option value="${e.name}|${esc(m.id)}">${esc(ENGINE_NAMES[e.name] ?? e.name)} · ${esc(m.name)}</option>`).join("")}
      </optgroup>`;
    })
    .join("");
  const efforts = [...new Set(engines.flatMap((e) => (e.models ?? []).flatMap((m) => m.efforts ?? [])))];
  return `<details class="goal-log dev-retry"><summary>Réessayer de zéro${t.attempts > 1 ? ` (tentative ${t.attempts + 1})` : ""}</summary>
    <form class="dev-retry-form" data-dev-retry>
      <p class="quiet">Nouvelle copie, nouvelle conversation : l'agent repart de la consigne, sans ce qui a été fait.</p>
      <label for="retry-engine-${t.id}">Moteur et modèle</label>
      <select id="retry-engine-${t.id}" name="engine"><option value="|">Moteur principal, réglages actuels</option>${opts}</select>
      <label for="retry-effort-${t.id}">Effort</label>
      <select id="retry-effort-${t.id}" name="effort"><option value="">Celui des réglages</option>${efforts.map((x) => `<option value="${x}">${esc(EFFORT_LABELS[x] ?? x)}</option>`).join("")}</select>
      <div class="card-actions"><button type="submit" class="btn secondary">Réessayer</button></div>
    </form>
  </details>`;
}

// Le reste des actions d'une tâche, rangé dans « … » ; un choix ouvre son panneau sous la carte.
let devPanel = null; // { id, panel: "rounds" | "retry" | "compare" | "info" }

function renderDevMore(t, project, nested) {
  const items = [
    project?.test ? `<ui-menu-item value="test"${t.tests?.running ? " disabled" : ""}>Lancer les tests</ui-menu-item>` : "",
    (t.checkpoints ?? []).length >= 2 ? `<ui-menu-item value="rounds">Tours de l'agent (${t.checkpoints.length})</ui-menu-item>` : "",
    !nested && !t.compareWith && !t.prOf && !t.onPrBranch ? `<ui-menu-item value="compare">Comparer avec un autre agent…</ui-menu-item>` : "",
    `<ui-menu-item value="retry">Réessayer de zéro…</ui-menu-item>`,
    `<ui-menu-item value="info">Détails (branche, moteur, tours)</ui-menu-item>`,
    `<ui-menu-separator></ui-menu-separator>`,
    `<ui-menu-item value="discard" class="danger">Jeter</ui-menu-item>`,
  ];
  return `<ui-menu data-dev-more="${t.id}">
    <ui-menu-trigger><button type="button" class="btn ghost more-btn" aria-label="Plus d'actions pour la tâche #${t.id}"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><circle cx="12.5" cy="8" r="1.3" fill="currentColor" /></svg></button></ui-menu-trigger>
    <ui-menu-content class="menu-more" align="start">${items.join("")}</ui-menu-content>
  </ui-menu>`;
}

function renderDevPanel(t) {
  const close = `<button type="button" class="link dev-panel-close" data-dev-panel-close>Fermer</button>`;
  if (devPanel.panel === "rounds") return renderCheckpoints(t).replace("<details ", "<details open ") + close;
  if (devPanel.panel === "retry") return renderRetry(t).replace("<details ", "<details open ") + close;
  if (devPanel.panel === "compare") return renderCompareForm(t).replace("<details ", "<details open ") + close;
  return `<dl class="dev-info">
    <dt>Tâche</dt><dd>#${t.id}${t.attempts > 1 ? `, tentative ${t.attempts}` : ""}</dd>
    <dt>Branche</dt><dd><code>${esc(t.branch)}</code></dd>
    <dt>Agent</dt><dd>${esc(sideLabel(t))}</dd>
    <dt>Tours</dt><dd>${t.rounds}</dd>
  </dl>${close}`;
}

document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-dev-panel-close]")) return;
  devPanel = null;
  renderView();
});

document.addEventListener("action", (e) => {
  const menu = e.target.closest?.("[data-dev-more]");
  if (!menu) return;
  const id = Number(menu.dataset.devMore);
  const value = String(e.detail.value);
  if (["rounds", "retry", "compare", "info"].includes(value)) {
    devPanel = devPanel?.id === id && devPanel.panel === value ? null : { id, panel: value };
    renderView();
    return;
  }
  // Tests et Jeter passent par les mêmes chemins que les anciens boutons.
  const card = menu.closest("[data-dev]");
  const proxy = document.createElement("button");
  proxy.type = "button";
  proxy.hidden = true;
  proxy.dataset.devAction = value;
  card.querySelector(".card-actions").append(proxy);
  proxy.click();
  proxy.remove();
}, true);

/** Qui fait cette version : moteur (le principal si rien n'est choisi), modèle, effort. */
function sideLabel(t) {
  const engine = t.engine ?? (state.engines ?? []).find((e) => e.main)?.name ?? state.clark.engine.name;
  return [ENGINE_NAMES[engine] ?? engine, t.model, t.effort ? `effort ${EFFORT_M[t.effort] ?? t.effort}` : null].filter(Boolean).join(" · ");
}

/** Depuis une tâche seule : la même consigne, à un autre agent, dans sa propre copie. */
function renderCompareForm(t) {
  const engines = (state.engines ?? []).filter((e) => e.ready !== false);
  const opts = engines
    .map((e) => `<optgroup label="${esc(ENGINE_NAMES[e.name] ?? e.name)}">
        <option value="${e.name}|">${esc(ENGINE_NAMES[e.name] ?? e.name)} · modèle des réglages</option>
        ${(e.models ?? []).map((m) => `<option value="${e.name}|${esc(m.id)}">${esc(ENGINE_NAMES[e.name] ?? e.name)} · ${esc(m.name)}</option>`).join("")}
      </optgroup>`)
    .join("");
  const efforts = [...new Set(engines.flatMap((e) => (e.models ?? []).flatMap((m) => m.efforts ?? [])))];
  const other = (t.engine ?? (state.engines ?? []).find((e) => e.main)?.name) === "codex" ? "claude" : "codex";
  return `<details class="goal-log dev-compare-open"><summary>Comparer avec un autre agent</summary>
    <form class="dev-retry-form" data-dev-compare>
      <p class="quiet">La même consigne, dans une autre copie. Tu compares les deux et tu gardes celle que tu préfères ; celle-ci reste telle quelle.</p>
      <label for="compare-engine-${t.id}">Moteur et modèle</label>
      <select id="compare-engine-${t.id}" name="engine">${opts.replace(`value="${other}|"`, `value="${other}|" selected`)}</select>
      <label for="compare-effort-${t.id}">Effort</label>
      <select id="compare-effort-${t.id}" name="effort"><option value="">Celui des réglages</option>${efforts.map((x) => `<option value="${x}">${esc(EFFORT_LABELS[x] ?? x)}</option>`).join("")}</select>
      <div class="card-actions"><button type="submit" class="btn secondary">Lancer l'autre version</button></div>
    </form>
  </details>`;
}

/**
 * Comparaison : les deux versions côte à côte (qui, où elles en sont, ce qu'elles ont touché),
 * les fichiers touchés par les deux, puis « Garder celle-ci ».
 */
function renderCompare(t) {
  const all = allDevTasks();
  const o = all.find((x) => x.id === t.compareWith);
  if (!o) return "";
  const [a, b] = t.id < o.id ? [t, o] : [o, t];
  const paths = (x) => (x.diff?.files ?? []).map((f) => f.path);
  const finished = (x) => ["review", "failed", "accepted", "discarded"].includes(x.status);
  const decided = [a, b].find((x) => x.status === "accepted");
  const col = (x) => {
    const files = x.diff?.files ?? [];
    const here = x.id === t.id;
    return `<div class="compare-side" data-compare-side="${x.id}"${here ? ' aria-current="true"' : ""}>
      <div class="goal-head">
        <span class="compare-who">${esc(sideLabel(x))}</span>
        <span class="tag dev-${x.status}">${x.status === "working" ? sprite("clark", { walking: true, size: 14 }) : ""}${devStatus[x.status] ?? x.status}</span>
      </div>
      <p class="quiet">#${x.id}${here ? " · cette page" : ` · <a href="#dev/${x.id}">ouvrir</a>`}${x.rounds > 1 ? ` · ${x.rounds} tours` : ""}</p>
      ${
        x.status === "working"
          ? `<p class="quiet">${x.waiting ? "En attente d'un agent libre." : esc(x.checkpoint ?? "L'agent travaille.")}</p>`
          : files.length
            ? `<p class="compare-stat">${files.length} fichier${files.length > 1 ? "s" : ""} · <span class="d-add">+${x.diff.added}</span> <span class="d-del">−${x.diff.removed}</span></p>`
            : finished(x)
              ? `<p class="quiet">Aucun fichier changé.</p>`
              : ""
      }
      ${x.tests && !x.tests.running ? `<p class="quiet">Tests : ${x.tests.ok ? "réussis" : "en échec"}</p>` : ""}
      ${x.summary && finished(x) ? `<p class="compare-summary">${esc(x.summary.split("\n").find((l) => l.trim())?.slice(0, 220) ?? "")}</p>` : ""}
      ${!decided && x.status === "review" ? `<div class="card-actions"><button type="button" class="btn ${here ? "primary" : "secondary"}" data-dev-keep="${x.id}">Garder celle-ci</button></div>` : ""}
    </div>`;
  };
  let converge = "";
  if (decided) converge = `<p class="card-note">Tranchée : #${decided.id} (${esc(sideLabel(decided))}) gardée.</p>`;
  else if (!finished(a) || !finished(b)) converge = `<p class="quiet">Les fichiers touchés par les deux s'afficheront quand les deux auront fini.</p>`;
  else {
    const pa = paths(a);
    const pb = paths(b);
    const both = pa.filter((p) => pb.includes(p));
    const onlyA = pa.filter((p) => !pb.includes(p));
    const onlyB = pb.filter((p) => !pa.includes(p));
    const list = (xs) => xs.map((p) => `<code>${esc(p)}</code>`).join(", ");
    converge = `<dl class="compare-converge">
      <dt>Touchés par les deux</dt><dd>${both.length ? list(both) : "aucun"}</dd>
      ${onlyA.length ? `<dt>Seulement ${esc(sideLabel(a))}</dt><dd>${list(onlyA)}</dd>` : ""}
      ${onlyB.length ? `<dt>Seulement ${esc(sideLabel(b))}</dt><dd>${list(onlyB)}</dd>` : ""}
    </dl>`;
  }
  return `<section class="card compare" aria-labelledby="compare-title-${t.id}">
    <p class="card-title" id="compare-title-${t.id}">Comparaison</p>
    <div class="compare-grid">${col(a)}${col(b)}</div>
    ${converge}
  </section>`;
}

function renderDevTask(t, nested = false) {
  const files = t.diff?.files ?? [];
  const open = t.status === "review" || t.status === "failed";
  const tests = t.tests;
  const project = (state.dev?.projects ?? []).find((p) => p.name === t.project);
  const testBlock = !open
    ? ""
    : tests?.running
      ? `<p class="quiet">Tests en cours…</p>`
      : tests
        ? `<details class="goal-log dev-tests" data-ok="${tests.ok}"><summary>Tests : ${tests.ok ? "réussis" : tests.timedOut ? "trop longs, arrêtés" : `échec (code ${tests.code ?? "?"})`} · ${time(new Date(tests.at))}</summary><pre class="command-prompt">${esc(tests.output || "(aucune sortie)")}</pre></details>`
        : "";
  return `<div class="card dev-task${nested ? " nested" : ""}" data-dev="${t.id}" data-status="${t.status}">
    <div class="goal-head">
      <span class="kind-line">${esc(nested ? `Sous-tâche · ${sideLabel(t)}` : `${t.project} · ${sideLabel(t)}`)}</span>
      <span class="tag dev-${t.status}">${t.status === "working" ? `${sprite("clark", { walking: true, size: 14 })}` : ""}${devStatus[t.status] ?? t.status}</span>
    </div>
    ${nested ? `<p class="card-title">${esc(t.title)}</p>` : ""}
    ${
      t.setup && (!t.setup.ok || t.setup.dirty?.length)
        ? `<details class="goal-log dev-tests" data-ok="false"><summary>${!t.setup.ok ? `Préparation de la copie en échec (<code>${esc(t.setup.command)}</code>)` : `La préparation a créé ou changé ${t.setup.dirty.length} fichier(s) suivi(s) par git : ils sont dans le diff`}</summary>${
            t.setup.dirty?.length ? `<p class="quiet">${t.setup.dirty.map((f) => `<code>${esc(f)}</code>`).join(", ")}. Ajoute-les au .gitignore du projet, ou jette-les avant d'accepter.</p>` : ""
          }${t.setup.output ? `<pre class="command-prompt">${esc(t.setup.output)}</pre>` : ""}</details>`
        : ""
    }
    ${t.issue ? `<p class="quiet">Depuis l'issue <a href="${esc(t.issue.url)}" target="_blank" rel="noreferrer noopener">#${t.issue.number}</a> : la PR la fermera.</p>` : ""}
    ${t.prOf ? `<p class="quiet">Suivi de la PR${t.pr ? ` <a href="${esc(t.pr)}" target="_blank" rel="noreferrer noopener">${esc(t.pr.replace(/^.*\/pull\//, "#"))}</a>` : ""}, sur sa branche : accepter met la PR à jour (sans forcer).</p>` : ""}
    ${t.status === "waiting" ? waitingFor(t) : t.dependsOn?.length ? `<p class="quiet">Part du travail de ${t.dependsOn.map((d) => `#${d}`).join(", ")}.</p>` : ""}
    ${t.stalledSince ? `<p class="dev-stalled" role="status">Silencieux depuis ${minutesSince(t.stalledSince)} min : l'agent est peut-être bloqué.</p>` : ""}
    ${t.status === "working" && t.stoppable ? `<div class="card-actions"><button type="button" class="btn ghost" data-dev-action="stop"${t.waiting ? " data-waiting" : ""}>${t.waiting ? "Annuler" : "Arrêter l'agent"}</button></div>` : ""}
    ${t.status === "working" ? (t.waiting ? `<p class="quiet">En attente d'un agent libre (${state.dev?.parallel ?? 2} en même temps au plus).</p>` : `${t.checkpoint ? `<p class="checkpoint solo">${esc(t.checkpoint)}</p>` : ""}${t.steps.length ? renderSteps(t.steps) : `<p class="quiet">L'agent lit le projet.</p>`}`) : ""}
    ${t.error ? `<p class="goal-reason">${esc(t.error)}</p>` : ""}
    ${open && t.summary ? `<div class="prose dev-summary">${md(t.summary)}</div>` : ""}
    ${
      open && files.length
        ? `<ul class="dev-files">${files
            .map((f, i) => `<li><span class="dev-mark" title="${f.status}">${fileStatusMark[f.status] ?? "M"}</span><button type="button" class="link dev-file-go" data-diff-goto="${i}"><code>${esc(f.path)}</code></button><span class="dev-count">${f.binary ? "binaire" : `<span class="d-add">+${f.added}</span> <span class="d-del">−${f.removed}</span>`}</span></li>`)
            .join("")}</ul>
          <details class="goal-log dev-diff" data-dev-diff><summary>Voir le diff (+${t.diff.added} −${t.diff.removed})</summary>${devPatches.get(t.id)?.rounds === patchKey(t) ? renderPatch(devPatches.get(t.id).patch, t) : `<p class="quiet">Chargement du diff…</p>`}</details>`
        : open
          ? `<p class="quiet">Aucun fichier changé.</p>`
          : ""
    }
    ${testBlock}
    ${t.status === "accepted" ? `<p class="card-note">${t.commit ? `Commit <code>${esc(t.commit.slice(0, 7))}</code> sur <code>${esc(t.branch)}</code>.` : "Acceptée, sans changement."}</p>` : ""}
    ${t.status === "accepted" && t.commit && !nested && !t.prOf ? renderPr("tasks", t.id, t.pr, t.prStatus, t.followUps) : ""}
    ${
      open
        ? `<div class="card-actions">
            ${t.status === "review" ? (t.compareWith ? `<button type="button" class="btn primary" data-dev-keep="${t.id}">Garder celle-ci</button>` : `<button type="button" class="btn primary" data-dev-action="accept">${t.prOf ? "Accepter et mettre à jour la PR" : "Accepter"}</button>`) : ""}
            ${state.dev?.preview?.taskId === t.id ? "" : `<button type="button" class="btn secondary" data-design-open>Aperçu</button>`}
            ${renderDevMore(t, project, nested)}
          </div>
          ${designPick?.taskId === t.id ? renderDesignPick(designPick) : ""}
          <form class="command-run dev-retouch" data-dev-retouch>
            <label class="visually-hidden" for="dev-retouch-${t.id}">Retouche pour la tâche #${t.id}</label>
            <input id="dev-retouch-${t.id}" name="instruction" type="text" autocomplete="off" placeholder="${designPick?.taskId === t.id ? "Retouche pour cet élément : ce qu'il faut changer" : "Retouche : ce qu'il faut changer"}" />
            <button type="submit" class="btn secondary">Retoucher</button>
          </form>
          ${devPanel?.id === t.id ? renderDevPanel(t) : ""}`
        : t.status === "waiting"
          ? `<div class="card-actions"><button type="button" class="btn ghost" data-dev-action="discard">Jeter</button></div>`
          : ""
    }
  </div>`;
}

function renderProjectForm() {
  return `<form class="card auto-form" id="project-form" novalidate>
    <p class="card-title">Nouveau projet</p>
    <label for="pf-name">Nom</label>
    <input id="pf-name" name="name" type="text" maxlength="40" autocomplete="off" placeholder="portfolio" />
    <label for="pf-path">Dossier du dépôt git</label>
    <input id="pf-path" name="path" type="text" autocomplete="off" placeholder="/Users/charles/Developer/portfolio" />
    <label for="pf-base">Branche de base <span class="optional">(facultatif : celle du dépôt par défaut)</span></label>
    <input id="pf-base" name="baseBranch" type="text" autocomplete="off" placeholder="main" />
    <label for="pf-test">Commande de test <span class="optional">(facultatif)</span></label>
    <input id="pf-test" name="testCommand" type="text" autocomplete="off" placeholder="npm test" aria-describedby="pf-test-hint" />
    <p class="quiet field-hint" id="pf-test-hint">Lancée sur ton clic, dans la copie de la tâche, hors du bac à sable : les tests ont souvent besoin du réseau et des dépendances.</p>
    <p class="inline-error" id="pf-error" role="alert" hidden></p>
    <div class="card-actions"><button type="submit" class="btn primary">Ajouter</button><button type="button" class="btn ghost" data-project-cancel>Annuler</button></div>
  </form>`;
}

// Issues GitHub d'un projet : chargées sur demande, une tâche (ou un groupe) en un clic.
const issueLists = new Map(); // projet → { loading, issues, error }

function renderIssues(pid) {
  const l = issueLists.get(pid);
  if (!l) return "";
  if (l.loading) return `<p class="quiet">Lecture des issues…</p>`;
  if (l.error) return `<p class="inline-error" role="alert">${esc(l.error)}</p>`;
  if (!l.issues.length) return `<p class="quiet">Aucune issue ouverte.</p>`;
  return `<ul class="issue-list">${l.issues
    .map(
      (i) => `<li data-issue="${i.number}">
      <div><a href="${esc(i.url)}" target="_blank" rel="noreferrer noopener">#${i.number}</a> ${esc(i.title)}${i.labels.length ? ` <span class="quiet">${i.labels.map(esc).join(", ")}</span>` : ""}</div>
      <div class="card-actions"><button type="button" class="btn secondary" data-issue-start="task">Tâche dev</button><button type="button" class="btn ghost" data-issue-start="split">En parallèle</button></div>
    </li>`,
    )
    .join("")}</ul>`;
}

side.addEventListener("click", async (e) => {
  const load = e.target.closest("[data-issues-load]");
  const start = e.target.closest("[data-issue-start]");
  if (load) {
    const pid = Number(load.closest("[data-project]").dataset.project);
    issueLists.set(pid, { loading: true });
    renderView();
    try {
      const res = await fetch(`/api/dev/projects/${pid}/issues?fresh=1`);
      const data = await res.json();
      issueLists.set(pid, res.ok ? { issues: data.issues } : { error: data.error });
    } catch (err) {
      issueLists.set(pid, { error: err.message });
    }
    renderView();
  } else if (start) {
    const pid = Number(start.closest("[data-project]").dataset.project);
    const n = Number(start.closest("[data-issue]").dataset.issue);
    start.disabled = true;
    try {
      const r = await post("/api/dev/tasks", { projectId: pid, issue: n, instruction: "", engine: "", split: start.dataset.issueStart === "split" });
      location.hash = start.dataset.issueStart === "split" ? `#groupe/${r.id}` : `#dev/${r.id}`;
    } catch (err) {
      start.disabled = false;
      start.closest("li").insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
  }
});

/** Réglages d'un projet : moteur, modèle et effort par défaut ; préparation de chaque copie. */
function renderProjectSettings(p) {
  const engines = state.engines ?? [];
  const models = (engines.find((e) => e.name === p.engine)?.models ?? []);
  const efforts = models.find((m) => m.id === p.model)?.efforts ?? [...new Set(models.flatMap((m) => m.efforts ?? []))];
  const summary = [p.engine ? `${ENGINE_NAMES[p.engine]}${p.model ? ` · ${p.model}` : ""}${p.effort ? ` · ${EFFORT_LABELS[p.effort] ?? p.effort}` : ""}` : "moteur principal", p.setup ? "préparation" : "", p.copy.length ? `${p.copy.length} fichier(s) copiés` : ""].filter(Boolean).join(" · ");
  return `<details class="goal-log project-settings"><summary>Réglages du projet <span class="quiet">${esc(summary)}</span></summary>
    <form class="auto-form" data-project-settings="${p.id}" novalidate>
      <label for="ps-engine-${p.id}">Moteur par défaut</label>
      <select id="ps-engine-${p.id}" name="engine"><option value="">Moteur principal</option>${["claude", "codex"].map((e) => `<option value="${e}"${p.engine === e ? " selected" : ""}>${ENGINE_NAMES[e]}</option>`).join("")}</select>
      <label for="ps-model-${p.id}">Modèle</label>
      <select id="ps-model-${p.id}" name="model"${p.engine ? "" : " disabled"}><option value="">Celui des réglages du moteur</option>${models.map((m) => `<option value="${esc(m.id)}"${p.model === m.id ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
      <label for="ps-effort-${p.id}">Effort</label>
      <select id="ps-effort-${p.id}" name="effort"${p.engine ? "" : " disabled"}><option value="">Celui des réglages du moteur</option>${efforts.map((x) => `<option value="${x}"${p.effort === x ? " selected" : ""}>${esc(EFFORT_LABELS[x] ?? x)}</option>`).join("")}</select>
      <label for="ps-test-${p.id}">Commande de test</label>
      <input id="ps-test-${p.id}" name="testCommand" type="text" autocomplete="off" value="${esc(p.test ?? "")}" placeholder="npm test" />
      <label for="ps-setup-${p.id}">Préparation de chaque copie <span class="optional">(facultatif)</span></label>
      <input id="ps-setup-${p.id}" name="setupCommand" type="text" autocomplete="off" value="${esc(p.setup ?? "")}" placeholder="npm ci" aria-describedby="ps-setup-hint-${p.id}" />
      <p class="quiet field-hint" id="ps-setup-hint-${p.id}">Lancée dans chaque nouvelle copie, avant l'agent, hors du bac à sable (souvent besoin du réseau), 10 minutes au plus.</p>
      <label for="ps-copy-${p.id}">Fichiers ignorés par git à copier dans chaque copie <span class="optional">(un par ligne)</span></label>
      <textarea id="ps-copy-${p.id}" name="copyPaths" rows="3" placeholder="config/local.json" aria-describedby="ps-copy-hint-${p.id}">${esc(p.copy.join("\n"))}</textarea>
      <p class="quiet field-hint" id="ps-copy-hint-${p.id}">Jamais de secret : .env, clés et identifiants sont refusés, car l'agent lit sa copie.</p>
      <label for="ps-pcmd-${p.id}">Aperçu (mode design) : serveur de dev <span class="optional">(facultatif)</span></label>
      <input id="ps-pcmd-${p.id}" name="previewCommand" type="text" autocomplete="off" value="${esc(p.preview?.command ?? "")}" placeholder="npm run dev -- --port $PORT" aria-describedby="ps-pcmd-hint-${p.id}" />
      <p class="quiet field-hint" id="ps-pcmd-hint-${p.id}">Lancée dans la copie quand tu ouvres l'aperçu, avec le port à utiliser dans $PORT. Vide : Clark montre les fichiers de la copie tels quels.</p>
      <label for="ps-ppath-${p.id}">Page ouverte par l'aperçu <span class="optional">(facultatif)</span></label>
      <input id="ps-ppath-${p.id}" name="previewPath" type="text" autocomplete="off" value="${esc(p.preview?.path ?? "")}" placeholder="index.html" />
      <p class="inline-error" role="alert" hidden></p>
      <div class="card-actions"><button type="submit" class="btn primary">Enregistrer</button></div>
    </form>
  </details>`;
}

side.addEventListener("input", (e) => {
  const f = e.target.closest("[data-project-settings]");
  if (f) f.dataset.dirty = "1";
});

side.addEventListener("change", (e) => {
  // Changer de moteur change la liste des modèles : on rafraîchit le formulaire sans perdre le reste.
  const f = e.target.closest("[data-project-settings]");
  if (!f || e.target.name !== "engine") return;
  const p = (state.dev?.projects ?? []).find((x) => x.id === Number(f.dataset.projectSettings));
  if (!p) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = renderProjectSettings({ ...p, engine: e.target.value || null, model: null, effort: null });
  const fresh = tmp.querySelector("form");
  for (const name of ["testCommand", "setupCommand", "copyPaths", "previewCommand", "previewPath"]) fresh.elements[name].value = f.elements[name].value;
  fresh.dataset.dirty = "1";
  f.replaceWith(fresh);
  fresh.elements.engine.focus();
});

side.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-project-settings]");
  if (!f) return;
  e.preventDefault();
  const err = f.querySelector(".inline-error");
  const el = f.elements;
  try {
    await post(`/api/dev/projects/${f.dataset.projectSettings}`, {
      action: "settings",
      engine: el.engine.value,
      model: el.model.value,
      effort: el.effort.value,
      testCommand: el.testCommand.value,
      setupCommand: el.setupCommand.value,
      copyPaths: el.copyPaths.value.split("\n").map((x) => x.trim()).filter(Boolean),
      previewCommand: el.previewCommand.value,
      previewPath: el.previewPath.value,
    });
    delete f.dataset.dirty;
    err.hidden = true;
    $("#announce").textContent = "Réglages du projet enregistrés";
    renderSettings();
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  }
});

// La fenêtre des raccourcis est hors de #app : son bouton, et un clic à côté, la ferment.
$("#shortcuts").addEventListener("click", (e) => {
  if (e.target.closest("[data-shortcuts-close]") || e.target === e.currentTarget) $("#shortcuts").close();
});

function buildProjects() {
  const projects = (state.dev ?? { projects: [] }).projects;
  return section(
    "projects",
    "Projets",
    projects.length || "",
    `${
      projects.length
        ? `<ul class="memories">${projects
            .map(
              (p) => `<li data-project="${p.id}"><span class="kind">${esc(p.name)} · ${esc(p.base)}</span><code class="dev-path">${esc(p.path)}</code><span class="origin">${p.test ? `tests : <code>${esc(p.test)}</code>` : "pas de commande de test"} · <button type="button" class="link" data-issues-load>${issueLists.has(p.id) ? "Actualiser les issues" : "Issues GitHub"}</button> · <button type="button" class="link" data-project-delete>Retirer</button></span>${renderProjectSettings(p)}${renderIssues(p.id)}</li>`,
            )
            .join("")}</ul>`
        : `<p class="quiet">Ajoute un dépôt git : Clark y fera travailler ses agents, chacun dans sa propre copie, sans toucher à ta branche. Ensuite, choisis « Tâche dev » sous le champ de message.</p>`
    }${projectFormOpen ? renderProjectForm() : `<button type="button" class="btn secondary mcp-new" data-project-new>Ajouter un projet</button>`}`,
  );
}

const allDevTasks = () => [...(state.dev?.tasks ?? []), ...(state.dev?.groups ?? []).flatMap((g) => g.tasks)];

const patchLoading = new Set();
const openDiffTasks = new Set(); // tâches dont le diff est ouvert (ids, en texte)

async function loadPatch(id) {
  const t = allDevTasks().find((x) => x.id === id);
  patchLoading.add(id);
  try {
    const res = await fetch(`/api/dev/tasks/${id}/diff`);
    const data = await res.json();
    devPatches.set(id, { rounds: t ? patchKey(t) : undefined, patch: res.ok ? data.patch : `Diff indisponible : ${data.error}` });
  } catch (err) {
    devPatches.set(id, { rounds: t ? patchKey(t) : undefined, patch: `Diff indisponible : ${err.message}` });
  } finally {
    patchLoading.delete(id);
  }
  if (view === "detail") renderView();
}

side.addEventListener(
  "toggle",
  (e) => {
    const d = e.target.closest?.("[data-dev-diff]");
    if (!d) return;
    // Un diff ouvert le reste pendant le tour de l'agent (il disparaît le temps du tour) : on s'en souvient.
    if (d.open) openDiffTasks.add(d.closest("[data-dev]").dataset.dev);
    else openDiffTasks.delete(d.closest("[data-dev]").dataset.dev);
    if (!d.open) return;
    const id = Number(d.closest("[data-dev]").dataset.dev);
    const t = allDevTasks().find((x) => x.id === id);
    if (devPatches.get(id)?.rounds !== (t ? patchKey(t) : undefined)) void loadPatch(id);
  },
  true,
);


// ── Relecture du diff : commentaires, clavier, retour à la ligne ──

const rowInfo = (row) => {
  const card = row.closest("[data-dev]");
  const file = row.closest("[data-diff-file]").dataset.diffFile;
  return { task: Number(card.dataset.dev), file, side: row.dataset.side, line: Number(row.dataset.line) };
};

function snippetOf(taskId, file, side, start, end) {
  const box = document.querySelector(`[data-dev="${taskId}"] [data-diff-file="${CSS.escape(file)}"]`);
  return [...(box?.querySelectorAll(`.dl[data-side="${side}"]`) ?? [])]
    .filter((r) => Number(r.dataset.line) >= start && Number(r.dataset.line) <= end)
    .map((r) => r.querySelector(".dl-text").textContent.replace(/^ $/, ""))
    .join("\n");
}

function startComment(row, extend) {
  const info = rowInfo(row);
  if (extend && commentDraft && commentDraft.task === info.task && commentDraft.file === info.file && commentDraft.side === info.side) {
    commentDraft.start = Math.min(commentDraft.start, info.line);
    commentDraft.end = Math.max(commentDraft.end, info.line);
  } else commentDraft = { task: info.task, file: info.file, side: info.side, start: info.line, end: info.line };
  const typed = $("#comment-text")?.value ?? "";
  renderView();
  const ta = $("#comment-text");
  if (ta) {
    ta.value = typed;
    ta.focus();
  }
}

async function saveComment(form) {
  const body = form.elements.body.value.trim();
  if (!body) return form.elements.body.focus();
  const d = commentDraft;
  try {
    await post(`/api/dev/tasks/${d.task}`, { action: "comment", file: d.file, side: d.side, start: d.start, end: d.end, snippet: snippetOf(d.task, d.file, d.side, d.start, d.end), body });
    commentDraft = null;
    renderView();
    // La ligne commentée reprend le focus (après le rendu, qui a remplacé l'ancienne).
    document.querySelector(`[data-dev="${d.task}"] [data-diff-file="${CSS.escape(d.file)}"] .dl[data-side="${d.side}"][data-line="${d.end}"]`)?.focus();
    $("#announce").textContent = "Commentaire enregistré";
  } catch (err) {
    form.querySelector(".inline-error")?.remove();
    form.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
}

side.addEventListener("click", async (e) => {
  const add = e.target.closest("[data-comment-line]");
  if (add) return startComment(add.closest(".dl"), e.shiftKey);
  const row = e.target.closest(".dl[data-line]");
  if (row && e.shiftKey && commentDraft) return startComment(row, true);
  if (e.target.closest("[data-comment-cancel]")) {
    commentDraft = null;
    return renderView();
  }
  const act = e.target.closest("[data-comment-act]");
  if (act) {
    act.disabled = true;
    await post(`/api/dev/comments/${act.closest("[data-comment]").dataset.comment}`, { action: act.dataset.commentAct }).catch((err) => {
      act.disabled = false;
      act.insertAdjacentHTML("afterend", ` <span class="inline-error" role="alert">${esc(err.message)}</span>`);
    });
    return;
  }
  const send = e.target.closest("[data-diff-send]");
  if (send) {
    send.disabled = true;
    const id = send.closest("[data-dev]").dataset.dev;
    await post(`/api/dev/tasks/${id}`, { action: "review" }).catch((err) => {
      send.disabled = false;
      send.insertAdjacentHTML("afterend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    });
    return;
  }
  const go = e.target.closest("[data-diff-goto]");
  if (go) {
    const card = go.closest("[data-dev]");
    const details = card.querySelector("[data-dev-diff]");
    if (!details.open) details.open = true;
    const target = () => card.querySelector(`#df-${card.dataset.dev}-${go.dataset.diffGoto}`);
    for (let i = 0; i < 40 && !target(); i++) await new Promise((r) => setTimeout(r, 50));
    target()?.scrollIntoView({ block: "start" });
    target()?.focus({ preventScroll: true });
  }
});

side.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-comment-form]");
  if (!form) return;
  e.preventDefault();
  void saveComment(form);
});

side.addEventListener("change", (e) => {
  if (!e.target.matches("[data-diff-wrap]")) return;
  diffWrap = e.target.checked;
  try {
    localStorage.setItem("clark.diffWrap", diffWrap ? "1" : "0");
  } catch {}
  document.querySelectorAll(".diff").forEach((d) => d.classList.toggle("wrap", diffWrap));
});

// j/k : fichier suivant / précédent ; n/p : changement suivant / précédent ; c : commenter la ligne ; dans un diff ouvert.
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("[data-comment-form]")) {
    if (e.key === "Escape") {
      e.preventDefault();
      commentDraft = null;
      renderView();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void saveComment(e.target.closest("[data-comment-form]"));
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (!["j", "k", "n", "p", "c"].includes(e.key)) return;
  const diff = (document.activeElement?.closest?.("[data-dev-diff][open]") ?? document.querySelector(".view:not([hidden]) [data-dev-diff][open]"));
  if (!diff) return;
  const here = document.activeElement;
  if (e.key === "c") {
    if (here?.matches?.(".dl[data-line]") && here.querySelector("[data-comment-line]")) {
      e.preventDefault();
      startComment(here, false);
    }
    return;
  }
  const items = [...diff.querySelectorAll(e.key === "j" || e.key === "k" ? ".diff-file" : ".dl.d-add, .dl.d-del")];
  if (!items.length) return;
  e.preventDefault();
  // Le suivant (ou le précédent) après l'élément qui a le focus, dans l'ordre du document.
  const inside = here && diff.contains(here);
  const isAfter = (el) => inside && here !== el && Boolean(here.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const forward = e.key === "j" || e.key === "n";
  const next = forward ? (inside ? (items.find(isAfter) ?? items.at(-1)) : items[0]) : (inside ? (items.filter((el) => el !== here && !isAfter(el)).at(-1) ?? items[0]) : items[0]);
  next.focus();
  next.scrollIntoView({ block: "center" });
});

async function sendForm(form, url, body, errorId) {
  const error = form.querySelector(errorId);
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.textContent = data.error || `Erreur ${res.status}`;
      error.hidden = false;
      const field = data.field && form.elements[data.field];
      if (field?.focus) {
        field.insertAdjacentElement("afterend", error);
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby", error.id);
        field.focus();
      }
      return false;
    }
    return true;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    return false;
  } finally {
    submit.disabled = false;
  }
}

side.addEventListener("click", async (e) => {
  if (e.target.closest("[data-project-new]")) {
    projectFormOpen = true;
    renderDev();
    $("#pf-name")?.focus();
    return;
  }
  if (e.target.closest("[data-project-cancel]")) {
    projectFormOpen = false;
    renderDev();
    return;
  }
  const delProject = e.target.closest("[data-project-delete]");
  if (delProject) {
    const li = delProject.closest("[data-project]");
    if (!(await ask("Retirer ce projet de Clark ?", "Ton dépôt n'est pas touché ; Clark ne pourra simplement plus y lancer de tâche.", "Retirer"))) return;
    try {
      await post(`/api/dev/projects/${li.dataset.project}`, { action: "delete" });
    } catch (err) {
      li.querySelector(".inline-error")?.remove();
      li.insertAdjacentHTML("beforeend", `<span class="inline-error" role="alert">${esc(err.message)}</span>`);
    }
    return;
  }
  const groupButton = e.target.closest("[data-group-action]");
  if (groupButton) {
    const card = groupButton.closest("[data-dev-group]");
    if (groupButton.dataset.groupAction === "discard" && !(await ask("Jeter ce groupe ?", "Les branches des sous-tâches acceptées restent dans le dépôt.", "Jeter"))) return;
    groupButton.disabled = true;
    try {
      await post(`/api/dev/groups/${card.dataset.devGroup}`, { action: groupButton.dataset.groupAction });
    } catch (err) {
      groupButton.disabled = false;
      card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const prOpen = e.target.closest("[data-pr-open]");
  if (prOpen) {
    const key = prOpen.dataset.prOpen;
    const [kind, id] = key.split(":");
    prOpen.disabled = true;
    try {
      const res = await fetch(`/api/dev/${kind}/${id}/pr`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Erreur ${res.status}`);
      prForms.set(key, d);
      renderDev();
      $(`[data-pr-form="${key}"] input`)?.focus();
    } catch (err) {
      prOpen.disabled = false;
      prOpen.insertAdjacentHTML("afterend", `<span class="inline-error" role="alert"> ${esc(err.message)}</span>`);
    }
    return;
  }
  const prCancel = e.target.closest("[data-pr-cancel]");
  if (prCancel) {
    prForms.delete(prCancel.dataset.prCancel);
    renderDev();
    return;
  }
  const button = e.target.closest("[data-dev-action]");
  if (!button) return;
  const card = button.closest("[data-dev]");
  const action = button.dataset.devAction;
  if (action === "discard" && !(await ask("Jeter cette tâche ?", "Sa copie et sa branche sont supprimées. Ta branche n'est pas touchée.", "Jeter"))) return;
  if (action === "stop" && button.hasAttribute("data-waiting")) {
    if (!(await ask("Annuler ce tour ?", "L'agent n'a pas encore commencé : la demande sort de la file. Une version déjà faite reste à relire.", "Annuler le tour", "Garder"))) return;
  } else if (action === "stop" && !(await ask("Arrêter l'agent ?", "Son tour s'arrête là. Ce qu'il a déjà changé reste dans la copie : tu pourras retoucher, réessayer ou jeter.", "Arrêter"))) return;
  card.querySelectorAll(".card-actions button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/dev/tasks/${card.dataset.dev}`, { action });
  } catch (err) {
    card.querySelectorAll(".card-actions button").forEach((b) => (b.disabled = false));
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

side.addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-gate-pick]");
  const stop = e.target.closest("[data-stop-task]");
  if (pick) {
    const card = pick.closest("[data-gate]");
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await post(`/api/dev/gates/${card.dataset.gate}`, { resolution: pick.dataset.gatePick });
    } catch (err) {
      card.querySelectorAll("button").forEach((b) => (b.disabled = false));
      card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
  } else if (stop) {
    if (!(await ask("Arrêter l'agent ?", "Son tour s'arrête là. Une écriture en cours sera à vérifier, rien n'est refait sans toi.", "Arrêter"))) return;
    stop.disabled = true;
    await post(`/api/tasks/${stop.dataset.stopTask}/stop`, {}).catch((err) => {
      stop.disabled = false;
      stop.insertAdjacentHTML("afterend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    });
  }
});

side.addEventListener("submit", async (e) => {
  const gate = e.target.closest("[data-gate-form]");
  if (gate) {
    e.preventDefault();
    const text = gate.elements.resolution.value.trim();
    if (!text) return gate.elements.resolution.focus();
    const card = gate.closest("[data-gate]");
    try {
      await post(`/api/dev/gates/${card.dataset.gate}`, { resolution: text });
    } catch (err) {
      card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const cmp = e.target.closest("[data-dev-compare]");
  if (cmp) {
    e.preventDefault();
    const card = cmp.closest("[data-dev]");
    const [engine, model] = cmp.elements.engine.value.split("|");
    cmp.querySelectorAll("button, select").forEach((b) => (b.disabled = true));
    try {
      const r = await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "compare", engine, model, effort: cmp.elements.effort.value });
      if (r.id) $("#announce").textContent = `Deuxième version lancée : #${r.id}.`;
    } catch (err) {
      cmp.querySelectorAll("button, select").forEach((b) => (b.disabled = false));
      cmp.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const retry = e.target.closest("[data-dev-retry]");
  if (retry) {
    e.preventDefault();
    const card = retry.closest("[data-dev]");
    const [engine, model] = retry.elements.engine.value.split("|");
    retry.querySelectorAll("button, select").forEach((b) => (b.disabled = true));
    try {
      await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "retry", engine, model, effort: retry.elements.effort.value });
    } catch (err) {
      retry.querySelectorAll("button, select").forEach((b) => (b.disabled = false));
      retry.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const project = e.target.closest("#project-form");
  if (project) {
    e.preventDefault();
    const f = project.elements;
    const ok = await sendForm(project, "/api/dev/projects", { name: f.name.value.trim(), path: f.path.value.trim(), baseBranch: f.baseBranch.value.trim(), testCommand: f.testCommand.value.trim() }, "#pf-error");
    if (ok) {
      projectFormOpen = false;
      renderDev();
    }
    return;
  }
  const task = e.target.closest("#dev-form");
  if (task) {
    e.preventDefault();
    const f = task.elements;
    if (await sendForm(task, "/api/dev/tasks", { projectId: Number(f.projectId.value), instruction: f.instruction.value, engine: f.engine.value, split: f.split.checked }, "#df-error")) {
      f.instruction.value = "";
      f.split.checked = false;
    }
    return;
  }
  const prForm = e.target.closest("[data-pr-form]");
  if (prForm) {
    e.preventDefault();
    const key = prForm.dataset.prForm;
    const [kind, id] = key.split(":");
    const f = prForms.get(key);
    Object.assign(f, { title: prForm.elements.title.value, body: prForm.elements.body.value, sending: true, error: null });
    renderDev();
    try {
      await post(`/api/dev/${kind}/${id}`, { action: "pr", title: f.title, body: f.body });
      prForms.delete(key);
    } catch (err) {
      Object.assign(f, { sending: false, error: err.message });
    }
    renderDev();
    return;
  }
  const retouch = e.target.closest("[data-dev-retouch]");
  if (!retouch) return;
  e.preventDefault();
  const card = retouch.closest("[data-dev]");
  const instruction = retouch.elements.instruction.value.trim();
  if (!instruction) return retouch.elements.instruction.focus();
  retouch.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  try {
    const pick = designPick?.taskId === Number(card.dataset.dev) ? designPick : null;
    const design = pick ? { selector: pick.selector, html: pick.html, css: pick.css, page: pick.page, width: pick.width, shot: pick.shot?.file ?? null } : undefined;
    await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "retouch", instruction, ...(design ? { design } : {}) });
    retouch.elements.instruction.value = "";
    if (pick) {
      designPick = null;
      renderView();
    }
  } catch (err) {
    retouch.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  } finally {
    retouch.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
  }
});

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
  ["Vidéos", "prepare_social_post"],
  ["Mail et agenda", "mail_search, mail_read, send_mail, calendar_events"],
  ["iMessage", "messages_recent, messages_read, send_imessage"],
  ["Navigateur", "browser_open, browser_read, browser_scroll, browser_back, browser_click, browser_type, browser_select"],
];

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

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
        : `<p class="quiet">Crée d'abord un identifiant OAuth « application de bureau » (README, « Mail et agenda »), puis mets GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env.</p>`;
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
  const isCurrent = (c) => view === "chat" && (c.id === state.conversationId ? !pastId : pastId === c.id);
  const row = (c) =>
    listRow({
      href: c.id === state.conversationId ? "#conversation" : `#conversation/${c.id}`,
      agent: c.agent,
      title: c.title,
      badge: c.agent ? contactOf(c.agent).name : "",
      preview: c.preview,
      previewRole: c.preview_role,
      at: c.at,
      unread: c.id === state.conversationId && !pastId && view === "chat" ? 0 : c.unread,
      current: isCurrent(c),
    });
  const unread = list.filter((c) => c.unread && !(c.id === state.conversationId && view === "chat" && !pastId) && matchesList(c.title, c.preview));
  const team = (state.contacts ?? [])
    .filter((ct) => matchesList(ct.name, ct.badge))
    .map((ct) => {
      const latest = ct.latest ? byId.get(ct.latest) : null;
      const open = ct.latest === state.conversationId;
      return listRow({
        href: `#agent/${ct.role ?? "clark"}`,
        agent: ct.role,
        title: ct.name,
        badge: ct.badge,
        preview: latest?.preview ?? null,
        previewRole: latest?.preview_role ?? null,
        at: latest?.at ?? null,
        unread: open && view === "chat" && !pastId ? 0 : (latest?.unread ?? 0),
        current: false,
      });
    })
    .join("");
  const unreadIds = new Set(unread.map((c) => c.id));
  const rest = list.filter((c) => !unreadIds.has(c.id) && matchesList(c.title, c.preview, contactOf(c.agent).name));
  return `${unread.length ? `<p class="threads-title">Non lues <span class="threads-count">${unread.length}</span></p>${unread.map(row).join("")}` : ""}
    ${team ? `<p class="threads-title">Équipe</p>${team}` : ""}
    ${rest.length ? `<p class="threads-title">Conversations</p>${rest.map(row).join("")}` : listQuery.trim() ? `<p class="threads-empty">Rien ne correspond.</p>` : ""}`;
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
  for (const v of ["chat", "detail", "inbox", "settings"]) $(`#view-${v}`).hidden = v !== view;
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

// Petit écran : la barre de gauche s'ouvre par-dessus, se ferme en choisissant un fil.
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-drawer]")) {
    $("#app").setAttribute("data-drawer", "open");
    $("#threads a")?.focus();
  } else if (e.target.closest("[data-drawer-close]")) $("#app").removeAttribute("data-drawer");
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
    if (!prefs.routes[kind]?.browser) return false;
    return !(quietNow(prefs) && !(kind === "approval" && prefs.quiet.approvals));
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
    if (mode === "dev" || mode === "dev-split" || mode === "dev-compare") {
      const projectId = Number($("#dev-project").value);
      if (!projectId) throw new Error("Ajoute d'abord un projet dans Réglages › Projets dev.");
      const compare = mode === "dev-compare" ? comparePairs().find((x) => x.value === $("#compare-pair").value)?.sides : undefined;
      if (mode === "dev-compare" && !compare) throw new Error("Choisis les deux agents à comparer.");
      const r = await post("/api/dev/tasks", { projectId, instruction: text, engine: "", split: mode === "dev-split", ...(compare ? { compare } : {}) });
      location.hash = mode === "dev-split" ? `#groupe/${r.id}` : `#dev/${r.id}`;
    } else {
      // Écrire dans une conversation passée la reprend : elle redevient l'ouverte, avec son fil.
      if (pastId) {
        await post(`/api/conversations/${pastId}/open`, {});
        location.hash = "#conversation";
      }
      const r = await post("/api/messages", { text, mode });
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
const MODE_NAMES = { team: "Équipe", goal: "Objectif", dev: "Tâche de code", "dev-split": "Code en parallèle", "dev-compare": "Comparer deux agents" };
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
  $("#mode-chip").hidden = mode === "chat";
  $("#mode-chip-label").textContent = MODE_NAMES[mode] ?? "";
  input.placeholder = mode.startsWith("dev") ? "Consigne pour l'agent de code, ou #12 pour une issue GitHub" : mode === "goal" ? "L'objectif à atteindre" : `Écrire à ${state ? contactOf(threadAgent).name : "Clark"}`;
}
$("#mode-menu").addEventListener("action", (e) => {
  setMode(String(e.detail.value));
  setTimeout(() => input.focus(), 0);
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

// ── Dictée : le micro enregistre, le Mac transcrit, le texte arrive dans le champ ──

const mic = $("#mic");
const micTime = $("#mic-time");
const DICTATION_MAX = 5 * 60_000;
let recorder = null;
let recordingCancelled = false;

function renderMic() {
  const can = Boolean(state.voice?.ready && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  mic.hidden = !can && !recorder;
}

function micState(phase) {
  mic.dataset.state = phase;
  mic.setAttribute("aria-pressed", String(phase === "rec"));
  mic.setAttribute("aria-label", phase === "rec" ? "Arrêter la dictée (Échap pour l'annuler)" : phase === "busy" ? "Transcription en cours" : "Dicter un message");
  mic.disabled = phase === "busy";
  micTime.hidden = phase === "idle";
  if (phase === "busy") micTime.textContent = "Transcription…";
}

const dictationError = (text) => {
  sendError.textContent = text;
  sendError.hidden = false;
};

async function startDictation() {
  sendError.hidden = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return dictationError("Micro refusé : autorise-le pour cette page dans le navigateur.");
  }
  const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks = [];
  const started = Date.now();
  recordingCancelled = false;
  const tick = () => {
    const sec = Math.floor((Date.now() - started) / 1000);
    micTime.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    if (Date.now() - started > DICTATION_MAX && rec.state === "recording") rec.stop();
  };
  const timer = setInterval(tick, 500);
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    if (recordingCancelled || !chunks.length) {
      micState("idle");
      $("#announce").textContent = "Dictée annulée";
      return;
    }
    micState("busy");
    try {
      const blob = new Blob(chunks, { type: (rec.mimeType || "audio/webm").split(";")[0] });
      const res = await fetch("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      if (!data.text) throw new Error("rien entendu");
      // Le texte s'ajoute à ce qui est déjà écrit ; tu relis avant d'envoyer.
      input.value = input.value.trim() ? `${input.value.trimEnd()} ${data.text}` : data.text;
      autosize();
      send.disabled = !input.value.trim();
      $("#announce").textContent = "Dictée ajoutée au message";
    } catch (err) {
      dictationError(`Dictée non transcrite : ${err.message}`);
    } finally {
      micState("idle");
      renderMic();
      input.focus();
    }
  };
  recorder = rec;
  rec.start();
  tick();
  micState("rec");
}

mic.addEventListener("click", () => (recorder ? recorder.stop() : void startDictation()));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && recorder) {
    recordingCancelled = true;
    recorder.stop();
  }
});

// ── Écouter un message de Clark (voix macOS), et l'essai de voix des réglages ──

let listening = null; // { id, phase: "loading" | "playing", audio }

function stopListening() {
  if (!listening) return;
  listening.audio.pause();
  listening.audio.removeAttribute("src");
  listening = null;
  renderThread();
}

function play(url, id) {
  stopListening();
  const audio = new Audio(url);
  listening = { id, phase: "loading", audio };
  if (id !== null) renderThread();
  audio.addEventListener("playing", () => {
    if (listening?.audio !== audio) return;
    listening.phase = "playing";
    if (id !== null) renderThread();
  });
  const done = () => listening?.audio === audio && stopListening();
  audio.addEventListener("ended", done);
  audio.addEventListener("error", () => {
    if (listening?.audio !== audio) return;
    done();
    const where = id !== null ? sendError : $("#voice-error");
    if (where) {
      where.textContent = "Lecture impossible pour l'instant.";
      where.hidden = false;
    }
  });
  audio.play().catch(() => {});
}

side.addEventListener("click", (e) => {
  const listen = e.target.closest("[data-listen]");
  if (listen) {
    const id = Number(listen.dataset.listen);
    if (listening?.id === id) stopListening();
    else play(`/api/voice/speech/${id}`, id);
    return;
  }
  if (e.target.closest("[data-voice-sample]")) {
    play(`/api/voice/sample?voix=${encodeURIComponent($("#voice-name")?.value ?? "")}`, null);
    return;
  }
  if (e.target.closest("[data-personality-reset]")) void savePersonalityText("", true);
});

async function saveVoice(body) {
  const error = $("#voice-error");
  try {
    await post("/api/voice/settings", body);
    if (error) error.hidden = true;
  } catch (err) {
    if (error) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }
}

side.addEventListener("change", (e) => {
  if (e.target.matches("[data-voice-mode]")) void saveVoice({ mode: e.target.value });
  else if (e.target.matches("[data-voice-name]")) void saveVoice({ voice: e.target.value });
  else if (e.target.matches("[data-voice-vocab]")) void saveVoice({ vocabulary: e.target.value });
});

side.addEventListener("input", (e) => {
  if (e.target.id !== "pf-text") return;
  personalityDirty = true;
  $("#pf-count").textContent = `${e.target.value.length} / ${state.personality?.limit ?? 4000} caractères`;
});

async function savePersonalityText(text, reset = false) {
  if (reset && !(await ask("Revenir à la personnalité par défaut ?", "Ton texte actuel est remplacé.", "Revenir au défaut"))) return;
  const error = $("#pf-error");
  try {
    await post("/api/personality", { text });
    personalityDirty = false;
    renderSettings();
    $("#announce").textContent = "Personnalité enregistrée";
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
}

side.addEventListener("submit", (e) => {
  if (e.target.id !== "personality-form") return;
  e.preventDefault();
  void savePersonalityText(e.target.elements.text.value);
});

const EFFORT_M = { none: "nul", minimal: "minimal", low: "faible", medium: "moyen", high: "élevé", xhigh: "très élevé", max: "maximal" };

// Comparer : Claude contre Codex quand les deux sont là, sinon un même moteur à deux efforts.
function comparePairs() {
  const engines = (state?.engines ?? []).filter((e) => e.ready !== false);
  const pairs = [];
  if (engines.some((e) => e.name === "claude") && engines.some((e) => e.name === "codex"))
    pairs.push({ value: "claude|codex", label: "Claude et Codex", sides: [{ engine: "claude" }, { engine: "codex" }] });
  for (const e of engines) {
    const efforts = [...new Set((e.models ?? []).flatMap((m) => m.efforts ?? []))];
    const [lo, hi] = efforts.includes("medium") && efforts.includes("high") ? ["medium", "high"] : efforts.length >= 2 ? efforts.slice(-2) : [];
    if (lo && hi)
      pairs.push({ value: `${e.name}:${lo}|${e.name}:${hi}`, label: `${ENGINE_NAMES[e.name] ?? e.name}, effort ${EFFORT_M[lo] ?? lo} et ${EFFORT_M[hi] ?? hi}`, sides: [{ engine: e.name, effort: lo }, { engine: e.name, effort: hi }] });
  }
  return pairs;
}

let pairsKey = "";
function renderComparePairs() {
  const pairs = comparePairs();
  const key = pairs.map((x) => x.value).join(",");
  if (key === pairsKey) return;
  pairsKey = key;
  const select = $("#compare-pair");
  const current = select.value;
  select.innerHTML = pairs.length ? pairs.map((x) => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join("") : `<option value="">Aucun moteur connecté</option>`;
  if (pairs.some((x) => x.value === current)) select.value = current;
}

let projectsKey = "";
function renderProjectOptions() {
  const projects = state.dev?.projects ?? [];
  const key = projects.map((p) => `${p.id}:${p.name}`).join(",");
  if (key === projectsKey) return;
  projectsKey = key;
  const select = $("#dev-project");
  const current = select.value;
  select.innerHTML = projects.length ? projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("") : `<option value="">Aucun projet</option>`;
  if (projects.some((p) => String(p.id) === current)) select.value = current;
  renderComparePairs();
}

showView();


// ── Clark, la mascotte ──────────────────────────────────────────────────
// Il montre ce qui se passe vraiment : il marche quand un agent travaille, lève un « ! » quand
// quelque chose t'attend, somnole pendant tes heures calmes. Un clic : son état en clair et
// quelques raccourcis. Il ne bouge pas pour rien.

const MASCOT_EYES = {
  normal: ["XXWWXXXXWWXX", "XXWPXXXXWPXX"],
  closed: ["XXXXXXXXXXXX", "XXPPXXXXPPXX"],
  happy: ["XXXPXXXXPXXX", "XXPXPXXPXPXX"],
};

/** Le bonhomme bleu en grand, avec ses yeux et son accessoire (« ! », « z », « ? »). */
function mascotSvg(mood) {
  const c = CREATURES[mood === "offline" ? "galet" : "bleu"];
  const colors = { ...EYES, X: c.X, O: c.O, A: c.A };
  const eyes = mood === "sleeping" ? MASCOT_EYES.closed : mood === "done" ? MASCOT_EYES.happy : MASCOT_EYES.normal;
  const rows = SHAPES.bleu.map((r, y) => (y === 4 ? eyes[0] : y === 5 ? eyes[1] : r));
  const body = rows.map((row, y) => pixelRow(row, y + 4, colors)).join("");
  const walking = mood === "working" || mood === "busy-waiting";
  const legs = walking
    ? `<g class="step-a">${pixelRow("..OO....OO..", 13, colors)}</g><g class="step-b">${pixelRow("...OO..OO...", 13, colors)}</g>`
    : pixelRow("..OO....OO..", 13, colors);
  const ink = "var(--text)";
  const extra =
    mood === "waiting" || mood === "busy-waiting"
      ? `<rect x="13" y="0" width="1" height="3" fill="${ink}"/><rect x="13" y="4" width="1" height="1" fill="${ink}"/>`
      : mood === "sleeping"
        ? `<rect x="12" y="0" width="3" height="1" fill="${ink}"/><rect x="13" y="1" width="1" height="1" fill="${ink}"/><rect x="12" y="2" width="3" height="1" fill="${ink}"/>`
        : mood === "problem"
          ? `<rect x="12" y="0" width="2" height="1" fill="${ink}"/><rect x="14" y="1" width="1" height="1" fill="${ink}"/><rect x="13" y="2" width="1" height="1" fill="${ink}"/><rect x="13" y="4" width="1" height="1" fill="${ink}"/>`
          : "";
  return `<svg class="sprite mascot-svg${walking ? " walking" : ""}" viewBox="0 0 16 14" width="48" height="42" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><g transform="translate(0 0)">${body}${legs}</g>${extra}</svg>`;
}

/** Ce qui l'occupe vraiment, et la phrase qui va avec. */
function mascotMood() {
  if (status.dataset.state === "offline") return { mood: "offline", line: "Je ne te vois plus : la connexion est coupée (Clark est arrêté ?)." };
  const waiting = waitingCount();
  const running = state.running ?? [];
  const dev = allDevTasks().filter((t) => t.status === "working");
  const waitingText = `${waiting} chose${waiting > 1 ? "s" : ""} t'attend${waiting > 1 ? "ent" : ""} : un accord, une question ou une relecture.`;
  if (running.length || dev.length) {
    const t = running[0];
    const what = t?.checkpoint || t?.steps?.at(-1)?.text || (dev[0] ? `la tâche dev « ${dev[0].title} »` : "je réfléchis");
    // Il travaille ET quelque chose t'attend : il marche, avec son « ! ».
    return waiting ? { mood: "busy-waiting", line: `Je travaille : ${what}. Et ${waitingText}` } : { mood: "working", line: `Je travaille : ${what}.` };
  }
  if (waiting) return { mood: "waiting", line: waitingText };
  if (state.clark.engine.problem) return { mood: "problem", line: "Je ne suis pas connecté à mon moteur : rien ne peut tourner pour l'instant (Réglages › Moteurs)." };
  const prefs = state.notify?.prefs;
  if (prefs && quietNow(prefs)) return { mood: "sleeping", line: `Je me fais discret jusqu'à ${prefs.quiet.to} : rien ne part sur ton téléphone (sauf les accords si tu l'as gardé).` };
  if (mascotDoneUntil > Date.now()) return { mood: "done", line: "C'est fait. La réponse est dans la conversation." };
  return { mood: "idle", line: "Rien en cours. Écris-moi, ou choisis ci-dessous." };
}

let mascotKey = "";
let mascotDoneUntil = 0;
let mascotPrev = null; // { busy, waiting, lastReply }
let mascotTimer = null;

const mascotHidden = () => {
  try {
    return localStorage.getItem("clark.mascot") === "off";
  } catch {
    return false;
  }
};

function mascotSay(text) {
  const b = $("#mascot-bubble");
  b.textContent = text;
  b.hidden = false;
  clearTimeout(mascotTimer);
  mascotTimer = setTimeout(() => (b.hidden = true), 5000);
}

function renderMascot() {
  const box = $("#mascot");
  box.hidden = mascotHidden();
  if (!state || box.hidden) return;
  // Ce qui vient de changer : une réponse arrivée, quelque chose qui t'attend.
  const busy = (state.running ?? []).length > 0;
  const waiting = waitingCount();
  const lastReply = [...state.messages].reverse().find((m) => m.role === "clark")?.id ?? 0;
  if (mascotPrev && !firstRender) {
    if (waiting > mascotPrev.waiting) mascotSay(waiting === 1 ? "Il me faut ton avis." : `${waiting} choses t'attendent.`);
    else if (lastReply > mascotPrev.lastReply && !busy) {
      mascotDoneUntil = Date.now() + 8000;
      mascotSay("C'est fait.");
      setTimeout(() => renderMascot(), 8100);
    }
  }
  mascotPrev = { busy, waiting, lastReply };
  const { mood, line } = mascotMood();
  box.dataset.mood = mood;
  const key = `${mood}|${line}`;
  if (key === mascotKey) return;
  mascotKey = key;
  const btn = $("#mascot-btn");
  btn.innerHTML = mascotSvg(mood);
  btn.setAttribute("aria-label", `Clark : ${line}`);
  btn.title = line;
  if ($("#mascot-pop").matches(":popover-open")) renderMascotPop();
}

function renderMascotPop() {
  const { mood, line } = mascotMood();
  const waiting = waitingCount();
  const dev = allDevTasks().find((t) => t.status === "working");
  const actions = [
    waiting ? `<button type="button" class="mascot-act" data-mascot="inbox">Voir ce qui t'attend (${waiting})</button>` : "",
    dev ? `<button type="button" class="mascot-act" data-mascot="dev" data-id="${dev.id}">Voir la tâche en cours</button>` : "",
    `<button type="button" class="mascot-act quiet" data-mascot="hide">Me cacher</button>`,
  ].filter(Boolean);
  $("#mascot-pop").innerHTML = `<div class="mascot-head">${mascotSvg(mood)}<div><p class="mascot-name">Clark</p><p class="mascot-line">${esc(line)}</p></div></div>
    <div class="mascot-actions">${actions.join("")}</div>
    <p class="inline-error" id="mascot-error" role="alert" hidden></p>`;
}

$("#mascot-pop").addEventListener("toggle", (e) => {
  if (e.newState !== "open") return;
  renderMascotPop();
  // La fenêtre s'ouvre au-dessus de la mascotte (en bas à droite), ou sous elle (en haut, sur petit écran).
  const r = $("#mascot-btn").getBoundingClientRect();
  const pop = $("#mascot-pop");
  pop.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  if (r.top > innerHeight / 2) {
    pop.style.bottom = `${innerHeight - r.top + 8}px`;
    pop.style.top = "auto";
  } else {
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.bottom = "auto";
  }
  pop.querySelector(".mascot-act")?.focus();
});

$("#mascot-pop").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-mascot]");
  if (!b) return;
  const pop = $("#mascot-pop");
  const act = b.dataset.mascot;
  if (act === "heartbeat") {
    b.disabled = true;
    try {
      await post("/api/heartbeat/run", {});
      pop.hidePopover();
      mascotSay("Je fais un tour, je te dis s'il y a quelque chose.");
    } catch (err) {
      const box = $("#mascot-error");
      box.textContent = err.message;
      box.hidden = false;
      b.disabled = false;
    }
    return;
  }
  pop.hidePopover();
  if (act === "inbox") location.hash = "#activite";
  else if (act === "dev") location.hash = `#dev/${b.dataset.id}`;
  else if (act === "write" || act === "dictate" || act === "dev-mode") {
    location.hash = "#conversation";
    if (act === "dev-mode") setMode("dev");
    setTimeout(() => (act === "dictate" ? $("#mic").click() : input.focus()), 50);
  } else if (act === "shortcuts") $("#shortcuts").showModal();
  else if (act === "hide") {
    try {
      localStorage.setItem("clark.mascot", "off");
    } catch {}
    renderMascot();
    $("#announce").textContent = "Clark est caché. Pour le revoir : Réglages › Général › Apparence.";
  }
});

// ── Connexion ───────────────────────────────────────────────────────────

function connect() {
  const events = new EventSource("/api/events");
  events.addEventListener("state", (e) => {
    const first = state === null;
    state = JSON.parse(e.data);
    if (first && view === "inbox") void loadHistory();
    // Adresse d'une conversation lue avant l'arrivée de l'état, ou devenue l'ouverte entre-temps.
    if (view === "chat" && (first || pastId === state.conversationId)) route();
    status.dataset.state = "online";
    // En ligne : le point vert suffit ; le texte reste pour les lecteurs d'écran.
    status.innerHTML = `<span class="visually-hidden">Clark est en ligne</span>`;
    render();
  });
  events.addEventListener("error", () => {
    status.dataset.state = "offline";
    status.textContent = "hors ligne, Clark est arrêté ?";
    if (state) renderMascot();
    // EventSource se reconnecte seul après une coupure, mais abandonne pour de bon si le serveur
    // répond par une erreur HTTP (redémarrage derrière un proxy) : on relance alors nous-mêmes.
    if (events.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
  });
}

connect();
