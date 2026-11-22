// ── Idées : le tour d'idées (Clark scrolle), tes idées en vrac, ses avis ──

let ideasFilter = "sort"; // sort | kept | started | dropped
let ideasKind = "all"; // all | projet | design
const IDEA_KIND_FILTERS = [
  ["all", "Tout"],
  ["projet", "Projets"],
  ["design", "Design"],
];
const IDEA_FILTERS = [
  ["sort", "À trier", (i) => i.status === "new" || i.status === "digging" || i.status === "dug"],
  ["kept", "Gardées", (i) => i.status === "kept"],
  ["started", "Lancées", (i) => i.status === "started"],
  ["dropped", "Écartées", (i) => i.status === "dropped"],
];
const IDEA_VERDICT = { go: ["À faire", "idea-go"], later: ["Pour plus tard", "idea-later"], skip: ["À laisser", "idea-skip"] };
const IDEA_ORIGIN = { scroll: "Tour d'idées", toi: "Toi", clark: "Clark" };
/** Idées dont l'avis est ouvert (gardé d'un rendu à l'autre : render() redessine la page à chaque changement). */
const ideaOpen = new Set();

/** Nombre sur l'icône : les idées creusées qui attendent ta décision, et les nouvelles. */
function renderIdeasCount() {
  const el = $("#ideas-count");
  if (!el) return;
  const n = (state?.ideas ?? []).filter((i) => i.status === "new" || i.status === "dug").length;
  el.hidden = n === 0;
  el.textContent = n > 9 ? "9+" : String(n);
}

function ideaSource(i) {
  const label = i.sourceLabel || (i.sourceUrl ? hostOf(i.sourceUrl) : "");
  if (i.sourceUrl) return `<a href="${esc(i.sourceUrl)}" target="_blank" rel="noreferrer noopener">${esc(label || "source")}</a>`;
  return label ? esc(label) : "";
}

function ideaActions(i) {
  const b = (action, label, kind = "ghost") => `<button type="button" class="btn ${kind}" data-idea-action="${action}">${label}</button>`;
  switch (i.status) {
    case "new":
      return b("dig", "Creuser", "primary") + b("keep", "Garder") + b("drop", "Écarter");
    case "digging":
      return `<p class="quiet idea-busy" role="status">Clark la creuse…</p>`;
    case "dug":
      return b("start", "Lancer", "primary") + b("keep", "Garder") + b("drop", "Écarter");
    case "kept":
      return b("start", "Lancer", "primary") + (i.report ? "" : b("dig", "Creuser")) + b("drop", "Écarter");
    case "dropped":
      return b("reopen", "Remettre") + b("delete", "Supprimer");
    default:
      return "";
  }
}

function ideaCard(i) {
  const verdict = i.verdict ? IDEA_VERDICT[i.verdict] : null;
  const src = ideaSource(i);
  const open = ideaOpen.has(i.id) || (i.status === "dug" && !ideaOpen.has(-i.id));
  return `<article class="card idea" data-idea="${i.id}" data-status="${i.status}">
    <div class="idea-tags">
      ${i.kind === "design" ? `<span class="tag idea-design">Design</span>` : ""}
      <span class="tag idea-origin">${esc(IDEA_ORIGIN[i.origin] ?? i.origin)}</span>
      ${verdict ? `<span class="tag ${verdict[1]}">${verdict[0]}</span>` : ""}
      ${i.status === "started" ? `<span class="tag idea-go">Lancée</span>` : ""}
    </div>
    <h3 class="card-title">${esc(i.title)}</h3>
    ${i.pitch.replace(/https?:\/\/\S+/g, "").trim() === i.title ? "" : `<p class="idea-pitch">${esc(i.pitch)}</p>`}
    ${i.why ? `<p class="card-note">${esc(i.why)}</p>` : ""}
    <p class="auto-meta">${src ? `${src} · ` : ""}${esc(dayLabel(parseDate(i.at)))}${i.dropReason ? ` · écartée : ${esc(i.dropReason)}` : ""}</p>
    ${i.report ? `<details class="idea-report"${open ? " open" : ""}><summary>Avis de Clark</summary><div class="prose">${md(i.report)}</div></details>` : ""}
    <div class="card-actions">${ideaActions(i)}</div>
  </article>`;
}

/** Un site en clair : « r/SideProject », « GitHub Trending typescript », « godly.website ». */
function siteLabel(url) {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^(www|old)\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    if (host === "reddit.com" && parts[0] === "r" && parts[1]) return `r/${parts[1]}`;
    if (host === "github.com" && parts[0] === "trending") return `GitHub Trending${parts[1] ? ` ${parts[1]}` : ""}`;
    if (host === "news.ycombinator.com") return parts[0] === "show" ? "Show HN" : "Hacker News";
    return host;
  } catch {
    return url;
  }
}

function ideaSourcesField(t, kind, label) {
  const list = t.sources[kind] ?? [];
  return `<div class="idea-sources-field">
    <label for="idea-sources-${kind}">${label} <span class="block-count">${list.length} sites, ${t.perTour?.[kind] ?? 0} par tour</span></label>
    <textarea id="idea-sources-${kind}" data-sources-kind="${kind}" rows="${Math.min(12, Math.max(4, list.length + 1))}" spellcheck="false">${esc(list.join("\n"))}</textarea>
  </div>`;
}

function ideasTourLine(t) {
  if (!t) return "";
  const when = t.running ? "tour en cours" : t.hour === null ? "coupé" : `chaque jour à ${t.hour} h : ${t.why}`;
  const total = (t.sources.projet?.length ?? 0) + (t.sources.design?.length ?? 0);
  const next = [...(t.next?.projet ?? []), ...(t.next?.design ?? [])].map(siteLabel);
  return `<div class="idea-tour">
    <p class="quiet">Tour d'idées, ${esc(when)}. ${t.running ? "" : `<button type="button" class="link" data-ideas-tour>Faire un tour maintenant</button>`}</p>
    <details class="idea-sources">
      <summary>Sites parcourus (${total})</summary>
      <form id="idea-sources-form">
        <p class="quiet">Clark en visite quelques-uns à chaque tour, à tour de rôle : tout est couvert en quelques jours.${next.length ? ` Prochain tour : ${esc(next.join(", "))}.` : ""}</p>
        ${ideaSourcesField(t, "projet", "Projets")}
        ${ideaSourcesField(t, "design", "Design")}
        <p class="quiet">Un lien par ligne. Une page qui demande de se connecter est sautée : connecte-toi toi-même dans le navigateur de Clark pour qu'il la voie.</p>
        <button type="submit" class="btn secondary">Enregistrer</button>
      </form>
    </details>
  </div>`;
}

function renderIdeas() {
  const box = $("#ideas");
  if (!box || !state) return;
  // Pendant qu'on modifie la liste des sites, on ne redessine pas sous les doigts.
  if (box.contains(document.activeElement) && document.activeElement.dataset.sourcesKind) return;
  const every = state.ideas ?? [];
  const all = ideasKind === "all" ? every : every.filter((i) => (i.kind ?? "projet") === ideasKind);
  const kinds = IDEA_KIND_FILTERS.map(([key, label]) => `<button type="button" class="idea-filter" data-idea-kind="${key}" aria-pressed="${key === ideasKind}">${label}</button>`).join("");
  const filter = IDEA_FILTERS.find((f) => f[0] === ideasFilter) ?? IDEA_FILTERS[0];
  const shown = all.filter(filter[2]);
  const tabs = IDEA_FILTERS.map(([key, label, test]) => {
    const n = all.filter(test).length;
    return `<button type="button" class="idea-filter" data-idea-filter="${key}" aria-pressed="${key === filter[0]}">${label}${n ? ` <span class="block-count">${n}</span>` : ""}</button>`;
  }).join("");
  const sourcesOpen = box.querySelector(".idea-sources")?.open ?? false;
  const empty =
    filter[0] === "sort"
      ? all.length
        ? "Rien à trier. Le prochain tour d'idées en apportera, ou lance la tienne au-dessus."
        : "Pas encore d'idée. Lance la tienne au-dessus, ou fais faire un tour à Clark."
      : "Aucune pour l'instant.";
  box.innerHTML = `${ideasTourLine(state.ideasTour)}
    <div class="idea-filter-bar">
      <div class="idea-filters" role="group" aria-label="Filtrer par état">${tabs}</div>
      <div class="idea-filters" role="group" aria-label="Filtrer par sorte">${kinds}</div>
    </div>
    ${shown.length ? shown.map(ideaCard).join("") : `<p class="quiet">${empty}</p>`}`;
  if (sourcesOpen) box.querySelector(".idea-sources").open = true;
}

$("#idea-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#idea-text").value.trim();
  const err = $("#idea-error");
  err.hidden = true;
  if (text.length < 5) {
    err.textContent = "Écris l'idée en une phrase au moins.";
    err.hidden = false;
    return;
  }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await post("/api/ideas", { text, dig: $("#idea-dig").checked, kind: $("#idea-kind").value });
    $("#idea-text").value = "";
    ideasFilter = "sort";
    renderIdeas();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// Entrée ajoute, Maj + Entrée passe à la ligne.
$("#idea-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#idea-add").requestSubmit();
  }
});

$("#ideas").addEventListener("toggle", (e) => {
  const card = e.target.closest?.(".idea-report") && e.target.closest("[data-idea]");
  if (!card) return;
  const id = Number(card.dataset.idea);
  // Retenu dans les deux sens : un avis fermé à la main reste fermé.
  ideaOpen.delete(id);
  ideaOpen.delete(-id);
  ideaOpen.add(e.target.open ? id : -id);
}, true);

$("#ideas").addEventListener("submit", async (e) => {
  if (e.target.id !== "idea-sources-form") return;
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    for (const area of e.target.querySelectorAll("[data-sources-kind]")) {
      const sources = area.value.split("\n").map((s) => s.trim()).filter(Boolean);
      await post("/api/ideas/sources", { kind: area.dataset.sourcesKind, sources });
    }
    document.activeElement?.blur();
  } catch (error) {
    e.target.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(error.message)}</p>`);
  } finally {
    btn.disabled = false;
  }
});

$("#ideas").addEventListener("click", async (e) => {
  const tab = e.target.closest("[data-idea-filter]");
  if (tab) {
    ideasFilter = tab.dataset.ideaFilter;
    return renderIdeas();
  }
  const kindTab = e.target.closest("[data-idea-kind]");
  if (kindTab) {
    ideasKind = kindTab.dataset.ideaKind;
    return renderIdeas();
  }
  if (e.target.closest("[data-ideas-tour]")) {
    const b = e.target.closest("[data-ideas-tour]");
    b.disabled = true;
    try {
      await post("/api/ideas/tour", {});
    } catch (error) {
      b.disabled = false;
      b.closest(".idea-tour").insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(error.message)}</p>`);
    }
    return;
  }
  const btn = e.target.closest("[data-idea-action]");
  if (!btn) return;
  const card = btn.closest("[data-idea]");
  const action = btn.dataset.ideaAction;
  const title = card.querySelector(".card-title")?.textContent ?? "";
  if (action === "delete" && !(await ask("Supprimer cette idée ?", `« ${title} » disparaît pour de bon, et Clark pourra la reproposer.`, "Supprimer"))) return;
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/ideas/${card.dataset.idea}`, { action });
    if (action === "start") location.hash = "#conversation";
  } catch (error) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(error.message)}</p>`);
  }
});
