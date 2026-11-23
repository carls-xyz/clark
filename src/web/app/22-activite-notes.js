// ── Activité › « Ce qui s'est passé » : les notes sorties de ta conversation (dev, PR, souvenirs…) ──

const NOTE_CATEGORIES = [
  ["sante", "Santé"],
  ["dev", "Dev et PR"],
  ["memoire", "Mémoire"],
  ["propositions", "Propositions"],
  ["accords", "Accords et questions"],
  ["agents", "Agents silencieux"],
  ["autres", "Autres"],
];
const NOTES_SEEN_KEY = "clark.notesSeen";
// « var » : showView (14-navigation.js) appelle leaveNotes() dès le chargement, avant que ce fichier soit lu.
var notesFilter = "all";
var notesMore = false;
/** Dernière note vue avant d'ouvrir Activité : celles d'après sont marquées « nouvelle » pendant la visite. */
var notesSeenBefore = null;

function notesSeen() {
  try {
    return Number(localStorage.getItem(NOTES_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markNotesSeen() {
  const last = state?.notes?.[0]?.id;
  if (!last) return;
  if (notesSeenBefore === null) notesSeenBefore = notesSeen();
  try {
    if (last > notesSeen()) localStorage.setItem(NOTES_SEEN_KEY, String(last));
  } catch {
    // Stockage indisponible : les notes resteront marquées « nouvelles », rien de grave.
  }
}

/** En quittant Activité, la prochaine visite repart de ce qui a été vu. */
function leaveNotes() {
  notesSeenBefore = null;
}

/** Notes nouvelles depuis la dernière visite d'Activité. */
function newNotesCount() {
  const seen = notesSeenBefore ?? notesSeen();
  return (state?.notes ?? []).filter((n) => n.id > seen).length;
}

function renderNotes() {
  markNotesSeen();
  const all = (state.notes ?? []).filter((n) => matches(n.text));
  const counts = new Map();
  for (const n of all) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
  if (notesFilter !== "all" && !counts.get(notesFilter)) notesFilter = "all";
  const list = notesFilter === "all" ? all : all.filter((n) => n.category === notesFilter);
  const fresh = newNotesCount();
  const chips = [["all", "Tout", all.length], ...NOTE_CATEGORIES.filter(([k]) => counts.get(k)).map(([k, l]) => [k, l, counts.get(k)])]
    .map(([k, l, n]) => `<button type="button" class="idea-filter" data-notes-filter="${k}" aria-pressed="${k === notesFilter}">${l} <span class="block-count">${n}</span></button>`)
    .join("");
  const label = Object.fromEntries(NOTE_CATEGORIES);
  const shown = notesMore ? list : list.slice(0, 25);
  const seen = notesSeenBefore ?? 0;
  const items = shown
    .map((n) => {
      const d = parseDate(n.at);
      const when = sameDay(d, new Date()) ? time(d) : `${shortDate(n.at)} ${time(d)}`;
      return `<li class="note-item${n.id > seen ? " is-new" : ""}">
        <span class="note-meta"><span class="quiet">${when}</span><span class="tag note-cat">${esc(label[n.category] ?? "Autres")}</span></span>
        <span class="note-text">${esc(n.text)}</span>
      </li>`;
    })
    .join("");
  const body = all.length
    ? `<div class="idea-filters note-filters" role="group" aria-label="Filtrer les notes">${chips}</div>
       <ul class="note-list">${items}</ul>
       ${list.length > shown.length ? `<button type="button" class="btn ghost" data-notes-more>Voir les ${list.length - shown.length} plus anciennes</button>` : ""}`
    : `<p class="quiet">${(state.notes ?? []).length ? `Rien ne correspond à « ${esc(activityFilter)} ».` : "Rien pour l'instant. Les notes du dev, des PR, de la mémoire et des propositions arrivent ici, plus dans ta conversation."}</p>`;
  return `<h2 class="activity-group" id="h-notes">Ce qui s'est passé${fresh ? ` <span class="block-count is-hot">${fresh} nouvelle${fresh > 1 ? "s" : ""}</span>` : ""}</h2>${body}`;
}

/** Au bas de ta conversation : combien de notes sont parties dans Activité depuis ton dernier message. */
function notesSinceLastAsk() {
  const lastAsk = [...(state.messages ?? [])].reverse().find((m) => m.role === "user");
  const since = lastAsk ? lastAsk.id : 0;
  return (state.notes ?? []).filter((n) => n.id > since && n.id > notesSeen()).length;
}

$("#inbox").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-notes-filter]");
  if (chip) {
    notesFilter = chip.dataset.notesFilter;
    notesMore = false;
    renderView();
    return;
  }
  if (e.target.closest("[data-notes-more]")) {
    notesMore = true;
    renderView();
  }
});
