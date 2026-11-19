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

