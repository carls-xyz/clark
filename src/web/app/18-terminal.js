// ── Terminal : tes commandes sur le Mac, et celles que Clark propose (à valider ici seulement) ──

let termRuns = [];
let termCwd = "";
let termTimer = null;
let termLoading = false;
const termHistory = [];
let termHistoryAt = -1;

/** ~/Developer/clark plutôt que /Users/charles/Developer/clark. */
function shortPath(path) {
  const m = path.match(/^\/Users\/[^/]+/);
  const h = m ? m[0] : "";
  return h && path.startsWith(h) ? `~${path.slice(h.length)}` : path;
}

async function loadTerminal() {
  if (termLoading) return;
  termLoading = true;
  try {
    const r = await fetch("/api/terminal");
    if (!r.ok) return;
    const data = await r.json();
    termRuns = data.runs ?? [];
    termCwd = data.cwd ?? termCwd;
    if (view === "terminal") paintTerminal();
  } catch {
    // Coupure passagère : le prochain relevé rattrape.
  } finally {
    termLoading = false;
  }
  scheduleTerminal();
}

/** Tant qu'une commande tourne et que la page est affichée, la sortie est relue régulièrement. */
function scheduleTerminal() {
  clearTimeout(termTimer);
  const live = termRuns.some((r) => r.status === "running") || state?.terminal?.running;
  if (view === "terminal" && live) termTimer = setTimeout(() => void loadTerminal(), 600);
}

function renderTerminal() {
  const t = state?.terminal;
  if (!t) {
    $("#term-runs").innerHTML = `<p class="quiet">Le Terminal n'est pas disponible dans ce mode.</p>`;
    $("#term-form").hidden = true;
    return;
  }
  $("#term-form").hidden = false;
  termCwd = t.cwd ?? termCwd;
  renderTermRequests(t.pending ?? []);
  void loadTerminal();
}

function renderTermRequests(pending) {
  const box = $("#term-requests");
  const key = pending.map((p) => p.id).join(",");
  if (box.dataset.key === key) return; // ne pas reconstruire sous le doigt
  box.dataset.key = key;
  box.innerHTML = pending
    .map(
      (p) => `<div class="card term-request" data-term-request="${p.id}">
        <span class="tag warn">Clark propose</span>
        ${p.reason ? `<p class="card-title">${esc(p.reason)}</p>` : ""}
        <pre class="term-cmd"><code>${esc(p.command)}</code></pre>
        <p class="card-note">Dans ${esc(shortPath(p.cwd))}. Elle tournera sur ton Mac, hors du bac à sable de Clark, sous tes yeux ; il lira la sortie.</p>
        <div class="card-actions">
          <button type="button" class="btn primary" data-term-decide="ok">Lancer</button>
          <button type="button" class="btn ghost" data-term-decide="no">Refuser</button>
        </div>
      </div>`,
    )
    .join("");
}

function runHtml(r) {
  const label = r.status === "running" ? "en cours…" : r.status === "stopped" ? "arrêtée" : r.exitCode === 0 ? "" : `code ${r.exitCode ?? "?"}`;
  return `<div class="term-run${r.status === "failed" ? " is-failed" : ""}" data-term-run="${r.id}">
    <div class="term-line">
      <span class="term-where">${esc(shortPath(r.cwd))}</span>
      ${r.by === "clark" ? `<span class="tag">Clark</span>` : ""}
      ${label ? `<span class="term-state">${esc(label)}</span>` : ""}
    </div>
    <div class="term-input-line"><span class="term-sign" aria-hidden="true">$</span><code>${esc(r.command)}</code></div>
    ${r.output ? `<pre class="term-out">${esc(r.output)}</pre>` : ""}
  </div>`;
}

function paintTerminal() {
  const body = $("#term-body");
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const box = $("#term-runs");
  // On ne redessine que ce qui a changé : la sélection de texte dans une ancienne sortie reste.
  const seenIds = new Set();
  for (const r of termRuns) {
    seenIds.add(String(r.id));
    const html = runHtml(r);
    const el = box.querySelector(`[data-term-run="${r.id}"]`);
    if (!el) box.insertAdjacentHTML("beforeend", html);
    else if (el.dataset.sig !== `${r.status}:${r.output.length}`) el.outerHTML = html;
    const now = box.querySelector(`[data-term-run="${r.id}"]`);
    if (now) now.dataset.sig = `${r.status}:${r.output.length}`;
  }
  for (const el of box.querySelectorAll("[data-term-run]")) if (!seenIds.has(el.dataset.termRun)) el.remove();
  if (!termRuns.length) box.innerHTML = `<p class="quiet term-empty">Tape une commande en bas : elle tourne dans ton shell (zsh), dans le dossier affiché. « cd » change de dossier. Les commandes que Clark propose apparaissent ici, et rien ne tourne sans ton clic.</p>`;
  else box.querySelector(".term-empty")?.remove();
  $("#term-cwd").textContent = `${shortPath(termCwd)} $`;
  const running = termRuns.find((r) => r.status === "running");
  $("#term-stop").hidden = !running;
  $("#term-stop").dataset.id = running ? String(running.id) : "";
  if (nearBottom) body.scrollTop = body.scrollHeight;
}

$("#term-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#term-input");
  const command = input.value.trim();
  if (!command) return;
  if (command === "clear") {
    input.value = "";
    return void post("/api/terminal/clear", {}).then(loadTerminal);
  }
  try {
    await post("/api/terminal/run", { command });
    termHistory.push(command);
    termHistoryAt = -1;
    input.value = "";
    $("#term-body").scrollTop = $("#term-body").scrollHeight;
    void loadTerminal();
  } catch (err) {
    termError(err.message);
  }
});

// Flèches : les commandes précédentes, comme dans un vrai terminal.
$("#term-input").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (!termHistory.length) return;
  e.preventDefault();
  if (e.key === "ArrowUp") termHistoryAt = termHistoryAt < 0 ? termHistory.length - 1 : Math.max(0, termHistoryAt - 1);
  else termHistoryAt = termHistoryAt < 0 ? -1 : termHistoryAt + 1 >= termHistory.length ? -1 : termHistoryAt + 1;
  e.target.value = termHistoryAt < 0 ? "" : termHistory[termHistoryAt];
});

$("#term-stop").addEventListener("click", async (e) => {
  const id = Number(e.currentTarget.dataset.id);
  if (!id) return;
  try {
    await post("/api/terminal/stop", { id });
  } catch (err) {
    termError(err.message);
  }
});

$("#term-clear").addEventListener("click", async () => {
  await post("/api/terminal/clear", {}).catch((err) => termError(err.message));
  $("#term-runs").innerHTML = "";
  void loadTerminal();
});

$("#term-requests").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-term-decide]");
  if (!btn) return;
  const card = btn.closest("[data-term-request]");
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/terminal/requests/${card.dataset.termRequest}`, { ok: btn.dataset.termDecide === "ok" });
    void loadTerminal();
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    card.querySelector(".inline-error")?.remove();
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

function termError(message) {
  const form = $("#term-form");
  form.querySelector(".inline-error")?.remove();
  form.insertAdjacentHTML("afterbegin", `<p class="inline-error term-error" role="alert">${esc(message)}</p>`);
  setTimeout(() => form.querySelector(".term-error")?.remove(), 5000);
}

/** Pastille de la colonne d'icônes : les commandes de Clark qui attendent ton clic. */
function renderTermCount() {
  const n = state?.terminal?.pending?.length ?? 0;
  const el = $("#term-count");
  el.hidden = !n;
  el.textContent = n ? String(n) : "";
  el.setAttribute("aria-label", `${n} commande${n > 1 ? "s" : ""} à valider`);
}
