import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserDriver, PageView } from "../src/browser/driver.ts";
import { BrowserService, REMOTE_IDLE_MS } from "../src/browser/service.ts";
import { loginShell } from "../src/core/platform.ts";
import { textCardHtml } from "../src/social/render.ts";
import { planRelocation } from "../scripts/relocate-projects.ts";

/** Faux navigateur : garde ce qu'on lui fait (clics, saisie, touches), sans rien lancer. */
class RemoteFake implements BrowserDriver {
  log: string[] = [];
  on = false;
  url = "about:blank";
  available() {
    return true;
  }
  running() {
    return this.on;
  }
  visible() {
    return false;
  }
  async ensure() {
    this.on = true;
  }
  async open(url: string) {
    this.url = url;
    this.log.push(`open ${url}`);
  }
  async view(): Promise<PageView> {
    return { url: this.url, title: "Connexion", text: "Identifiant, mot de passe", elements: [] };
  }
  async click() {}
  async fill() {}
  async press() {}
  async select() {}
  async scroll(d: "down" | "up") {
    this.log.push(`scroll ${d}`);
  }
  async back() {
    this.log.push("back");
  }
  async screenshot() {
    return Buffer.from("jpeg");
  }
  async close() {
    this.on = false;
  }
  async clickAt(x: number, y: number) {
    this.log.push(`click ${x},${y}`);
  }
  async typeText(t: string) {
    this.log.push(`type ${t}`);
  }
  async pressKey(k: string) {
    this.log.push(`key ${k}`);
  }
}

test("vue distante : tu te connectes, l'agent attend ; clics bornés à la page, touches choisies, fermée seule", async () => {
  const d = new RemoteFake();
  const svc = new BrowserService({ driver: d, approve: async () => true, taskAlive: () => true });
  await svc.remote({ action: "start", url: "https://x.com/login" });
  assert.ok(svc.state().remoteUntil! > Date.now());
  assert.match(await svc.act(1, "open", { url: "https://exemple.fr" }), /Charles utilise le navigateur/, "l'agent n'a pas la main");

  await svc.remote({ action: "click", x: 5000, y: -3 });
  await svc.remote({ action: "type", text: "mon-secret" });
  await svc.remote({ action: "key", key: "Enter" });
  await assert.rejects(svc.remote({ action: "key", key: "Meta+A" }), /Touche non prise en charge/);
  await assert.rejects(svc.remote({ action: "goto", url: "javascript:alert(1)" }), /Adresse invalide/);
  assert.deepEqual(d.log, ["open https://x.com/login", "click 1279,0", "type mon-secret", "key Enter"]);
  assert.ok(!JSON.stringify(svc.state()).includes("mon-secret"), "ce que tu tapes n'est pas gardé dans l'état");

  await svc.remote({ action: "stop" });
  assert.equal(svc.state().remoteUntil, null);
  await assert.rejects(svc.remote({ action: "type", text: "x" }), /fermée/);
  assert.doesNotMatch(await svc.act(1, "open", { url: "https://exemple.fr" }), /Charles utilise/);

  // Sans action pendant 10 min : fermée toute seule.
  await svc.remote({ action: "start" });
  const realNow = Date.now;
  Date.now = () => realNow() + REMOTE_IDLE_MS + 1000;
  try {
    assert.equal(svc.state().remoteUntil, null);
  } finally {
    Date.now = realNow;
  }
  await svc.remote({ action: "stop" });
});

test("shell des commandes : CLARK_SHELL, sinon zsh s'il est là, sinon bash", () => {
  const before = process.env.CLARK_SHELL;
  delete process.env.CLARK_SHELL;
  try {
    assert.equal(loginShell(() => true), "/bin/zsh");
    assert.equal(loginShell(() => false), "/bin/bash");
    process.env.CLARK_SHELL = "/usr/bin/fish";
    assert.equal(loginShell(() => true), "/usr/bin/fish");
  } finally {
    if (before === undefined) delete process.env.CLARK_SHELL;
    else process.env.CLARK_SHELL = before;
  }
});

test("migration : Clark devient ce dossier, les autres projets vont dans ~/Developer (re-clonés s'il le faut)", () => {
  const tsv = [
    "clark_root\t/Users/charles/Developer/clark",
    "4\tclark\t/Users/charles/Developer/clark\tgit@github.com:carls-xyz/clark.git",
    "1\tportfolio\t/Users/charles/Desktop/cours/projets/portfolio\thttps://github.com/carls-xyz/portfolio.git",
    "7\tbrouillon perso\t/Users/charles/tmp/brouillon\t",
    "9\tdeja\t/Users/charles/Developer/deja\thttps://github.com/x/deja.git",
  ].join("\n");
  const plan = planRelocation(tsv, "/home/charles/clark", "/home/charles/Developer", (p) => p.endsWith("/deja"));
  assert.deepEqual(
    plan.map((r) => [r.name, r.to, r.action]),
    [
      ["clark", "/home/charles/clark", "self"],
      ["portfolio", "/home/charles/Developer/portfolio", "clone"],
      ["brouillon perso", "/home/charles/Developer/brouillon-perso", "missing"],
      ["deja", "/home/charles/Developer/deja", "kept"],
    ],
  );
});

test("texte d'écran hors Mac : page HTML échappée, à la taille de la vidéo", () => {
  const html = textCardHtml("<b>Promo</b> & co", 1080, 1920, 64);
  assert.match(html, /&lt;b&gt;Promo&lt;\/b&gt; &amp; co/);
  assert.match(html, /width:1080px;height:1920px/);
  assert.match(html, /font:700 64px/);
});
