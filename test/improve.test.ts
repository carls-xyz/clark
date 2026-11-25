import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import {
  detect,
  improveSources,
  ImproveStore,
  isSnoozed,
  recordSignatures,
  refreshFiches,
  type ImproveSources,
  type SignatureHistory,
} from "../src/core/improve.ts";
import { errorSignature } from "../src/core/health.ts";
import { redactSecrets } from "../src/core/redact.ts";

/** La signature telle que la source d'erreurs la calcule (ligne sans « [clark] », expurgée). */
const sigOf = (message: string) => errorSignature(redactSecrets(message).slice(0, 220));

const NOW = new Date("2026-11-25T10:00:00Z"); // Paris : 2026-11-25
const DAYS = ["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"];

/** Un instant UTC au format SQLite, pour peupler `updated_at`. */
const sqlUtc = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace("T", " ");

test("récurrence : 5 occurrences réparties sur au moins 2 jours ; les cas juste en dessous rejetés", () => {
  const histories: SignatureHistory[] = [
    { signature: "a", source: "error", example: "erreur a", days: [{ day: "2026-11-24", count: 2 }, { day: "2026-11-25", count: 3 }] }, // 5 / 2 jours : accepté
    { signature: "b", source: "task", example: "erreur b", days: [{ day: "2026-11-24", count: 2 }, { day: "2026-11-25", count: 2 }] }, // 4 : rejeté
    { signature: "c", source: "alert", example: "erreur c", days: [{ day: "2026-11-25", count: 5 }] }, // 1 jour : rejeté
    { signature: "d", source: "error", example: "erreur d", days: [{ day: "2026-11-10", count: 20 }] }, // hors fenêtre : ignoré
  ];
  const got = detect(histories, { now: NOW });
  assert.deepEqual(got.map((d) => d.signature), ["a"]);
  assert.equal(got[0].before.total, 5);
});

test("persistance par jour : MAX des relevés d'un même jour, jamais l'addition", () => {
  const store = new ImproveStore(new DatabaseSync(":memory:"));
  store.record("2026-11-25", "error", "x", 2, "erreur x");
  store.record("2026-11-25", "error", "x", 1, "erreur x"); // plus petit : ignoré
  assert.equal(store.dailyCounts("error", "x", 7, NOW).total, 2, "deux relevés du même jour : MAX, pas 3");
  store.record("2026-11-25", "error", "x", 5, "erreur x"); // plus grand : retenu
  assert.equal(store.dailyCounts("error", "x", 7, NOW).total, 5);
  store.record("2026-11-24", "error", "x", 3, "erreur x"); // autre jour : s'ajoute au total
  assert.equal(store.dailyCounts("error", "x", 7, NOW).total, 8);
});

test("mesure « avant » : un compte par jour sur 7 jours", () => {
  const store = new ImproveStore(new DatabaseSync(":memory:"));
  store.record("2026-11-24", "error", "y", 2, "erreur y");
  store.record("2026-11-25", "error", "y", 4, "erreur y");
  const before = store.dailyCounts("error", "y", 7, NOW);
  assert.equal(before.days.length, 7);
  assert.deepEqual(before.days.map((d) => d.day), DAYS);
  assert.equal(before.total, 6);
  assert.equal(before.days.find((d) => d.day === "2026-11-24")?.count, 2);
});

test("source dans l'identité : même texte, erreur et alerte restent distinctes", () => {
  const store = new ImproveStore(new DatabaseSync(":memory:"));
  store.record("2026-11-25", "error", "sig", 3, "même texte");
  store.record("2026-11-25", "alert", "sig", 7, "même texte");
  assert.equal(store.dailyCounts("error", "sig", 7, NOW).total, 3, "l'alerte n'écrase pas l'erreur");
  assert.equal(store.dailyCounts("alert", "sig", 7, NOW).total, 7);
});

test("exemples expurgés et titre maîtrisé : aucun jeton stocké", () => {
  const store = new ImproveStore(new DatabaseSync(":memory:"));
  const leak = "échec push ghp_abcdefghijklmnopqrstuvwxyz12 vers le dépôt";
  store.record("2026-11-24", "error", "z", 3, leak);
  store.record("2026-11-25", "error", "z", 2, leak);
  const raw = store.histories("2026-11-19");
  assert.doesNotMatch(raw[0].example, /ghp_abc/, "le relevé stocké est expurgé");

  const applied = refreshFiches(store, NOW);
  assert.deepEqual(applied.map((d) => d.signature), ["z"]);
  const fiche = store.fiche("error", "z");
  assert.ok(fiche);
  assert.equal(fiche.status, "detected");
  assert.equal(fiche.title, "Erreur récurrente dans le journal", "titre tiré d'un libellé maîtrisé, pas du texte de l'erreur");
  assert.doesNotMatch(fiche.examples, /ghp_abc/, "les exemples de la fiche sont expurgés");
  assert.doesNotMatch(fiche.title, /ghp_abc/);
});

test("une fiche 'dismissed', 'done' ou 'snoozed' non expiré n'est pas recréée", () => {
  const store = new ImproveStore(new DatabaseSync(":memory:"));
  for (const sig of ["dis", "don", "sno"]) {
    store.record("2026-11-24", "error", sig, 3, `erreur ${sig}`);
    store.record("2026-11-25", "error", sig, 3, `erreur ${sig}`);
  }
  refreshFiches(store, NOW);
  store.setStatus("error", "dis", "dismissed", NOW);
  store.setStatus("error", "don", "done", NOW);
  store.setStatus("error", "sno", "snoozed", NOW);
  assert.equal(isSnoozed(store.fiche("error", "sno")!, NOW), true);

  const applied = refreshFiches(store, NOW);
  assert.equal(applied.length, 0, "aucune n'est ramenée à 'detected'");
  assert.equal(store.fiche("error", "dis")!.status, "dismissed");
  assert.equal(store.fiche("error", "don")!.status, "done");
  assert.equal(store.fiche("error", "sno")!.status, "snoozed");

  assert.equal(isSnoozed(store.fiche("error", "sno")!, new Date("2026-11-29T10:00:00Z")), false, "sommeil écoulé après 3 jours");
});

test("sources réelles : les tâches sont datées par updated_at, pas par le jour courant", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, label TEXT, status TEXT, updated_at TEXT)");
  const ins = db.prepare("INSERT INTO tasks (label, status, updated_at) VALUES (?, ?, ?)");
  // 3 échecs lundi 23, 2 échecs mardi 24, tous du même label : 5 sur 2 jours.
  for (let i = 0; i < 3; i++) ins.run("brief", "failed", sqlUtc("2026-11-23T09:00:00Z"));
  for (let i = 0; i < 2; i++) ins.run("brief", "failed", sqlUtc("2026-11-24T09:00:00Z"));
  const store = new ImproveStore(db);
  const sources = improveSources({ db, logFile: "/dev/null", alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => [] });

  // Même si on relève plusieurs fois le 25, les occurrences restent sur le 23 et le 24.
  recordSignatures(store, sources, NOW);
  recordSignatures(store, sources, NOW);
  const applied = refreshFiches(store, NOW);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].source, "task");
  assert.equal(applied[0].before.total, 5, "5 échecs réels, pas un cumul recompté chaque jour");
  assert.equal(applied[0].before.days.find((d) => d.day === "2026-11-25")?.count, 0, "rien attribué au jour courant");
});

test("source réelle d'erreurs : passage à minuit sans nouvel événement n'invente rien", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-improve-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "clark.log");
  // Un démarrage, puis 5 occurrences de la même erreur (déjà présentes « hier »). Lignes terminées.
  writeFileSync(logFile, ["[clark] démarré — moteur claude", ...Array(5).fill("[clark] échec de la tâche 12 : timeout"), ""].join("\n"));

  const db = new DatabaseSync(":memory:");
  const store = new ImproveStore(db);
  const sources = improveSources({ db, logFile, alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => [] });

  const day1 = new Date("2026-11-24T10:00:00Z");
  recordSignatures(store, sources, day1); // les 5 erreurs attribuées au 24
  recordSignatures(store, sources, day1); // même relevé : rien de plus (delta nul)

  const day2 = new Date("2026-11-25T10:00:00Z"); // minuit franchi, aucune nouvelle ligne
  recordSignatures(store, sources, day2);

  const hist = store.histories("2026-11-18");
  assert.equal(hist.length, 1);
  const total = hist[0].days.reduce((s, d) => s + d.count, 0);
  assert.equal(total, 5, "le passage à minuit ne réattribue pas les erreurs d'hier");
  const d25 = store.dailyCounts("error", hist[0].signature, 7, day2).days.find((d) => d.day === "2026-11-25");
  assert.equal(d25?.count, 0, "rien le 25 sans nouvelle erreur");
  // Pas récurrent (1 seul jour) : aucune fiche.
  assert.equal(refreshFiches(store, day2).length, 0);
});

test("source d'erreurs : une signature hors du top 8 garde sa base ; de retour après minuit, rien n'est réinventé", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-improve-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "clark.log");
  // 8 signatures bruyantes (6 occurrences chacune) + une cible « omega » à 5 : la cible est au 9e rang.
  const noisy = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  const lines = ["[clark] démarré — moteur claude"];
  for (const w of noisy) for (let i = 0; i < 6; i++) lines.push(`[clark] erreur réseau ${w}`);
  for (let i = 0; i < 5; i++) lines.push("[clark] erreur cible omega");
  lines.push(""); // ligne finale terminée
  writeFileSync(logFile, lines.join("\n"));

  const db = new DatabaseSync(":memory:");
  const store = new ImproveStore(db);
  const sources = improveSources({ db, logFile, alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => [] });

  const day1 = new Date("2026-11-24T10:00:00Z");
  recordSignatures(store, sources, day1); // la cible (9e) est bien suivie : 5 attribuées au 24
  const day2 = new Date("2026-11-25T10:00:00Z"); // minuit franchi, aucune nouvelle ligne
  recordSignatures(store, sources, day2);

  const omega = store.histories("2026-11-18").find((h) => h.signature === sigOf("erreur cible omega"));
  assert.ok(omega, "la cible hors top 8 est quand même suivie");
  const total = omega!.days.reduce((s, d) => s + d.count, 0);
  assert.equal(total, 5, "aucun cumul fantôme réattribué au nouveau jour");
  const counts = store.dailyCounts("error", omega!.signature, 7, day2);
  assert.equal(counts.days.find((d) => d.day === "2026-11-24")?.count, 5);
  assert.equal(counts.days.find((d) => d.day === "2026-11-25")?.count, 0, "rien le 25 sans nouvelle occurrence");
});

test("source d'agents silencieux : des épisodes successifs, jamais simultanés, comptent chacun", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ImproveStore(db);
  let now = new Date("2026-11-24T10:00:00Z");
  let stalledNow: { taskId: number; since: number }[] = [];
  const sources = improveSources({ db, logFile: "/dev/null", alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => stalledNow });

  const d24 = new Date("2026-11-24T09:00:00Z").getTime();
  const d25 = new Date("2026-11-25T09:00:00Z").getTime();
  // Lundi : trois épisodes distincts observés à trois ticks, jamais ensemble.
  for (const taskId of [1, 2, 3]) {
    stalledNow = [{ taskId, since: d24 }];
    recordSignatures(store, sources, now);
  }
  // Mardi : deux autres épisodes distincts, également successifs.
  now = new Date("2026-11-25T10:00:00Z");
  for (const taskId of [4, 5]) {
    stalledNow = [{ taskId, since: d25 }];
    recordSignatures(store, sources, now);
  }

  const applied = refreshFiches(store, now);
  assert.equal(applied.length, 1, "5 épisodes distincts sur 2 jours : une fiche");
  assert.equal(applied[0].source, "silent");
  assert.equal(applied[0].before.total, 5, "chaque épisode compte, pas seulement le pic simultané (1)");
  assert.equal(applied[0].before.days.find((d) => d.day === "2026-11-24")?.count, 3);
  assert.equal(applied[0].before.days.find((d) => d.day === "2026-11-25")?.count, 2);
});

test("fenêtre par position : des lignes ordinaires après minuit ne rouvrent pas d'anciennes erreurs", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-improve-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "clark.log");
  writeFileSync(logFile, ["[clark] démarré — moteur claude", ...Array(5).fill("[clark] échec de la tâche 12 : timeout"), ""].join("\n"));

  const db = new DatabaseSync(":memory:");
  const store = new ImproveStore(db);
  const sources = improveSources({ db, logFile, alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => [] });

  const day1 = new Date("2026-11-24T10:00:00Z");
  recordSignatures(store, sources, day1); // les 5 erreurs lues et attribuées au 24

  // Après minuit : plus de 400 ko de lignes ordinaires, qui repousseraient les erreurs hors d'un tail.
  const filler = Array(600).fill("[clark] tout va bien ".padEnd(1000, "x")).join("\n") + "\n";
  appendFileSync(logFile, filler);
  const day2 = new Date("2026-11-25T10:00:00Z");
  recordSignatures(store, sources, day2);

  const err = store.histories("2026-11-18").find((h) => /timeout/.test(h.example));
  assert.ok(err, "l'erreur du 24 reste connue");
  assert.equal(err!.days.reduce((s, d) => s + d.count, 0), 5, "aucune occurrence recomptée : la baisse du total n'est pas un redémarrage");
  assert.equal(store.dailyCounts("error", err!.signature, 7, day2).days.find((d) => d.day === "2026-11-25")?.count, 0, "rien le 25");
});

test("exemples gardés : une affectation NOM=valeur de format inconnu n'est persistée nulle part", () => {
  const store = new ImproveStore(new DatabaseSync(":memory:"));
  const leak = "[clark] échec : CLARK_FOO=valeur_inconnue_xyz refusée par le service";
  store.record("2026-11-24", "error", "k", 3, leak);
  store.record("2026-11-25", "error", "k", 2, leak);

  const raw = store.histories("2026-11-19")[0];
  assert.doesNotMatch(raw.example, /CLARK_FOO=valeur_inconnue_xyz/, "le relevé stocké est masqué");
  assert.doesNotMatch(raw.example, /valeur_inconnue_xyz/);

  const applied = refreshFiches(store, NOW);
  assert.equal(applied.length, 1);
  const fiche = store.fiche("error", "k")!;
  for (const field of [fiche.title, fiche.examples, fiche.before]) {
    assert.doesNotMatch(field, /CLARK_FOO=valeur_inconnue_xyz/, "aucun champ persisté ne contient la valeur inconnue");
    assert.doesNotMatch(field, /valeur_inconnue_xyz/);
  }
});

test("exemples gardés : chaque exemple est borné à 160 caractères", () => {
  const store = new ImproveStore(new DatabaseSync(":memory:"));
  store.record("2026-11-25", "error", "long", 1, "[clark] erreur " + "mot ".repeat(100));
  assert.ok(store.histories("2026-11-19")[0].example.length <= 160);
});

test("exemples d'erreur : ni affectation avec espaces ni extrait de page dans les deux tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-improve-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "clark.log");
  const line = "[clark] échec : API_KEY = demo-123 ; page: Bonjour ceci est le contenu secret de la page\n";
  writeFileSync(logFile, "[clark] démarré — moteur claude\n" + line.repeat(3)); // 3 lundi
  const db = new DatabaseSync(":memory:");
  const store = new ImproveStore(db);
  const sources = improveSources({ db, logFile, alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => [] });

  recordSignatures(store, sources, new Date("2026-11-24T10:00:00Z"));
  appendFileSync(logFile, line.repeat(2)); // 2 mardi → récurrent sur 2 jours
  const now = new Date("2026-11-25T10:00:00Z");
  recordSignatures(store, sources, now);

  const forbidden = [/API_KEY/, /demo-123/, /Bonjour/, /contenu secret/, /de la page/];
  const hist = store.histories("2026-11-18");
  assert.equal(hist.length, 1);
  for (const re of forbidden) assert.doesNotMatch(hist[0].example, re, `improve_signatures.example laisse passer ${re}`);

  const applied = refreshFiches(store, now);
  assert.equal(applied.length, 1);
  const fiche = store.fiche("error", hist[0].signature)!;
  for (const re of forbidden) {
    assert.doesNotMatch(fiche.examples, re, `improvements.examples laisse passer ${re}`);
    assert.doesNotMatch(fiche.title, re);
  }
});

test("rotation par remplacement : un nouveau journal de taille égale ou supérieure n'est pas sauté", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-improve-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "clark.log");
  writeFileSync(logFile, "[clark] démarré — moteur claude\n" + "[clark] erreur un\n".repeat(3));
  const db = new DatabaseSync(":memory:");
  const store = new ImproveStore(db);
  const sources = improveSources({ db, logFile, alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => [] });

  const now = new Date("2026-11-24T10:00:00Z");
  recordSignatures(store, sources, now); // lit « erreur un » ×3

  // Remplacement entre deux relevés : autre fichier (inode différent), plus gros, erreurs dès le début.
  rmSync(logFile);
  writeFileSync(logFile, "[clark] démarré — moteur claude\n" + "[clark] erreur deux remplacement\n".repeat(4));
  recordSignatures(store, sources, now);

  const deux = store.histories("2026-11-18").find((h) => h.signature === sigOf("erreur deux remplacement"));
  assert.ok(deux, "le nouveau journal est relu depuis le début");
  assert.equal(deux!.days.find((d) => d.day === "2026-11-24")?.count, 4, "les erreurs du remplaçant ne sont pas sautées");
});

test("reprise par octets : une limite initiale au milieu d'un caractère multioctet ne décale pas le curseur", () => {
  const dir = mkdtempSync(join(tmpdir(), "clark-improve-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "clark.log");
  // « é » (2 octets) au tout début ; on dimensionne pour que l'offset initial (taille − 400 000) tombe
  // sur son 2e octet (continuation) — soit au milieu du caractère.
  const tailLine = "\n[clark] erreur multibyte unique\n";
  const padLen = 400_000 - 1 - tailLine.length;
  writeFileSync(logFile, "é" + "y".repeat(padLen) + tailLine);

  const db = new DatabaseSync(":memory:");
  const store = new ImproveStore(db);
  const sources = improveSources({ db, logFile, alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => [] });

  const now = new Date("2026-11-24T10:00:00Z");
  recordSignatures(store, sources, now); // lecture initiale coupée au milieu du « é »
  appendFileSync(logFile, "[clark] erreur ajoutée bien réelle\n");
  recordSignatures(store, sources, now);

  const added = store.histories("2026-11-18").find((h) => h.signature === sigOf("erreur ajoutée bien réelle"));
  assert.ok(added, "la ligne ajoutée après la coupure multioctet est bien lue");
  assert.equal(added!.days.find((d) => d.day === "2026-11-24")?.count, 1);
});

test("exemples de tâches : le label (texte libre) n'est jamais persisté, seulement une catégorie", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, label TEXT, status TEXT, updated_at TEXT)");
  const ins = db.prepare("INSERT INTO tasks (label, status, updated_at) VALUES (?, ?, ?)");
  const secretLabel = "sync token sk-demo-9 vers Bonjour contenu de page";
  for (let i = 0; i < 3; i++) ins.run(secretLabel, "failed", sqlUtc("2026-11-23T09:00:00Z"));
  for (let i = 0; i < 2; i++) ins.run(secretLabel, "failed", sqlUtc("2026-11-24T09:00:00Z"));
  const store = new ImproveStore(db);
  const sources = improveSources({ db, logFile: "/dev/null", alerts: () => ({ seen: {}, active: {}, gone: {}, history: [] }), stalled: () => [] });

  recordSignatures(store, sources, NOW);
  const forbidden = [/sk-demo-9/, /token/, /Bonjour/, /contenu de page/];
  const hist = store.histories("2026-11-19");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].source, "task");
  for (const re of forbidden) assert.doesNotMatch(hist[0].example, re, `improve_signatures.example (tâche) laisse passer ${re}`);

  const applied = refreshFiches(store, NOW);
  assert.equal(applied.length, 1);
  const fiche = store.fiche("task", hist[0].signature)!;
  for (const re of forbidden) {
    assert.doesNotMatch(fiche.examples, re, `improvements.examples (tâche) laisse passer ${re}`);
    assert.doesNotMatch(fiche.title, re);
  }
});

test("exemples d'alertes : le texte libre n'est jamais persisté, seulement une catégorie", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ImproveStore(db);
  const secretText = "Quota Claude atteint — jeton sk-demo-7 Bonjour contenu de page";
  const mk = (iso: string) => ({ at: new Date(iso).getTime(), kind: "alerte" as const, text: secretText });
  const history = [mk("2026-11-23T09:00:00Z"), mk("2026-11-23T10:00:00Z"), mk("2026-11-23T11:00:00Z"), mk("2026-11-24T09:00:00Z"), mk("2026-11-24T10:00:00Z")];
  const sources = improveSources({ db, logFile: "/dev/null", alerts: () => ({ seen: {}, active: {}, gone: {}, history }), stalled: () => [] });

  recordSignatures(store, sources, NOW);
  const forbidden = [/sk-demo-7/, /jeton/, /Bonjour/, /contenu de page/];
  const hist = store.histories("2026-11-19");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].source, "alert");
  assert.match(hist[0].example, /quota/, "l'exemple garde une catégorie lisible");
  for (const re of forbidden) assert.doesNotMatch(hist[0].example, re, `improve_signatures.example (alerte) laisse passer ${re}`);

  const applied = refreshFiches(store, NOW);
  assert.equal(applied.length, 1);
  const fiche = store.fiche("alert", hist[0].signature)!;
  for (const re of forbidden) {
    assert.doesNotMatch(fiche.examples, re, `improvements.examples (alerte) laisse passer ${re}`);
    assert.doesNotMatch(fiche.title, re);
  }
});

test("recordSignatures ignore les comptes nuls", () => {
  const store = new ImproveStore(new DatabaseSync(":memory:"));
  const sources: ImproveSources = {
    errors: () => [{ day: "2026-11-25", source: "error", signature: "e1", count: 3, example: "err" }],
    tasks: () => [],
    alerts: () => [],
    silent: () => [{ day: "2026-11-25", source: "silent", signature: "s1", count: 0, example: "silent" }],
  };
  recordSignatures(store, sources, NOW);
  assert.equal(store.dailyCounts("error", "e1", 7, NOW).total, 3);
  assert.equal(store.dailyCounts("silent", "s1", 7, NOW).total, 0);
});
