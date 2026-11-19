import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { paths } from "../config.ts";
import { claudeEnv } from "./claude-auth.ts";

/**
 * Connexion d'un moteur depuis l'interface : Clark lance le flux officiel (`claude auth login`,
 * `codex login`) dans son propre dossier de configuration, comme si tu tapais la commande.
 * Le navigateur s'ouvre sur la page d'Anthropic ou d'OpenAI ; tu t'y connectes toi-même.
 *
 * Clark ne lit ni ne garde aucun identifiant : il montre le lien affiché par la commande et,
 * pour Claude, transmet tel quel le code que la page te donne (si elle t'en donne un).
 */
export type LoginEngine = "claude" | "codex";
export type LoginState = {
  engine: LoginEngine;
  status: "waiting" | "done" | "failed";
  /** Le lien de connexion affiché par la commande (si le navigateur ne s'est pas ouvert). */
  url: string | null;
  /** Claude : la commande attend un code collé depuis la page. */
  asksCode: boolean;
  /** Un code a été transmis : on attend la réponse de la commande. */
  codeSent: boolean;
  error: string | null;
  startedAt: number;
};

type Spawn = (engine: LoginEngine) => ChildProcessWithoutNullStreams;

/** La vraie commande, dans le dossier de Clark (jamais ~/.claude ni ~/.codex). */
export const spawnLogin: Spawn = (engine) => {
  if (engine === "claude") return spawn("claude", ["auth", "login"], { env: claudeEnv(), stdio: "pipe" });
  mkdirSync(paths.codexHome, { recursive: true });
  return spawn("codex", ["login"], { env: { ...process.env, CODEX_HOME: paths.codexHome }, stdio: "pipe" });
};

const LOGIN_TIMEOUT = 15 * 60_000;
// Les liens de connexion attendus : rien d'autre n'est montré comme lien cliquable.
const URL_RE = /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|auth\.openai\.com)\/\S+/;
// Les codes de couleur du terminal ne doivent pas finir dans le lien ou le message.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

export function createLogins(opts: { onChange: () => void; onDone: (engine: LoginEngine) => void | Promise<void>; spawn?: Spawn }) {
  const run = opts.spawn ?? spawnLogin;
  const states = new Map<LoginEngine, LoginState>();
  const procs = new Map<LoginEngine, { child: ChildProcessWithoutNullStreams; timer: NodeJS.Timeout }>();

  const stop = (engine: LoginEngine) => {
    const p = procs.get(engine);
    if (!p) return;
    procs.delete(engine);
    clearTimeout(p.timer);
    p.child.kill();
  };

  return {
    list: (): LoginState[] => [...states.values()],

    start(engine: LoginEngine): LoginState {
      stop(engine);
      const s: LoginState = { engine, status: "waiting", url: null, asksCode: false, codeSent: false, error: null, startedAt: Date.now() };
      states.set(engine, s);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = run(engine);
      } catch (err) {
        s.status = "failed";
        s.error = err instanceof Error ? err.message : String(err);
        opts.onChange();
        return s;
      }
      let out = "";
      const read = (chunk: Buffer) => {
        if (states.get(engine) !== s) return;
        out = (out + plain(chunk.toString("utf8"))).slice(-8000);
        const url = out.match(URL_RE)?.[0] ?? null;
        const asks = engine === "claude" && /paste code/i.test(out);
        if (url !== s.url || asks !== s.asksCode) {
          s.url = url;
          s.asksCode = asks;
          opts.onChange();
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      const timer = setTimeout(() => {
        if (states.get(engine) !== s || s.status !== "waiting") return;
        stop(engine);
        s.status = "failed";
        s.error = "Délai dépassé (15 min). Relance la connexion.";
        opts.onChange();
      }, LOGIN_TIMEOUT);
      timer.unref();
      procs.set(engine, { child, timer });
      child.on("error", (err) => {
        if (states.get(engine) !== s || s.status !== "waiting") return;
        procs.delete(engine);
        clearTimeout(timer);
        s.status = "failed";
        s.error = (err as NodeJS.ErrnoException).code === "ENOENT" ? `${engine === "claude" ? "Claude Code" : "Codex"} n'est pas installé sur ce Mac.` : err.message;
        opts.onChange();
      });
      child.on("exit", (code) => {
        if (procs.get(engine)?.child === child) procs.delete(engine);
        clearTimeout(timer);
        if (states.get(engine) !== s || s.status !== "waiting") return;
        if (code === 0) {
          s.status = "done";
          s.error = null;
          opts.onChange();
          void Promise.resolve(opts.onDone(engine)).catch((err) => console.warn(`[clark] ${engine} non relu après connexion :`, err instanceof Error ? err.message : err));
        } else {
          s.status = "failed";
          // La dernière ligne utile de la commande dit ce qui a coincé (jamais un jeton : la commande n'en affiche pas).
          // L'invite « Paste code here… > » n'a pas de retour à la ligne : l'erreur la suit sur la même ligne.
          const last = out
            .replace(/paste code here if prompted >\s*/gi, "\n")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !URL_RE.test(l))
            .pop();
          s.error = last ? last.slice(0, 300) : "La connexion n'a pas abouti.";
          opts.onChange();
        }
      });
      opts.onChange();
      return s;
    },

    /** Claude : le code que la page de connexion affiche, transmis tel quel à la commande. */
    sendCode(engine: LoginEngine, code: string): { ok: true } | { error: string } {
      const s = states.get(engine);
      const p = procs.get(engine);
      if (!s || !p || s.status !== "waiting") return { error: "Aucune connexion en cours : relance-la." };
      const clean = code.trim();
      if (!clean || clean.length > 2000 || /[\r\n\x00-\x1f]/.test(clean)) return { error: "Code invalide : colle-le tel que la page l'affiche." };
      p.child.stdin.write(`${clean}\n`);
      s.codeSent = true;
      opts.onChange();
      return { ok: true };
    },

    cancel(engine: LoginEngine) {
      stop(engine);
      states.delete(engine);
      opts.onChange();
    },

    /** Le moteur est connecté et l'interface l'a montré : l'encart de connexion disparaît. */
    clear(engine: LoginEngine) {
      if (states.get(engine)?.status !== "waiting") states.delete(engine);
    },

    close() {
      for (const e of [...procs.keys()]) stop(e);
    },
  };
}
export type Logins = ReturnType<typeof createLogins>;

/** Clark tourne en service launchd : il peut se relancer seul (launchd le redémarre après une sortie non nulle). */
export const canRestart = () => process.env.XPC_SERVICE_NAME === "local.clark";
export const RESTART_EXIT_CODE = 75;
