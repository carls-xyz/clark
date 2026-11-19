// ── Colonne : à vérifier, en cours, budget, mémoire ─────────────────────

function renderSteps(steps) {
  const label = { running: "en cours", done: "fait", error: "erreur", denied: "refusé", expired: "expiré", awaiting_approval: "attend ton accord", unknown: "sans résultat" };
  return `<ul class="steps">${steps
    .map(
      (s) => `<li data-status="${s.status}">
        <span class="effect ${s.effect}" title="${s.effect === "write" ? "écriture" : "lecture"}"></span>
        <span class="t" title="${esc(s.text)}">${esc(s.text)}</span>
        <span class="s">${label[s.status] ?? s.status}</span>
      </li>`,
    )
    .join("")}</ul>`;
}

const planNames = { plus: "ChatGPT Plus", pro: "ChatGPT Pro", free: "ChatGPT Free", team: "ChatGPT Team", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu" };

function resetText(ms) {
  if (!ms) return "remise à zéro : heure inconnue";
  const d = new Date(ms);
  const t = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return sameDay(d, new Date()) ? `remise à zéro à ${t}` : `remise à zéro le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} à ${t}`;
}

/** Quota de l'abonnement ChatGPT : chiffres donnés par Codex, rien d'estimé. */
function renderQuota(q, engine) {
  const head = `<div class="block-head"><h2 class="block-title" id="h-quota">Quota Codex</h2>${q?.plan ? `<span class="block-count">${esc(planNames[q.plan] ?? q.plan)}</span>` : ""}</div>`;
  if (!q || q.windows.length === 0) {
    const why = engine.ready === false ? "Inconnu tant que Clark n'est pas connecté à ChatGPT." : "Codex n'a pas encore donné de chiffres.";
    return `<section class="block" aria-labelledby="h-quota">${head}<p class="quiet">${why}</p></section>`;
  }
  const rows = q.windows
    .map((w) => {
      const pct = Math.round(w.usedPercent);
      const level = q.reached || pct >= 100 ? " full" : pct >= 90 ? " near" : "";
      return `<div class="quota-row">
        <div class="quota-line"><span>${esc(w.label)}</span><span class="quota-pct">${pct} % utilisés</span></div>
        <div class="bar${level}" role="progressbar" aria-label="${esc(w.label)} : part du quota utilisée" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span data-ratio="${pct / 100}"></span></div>
        <p class="quiet">${resetText(w.resetsAt)}</p>
      </div>`;
    })
    .join("");
  const alert = q.reached ? `<p class="quota-alert">Limite atteinte : Clark ne pourra plus répondre avant la remise à zéro.</p>` : "";
  const when = new Date(q.readAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `<section class="block" aria-labelledby="h-quota">${head}${alert}${rows}<p class="quota-read">lu à ${when}</p></section>`;
}

