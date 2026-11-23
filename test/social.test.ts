import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Bot } from "grammy";
import { paths, type Config } from "../src/config.ts";
import type { executeTask } from "../src/core/agent.ts";
import { Conversation } from "../src/core/conversation.ts";
import { createHub, OWNER_CHAT } from "../src/core/hub.ts";
import { createTelegram } from "../src/gateway/telegram.ts";
import { startWeb } from "../src/gateway/web.ts";
import { Store } from "../src/memory/store.ts";
import { memoryTools } from "../src/memory/tools.ts";
import { PLATFORMS } from "../src/social/platforms.ts";
import { probeDuration, renderVertical } from "../src/social/render.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const config: Config = {
  telegram: { token: "123:test", ownerId: 1 },
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
};

// Clips de test (mires ffmpeg) dans le vrai dossier de travail : l'outil de Clark n'accepte que lui.
const CLIPS = resolve(paths.workspace, `test-clips-${process.pid}`);
const rel = (f: string) => `${CLIPS.slice(paths.workspace.length + 1)}/${f}`;
/** Sans ffmpeg (une machine de CI où l'installation a échoué) : les montages sont sautés, le reste tourne sur des faux clips. */
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const needsFfmpeg = { skip: !hasFfmpeg && "ffmpeg n'est pas installé" };
before(() => {
  mkdirSync(CLIPS, { recursive: true });
  if (!hasFfmpeg) {
    for (const i of [1, 2]) writeFileSync(join(CLIPS, `c${i}.mp4`), Buffer.alloc(4096, i));
    return;
  }
  for (const [i, hue] of [0, 180].entries()) {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-vf", `hue=h=${hue}`, join(CLIPS, `c${i + 1}.mp4`)]);
  }
});
after(() => {
  rmSync(CLIPS, { recursive: true, force: true });
  // Brouillons créés par les tests de l'outil.
  const drafts = resolve(paths.workspace, "social/brouillons");
  if (existsSync(drafts)) for (const f of readdirSync(drafts)) if (f.includes(`-test${process.pid}-`)) rmSync(join(drafts, f));
});

const dims = (file: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();

test("montage : clips recadrés en vertical, coupés, mis bout à bout, textes incrustés", { timeout: 240_000, ...needsFfmpeg }, async () => {
  const out = join(CLIPS, "out.mp4");
  const r = await renderVertical(
    { clips: [{ path: rel("c1.mp4") }, { path: rel("c2.mp4"), start: 0.5, end: 1.5 }], texts: [{ text: "Se règle en 10 secondes", start: 0, end: 2 }], output: out },
    { width: 270, height: 480 },
  );
  assert.equal(dims(out), "270,480");
  assert.ok(Math.abs(r.duration - 3) < 0.15, `durée ${r.duration}`);
  assert.ok(Math.abs((await probeDuration(out)) - 3) < 0.15);
});

test("montage : rien hors du dossier de Clark, et des demandes cohérentes", needsFfmpeg, async () => {
  await assert.rejects(renderVertical({ clips: [{ path: "/etc/hosts" }], output: join(CLIPS, "x.mp4") }), /hors du dossier/);
  await assert.rejects(renderVertical({ clips: [{ path: rel("c1.mp4") }], output: "/tmp/x.mp4" }), /dossier de Clark/);
  await assert.rejects(renderVertical({ clips: [{ path: rel("absent.mp4") }], output: join(CLIPS, "x.mp4") }), /introuvable/);
  await assert.rejects(renderVertical({ clips: [{ path: rel("c1.mp4") }], texts: [{ text: "x", start: 5, end: 6 }], output: join(CLIPS, "x.mp4") }), /moment de texte/);
});

function setup() {
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const calls: string[] = [];
  const execute: typeof executeTask = async (deps, taskId, run) => {
    calls.push(run.prompt);
    deps.journal.finish(taskId, "done", "ok", 0);
    return { text: "ok", costUsd: 0, status: "done" };
  };
  const hub = createHub({ config, store, journal, conversation }, { execute });
  return { store, journal, conversation, hub, calls };
}

const draft = (store: Store, media = join(CLIPS, "c1.mp4"), over: Partial<Parameters<Store["posts"]["create"]>[0]> = {}) =>
  store.posts.create({ platform: "tiktok", title: "Démo coussin", caption: "Le coussin qui soutient le dos.", hashtags: ["grossesse", "#maman"], mediaPath: media, duration: 11, width: 1080, height: 1920, ...over });

test("brouillon : vérifications TikTok, règles et conseils séparés", () => {
  const { store } = setup();
  const ok = store.posts.get(draft(store))!;
  const checks = PLATFORMS.tiktok.checks(ok);
  assert.ok(checks.filter((c) => c.kind === "règle").every((c) => c.ok));
  assert.ok(checks.some((c) => c.kind === "rappel" && /musique/.test(c.text)));
  const wrong = store.posts.get(draft(store, undefined, { width: 1920, height: 1080, duration: 95, hashtags: [] }))!;
  const bad = PLATFORMS.tiktok.checks(wrong).filter((c) => !c.ok).map((c) => c.kind);
  assert.deepEqual(bad, ["règle", "conseil", "conseil"], "format horizontal, trop long, pas de mots-clés");
});

test("décision : valider range la vidéo et sa légende, une seule fois ; refaire demande une consigne", async () => {
  const { store, hub, calls, conversation } = setup();
  const dir = mkdtempSync(join(tmpdir(), "clark-pub-"));
  try {
    const id = draft(store);
    assert.ok(store.posts.approve(id, dir));
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 2);
    assert.match(readFileSync(join(dir, files.find((f) => f.endsWith(".txt"))!), "utf8"), /Le coussin qui soutient le dos\.\n\n#grossesse #maman/);
    assert.equal(hub.decidePost(id, "approve"), "already");

    const second = draft(store);
    assert.equal(hub.decidePost(second, "redo"), "missing_feedback");
    assert.equal(hub.decidePost(second, "redo", "Texte d'ouverture plus court"), "done");
    await new Promise((r) => setTimeout(r, 10));
    assert.match(calls[0], /Refais le contenu TikTok « Démo coussin » \(brouillon #2, mêmes clips\) avec cette retouche : Texte d'ouverture plus court/);
    assert.equal(store.posts.get(second)!.status, "redo");

    const third = draft(store);
    assert.equal(hub.decidePost(third, "reject"), "done");
    assert.ok(conversation.recent(OWNER_CHAT).some((m) => /Contenu jeté/.test(m.text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outil de Clark : refusé en lecture seule ou sans tâche, sinon monte et propose", { timeout: 240_000, ...needsFfmpeg }, async () => {
  const { store, journal } = setup();
  const args = {
    platform: "tiktok" as const,
    title: `Démo test${process.pid}`,
    clips: [{ path: rel("c1.mp4") }],
    texts: [{ text: "Bonjour", start: 0, end: 1 }],
    caption: "Légende",
    hashtags: ["test"],
  };
  const ro = memoryTools(store, { taskId: () => 1, writeRefusal: () => "Refusé : lecture seule." });
  await assert.rejects(ro.prepare_social_post.run(args), /lecture seule/);
  const none = memoryTools(store, { taskId: () => undefined, writeRefusal: () => null });
  assert.match(await none.prepare_social_post.run(args), /je ne retrouve pas la tâche/);

  const task = journal.create(OWNER_CHAT, "chat", "Fais une vidéo");
  const t = memoryTools(store, { taskId: () => task, writeRefusal: () => null });
  const out = await t.prepare_social_post.run(args);
  assert.match(out, /Brouillon #1 prêt \(1080×1920, 2 s\)/);
  const p = store.posts.get(1)!;
  assert.equal(p.task_id, task);
  assert.ok(p.media_path.startsWith(resolve(paths.workspace, "social/brouillons")));
  assert.equal(dims(p.media_path), "1080,1920");
  rmSync(p.media_path, { force: true });
});

test("interface : la vidéo est servie par morceaux (Safari), et le brouillon se valide", async () => {
  const { store, hub } = setup();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const web = await startWeb(hub, { port });
  const id = draft(store);
  const call = (path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; length: number }>((resolveP, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { Host: `localhost:${port}`, ...opts.headers } }, (res) => {
        let length = 0;
        res.on("data", (c) => (length += c.length));
        res.on("end", () => resolveP({ status: res.statusCode ?? 0, headers: res.headers, length }));
      });
      req.on("error", reject);
      req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
    });
  try {
    const full = await call(`/media/posts/${id}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-type"], "video/mp4");
    const part = await call(`/media/posts/${id}`, { headers: { Range: "bytes=0-99" } });
    assert.equal(part.status, 206);
    assert.equal(part.length, 100);
    assert.match(String(part.headers["content-range"]), /^bytes 0-99\/\d+$/);
    assert.equal((await call("/media/posts/999")).status, 404);

    const state = await new Promise<any>((resolveP) => {
      request({ host: "127.0.0.1", port, path: "/api/state", headers: { Host: `localhost:${port}` } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolveP(JSON.parse(d)));
      }).end();
    });
    assert.equal(state.posts[0].media, `/media/posts/${id}`);
    assert.ok(state.posts[0].checks.length > 0);

    const json = { "Content-Type": "application/json", Origin: `http://localhost:${port}` };
    assert.equal((await call(`/api/posts/${id}`, { method: "POST", headers: json, body: { action: "redo", feedback: "" } })).status, 400);
    assert.equal((await call(`/api/posts/${id}`, { method: "POST", headers: json, body: { action: "reject" } })).status, 200);
    assert.equal((await call(`/api/posts/${id}`, { method: "POST", headers: json, body: { action: "approve" } })).status, 409);
  } finally {
    await web.close();
  }
});

test("Telegram : la vidéo arrive avec Valider / Jeter, et répondre au message demande une retouche", async () => {
  const { store, journal, conversation, calls } = setup();
  const hub = createHub({ config, store, journal, conversation }, {
    execute: (async (deps, taskId, run) => {
      calls.push(run.prompt);
      deps.journal.finish(taskId, "done", "ok", 0);
      return { text: "ok", costUsd: 0, status: "done" };
    }) as typeof executeTask,
  });
  const sent: { method: string; payload: any }[] = [];
  const bot = new Bot("123:test", { botInfo: { id: 999, is_bot: true, first_name: "Clark", username: "clark_bot" } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 1, type: "private" } } } as never;
  });
  createTelegram(hub, { token: "123:test", ownerId: 1, bot });

  const id = draft(store);
  await new Promise((r) => setTimeout(r, 20));
  const video = sent.find((s) => s.method === "sendVideo")!;
  assert.ok(video, "la vidéo est envoyée");
  assert.deepEqual(video.payload.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data), [`sp:ok:${id}`, `sp:no:${id}`]);
  const videoMessage = sent.indexOf(video) + 1;

  const owner = { id: 1, is_bot: false, first_name: "Charles" };
  const chat = { id: 1, type: "private" as const, first_name: "Charles" };
  await bot.handleUpdate({
    update_id: 1,
    message: { message_id: 50, date: 0, chat, from: owner, text: "Texte d'ouverture plus court", reply_to_message: { message_id: videoMessage, date: 0, chat, from: { id: 999, is_bot: true, first_name: "Clark" } } as never },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.posts.get(id)!.status, "redo");
  assert.match(calls[0] ?? "", /avec cette retouche : Texte d'ouverture plus court/);

  const second = draft(store);
  await bot.handleUpdate({ update_id: 2, callback_query: { id: "cb", chat_instance: "x", from: owner, data: `sp:no:${second}`, message: { message_id: 60, date: 0, chat } as never } });
  assert.equal(store.posts.get(second)!.status, "rejected");
});
