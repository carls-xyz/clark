import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { paths } from "../config.ts";

/** Un élément de la page, tel que Clark le voit et tel que les règles d'accord le jugent. */
export type ElementInfo = {
  ref: string;
  tag: string;
  role: string;
  name: string;
  type: string;
  href: string | null;
  /** Bouton qui envoie un formulaire (submit). */
  submits: boolean;
  /** Champ de mot de passe, de carte ou de code à usage unique : Clark n'y tape jamais. */
  secret: boolean;
  value?: string;
  disabled: boolean;
};

export type PageView = { url: string; title: string; text: string; elements: ElementInfo[] };

/** Ce que Clark sait faire dans un navigateur : remplaçable par un faux dans la démo et les tests. */
export interface BrowserDriver {
  available(): boolean;
  running(): boolean;
  visible(): boolean;
  /** Lance le navigateur (ou le relance pour changer d'affichage, sur la même page). */
  ensure(visible: boolean): Promise<void>;
  open(url: string): Promise<void>;
  view(): Promise<PageView>;
  click(ref: string): Promise<void>;
  fill(ref: string, text: string): Promise<void>;
  press(ref: string, key: string): Promise<void>;
  select(ref: string, value: string): Promise<void>;
  scroll(direction: "down" | "up"): Promise<void>;
  back(): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
  /** Vue distante (toi, pas l'agent) : un clic à une position de la page, une saisie, une touche. */
  clickAt?(x: number, y: number): Promise<void>;
  typeText?(text: string): Promise<void>;
  pressKey?(key: string): Promise<void>;
  /** Taille de la page (la vue distante depuis un téléphone passe en largeur de téléphone). */
  resize?(width: number, height: number): Promise<void>;
}

/** Taille de la page du navigateur de Clark : les clics de la vue distante s'y rapportent. */
export const VIEWPORT = { width: 1280, height: 800 } as const;

export const browserProfileDir = () => process.env.CLARK_BROWSER_PROFILE?.trim() || resolve(paths.root, "data/browser-profile");
/** Chrome : CLARK_BROWSER_EXECUTABLE, sinon l'emplacement habituel (Mac, ou Linux : Chrome puis Chromium). */
const CHROMES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
export const chromePath = () => process.env.CLARK_BROWSER_EXECUTABLE?.trim() || CHROMES.find((p) => existsSync(p)) || CHROMES[0];

/**
 * Relevé de la page, exécuté dans le navigateur : les éléments visibles avec lesquels on peut
 * agir reçoivent une référence (data-clark-ref), et le texte visible est relevé.
 */
const SNAPSHOT = `(() => {
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [contenteditable=""], [contenteditable=true]';
  document.querySelectorAll('[data-clark-ref]').forEach((e) => e.removeAttribute('data-clark-ref'));
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
    if (n >= 150) break;
    const ref = 'e' + ++n;
    el.setAttribute('data-clark-ref', ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const labels = el.labels ? [...el.labels].map((l) => l.innerText).join(' ') : '';
    const own = tag === 'input' ? (['submit', 'button', 'reset'].includes(type) ? el.value : '') : tag === 'select' || tag === 'textarea' ? '' : el.innerText;
    const name = (el.getAttribute('aria-label') || labels || own || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 120);
    const form = el.form || el.closest('form');
    const submits = (tag === 'button' && (type === '' || type === 'submit') && !!form) || (tag === 'input' && (type === 'submit' || type === 'image'));
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const secret = type === 'password' || /cc-|password|one-time-code/.test(ac);
    const value = (tag === 'input' || tag === 'textarea') && !secret && !['submit', 'button', 'reset'].includes(type) ? String(el.value || '').slice(0, 80) : undefined;
    out.push({ ref, tag, role: el.getAttribute('role') || '', name, type, href: tag === 'a' ? el.href : null, submits, secret, value, disabled: !!el.disabled });
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000);
  return { url: location.href, title: document.title, text, elements: out };
})()`;

/** Le vrai navigateur : ton Google Chrome, avec un profil à part, celui de Clark (data/browser-profile). */
export class ChromeDriver implements BrowserDriver {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private shown = false;

  available() {
    return existsSync(chromePath());
  }
  running() {
    return this.context !== null;
  }
  visible() {
    return this.running() && this.shown;
  }

  async ensure(visible: boolean) {
    if (this.context && this.shown === visible) return;
    const url = this.page && !this.page.isClosed() ? this.page.url() : null;
    await this.close();
    const { chromium } = await import("playwright-core");
    const dir = browserProfileDir();
    mkdirSync(dir, { recursive: true });
    this.context = await chromium.launchPersistentContext(dir, {
      executablePath: chromePath(),
      headless: !visible,
      viewport: { ...VIEWPORT },
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
      acceptDownloads: false,
    });
    this.shown = visible;
    this.context.on("close", () => {
      this.context = null;
      this.page = null;
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    // Un lien qui ouvre un nouvel onglet : on suit le nouvel onglet.
    this.context.on("page", (p) => (this.page = p));
    if (url && url !== "about:blank") await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  }

  private current(): Page {
    if (!this.page || this.page.isClosed()) {
      const pages = this.context?.pages() ?? [];
      this.page = pages.at(-1) ?? null;
    }
    if (!this.page) throw new Error("Le navigateur n'a pas de page ouverte.");
    return this.page;
  }

  private async settle() {
    const page = this.current();
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(600);
  }

  private el(ref: string) {
    return this.current().locator(`[data-clark-ref="${ref.replace(/[^\w-]/g, "")}"]`).first();
  }

  async open(url: string) {
    await this.current().goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.settle();
  }
  async view(): Promise<PageView> {
    return (await this.current().evaluate(SNAPSHOT)) as PageView;
  }
  async click(ref: string) {
    await this.el(ref).click({ timeout: 10_000 });
    await this.settle();
  }
  async fill(ref: string, text: string) {
    await this.el(ref).fill(text, { timeout: 10_000 });
  }
  async press(ref: string, key: string) {
    await this.el(ref).press(key, { timeout: 10_000 });
    await this.settle();
  }
  async select(ref: string, value: string) {
    await this.el(ref).selectOption({ label: value }, { timeout: 10_000 }).catch(() => this.el(ref).selectOption(value, { timeout: 10_000 }));
    await this.settle();
  }
  async scroll(direction: "down" | "up") {
    await this.current().mouse.wheel(0, direction === "down" ? 700 : -700);
    await this.current().waitForTimeout(400);
  }
  async back() {
    await this.current().goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    await this.settle();
  }
  async screenshot() {
    return this.current().screenshot({ type: "jpeg", quality: 70 });
  }
  async clickAt(x: number, y: number) {
    await this.current().mouse.click(Math.round(x), Math.round(y));
    await this.settle();
  }
  async typeText(text: string) {
    await this.current().keyboard.type(text, { delay: 20 });
  }
  async resize(width: number, height: number) {
    await this.current().setViewportSize({ width, height });
  }
  async pressKey(key: string) {
    await this.current().keyboard.press(key);
    await this.settle();
  }
  async close() {
    const ctx = this.context;
    this.context = null;
    this.page = null;
    await ctx?.close().catch(() => {});
  }
}
