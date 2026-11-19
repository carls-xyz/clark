import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { Store, toFtsQuery } from "../src/memory/store.ts";
import { isInside } from "../src/policy/permissions.ts";
import { splitMessage } from "../src/gateway/telegram.ts";

test("retrouve un souvenir sans tenir compte des accents ni de la casse", () => {
  const s = new Store(":memory:");
  s.remember({ kind: "event", content: "Partiel de réseaux à l'IIM le 2026-12-03", tags: ["école"] });
  s.remember({ kind: "preference", content: "Charles préfère les réponses courtes" });
  const hits = s.recall("RESEAUX partiel");
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /réseaux/);
});

test("un doublon exact renforce le souvenir au lieu d'en créer un second", () => {
  const s = new Store(":memory:");
  const a = s.remember({ kind: "fact", content: "Le Mac a 8 Go de RAM", importance: 2 });
  const b = s.remember({ kind: "fact", content: "le mac a 8 go de ram" });
  assert.equal(a, b);
  assert.equal(s.count(), 1);
  assert.equal(s.top(1)[0].importance, 3);
});

test("forget archive et update réindexe", () => {
  const s = new Store(":memory:");
  const id = s.remember({ kind: "project", content: "Boutique Shopify : coussin de grossesse" });
  assert.ok(s.update(id, "Boutique Shopify : coussin d'allaitement"));
  assert.equal(s.recall("grossesse").length, 0);
  assert.equal(s.recall("allaitement").length, 1);
  assert.ok(s.forget(id));
  assert.equal(s.recall("allaitement").length, 0);
  assert.equal(s.count(), 0);
});

test("la requête FTS neutralise la syntaxe spéciale", () => {
  assert.equal(toFtsQuery('NEAR( "x" OR -drop'), '"near"* OR "drop"*');
  assert.equal(toFtsQuery("a b"), "");
  const s = new Store(":memory:");
  assert.doesNotThrow(() => s.recall('"; DROP TABLE memories; --'));
});

test("budget du jour et tâche planifiée", () => {
  const s = new Store(":memory:");
  s.addSpend(0.4, "chat");
  s.addSpend(0.1, "brief");
  assert.ok(Math.abs(s.spentToday() - 0.5) < 1e-9);
  assert.ok(s.ranToday("brief"));
  assert.ok(!s.ranToday("heartbeat"));
});

test("isInside refuse les sorties du dossier", () => {
  const root = resolve("/tmp/clark/workspace");
  assert.ok(isInside("/tmp/clark/workspace/notes.md", [root]));
  assert.ok(!isInside("/tmp/clark/workspace/../.env", [root]));
  assert.ok(!isInside("/tmp/clark/workspace-evil/x", [root]));
});

test("splitMessage respecte la limite Telegram", () => {
  const long = Array.from({ length: 300 }, (_, i) => `ligne ${i} `.repeat(5)).join("\n");
  const parts = splitMessage(long, 1000);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join("\n").replace(/\n/g, ""), long.replace(/\n/g, ""));
});
