// ── Mode vision du navigateur : ce que l'agent voit et fait (lecture seule) ──
// Le miroir de la vue distante (24-vue-distante.js), mais à l'envers : là, tu te connectes
// toi-même à un site ; ici, c'est l'agent qui regarde le navigateur de Clark par capture et agit
// (clic, touche) avec ton accord. Cette page ne fait que montrer la dernière capture, l'état et le
// journal des dernières actions. Aucun envoi : les accords passent par les boutons déjà existants.

/** Dernier shotId affiché : on ne recharge l'image que quand le SSE en signale un nouveau. */
let computerShotId = null;

/** Noms lisibles des actions « vision » (VisionAction côté serveur). */
const COMPUTER_ACTIONS = { screenshot: "capture", click_at: "clic", key: "touche", scroll: "défilement" };

// Appelée par renderView() (14-navigation.js) à chaque état poussé par le SSE, tant que la vue est ouverte.
function renderComputer() {
  if (!state) return;
  const b = state.browser;
  const badge = $("#computer-badge");
  const img = $("#computer-shot");
  const empty = $("#computer-empty");
  const log = $("#computer-log");
  if (!b?.available) {
    badge.dataset.state = "off";
    badge.textContent = "Indisponible";
    img.hidden = true;
    empty.hidden = false;
    empty.textContent = "Google Chrome est introuvable sur cette machine.";
    computerShotId = null;
    log.innerHTML = "";
    return;
  }
  const v = b.vision;
  // « Contrôle actif » : une capture vision est en cours (l'agent regarde et peut agir, avec ton accord).
  const hasShot = !!(v && v.shotId);
  badge.dataset.state = hasShot ? "active" : "idle";
  badge.textContent = hasShot ? "Actif" : "Disponible";
  // Nouvelle capture : on recharge l'image par la route de capture, sans cache.
  if (hasShot && v.shotId !== computerShotId) {
    computerShotId = v.shotId;
    img.src = `/api/browser/vision/screenshot?t=${v.shotAt ?? Date.now()}`;
  }
  if (!hasShot) computerShotId = null;
  img.hidden = !hasShot;
  empty.hidden = hasShot;
  if (!hasShot) empty.textContent = "Pas de capture : l'agent n'utilise pas le mode vision en ce moment.";
  log.innerHTML = renderComputerLog(v?.recent ?? []);
}

/** Le journal des dernières actions, la plus récente en haut. */
function renderComputerLog(recent) {
  if (!recent.length) return `<li class="computer-empty-log quiet">Aucune action pour l'instant.</li>`;
  return [...recent]
    .reverse()
    .map((e) => {
      const verdict =
        e.granted === true
          ? `<span class="computer-verdict ok">accordée</span>`
          : e.granted === false
            ? `<span class="computer-verdict no">refusée</span>`
            : "";
      return `<li class="computer-act">
        <span class="computer-act-name">${esc(COMPUTER_ACTIONS[e.action] ?? e.action)}</span>
        <span class="computer-act-detail">${esc(e.detail ?? "")}</span>
        ${verdict}
        <time datetime="${new Date(e.at).toISOString()}">${time(new Date(e.at))}</time>
      </li>`;
    })
    .join("");
}
