import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Client du Codex App Server (`codex app-server`) : JSON-RPC, un message JSON par ligne
 * sur stdin/stdout. Trois sortes de messages arrivent :
 * - les réponses à nos requêtes (id connu, pas de method) ;
 * - les notifications (method, sans id) : progression des tours et des étapes ;
 * - les requêtes du serveur (method + id) : demandes de validation, auxquelles on répond.
 */
export type Notification = { method: string; params: any };
export type ServerRequest = { id: number | string; method: string; params: any };
export type ServerRequestHandler = (req: ServerRequest) => Promise<unknown>;

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export type Transport = {
  write(line: string): void;
  onLine(fn: (line: string) => void): void;
  onExit(fn: (reason: string) => void): void;
  close(): void;
};

/** Lance `codex app-server` avec son propre dossier de configuration (CODEX_HOME). */
export function spawnCodex(opts: { bin?: string; codexHome: string; args?: string[] }): Transport {
  const child: ChildProcess = spawn(opts.bin ?? "codex", ["app-server", ...(opts.args ?? [])], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: opts.codexHome },
  });
  let stderr = "";
  // Écrire à un Codex déjà arrêté ne doit jamais faire tomber Clark : l'arrêt est signalé par « exit ».
  child.stdin!.on("error", () => {});
  child.stderr!.on("data", (d) => (stderr = (stderr + d.toString()).slice(-2000)));
  return {
    write: (line) => {
      if (child.stdin!.writable) child.stdin!.write(line + "\n");
    },
    onLine: (fn) => createInterface({ input: child.stdout! }).on("line", fn),
    onExit: (fn) => {
      child.on("error", (err) => fn(`codex introuvable ou impossible à lancer (${err.message}). Installe-le : brew install codex`));
      child.on("exit", (code, signal) => fn(`codex app-server s'est arrêté (${signal ?? `code ${code}`}). ${stderr.trim().split("\n").slice(-3).join(" ")}`));
    },
    close: () => child.kill(),
  };
}

export class CodexClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(n: Notification) => void>();
  private handler: ServerRequestHandler = async (req) => {
    throw new RpcError(-32601, `Requête non gérée par Clark : ${req.method}`);
  };
  private dead: string | null = null;
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onLine((line) => this.receive(line));
    transport.onExit((reason) => {
      this.dead = reason;
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
      for (const l of this.listeners) l({ method: "clark/exited", params: { reason } });
    });
  }

  get alive() {
    return this.dead === null;
  }

  /** Poignée de main obligatoire avant toute autre requête. */
  async initialize(version: string) {
    const r = await this.request("initialize", {
      clientInfo: { name: "clark", title: "Clark", version },
      // API expérimentale : nécessaire pour choisir un profil de permissions à chaque tour.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    return r;
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.write(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.dead) this.transport.write(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  onNotification(fn: (n: Notification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Un seul gestionnaire : il voit les requêtes de tous les fils et route lui-même. */
  onServerRequest(fn: ServerRequestHandler) {
    this.handler = fn;
  }

  close() {
    this.transport.close();
  }

  private receive(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ligne non JSON (journal de debug) : ignorée
    }
    if (msg.method && msg.id !== undefined) {
      this.handler(msg)
        .then((result) => this.transport.write(JSON.stringify({ id: msg.id, result })))
        .catch((err) =>
          this.transport.write(
            JSON.stringify({ id: msg.id, error: { code: err instanceof RpcError ? err.code : -32000, message: err instanceof Error ? err.message : String(err) } }),
          ),
        );
      return;
    }
    if (msg.method) {
      for (const l of this.listeners) l({ method: msg.method, params: msg.params });
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code ?? -32000, msg.error.message ?? "Erreur Codex"));
    else p.resolve(msg.result);
  }
}
