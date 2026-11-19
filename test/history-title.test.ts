import assert from "node:assert/strict";
import { test } from "node:test";
import { historyTitle, matchesQuery, NEW_CONVERSATION_NOTE, originOf, sinceNewConversation } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";

test("historique : un titre lisible, jamais la consigne interne de l'agent", () => {
  const store = new Store(":memory:");
  const pid = store.dev.addProject({ name: "site", path: "/tmp/site", baseBranch: "main" });
  const id = store.dev.create({ projectId: pid, title: "Fonce le texte secondaire", instruction: "x", engine: null, branch: "b", worktree: "/tmp/w" });
  const dev = (prompt: string) => historyTitle({ label: `dev:${id}`, prompt }, store);
  assert.equal(dev("[Tâche dev #1 — projet site] Tu travailles dans une copie isolée…"), "Première version · Fonce le texte secondaire");
  assert.equal(dev("Retouche demandée par Charles pour la tâche dev #1 : plus foncé"), "Retouche · Fonce le texte secondaire");
  assert.equal(dev("Relecture de Charles pour la tâche dev #1 : 2 commentaires"), "Commentaires de relecture · Fonce le texte secondaire");
  assert.equal(dev("Charles est revenu à l'état de ton tour 1"), "Reprise depuis un tour précédent · Fonce le texte secondaire");
  assert.equal(originOf({ label: `dev:${id}`, chat_id: 2000 + id }, store), "Dev · site");
  assert.equal(historyTitle({ label: "heartbeat", prompt: "[Tour de veille de Clark] Nous sommes le jeudi…" }), "Tour de veille");
  assert.equal(historyTitle({ label: "chat", prompt: "[Contexte]\nFais le point sur mes candidatures" }), "Fais le point sur mes candidatures");
  assert.equal(historyTitle({ label: "chat", prompt: "Bonjour" }), "Bonjour");
});

test("nouvelle conversation : l'écran ne montre que ce qui suit", () => {
  const m = (role: string, text: string) => ({ role, text });
  const list = [m("user", "avant"), m("system", NEW_CONVERSATION_NOTE), m("user", "après"), m("clark", "réponse")];
  assert.deepEqual(sinceNewConversation(list).map((x) => x.text), ["après", "réponse"]);
  assert.deepEqual(sinceNewConversation([m("user", "seul")]).map((x) => x.text), ["seul"]);
});

test("recherche : sans accents ni majuscules, chaque mot dans n'importe quel ordre, pluriel toléré", () => {
  const t = "Fonce le texte secondaire de style.css pour un meilleur contraste";
  assert.ok(matchesQuery(t, "contraste FONCE"));
  assert.ok(matchesQuery("Tâche dev · Première version", "tache premiere"));
  assert.ok(matchesQuery("Dépense du jour", "dépenses"));
  assert.ok(matchesQuery(t, "  texte   style.css "));
  assert.ok(!matchesQuery(t, "fonce titre"), "tous les mots doivent y être");
  assert.ok(matchesQuery(t, ""), "rien tapé : tout passe");
});
