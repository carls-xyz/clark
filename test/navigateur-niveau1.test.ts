import assert from "node:assert/strict";
import { test } from "node:test";
import { Bot } from "grammy";
import type { BrowserDriver, PageView } from "../src/browser/driver.ts";
import { browserJournal, browserStepInput, browserStepOutput } from "../src/browser/journal.ts";
import { blockedRule, blockRules, hostMatches, normalizeHost, redactText, redactUrl, rulesView, TRUST_LIST_ENABLED } from "../src/browser/sensitive.ts";
import { BrowserService, REMOTE_IDLE_MS, type ApprovalOutcome } from "../src/browser/service.ts";
import type { Config } from "../src/config.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub } from "../src/core/hub.ts";
import { onStop } from "../src/core/stops.ts";
import { createTelegram } from "../src/gateway/telegram.ts";
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

// ── Domaines sensibles ───────────────────────────────────────────────────

test("sites sensibles : domaine exact ou sous-domaine, noms normalisés, provenance", () => {
  const rules = blockRules("banque.fr, *.mon-coffre.io");
  const rule = (u: string) => blockedRule(u, rules);
  assert.equal(rule("https://banque.fr/")?.source, "CLARK_BROWSER_BLOCK");
  assert.equal(rule("https://connexion.banque.fr/login")?.domain, "banque.fr");
  assert.equal(rule("https://CONNEXION.Banque.FR./x")?.domain, "banque.fr", "majuscules et point final");
  assert.equal(rule("https://fausse-banque.fr/"), null);
  assert.equal(rule("https://banque.fr.evil.com/"), null);
  assert.equal(rule("https://app.mon-coffre.io/"), rule("https://mon-coffre.io/"));
  assert.ok(rule("https://app.mon-coffre.io/"));
  assert.equal(rule("about:blank"), null);
  assert.equal(normalizeHost("https://bücher.example/"), "xn--bcher-kva.example");
  assert.ok(hostMatches("a.b.banque.fr", "banque.fr"));
  assert.ok(!hostMatches("xbanque.fr", "banque.fr"));

  // Les catégories par défaut, avec leur provenance.
  for (const u of ["https://www.boursorama.com/", "https://accounts.google.com/signin", "https://vault.bitwarden.com/", "https://www.binance.com/", "https://franceconnect.gouv.fr/", "https://appleid.apple.com/"]) {
    assert.equal(blockedRule(u)?.source, "defaut", u);
  }
  assert.equal(blockedRule("https://mail.google.com/"), null, "Gmail n'est pas un compte Google sensible");
  assert.equal(blockedRule("https://stripe.com/docs"), null, "la doc Stripe reste lisible");
  const view = rulesView("banque.fr");
  assert.deepEqual(view.map((g) => g.category), ["banque", "crypto", "mots_de_passe", "identite", "comptes", "ajout"]);
  assert.deepEqual(view.at(-1)?.domains, ["banque.fr"]);
  assert.equal(TRUST_LIST_ENABLED, false, "la liste de confiance n'est pas branchée");
});

// ── Faux navigateur à onglets ────────────────────────────────────────────

const BANK = "https://clients.boursobank.com/espace?token=SECRET#solde";

class TabsDriver implements BrowserDriver {
  on = false;
  shown = false;
  tabs: string[] = ["about:blank"];
  cur = 0;
  /** Où mène une adresse (redirection), et ce qu'ouvre un clic. */
  redirects: Record<string, string> = {};
  views: string[] = [];
  calls: string[] = [];
  available() {
    return true;
  }
  running() {
    return this.on;
  }
  visible() {
    return this.on && this.shown;
  }
  async ensure(v: boolean) {
    this.on = true;
    this.shown = v;
  }
  async open(url: string) {
    this.calls.push(`open ${url}`);
    this.tabs[this.cur] = this.redirects[url] ?? url;
  }
  async view(): Promise<PageView> {
    const url = this.tabs[this.cur];
    this.views.push(url);
    return {
      url,
      title: "Page",
      text: `CONTENU DE ${url}`,
      elements: [
        { ref: "e1", tag: "a", role: "", name: "Mon espace", type: "", href: "https://clients.boursobank.com/", submits: false, secret: false, disabled: false },
        { ref: "e2", tag: "a", role: "", name: "Nouvel onglet", type: "", href: "https://ok.example/popup", submits: false, secret: false, disabled: false },
        { ref: "e3", tag: "button", role: "", name: "Envoyer", type: "", href: null, submits: true, secret: false, disabled: false },
      ],
    };
  }
  async click(ref: string) {
    this.calls.push(`click ${ref}`);
    // Le lien « Nouvel onglet » ouvre un onglet qui file vers la banque.
    if (ref === "e2") {
      this.tabs.push(BANK);
      this.cur = this.tabs.length - 1;
    }
  }
  async fill() {}
  async press() {}
  async select() {}
  async scroll() {}
  async back() {
    this.tabs[this.cur] = BANK;
  }
  async screenshot() {
    return Buffer.from("jpeg");
  }
  async close() {
    this.on = false;
  }
  /** Mode vision : un clic à (9, 9) ouvre un onglet qui file vers la banque. */
  async clickAt(x: number, y: number) {
    this.calls.push(`clickAt ${x},${y}`);
    if (x === 9 && y === 9) {
      this.tabs.push(BANK);
      this.cur = this.tabs.length - 1;
    }
  }
  async typeText() {}
  async pressKey() {}
  currentUrl() {
    return this.tabs[this.cur] ?? null;
  }
  urls() {
    return [...this.tabs];
  }
  async closeWhere(refused: (u: string) => boolean) {
    const out = this.tabs.filter(refused);
    this.tabs = this.tabs.filter((u) => !refused(u));
    if (!this.tabs.length) this.tabs = ["about:blank"];
    this.cur = this.tabs.length - 1;
    return out;
  }
}

function browser(answer: ApprovalOutcome | (() => Promise<ApprovalOutcome>) = "ok") {
  const driver = new TabsDriver();
  const svc = new BrowserService({ driver, approve: async () => (typeof answer === "function" ? answer() : answer), taskAlive: () => true, readOnly: () => false });
  return { driver, svc };
}

test("navigateur : jamais de site sensible pour l'agent — ouverture, lien, redirection, nouvel onglet, retour arrière", async () => {
  const { driver, svc } = browser();

  // Ouverture directe : refusée avant tout chargement, avec la règle et sa provenance.
  const direct = await svc.act(1, "open", { url: "accounts.google.com/signin" });
  assert.match(direct, /Site bloqué pour l'agent : accounts\.google\.com \(Comptes Apple, Google et Microsoft, défaut Clark\)/);
  assert.ok(!driver.calls.some((c) => c.startsWith("open")));

  // Redirection vers la banque : l'onglet est fermé avant toute lecture.
  driver.redirects["https://ok.example/go"] = "https://www.boursorama.com/connexion?jeton=1";
  const redirected = await svc.act(1, "open", { url: "https://ok.example/go" });
  assert.match(redirected, /a mené vers un site sensible \(boursorama\.com/);
  assert.ok(!driver.urls().some((u) => u.includes("boursorama")));
  assert.ok(!driver.views.some((u) => u.includes("boursorama")), "la page sensible n'a jamais été lue");

  // Lien vers un site sensible : pas de clic.
  driver.redirects = {};
  await svc.act(1, "open", { url: "https://ok.example/" });
  driver.calls = [];
  assert.match(await svc.act(1, "click", { ref: "e1" }), /Site bloqué/);
  assert.deepEqual(driver.calls, []);

  // Un nouvel onglet qui file vers la banque : fermé.
  const popup = await svc.act(1, "click", { ref: "e2" });
  assert.match(popup, /site sensible/);
  assert.deepEqual(driver.urls(), ["https://ok.example/"]);

  // Retour arrière vers la banque : neutralisé.
  assert.match(await svc.act(1, "back", {}), /site sensible/);
  assert.ok(!driver.urls().some((u) => u.includes("boursobank")));
  assert.ok(!driver.views.some((u) => u.includes("boursobank")));
  assert.equal(svc.state().locked, null, "fermé par l'agent lui-même : pas de verrou");
});

test("navigateur : après ta visite d'un site sensible (vue distante), l'agent reste bloqué jusqu'à ce que tu le quittes", async () => {
  const { driver, svc } = browser();
  await svc.remote({ action: "start" });
  await svc.remote({ action: "goto", url: BANK });
  // Pendant : la capture sert à ta vue, mais rien de la page n'est lu pour l'agent.
  assert.ok(svc.screenshot());
  assert.ok(!driver.views.some((u) => u.includes("boursobank")));
  assert.match(await svc.act(1, "read", {}), /Charles utilise le navigateur/);

  await svc.remote({ action: "stop" });
  // Après : verrou, adresse réduite, plus de capture, toujours rien de lu.
  const st = svc.state();
  assert.equal(st.locked, "boursobank.com (Banque et paiement, défaut Clark)");
  assert.equal(st.url, "https://clients.boursobank.com/espace");
  assert.equal(st.title, null);
  assert.equal(svc.screenshot(), null);
  assert.equal(st.shotAt, null, "pas d'heure de capture sans capture");
  for (const action of ["read", "scroll", "back", "click", "type", "select"] as const) {
    assert.match(await svc.act(1, action, { ref: "e3", text: "x", value: "y" }), /site sensible .*ouvert par Charles/, action);
  }
  assert.match(await svc.act(1, "open", { url: "https://ok.example/" }), /ouvert par Charles/, "même pour partir ailleurs");
  assert.ok(!driver.views.some((u) => u.includes("boursobank")));

  // Tu quittes le site : l'agent retrouve la main.
  await svc.leaveSensitive();
  assert.equal(svc.state().locked, null);
  assert.match(await svc.act(1, "open", { url: "https://ok.example/" }), /Page : Page — https:\/\/ok\.example\//);
  assert.deepEqual(
    svc.controlEvents().map((e) => e.kind),
    ["repris", "rendu"],
  );
});

test("navigateur : vue distante expirée sur un site sensible → sa capture n'est plus servie, l'agent reste bloqué", async () => {
  const { driver, svc } = browser();
  await svc.remote({ action: "start" });
  await svc.remote({ action: "goto", url: BANK });
  assert.ok(svc.screenshot(), "pendant la vue distante, la capture sert à l'utilisateur");

  // Dix minutes sans action : la vue se ferme toute seule, sans passer par « Terminer ».
  const realNow = Date.now;
  Date.now = () => realNow() + REMOTE_IDLE_MS + 1000;
  try {
    const st = svc.state();
    assert.equal(st.remoteUntil, null);
    // Comme après « Terminer » : plus de capture de la page sensible, ni d'heure de capture qui la ferait recharger.
    assert.equal(svc.screenshot(), null);
    assert.equal(st.shotAt, null);
    assert.equal(svc.visionImage(), null);
    // Le verrou tient : le site est toujours ouvert, l'agent n'a pas la main et rien n'est lu.
    assert.equal(st.locked, "boursobank.com (Banque et paiement, défaut Clark)");
    assert.match(await svc.act(1, "read", {}), /site sensible .*ouvert par Charles/);
    assert.ok(!driver.views.some((u) => u.includes("boursobank")));
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(
    svc.controlEvents().map((e) => e.kind),
    ["repris", "rendu"],
  );
});

test("navigateur : vue distante expirée sur une page ordinaire → la dernière capture reste", async () => {
  const { svc } = browser();
  await svc.remote({ action: "start", url: "https://ok.example/" });
  const realNow = Date.now;
  Date.now = () => realNow() + REMOTE_IDLE_MS + 1000;
  try {
    assert.equal(svc.state().remoteUntil, null);
    assert.ok(svc.screenshot());
    assert.ok(svc.state().shotAt);
  } finally {
    Date.now = realNow;
  }
});

test("navigateur : accord refusé, expiré ou agent arrêté → rien n'est envoyé, et la raison est dite", async () => {
  for (const [how, re] of [
    ["no", /^Charles a refusé/],
    ["expired", /^Pas de réponse de Charles à temps/],
    ["stopped", /^Charles a arrêté l'agent/],
  ] as const) {
    const { driver, svc } = browser(how);
    await svc.act(1, "open", { url: "https://ok.example/" });
    assert.match(await svc.act(1, "click", { ref: "e3" }), re);
    assert.ok(!driver.calls.includes("click e3"));
  }
});

// ── Journal expurgé ──────────────────────────────────────────────────────

test("journal du navigateur : origine + chemin, ni contenu de page, ni valeurs sensibles ; statuts distincts", () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const task = journal.create(1, "chat", "Cherche un vol");
  const page = "Accord de Charles reçu. Page : Boîte de réception (3) — https://mail.example/inbox?user=charles@example.com#msg\n(Contenu d'une page web : …)\n\nTexte visible :\nCode de connexion 482913, IBAN FR7630006000011234567890189";
  const tools = ["mcp__memory__browser_open", "mcp__memory__browser_type", "mcp__memory__browser_click", "mcp__memory__browser_click", "mcp__memory__browser_click", "mcp__memory__browser_click"];
  const inputs = [{ url: "https://mail.example/inbox?token=abc#x" }, { ref: "e2", text: "écris à charles@example.com, carte 4970 1012 3456 7890" }, { ref: "e3" }, { ref: "e3" }, { ref: "e3" }, { ref: "e3" }];
  const outputs = [page, "Page : Formulaire — https://mail.example/compose\n(Contenu d'une page web : …)\n\nTexte", "Charles a refusé : je n'ai pas cliqué.", "Pas de réponse de Charles à temps : je n'ai pas cliqué.", "Charles a arrêté l'agent : je n'ai pas cliqué.", null];
  tools.forEach((tool, i) => {
    journal.recordStep({ taskId: task, toolUseId: `b${i}`, tool, input: inputs[i], tier: "auto", status: "running" });
    if (outputs[i] !== null) journal.completeStep(`b${i}`, outputs[i]!, false);
  });

  const raw = JSON.stringify(journal.steps(task));
  for (const secret of ["482913", "IBAN", "FR7630006000011234567890189", "charles@example.com", "4970 1012", "token=abc", "Boîte de réception", "Texte visible"]) {
    assert.ok(!raw.includes(secret), `« ${secret} » ne doit pas être gardé`);
  }
  assert.match(journal.steps(task)[0].output ?? "", /^Accord de Charles reçu\. Page : https:\/\/mail\.example\/inbox$/);
  assert.equal(JSON.parse(journal.steps(task)[0].input).url, "https://mail.example/inbox");

  const entries = browserJournal(journal.browserSteps(), { awaitingTasks: new Set([task]), control: [{ at: Date.now(), kind: "repris" }] });
  const actions = entries.filter((e) => e.kind === "action");
  assert.deepEqual(
    actions.map((e) => e.label).reverse(),
    ["Accord donné", "Fait", "Refusé", "Expiré", "Agent arrêté", "Accord demandé"],
  );
  assert.equal(actions.at(-1)?.kind === "action" && actions.at(-1)!.finalUrl, "https://mail.example/inbox", "l'adresse finale");
  assert.ok(entries.some((e) => e.kind === "controle" && e.label === "Contrôle repris par Charles"));

  assert.equal(redactUrl("https://site.example/u/charles@example.com/x?a=1#b"), "https://site.example/u/•••/x");
  assert.match(redactText("Cookie: sid=abc\nAuthorization: Bearer abcdefghijkl"), /Cookie: •••\nAuthorization: •••/);
  assert.deepEqual(browserStepInput({ url: "exemple.fr/a?b=c" }), { url: "https://exemple.fr/a" });
  assert.equal(browserStepOutput("Site bloqué pour l'agent : banque.fr"), "Site bloqué pour l'agent : banque.fr");
});

// ── Arrêt depuis Telegram ────────────────────────────────────────────────

const config: Config = {
  telegram: { token: "123:abc", ownerId: 1 },
  workspace: "/tmp/clark-ws",
  hasApiKey: true,
  engine: "claude",
  codexModel: null,
  engineAuto: false,
  heartbeatMinutes: 0,
  roleEngines: {},
  webPort: 0,
  model: "claude-opus-5-5",
  maxUsdPerTask: 1,
  maxUsdPerDay: 5,
  briefHour: null,
} as unknown as Config;

const owner = { id: 1, is_bot: false as const, first_name: "Charles" };
const stranger = { id: 99, is_bot: false as const, first_name: "Autre" };
const chat = { id: 1, type: "private" as const, first_name: "Charles" };

function fakeBot() {
  const bot = new Bot(config.telegram!.token);
  const sent: { text: string; buttons: string[] }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe") return { ok: true, result: { id: 2, is_bot: true, first_name: "Clark", username: "clark_bot" } } as never;
    if (method !== "sendMessage") return { ok: true, result: true } as never;
    const p = payload as { text: string; reply_markup?: { inline_keyboard?: { callback_data: string }[][] } };
    sent.push({ text: p.text, buttons: (p.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data) });
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 1, type: "private" } } } as never;
  });
  return { bot, sent };
}

const command = (bot: Bot, id: number, text: string) =>
  bot.handleUpdate({ update_id: id, message: { message_id: id, chat, from: owner, date: 0, text, entities: [{ type: "bot_command" as const, offset: 0, length: text.length }] } });
const press = (bot: Bot, id: number, data: string, from = owner) =>
  bot.handleUpdate({ update_id: id, callback_query: { id: `cb${id}`, chat_instance: "x", from, data, message: { message_id: 1, date: 0, chat } as never } });
const tick = () => new Promise<void>((r) => setImmediate(r));

test("Telegram /stop : il montre la tâche et son bouton, n'arrête rien sans clic ; l'arrêt annule les accords en attente", async () => {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const hub = createHub({ config, store, journal, conversation: new Conversation(store.db) });
  const { bot, sent } = fakeBot();
  createTelegram(hub, { ...config.telegram!, bot });
  await bot.init();

  await command(bot, 1, "/stop");
  assert.equal(sent.at(-1)?.text, "Aucun agent en cours.");

  const task = journal.create(1, "chat", "Compare trois vols pour Lisbonne");
  journal.setStatus(task, "running");
  let stopped = 0;
  const off = onStop(task, () => stopped++);
  const other = journal.create(1, "chat", "Range mes notes");
  journal.setStatus(other, "running");
  const offOther = onStop(other, () => {});

  // Un accord navigateur en attente : il porte « Arrêter l'agent ».
  const answer = hub.approveTaskOutcome(task, { tool: "browser", summary: "Navigateur · ok.example — cliquer « Envoyer »" });
  await tick();
  assert.ok(sent.at(-1)?.buttons.includes(`stop:${task}`));
  assert.equal(hub.approvals().length, 1);

  await command(bot, 2, "/stop");
  const list = sent.at(-1)!;
  assert.match(list.text, /2 agents sont en cours/);
  assert.match(list.text, new RegExp(`#${task} · Compare trois vols pour Lisbonne`));
  assert.deepEqual(list.buttons, [`stop:${task}`, `stop:${other}`]);
  assert.equal(stopped, 0, "rien n'est arrêté sans clic");

  // Un autre compte que le propriétaire : ignoré.
  await press(bot, 3, `stop:${task}`, stranger);
  assert.equal(stopped, 0);

  await press(bot, 4, `stop:${task}`);
  assert.equal(stopped, 1);
  assert.equal(await answer, "stopped", "l'accord en attente est annulé, pas validé");
  assert.equal(hub.approvals().length, 0);
  // Déjà arrêté : le bouton ne fait plus rien.
  await press(bot, 5, `stop:${task}`);
  assert.equal(stopped, 1);
  off();
  offOther();
});

test("journal du navigateur : les étapes écrites avant l'expurgation sont nettoyées au démarrage", () => {
  const store = new Store(":memory:");
  const first = new TaskJournal(store.db);
  const task = first.create(1, "chat", "Lis mes mails");
  store.db
    .prepare("INSERT INTO steps (task_id, tool_use_id, tool, input, tier, status, output) VALUES (?, 'old', 'mcp__memory__browser_open', ?, 'auto', 'done', ?)")
    .run(task, JSON.stringify({ url: "https://mail.example/inbox?token=abc" }), "Page : Studio — https://mail.example/inbox?u=1\n(Contenu d'une page web : …)\n\nTexte visible :\nCode 482913");
  const journal = new TaskJournal(store.db);
  const [step] = journal.steps(task);
  assert.equal(step.output, "Page : https://mail.example/inbox");
  assert.equal(JSON.parse(step.input).url, "https://mail.example/inbox");
  const [entry] = browserJournal(journal.browserSteps());
  assert.equal(entry.kind === "action" && entry.finalUrl, "https://mail.example/inbox");
});

// ── Mode vision : mêmes règles ───────────────────────────────────────────

test("vision : pas de capture d'un site sensible, onglet sensible fermé après un clic, refus jamais pris pour un accord", async () => {
  // Après ta visite d'un site sensible : ni capture, ni action, ni image servie à l'agent.
  {
    const { driver, svc } = browser();
    await svc.remote({ action: "start" });
    await svc.remote({ action: "goto", url: BANK });
    await svc.remote({ action: "stop" });
    const shot = await svc.vision(1, "screenshot");
    assert.equal(shot.ok, false);
    assert.match(shot.text, /site sensible .*ouvert par Charles/);
    assert.equal(shot.shot, undefined);
    assert.equal(svc.visionImage(), null);
    assert.match((await svc.vision(1, "scroll", { direction: "down" })).text, /ouvert par Charles/);
    assert.ok(!driver.views.some((u) => u.includes("boursobank")));
  }

  // Un clic accordé qui ouvre un onglet vers la banque : l'onglet est fermé avant toute capture.
  {
    const { driver, svc } = browser();
    await svc.act(1, "open", { url: "https://ok.example/" });
    const shot = await svc.vision(1, "screenshot");
    assert.ok(shot.ok);
    assert.ok(svc.visionImage());
    const click = await svc.vision(1, "click_at", { x: 9, y: 9, shotId: shot.shot!.shotId });
    assert.match(click.text, /a mené vers un site sensible \(boursobank\.com/);
    assert.ok(!driver.urls().some((u) => u.includes("boursobank")));
    assert.ok(!driver.views.some((u) => u.includes("boursobank")));
    assert.equal(svc.visionImage(), null, "plus de capture valable");
  }

  // Refusé, expiré, agent arrêté : jamais un clic.
  for (const how of ["no", "expired", "stopped"] as const) {
    const { driver, svc } = browser(how);
    await svc.act(1, "open", { url: "https://ok.example/" });
    const shot = await svc.vision(1, "screenshot");
    const r = await svc.vision(1, "click_at", { x: 5, y: 5, shotId: shot.shot!.shotId });
    assert.equal(r.ok, false, how);
    assert.ok(!driver.calls.some((c) => c.startsWith("clickAt")), how);
  }
});

test("vision : une seconde demande d'accord de la même tâche ne remplace pas la première", async () => {
  let decide!: (how: ApprovalOutcome) => void;
  const { driver, svc } = browser(() => new Promise<ApprovalOutcome>((r) => (decide = r)));
  await svc.act(1, "open", { url: "https://ok.example/" });
  const shot = await svc.vision(1, "screenshot");
  const first = svc.vision(1, "click_at", { x: 5, y: 5, shotId: shot.shot!.shotId });
  await new Promise((r) => setTimeout(r, 20));
  const second = await svc.vision(1, "key", { key: "Enter", shotId: shot.shot!.shotId });
  assert.equal(second.ok, false);
  assert.match(second.text, /attend déjà l'accord/);
  // Une autre tâche reste bloquée pendant ce temps.
  assert.match((await svc.vision(2, "scroll", { direction: "down" })).text, /réservé par la tâche #1/);
  decide("ok");
  assert.equal((await first).ok, true);
  assert.ok(driver.calls.includes("clickAt 5,5"));
});

test("journal : les captures vision gardent l'identifiant et l'adresse réduite, jamais le titre", () => {
  assert.equal(
    browserStepOutput("Capture v3 — Boîte de réception (charles@example.com) · https://mail.example/inbox?u=1 · 1280×800. Fournis ce shotId."),
    "Capture v3 · Page : https://mail.example/inbox",
  );
  const entries = browserJournal([
    { id: 1, task_id: 4, tool: "mcp__memory__computer_click_at", input: JSON.stringify({ x: 10, y: 20, shotId: "v3" }), status: "done", output: "Charles a refusé : je n'ai pas cliqué.", created_at: "2026-11-25 10:00:00" },
  ]);
  assert.deepEqual(entries[0], { kind: "action", at: "2026-11-25 10:00:00", taskId: 4, action: "Clique à une position (vision)", target: "(10, 20)", finalUrl: null, status: "refuse", label: "Refusé" });
});
