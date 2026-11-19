import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { paths } from "../config.ts";
import type { Hub } from "../core/hub.ts";

/**
 * Mode design : l'aperçu d'une copie (tâche dev), sur un port à part (CLARK_PREVIEW_PORT, 4320
 * par défaut). Une autre origine que l'interface : le code du site, écrit par un agent, ne peut
 * rien demander à Clark (les écritures exigent l'origine de l'interface).
 * - Sans réglage : les fichiers de la copie (index.html, ou la page choisie).
 * - Avec une commande ($PORT) : le serveur de dev du projet, lancé dans la copie, relayé ici.
 * Un petit script est ajouté aux pages HTML : il permet de choisir un élément, et envoie son
 * HTML et ses styles calculés à l'interface (et à elle seule).
 */

export type PreviewState = {
  taskId: number;
  kind: "static" | "server";
  status: "starting" | "ready" | "failed";
  url: string;
  origin: string;
  error: string | null;
  log: string;
};

/** Capture d'un élément de l'aperçu (Chrome sans fenêtre) ; remplaçable dans la démo et les tests. */
export type Shooter = (url: string, selector: string, width: number) => Promise<Buffer>;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const PICKER = resolve(import.meta.dirname, "../web/preview-pick.js");
export const designDir = (taskId: number) => resolve(process.env.CLARK_DESIGN_DIR?.trim() || resolve(paths.root, "data/design"), String(taskId));

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

const answers = (port: number) =>
  new Promise<boolean>((ok) => {
    const r = request({ host: "127.0.0.1", port, path: "/", method: "HEAD", timeout: 1500 }, (res) => {
      res.resume();
      ok(true);
    });
    r.on("error", () => ok(false));
    r.on("timeout", () => {
      r.destroy();
      ok(false);
    });
    r.end();
  });

/** Chrome sans fenêtre, un onglet par capture : rien de partagé avec le navigateur de Clark. */
export const chromeShooter: Shooter = async (url, selector, width) => {
  const { chromium } = await import("playwright-core");
  const exe = process.env.CLARK_BROWSER_EXECUTABLE?.trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(exe)) throw new Error("Google Chrome est introuvable : pas de capture.");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    const el = page.locator(selector).first();
    await el.waitFor({ state: "visible", timeout: 10_000 });
    return await el.screenshot({ type: "jpeg", quality: 80, timeout: 15_000 });
  } finally {
    await browser.close().catch(() => {});
  }
};

let current: PreviewService | null = null;
/** Une tâche acceptée ou jetée n'a plus de copie : son aperçu se ferme. */
export const closePreviewFor = (taskId: number) => current?.close(taskId);

export class PreviewService {
  private readonly hub: Hub;
  private readonly wantedPort: number;
  private readonly webOrigins: string[];
  private readonly shooter: Shooter;
  private server: Server | null = null;
  private port = 0;
  private active: (PreviewState & { root: string; target: number | null; child: ChildProcess | null }) | null = null;

  constructor(hub: Hub, opts: { port: number; webOrigins: string[]; shooter?: Shooter }) {
    this.hub = hub;
    this.wantedPort = opts.port;
    this.webOrigins = opts.webOrigins;
    this.shooter = opts.shooter ?? chromeShooter;
    current = this;
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen(): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Aperçu indisponible : ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    await new Promise<void>((ok, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(this.wantedPort, "127.0.0.1", () => ok());
    });
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop() {
    await this.close();
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
    if (current === this) current = null;
  }

  state(): PreviewState | null {
    if (!this.active) return null;
    const { taskId, kind, status, url, origin, error, log } = this.active;
    return { taskId, kind, status, url, origin, error, log };
  }

  /** Ouvre l'aperçu de cette tâche (et ferme celui d'une autre). */
  async open(taskId: number): Promise<{ ok: true; url: string } | { error: string }> {
    const { store } = this.hub.deps;
    const t = store.dev.get(taskId);
    if (!t) return { error: "Tâche introuvable" };
    if (!["review", "failed", "working"].includes(t.status) || !existsSync(t.worktree)) return { error: "Cette tâche n'a pas de copie à montrer." };
    const p = store.dev.project(t.project_id)!;
    if (!this.port) return { error: "Le serveur d'aperçu n'est pas lancé." };
    if (this.active?.taskId === taskId && this.active.status !== "failed") return { ok: true, url: this.active.url };
    await this.close();
    const page = (p.preview_path ?? "").replace(/^\/+/, "");
    const url = `${this.origin}/${page}`;
    if (!p.preview_command) {
      const entry = resolve(t.worktree, page || "index.html");
      if (!existsSync(entry)) return { error: `Pas de ${page || "index.html"} dans la copie. Indique la page de l'aperçu, ou une commande de serveur de dev, dans Réglages › Projets dev.` };
      this.active = { taskId, kind: "static", status: "ready", url, origin: this.origin, error: null, log: "", root: realpathSync(t.worktree), target: null, child: null };
      this.hub.touch();
      return { ok: true, url };
    }
    const target = await freePort();
    const command = p.preview_command.replaceAll("$PORT", String(target));
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: t.worktree,
      env: { ...process.env, PORT: String(target), BROWSER: "none", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const state = { taskId, kind: "server" as const, status: "starting" as PreviewState["status"], url, origin: this.origin, error: null as string | null, log: "", root: realpathSync(t.worktree), target, child: child as ChildProcess | null };
    this.active = state;
    const keep = (chunk: Buffer) => (state.log = (state.log + chunk.toString()).slice(-4000));
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    child.on("exit", (code) => {
      if (this.active !== state) return;
      state.status = "failed";
      state.error = `Le serveur de dev s'est arrêté (code ${code ?? "?"}).`;
      state.child = null;
      this.hub.touch();
    });
    child.on("error", (err) => {
      if (this.active !== state) return;
      state.status = "failed";
      state.error = `Serveur de dev impossible à lancer : ${err.message}`;
      state.child = null;
      this.hub.touch();
    });
    this.hub.touch();
    const end = Date.now() + 90_000;
    while (Date.now() < end && this.active === state && state.status === "starting") {
      if ((await answers(target)) && this.active === state) {
        state.status = "ready";
        this.hub.touch();
        return { ok: true, url };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (this.active === state && state.status === "starting") {
      state.status = "failed";
      state.error = "Le serveur de dev ne répond pas après 90 s.";
      this.kill(state.child);
      state.child = null;
      this.hub.touch();
    }
    // Remplacé pendant le démarrage (deux ouvertures rapprochées) : ce serveur-là ne sert plus à
    // personne, close() ne le voit pas, on l'arrête ici.
    if (this.active !== state) this.kill(state.child);
    return { error: state.error ?? "Aperçu fermé." };
  }

  async close(taskId?: number) {
    if (!this.active || (taskId !== undefined && this.active.taskId !== taskId)) return;
    this.kill(this.active.child);
    this.active = null;
    this.hub.touch();
  }

  private kill(child: ChildProcess | null) {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }

  /** Capture de l'élément choisi, rangée dans data/design/<tâche>/ ; renvoie le nom du fichier. */
  async capture(taskId: number, raw: { selector: string; width: number; page: string }): Promise<{ ok: true; file: string } | { error: string }> {
    if (this.active?.taskId !== taskId || this.active.status !== "ready") return { error: "Ouvre d'abord l'aperçu de cette tâche." };
    const selector = raw.selector.trim();
    if (!selector || selector.length > 500 || /[\r\n]/.test(selector)) return { error: "Élément illisible" };
    const width = Math.round(Math.min(2000, Math.max(320, Number(raw.width) || 1280)));
    const page = String(raw.page ?? "/").startsWith("/") ? String(raw.page) : "/";
    try {
      const shot = await this.shooter(`${this.origin}${page}`, selector, width);
      const dir = designDir(taskId);
      mkdirSync(dir, { recursive: true });
      const file = `${Date.now()}.jpg`;
      writeFileSync(join(dir, file), shot);
      return { ok: true, file };
    } catch (err) {
      return { error: `Capture impossible : ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
    }
  }

  private headers(html: boolean): Record<string, string> {
    return {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(html ? { "Content-Security-Policy": `frame-ancestors ${this.webOrigins.join(" ")}` } : {}),
    };
  }

  private inject(html: string): string {
    const tag = `<script src="/__clark/pick.js"></script>`;
    return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : html + tag;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!hosts.includes(req.headers.host ?? "")) {
      res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
      return void res.end("Hôte non autorisé");
    }
    const url = new URL(req.url ?? "/", this.origin);
    if (url.pathname === "/__clark/pick.js") {
      res.writeHead(200, { ...this.headers(false), "Content-Type": "text/javascript; charset=utf-8" });
      return void res.end(`const CLARK_PARENTS = ${JSON.stringify(this.webOrigins)};\n${readFileSync(PICKER, "utf8")}`);
    }
    const a = this.active;
    if (!a || a.status !== "ready") {
      res.writeHead(404, { ...this.headers(true), "Content-Type": "text/html; charset=utf-8" });
      return void res.end(`<!doctype html><meta charset="utf-8"><title>Aperçu</title><p style="font:15px system-ui;padding:24px">Aucun aperçu ouvert. Ouvre-le depuis une tâche dev, dans Clark.</p>`);
    }
    if (a.kind === "server") return this.proxy(req, res, a.target!);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, this.headers(false));
      return void res.end();
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      rel = "\0";
    }
    // Ni fichier caché (.git, .env…), ni sortie de la copie.
    if (rel.includes("\0") || rel.split("/").some((s) => s.startsWith("."))) return this.notFound(res);
    let file = resolve(a.root, `.${rel}`);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return this.notFound(res);
    const real = realpathSync(file);
    if (real !== a.root && !real.startsWith(a.root + sep)) return this.notFound(res);
    const type = TYPES[extname(real).toLowerCase()] ?? "application/octet-stream";
    const isHtml = type.startsWith("text/html");
    const body = isHtml ? Buffer.from(this.inject(readFileSync(real, "utf8"))) : readFileSync(real);
    res.writeHead(200, { ...this.headers(isHtml), "Content-Type": type, "Content-Length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  private notFound(res: ServerResponse) {
    res.writeHead(404, { ...this.headers(false), "Content-Type": "text/plain; charset=utf-8" });
    res.end("Introuvable dans la copie");
  }

  /** Relais vers le serveur de dev : les pages HTML reçoivent le script de choix d'élément. */
  private proxy(req: IncomingMessage, res: ServerResponse, target: number) {
    const headers = { ...req.headers, host: `127.0.0.1:${target}`, "accept-encoding": "identity" };
    delete headers.origin;
    delete headers.referer;
    const up = request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (r) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(r.headers)) {
        if (v === undefined || ["content-security-policy", "x-frame-options", "content-length", "transfer-encoding", "connection"].includes(k)) continue;
        out[k] = k === "location" ? String(v).replace(`http://127.0.0.1:${target}`, this.origin).replace(`http://localhost:${target}`, this.origin) : v;
      }
      const isHtml = String(r.headers["content-type"] ?? "").includes("text/html");
      if (!isHtml) {
        res.writeHead(r.statusCode ?? 502, { ...out, ...this.headers(false) });
        return void r.pipe(res);
      }
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.from(this.inject(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(r.statusCode ?? 200, { ...out, ...this.headers(true), "Content-Length": String(body.length) });
        res.end(body);
      });
    });
    up.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Le serveur de dev ne répond pas : ${err.message}`);
    });
    req.pipe(up);
  }
}

/** Les captures d'une tâche tranchée ne servent plus. */
export const dropDesignShots = (taskId: number) => rmSync(designDir(taskId), { recursive: true, force: true });
