// ── Santé : sur un écran, ce qu'il faut pour laisser Clark tourner seul ──

const HEALTH_LEVEL = { ok: "Tout va bien", warn: "À regarder", bad: "À régler" };
const FAILED_STATUS = { failed: "en échec", needs_check: "à vérifier", abandoned: "abandonnée" };

/** Sur l'icône : le nombre de points à regarder (rien si tout va bien). */
function renderHealthCount() {
  const el = $("#health-count");
  if (!el) return;
  const h = state?.health;
  const n = h ? h.problems.length : 0;
  el.hidden = n === 0;
  el.textContent = n > 9 ? "9+" : String(n);
  el.dataset.level = h?.level ?? "ok";
  el.setAttribute("aria-label", n ? `${n} point${n > 1 ? "s" : ""} à regarder` : "");
}

const hours = (h) => (h < 1 ? "moins d'une heure" : h < 48 ? `${h} h` : `${Math.round(h / 24)} jours`);
const minutes = (m) => (m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} jours`);

function healthTile(title, value, detail, level = "ok") {
  return `<div class="card health-tile" data-level="${level}">
    <p class="health-tile-title">${title}</p>
    <p class="health-tile-value">${value}</p>
    ${detail ? `<p class="quiet health-tile-detail">${detail}</p>` : ""}
  </div>`;
}

function renderHealth() {
  const box = $("#health");
  if (!box || !state) return;
  const h = state.health;
  if (!h) {
    box.innerHTML = `<p class="quiet">Rapport indisponible.</p>`;
    return;
  }
  const verdict = `<section class="health-verdict" data-level="${h.level}" aria-live="polite">
    <p class="health-verdict-title"><span class="health-dot" data-level="${h.level}" aria-hidden="true"></span>${HEALTH_LEVEL[h.level]}</p>
    ${
      h.problems.length
        ? `<ul class="health-problems">${h.problems
            .map((p) => `<li data-level="${p.level}">${p.href ? `<a href="${esc(p.href)}">${esc(p.text)}</a>` : esc(p.text)}</li>`)
            .join("")}</ul>`
        : `<p class="quiet">Aucun point à regarder : la file avance, les moteurs répondent, la base est sauvegardée.</p>`
    }
  </section>`;

  const q = h.queue;
  const queue = healthTile(
    "File",
    q.running || q.queued ? `${q.running} en cours · ${q.queued} en attente` : "Vide",
    q.oldestQueuedMinutes !== null ? `La plus ancienne attend depuis ${minutes(q.oldestQueuedMinutes)}.` : h.stalled ? `${h.stalled} agent(s) silencieux.` : "",
    q.oldestQueuedMinutes !== null && q.oldestQueuedMinutes >= 15 ? "warn" : h.stalled ? "warn" : "ok",
  );
  const engines = h.engines
    .map((e) => {
      const level = e.ready === false ? (e.main ? "bad" : "warn") : e.quotaPercent !== null && e.quotaPercent >= 90 ? "warn" : "ok";
      const value = e.ready === false ? "Pas connecté" : e.quotaPercent !== null ? `${e.quotaPercent} % du quota` : "Connecté";
      const detail = [e.main ? "moteur principal" : "", e.quotaLabel && e.ready !== false ? e.quotaLabel.toLowerCase() : "", e.problem ?? ""].filter(Boolean).join(" · ");
      return healthTile(esc(e.label), esc(value), esc(detail), level);
    })
    .join("");
  const b = h.backup;
  const backup = healthTile(
    "Sauvegarde",
    b.last ? `Il y a ${hours(b.hoursAgo)}` : "Aucune",
    b.last ? `${b.count} gardée${b.count > 1 ? "s" : ""} · chaque nuit à 3 h` : "Elle se fait chaque nuit à 3 h.",
    b.hoursAgo === null || b.hoursAgo >= 36 ? "warn" : "ok",
  );
  const v = h.version;
  const version = healthTile(
    "Version",
    v.commit ? `<code>${esc(v.commit)}</code>${v.branch ? ` sur ${esc(v.branch)}` : " (détachée)"}` : "Inconnue",
    `Démarré il y a ${minutes(v.uptimeMinutes)} · ${esc(v.system)} · Node ${esc(v.node)}${v.lastGood && v.lastGood !== v.commit ? ` · dernière version qui a démarré : ${esc(v.lastGood)}` : ""}`,
    v.commit && !v.branch ? "bad" : "ok",
  );
  const st = h.storage;
  const storage = healthTile(
    "Place",
    st.freeGB !== null ? `${st.freeGB} Go libres` : "—",
    [st.dbMB !== null ? `base ${st.dbMB} Mo` : "", `Clark ${st.memoryMB} Mo en mémoire`].filter(Boolean).join(" · "),
    st.freeGB !== null && st.freeGB < 0.5 ? "bad" : st.freeGB !== null && st.freeGB < 2 ? "warn" : "ok",
  );

  const pg = h.ping ?? { configured: false };
  const watch = healthTile(
    "Surveillance",
    h.watchdog ? "Locale active" : "Locale absente",
    [
      h.watchdog ? "relance Clark s'il ne répond plus" : "scripts/service.sh install l'installe",
      !pg.configured ? "ping externe : pas configuré" : pg.failing ? `ping externe en échec${pg.lastError ? ` (${esc(pg.lastError)})` : ""}` : pg.lastOk ? `ping externe il y a ${minutes(Math.max(0, Math.round((Date.now() - pg.lastOk) / 60000)))}` : "ping externe : bientôt",
    ].join(" · "),
    !h.watchdog || pg.failing ? "warn" : "ok",
  );
  const al = h.alerts ?? { active: [], history: [] };
  const alerts = al.active.length || al.history.length
    ? `${al.active.length ? `<ul class="health-list">${al.active.map((a) => `<li><span class="tag ${a.urgent ? "cal-failed" : ""}">${a.urgent ? "urgent" : "en cours"}</span><span>${esc(a.text)}</span><span class="quiet">depuis ${time(new Date(a.since))}</span></li>`).join("")}</ul>` : `<p class="quiet">Aucune en cours.</p>`}
       ${al.history.length ? `<details class="health-history"><summary>Dernières alertes (${al.history.length})</summary><ul class="health-list">${al.history.map((e) => `<li><span class="quiet">${new Date(e.at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${time(new Date(e.at))}</span><span class="tag">${e.kind}</span><span>${esc(e.text)}</span></li>`).join("")}</ul></details>` : ""}`
    : `<p class="quiet">Aucune pour l'instant. Elles partent sur Telegram selon Réglages › Notifications › Santé de Clark.</p>`;

  const failures = h.failures.length
    ? `<ul class="health-list">${h.failures
        .map((f) => `<li><span class="quiet">${shortDate(f.at)} ${time(parseDate(f.at))}</span><span>${esc(f.title || f.label)}</span><span class="tag">${FAILED_STATUS[f.status] ?? esc(f.status)}</span></li>`)
        .join("")}</ul>`
    : `<p class="quiet">Aucune.</p>`;
  const errors = h.errors.length
    ? `<ul class="health-list">${h.errors.map((e) => `<li><span class="health-count">${e.count}×</span><span class="health-error">${esc(e.text)}</span></li>`).join("")}</ul>`
    : `<p class="quiet">Aucune.</p>`;

  box.innerHTML = `${verdict}
    <div class="health-grid">${queue}${engines}${backup}${version}${storage}${watch}</div>
    <section class="health-section" aria-labelledby="h-health-alerts"><h2 class="block-title" id="h-health-alerts">Alertes</h2>${alerts}</section>
    <section class="health-section" aria-labelledby="h-health-failures"><h2 class="block-title" id="h-health-failures">Échecs des dernières 24 h</h2>${failures}</section>
    <section class="health-section" aria-labelledby="h-health-errors"><h2 class="block-title" id="h-health-errors">Erreurs du journal depuis le démarrage</h2>${errors}
      <p class="quiet">Le détail : <code>scripts/service.sh logs</code>. Les secrets (jeton Telegram, clés) y sont masqués.</p></section>
    <p class="quiet health-at">Relevé à ${time(new Date(h.at))}.</p>`;
}

$("#view-health").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-health-refresh]");
  if (!btn) return;
  btn.disabled = true;
  try {
    const res = await fetch("/api/sante");
    if (res.ok) {
      state.health = await res.json();
      renderHealth();
      renderHealthCount();
    }
  } finally {
    btn.disabled = false;
  }
});
