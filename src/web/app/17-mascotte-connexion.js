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
