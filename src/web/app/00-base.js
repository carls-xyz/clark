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
  // Un titre est un paragraphe à lui seul, même collé au texte qui le suit (« ## Effort\nDeux soirées »).
  const spaced = text.replace(/^(#{1,4} [^\n]*)\n(?!\n)/gm, "$1\n\n").replace(/([^\n])\n(#{1,4} )/g, "$1\n\n$2");
  for (const para of spaced.split(/\n{2,}/)) {
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

