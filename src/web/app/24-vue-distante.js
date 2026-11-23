// ── Vue distante du navigateur : tu te connectes toi-même à un site (serveur sans écran, ou téléphone) ──

// « var » : showView (14-navigation.js) la lit dès le chargement, avant que ce fichier soit lu.
var remoteOpen = false;
/** Petit écran (téléphone) : la page passe en largeur de téléphone pendant la vue distante. */
const remotePhone = () => matchMedia("(max-width: 700px)").matches;
let remoteShotAt = null;

function remoteError(msg) {
  const el = $("#remote-error");
  el.textContent = msg ?? "";
  el.hidden = !msg;
}

async function remote(body) {
  remoteError("");
  try {
    const r = await post("/api/browser/remote", body);
    remoteOpen = true;
    if (r.state) state.browser = r.state;
    renderRemote();
  } catch (err) {
    remoteError(err.message);
  }
}

async function stopRemote() {
  if (!remoteOpen) return;
  remoteOpen = false;
  await post("/api/browser/remote", { action: "stop" }).catch(() => {});
}

/** Ne redessine que la capture : les champs gardent ce que tu y as tapé. */
function renderRemote() {
  if (!state) return;
  const b = state.browser;
  const img = $("#remote-shot");
  const empty = $("#remote-empty");
  if (!b?.available) {
    img.hidden = true;
    empty.hidden = false;
    empty.textContent = "Chrome est introuvable sur cette machine.";
    return;
  }
  // Ouverte ailleurs (autre onglet) ou fermée côté serveur : on suit.
  if (remoteOpen && !b.remoteUntil) remoteOpen = false;
  if (b.running && b.shotAt && b.shotAt !== remoteShotAt) {
    remoteShotAt = b.shotAt;
    img.src = `/api/browser/screenshot?t=${b.shotAt}`;
  }
  img.hidden = !(b.running && b.shotAt);
  empty.hidden = !img.hidden;
  if (b.url && document.activeElement !== $("#remote-url-input") && !$("#remote-url-input").value) $("#remote-url-input").placeholder = b.url;
}

$("#remote-url").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#remote-url-input").value.trim();
  if (!url) return void remote({ action: "start", phone: remotePhone() });
  void remote(remoteOpen ? { action: "goto", url } : { action: "start", url, phone: remotePhone() });
  $("#remote-url-input").value = "";
});

// Un clic sur la capture : la même position dans la page (la capture est réduite à l'écran).
$("#remote-shot").addEventListener("click", (e) => {
  const img = e.currentTarget;
  const scale = (state.browser?.remoteWidth ?? 1280) / img.clientWidth;
  void remote({ action: "click", x: Math.round(e.offsetX * scale), y: Math.round(e.offsetY * scale) });
});

$("#remote-type").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#remote-text");
  const text = input.value;
  if (!text) return;
  input.value = "";
  void remote({ action: "type", text });
});

$("#remote-mask").addEventListener("change", (e) => {
  $("#remote-text").type = e.target.checked ? "password" : "text";
});

$("#view-browser").addEventListener("click", (e) => {
  const key = e.target.closest("[data-remote-key]");
  if (key) return void remote({ action: "key", key: key.dataset.remoteKey });
  const btn = e.target.closest("[data-remote]");
  if (!btn) return;
  const a = btn.dataset.remote;
  if (a === "stop") {
    void stopRemote().then(() => (location.hash = "#reglages/connexions"));
  } else if (a === "scroll-up" || a === "scroll-down") void remote({ action: "scroll", direction: a === "scroll-up" ? "up" : "down" });
  else if (a === "back") void remote({ action: "back" });
});

// Fermer l'onglet ferme aussi la vue distante.
addEventListener("pagehide", () => {
  if (remoteOpen) navigator.sendBeacon?.("/api/browser/remote", new Blob([JSON.stringify({ action: "stop" })], { type: "application/json" }));
});
