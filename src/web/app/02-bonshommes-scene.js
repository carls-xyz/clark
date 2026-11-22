// ── Les bonshommes pixelisés : un par agent, Clark en bleu ──────────────
// Formes et couleurs reprises du portfolio de l'utilisateur (12 × 9 pixels : X corps, O ombre,
// A détail, W blanc de l'œil, P pupille), plus deux teintes pour Contenu et les temporaires.

const SHAPES = {
  bleu: ["....XXXX....", "..XXXXXXXX..", ".XXXXXXXXXX.", "XXXXXXXXXXXX", "XXWWXXXXWWXX", "XXWPXXXXWPXX", "XXXXXXXXXXXX", "OXXXXXXXXXXO", ".OOOOOOOOOO."],
  mousse: ["......AA....", "....AAA.....", "...XXXXXX...", "..XXXXXXXX..", "..XWWXXWWX..", "..XWPXXWPX..", "..XXXXXXXX..", "..OXXXXXXO..", "...OOOOOO..."],
  braise: ["......A.....", ".....AXA....", "....XXXX.A..", "..XXXXXXXX..", ".XXWWXXWWXX.", ".XXWPXXWPXX.", ".XXXXXXXXXX.", "..OXXXXXXO..", "...OOOOOO..."],
  guimauve: ["..X......X..", "..XA....AX..", "..XXXXXXXX..", ".XXXXXXXXXX.", ".XWWXXXXWWX.", ".XWPXXXXWPX.", ".XXXXAAXXXX.", ".OXXXXXXXXO.", "..OOOOOOOO.."],
};
const CREATURES = {
  bleu: { shape: "bleu", X: "#61a7d5", O: "#4a86ad", A: "#4a86ad" },
  mousse: { shape: "mousse", X: "#7ebf7a", O: "#5a9a57", A: "#a8dc78" },
  braise: { shape: "braise", X: "#ee8a52", O: "#c4662f", A: "#f7d26a" },
  guimauve: { shape: "guimauve", X: "#e48cb0", O: "#c06890", A: "#b85583" },
  lilas: { shape: "mousse", X: "#a48bd8", O: "#7f68b3", A: "#c9b6f0" },
  galet: { shape: "bleu", X: "#a3abb4", O: "#7f8892", A: "#7f8892" },
};
const EYES = { W: "#f2f4f7", P: "#15222d" };
const ROLE_CREATURE = { clark: "bleu", plan: "bleu", synthese: "bleu", chercheur: "mousse", redacteur: "braise", relecteur: "guimauve", contenu: "lilas", temporaire: "galet", groupe: "galet", code: "galet" };
const NAME_ROLE = { Chercheur: "chercheur", "Rédacteur": "redacteur", Relecteur: "relecteur", "Spécialiste Contenu": "contenu" };

/** Une rangée de pixels en segments horizontaux : un rectangle par segment. */
function pixelRow(row, y, colors) {
  let out = "";
  for (let i = 0; i < row.length; ) {
    const k = row[i];
    let j = i;
    while (j < row.length && row[j] === k) j++;
    if (k !== ".") out += `<rect x="${i}" y="${y}" width="${j - i}" height="1" fill="${colors[k]}"/>`;
    i = j;
  }
  return out;
}

/** Le bonhomme d'un rôle. walking : il marche (l'agent travaille). */
function sprite(role, { walking = false, size = 16 } = {}) {
  const c = CREATURES[ROLE_CREATURE[role] ?? "galet"];
  const colors = { ...EYES, X: c.X, O: c.O, A: c.A };
  const body = SHAPES[c.shape].map((row, y) => pixelRow(row, y, colors)).join("");
  const legs = walking
    ? `<g class="step-a">${pixelRow("..OO....OO..", 9, colors)}</g><g class="step-b">${pixelRow("...OO..OO...", 9, colors)}</g>`
    : pixelRow("..OO....OO..", 9, colors);
  return `<svg class="sprite${walking ? " walking" : ""}" viewBox="0 0 12 10" width="${size}" height="${Math.round((size * 10) / 12)}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${body}${legs}</svg>`;
}

const roleOfName = (name) => NAME_ROLE[name] ?? (name?.startsWith("Spécialiste") ? "temporaire" : "clark");

// ── La scène : les agents qui travaillent, en grand ──────────────────────
// Chaque agent tient l'outil de son rôle (loupe, plume, feuille cochée) ; celui qui travaille
// marche, réfléchit (bulle) et s'en sert ; une feuille passe de l'agent fini au suivant.

const PROPS = {
  loupe: { rows: [".OOO....", "O...O...", "O.G.O...", "O...O...", ".OOO....", "....HH..", ".....HH.", "......HH"], colors: { O: "#cfd6de", G: "#9fd0ee", H: "#a07850" } },
  plume: { rows: ["......WW", ".....WWW", "....WWW.", "...WWW..", "..WWW...", "..WW....", ".K......", "K......."], colors: { W: "#f2f4f7", K: "#5b6b7a" } },
  coche: { rows: ["WWWWWWW", "W.....W", "W....GW", "W...G.W", "WG.G..W", "W.G...W", "W.....W", "WWWWWWW"], colors: { W: "#e9e4d8", G: "#7ebf7a" } },
  carte: { rows: ["WWWWWWW", "W.....W", "W.LLL.W", "W.....W", "W.LL..W", "W.....W", "W.LLL.W", "WWWWWWW"], colors: { W: "#e9e4d8", L: "#61a7d5" } },
};
const ROLE_PROP = { code: "plume", chercheur: "loupe", temporaire: "loupe", redacteur: "plume", contenu: "plume", synthese: "plume", relecteur: "coche", plan: "carte" };
const PAPER = `<svg class="paper" viewBox="0 0 5 6" width="15" height="18" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${["WWWW.", "WLLWW", "WWWWW", "WLLLW", "WWWWW", "WWWWW"].map((r, y) => pixelRow(r, y, { W: "#e9e4d8", L: "#a3abb4" })).join("")}</svg>`;
const THINK = `<svg class="think" viewBox="0 0 11 6" width="33" height="18" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect class="think-bg" x="0" y="0" width="11" height="5"/><rect class="think-tail think-bg" x="2" y="5" width="2" height="1"/><rect class="d1" x="2" y="2" width="1" height="1"/><rect class="d2" x="5" y="2" width="1" height="1"/><rect class="d3" x="8" y="2" width="1" height="1"/></svg>`;

function prop(name) {
  const p = PROPS[name];
  if (!p) return "";
  const w = p.rows[0].length;
  return `<svg class="prop prop-${name}" viewBox="0 0 ${w} 8" width="${w * 3}" height="24" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${p.rows.map((r, y) => pixelRow(r, y, p.colors)).join("")}</svg>`;
}

/** Un agent sur la scène : bulle quand il réfléchit, outil en main, nom et état dessous. */
function actor({ role, name, status, tool, tag = "" }) {
  const running = status === "running";
  return `<li class="actor" data-status="${status}">
    <div class="actor-fig">
      ${running ? THINK : status === "done" ? `<span class="actor-done" aria-hidden="true">✓</span>` : ""}
      ${sprite(role, { walking: running, size: 46 })}${tool && (running || status === "done") ? prop(tool) : ""}
    </div>
    <span class="actor-name">${esc(name)}${tag}</span>
    <span class="actor-state">${teamStatus[status] ?? esc(status)}</span>
  </li>`;
}

function renderWorking(running) {
  if (!running.length || state.approvals.length || state.questions.length || state.posts.length || (state.mails ?? []).length) return "";
  // La demande de l'utilisateur (pas une mission confiée à un agent), et les agents qui y travaillent.
  const task = running.find((t) => !t.parentId) ?? running[0];
  const helpers = running.filter((t) => t.parentId === task.id && !task.team && ROLE_CREATURE[t.label]);
  if (helpers.length) {
    const cells = [
      actor({ role: "clark", name: "Clark", status: "running", tool: "carte" }),
      ...helpers.map((h) => `<li class="handoff flowing" aria-hidden="true">${PAPER}</li>${actor({ role: h.label, name: contactOf(h.label).name, status: h.status === "queued" ? "queued" : "running", tool: ROLE_PROP[h.label] })}`),
    ].join("");
    const says = helpers
      .map((h) => {
        const last = h.steps[h.steps.length - 1];
        return `<p class="stage-say">${sprite(h.label, { size: 14 })}<strong>${esc(contactOf(h.label).name)}</strong><span>${esc(h.checkpoint || (last ? last.text : "réfléchit"))}</span></p>`;
      })
      .join("");
    return `<section class="stage" aria-label="Clark et son équipe au travail">
      <p class="stage-head"><strong>Clark a confié le travail</strong><span>${helpers.map((h) => esc(contactOf(h.label).name)).join(", ")}</span></p>
      <ol class="stage-row">${cells}</ol>${says}
    </section>`;
  }
  if (task.team) {
    const agents = task.team.agents;
    const busy = agents.filter((a) => a.status === "running");
    const cells = agents
      .map((a, i) => {
        const role = a.temporary ? "temporaire" : a.role ?? roleOfName(a.name);
        // Entre deux agents : la feuille part de celui qui a fini vers celui qui travaille.
        const prev = agents[i - 1];
        const link = i === 0 ? "" : `<li class="handoff${a.status === "running" && prev?.status === "done" ? " flowing" : ""}${prev?.status === "done" ? " passed" : ""}" aria-hidden="true">${PAPER}</li>`;
        const tag = a.round && a.round > 1 ? ` <span class="round">v${a.round}</span>` : "";
        // Les agents de l'équipe s'affichent sous leur petit nom (Mousse, Braise…).
        const name = (state.contacts ?? []).some((c) => c.role === role) ? contactOf(role).name : a.name;
        return link + actor({ role, name, status: a.status, tool: ROLE_PROP[role], tag });
      })
      .join("");
    // Ce que disent les agents qui travaillent (leur point d'étape), chacun avec son bonhomme.
    const says = busy
      .map((a) => `<p class="stage-say">${sprite(a.temporary ? "temporaire" : a.role ?? roleOfName(a.name), { size: 14 })}<strong>${esc(a.name)}</strong><span>${esc(a.checkpoint || a.detail || "réfléchit")}</span></p>`)
      .join("");
    return `<section class="stage" aria-label="L'équipe au travail">
      <p class="stage-head"><strong>L'équipe travaille</strong><span>${esc(task.team.plan)}</span></p>
      <ol class="stage-row">${cells}</ol>
      ${says || `<p class="stage-say">${sprite("clark", { size: 14 })}<strong>Clark</strong><span>prépare la suite</span></p>`}
    </section>`;
  }
  const last = task.steps[task.steps.length - 1];
  const what = task.checkpoint ? esc(task.checkpoint) : last ? esc(last.text) : task.status === "queued" ? "en file d'attente" : "réfléchit";
  // Seul : Clark lit (loupe) ou écrit (plume) selon sa dernière action.
  const tool = last ? (last.effect === "read" ? "loupe" : "plume") : null;
  return `<section class="stage solo" aria-label="Clark au travail">
    <ol class="stage-row">${actor({ role: "clark", name: "Clark", status: task.status === "queued" ? "queued" : "running", tool })}</ol>
    <p class="stage-say"><strong>Clark travaille</strong><span>${what}</span></p>
  </section>`;
}

/**
 * La conversation est redessinée à chaque mise à jour : sans ça, les animations de la scène
 * repartiraient de zéro à chaque étape. Calées sur l'horloge de la page, elles continuent.
 */
function syncStage(root) {
  const now = document.timeline.currentTime ?? 0;
  for (const a of root.querySelector(".stage")?.getAnimations({ subtree: true }) ?? []) a.currentTime = now;
}

