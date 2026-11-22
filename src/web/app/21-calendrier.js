// ── Calendrier : les veilles et points réguliers, rangés par jour (hors de ta conversation) ──

const CAL_SEEN_KEY = "clark.calendarSeen";
const parisDay = (d) => d.toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ
let calMonth = parisDay(new Date()).slice(0, 7);
let calDay = null; // jour ouvert (AAAA-MM-JJ)
let calData = null; // { month, runs }
let calStamp = null; // dernière exécution connue au moment de la lecture
let calLoading = false;
let calError = "";
/** Comptes rendus repliés à la main (ouverts par défaut). */
const calClosed = new Set();

function calSeen() {
  try {
    return Number(localStorage.getItem(CAL_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Nombre sur l'icône : les comptes rendus arrivés depuis ta dernière visite du calendrier. */
function renderCalendarCount() {
  const el = $("#calendar-count");
  if (!el) return;
  const seen = calSeen();
  const n = (state?.calendar?.recent ?? []).filter((id) => id > seen).length;
  el.hidden = n === 0 || view === "calendar";
  el.textContent = n > 9 ? "9+" : String(n);
}

function markCalendarSeen() {
  const last = state?.calendar?.recent?.[0];
  if (!last) return;
  try {
    localStorage.setItem(CAL_SEEN_KEY, String(Math.max(last, calSeen())));
  } catch {
    // Stockage indisponible (navigation privée) : le nombre reviendra, rien de grave.
  }
}

async function loadCalendar() {
  if (calLoading) return;
  calLoading = true;
  const month = calMonth;
  const stamp = state?.calendar?.recent?.[0] ?? 0;
  try {
    const res = await fetch(`/api/calendar?month=${month}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Calendrier illisible");
    calData = data;
    calStamp = stamp;
    calError = "";
  } catch (err) {
    calError = err.message;
    calData = { month, runs: [] };
    calStamp = stamp;
  } finally {
    calLoading = false;
  }
  if (view === "calendar") renderCalendar();
}

function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function calRunState(r) {
  if (r.status === "skipped") return ["Rien de neuf", "cal-quiet"];
  if (r.status === "failed") return ["Pas aboutie", "cal-failed"];
  if (r.task === "queued" || r.task === "running") return ["En cours", "cal-running"];
  if (r.task === "failed" || r.task === "abandoned") return ["Pas aboutie", "cal-failed"];
  if (r.task === "needs_check") return ["À vérifier", "cal-failed"];
  return ["Faite", ""];
}

function calRunCard(r) {
  const [label, cls] = calRunState(r);
  const at = time(parseDate(r.at));
  const open = !calClosed.has(r.id);
  const body = r.report
    ? `<details class="cal-report" data-cal-run="${r.id}"${open ? " open" : ""}><summary>Compte rendu</summary><div class="prose">${md(r.report)}</div></details>`
    : r.note
      ? `<p class="quiet">${esc(r.note)}</p>`
      : "";
  return `<article class="card cal-run">
    <div class="cal-run-head">
      <p class="card-title">${esc(r.name)}</p>
      <span class="tag ${cls}">${label}</span>
    </div>
    <p class="auto-meta">${at}${r.manual ? " · lancée à la main" : ""}${r.taskId ? ` · <a href="#activite">tâche #${r.taskId}</a>` : ""}</p>
    ${body}
  </article>`;
}

/** Les automatisations qu'on peut ranger dans le calendrier (pas les tâches dev). */
function calCandidates() {
  return (state.automations ?? []).filter((a) => a.kind !== "dev" && a.thread !== "calendar");
}

function renderCalendar() {
  const box = $("#calendar");
  if (!box || !state) return;
  markCalendarSeen();
  renderCalendarCount();
  const stamp = state.calendar?.recent?.[0] ?? 0;
  if (!calLoading && (calData?.month !== calMonth || calStamp !== stamp)) void loadCalendar();

  const today = parisDay(new Date());
  const runs = (calData?.month === calMonth ? calData.runs : []).map((r) => ({ ...r, day: parisDay(parseDate(r.at)) })).filter((r) => r.day.startsWith(calMonth));
  const byDay = new Map();
  for (const r of runs) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  // Jour ouvert : celui choisi, sinon aujourd'hui (s'il est dans le mois), sinon le dernier jour avec une veille.
  if (!calDay || !calDay.startsWith(calMonth)) calDay = today.startsWith(calMonth) ? today : ([...byDay.keys()].at(-1) ?? `${calMonth}-01`);

  const [y, m] = calMonth.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // lundi en premier
  const monthName = first.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(`<div class="cal-cell cal-pad" aria-hidden="true"></div>`);
  for (let d = 1; d <= days; d++) {
    const key = `${calMonth}-${String(d).padStart(2, "0")}`;
    const list = byDay.get(key) ?? [];
    const names = [...new Set(list.map((r) => r.name))];
    const label = `${d} ${first.toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" })}${list.length ? `, ${list.length} ${list.length > 1 ? "veilles" : "veille"}` : ""}`;
    cells.push(`<button type="button" class="cal-cell${key === today ? " is-today" : ""}${list.length ? " has-runs" : ""}" data-cal-day="${key}" aria-pressed="${key === calDay}" aria-label="${esc(label)}">
      <span class="cal-num">${d}</span>
      ${names.length ? `<span class="cal-names">${names.slice(0, 2).map((n) => `<span class="cal-name">${esc(n)}</span>`).join("")}${names.length > 2 ? `<span class="cal-more">+${names.length - 2}</span>` : ""}</span><span class="cal-dot" aria-hidden="true"></span>` : ""}
    </button>`);
  }

  const dayRuns = (byDay.get(calDay) ?? []).slice().reverse();
  const [dy, dm, dd] = calDay.split("-").map(Number);
  const dayTitle = new Date(Date.UTC(dy, dm - 1, dd)).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

  const inCal = (state.automations ?? []).filter((a) => a.thread === "calendar");
  const candidates = calCandidates();
  const intro = inCal.length
    ? `<p class="quiet cal-line">Dans le calendrier : ${inCal.map((a) => esc(a.name)).join(", ")}. Leurs comptes rendus n'arrivent plus dans ta conversation.</p>`
    : `<div class="card cal-empty">
        <p class="card-title">Aucune veille dans le calendrier pour l'instant</p>
        <p class="quiet">Une automatisation rangée ici n'écrit plus dans ta conversation : son compte rendu s'affiche au jour où elle a tourné.</p>
        ${
          candidates.length
            ? `<ul class="cal-candidates">${candidates.map((a) => `<li><span>${esc(a.name)} <span class="quiet">· ${esc(a.schedule)}</span></span><button type="button" class="btn secondary" data-cal-move="${a.id}">Mettre dans le calendrier</button></li>`).join("")}</ul>`
            : `<p class="quiet">Crée d'abord une automatisation dans <a href="#reglages/automatisations">Automatisations</a>, avec « Dans le calendrier ».</p>`
        }
      </div>`;

  box.innerHTML = `${intro}
    <div class="cal-head">
      <h2 class="cal-month">${esc(monthName)}</h2>
      <div class="cal-nav">
        <button type="button" class="btn ghost cal-arrow" data-cal-shift="-1" aria-label="Mois précédent"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M9.5 4 5.5 8l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg></button>
        <button type="button" class="btn ghost" data-cal-today${calMonth === today.slice(0, 7) && calDay === today ? " disabled" : ""}>Aujourd'hui</button>
        <button type="button" class="btn ghost cal-arrow" data-cal-shift="1" aria-label="Mois suivant"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M6.5 4 10.5 8l-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg></button>
      </div>
    </div>
    ${calError ? `<p class="inline-error" role="alert">${esc(calError)}</p>` : ""}
    <div class="cal-grid" role="group" aria-label="${esc(monthName)}">
      ${["lun", "mar", "mer", "jeu", "ven", "sam", "dim"].map((w) => `<div class="cal-wd" aria-hidden="true">${w}</div>`).join("")}
      ${cells.join("")}
    </div>
    <section class="cal-day" aria-labelledby="cal-day-title">
      <h2 class="block-title" id="cal-day-title">${esc(dayTitle.charAt(0).toUpperCase() + dayTitle.slice(1))}</h2>
      ${dayRuns.length ? dayRuns.map(calRunCard).join("") : `<p class="quiet">${calLoading && calData?.month !== calMonth ? "Chargement…" : "Rien ce jour-là."}</p>`}
    </section>`;
}

$("#calendar").addEventListener("click", async (e) => {
  const day = e.target.closest("[data-cal-day]");
  if (day) {
    calDay = day.dataset.calDay;
    renderCalendar();
    return;
  }
  const shift = e.target.closest("[data-cal-shift]");
  if (shift) {
    calMonth = shiftMonth(calMonth, Number(shift.dataset.calShift));
    calDay = null;
    renderCalendar();
    return;
  }
  if (e.target.closest("[data-cal-today]")) {
    calMonth = parisDay(new Date()).slice(0, 7);
    calDay = parisDay(new Date());
    renderCalendar();
    return;
  }
  const move = e.target.closest("[data-cal-move]");
  if (move) {
    move.disabled = true;
    try {
      await post(`/api/automations/${move.dataset.calMove}`, { action: "thread", thread: "calendar" });
      calData = null;
    } catch (err) {
      move.disabled = false;
      move.insertAdjacentHTML("afterend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
  }
});

$("#calendar").addEventListener(
  "toggle",
  (e) => {
    const run = e.target.dataset?.calRun;
    if (!run) return;
    if (e.target.open) calClosed.delete(Number(run));
    else calClosed.add(Number(run));
  },
  true,
);
