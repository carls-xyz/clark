/**
 * Connexion de Clark à ton compte Google (Gmail + Google Agenda), à faire une fois :
 *   npm run google:login
 * Ton navigateur s'ouvre sur la page de Google ; tu choisis ton compte et tu acceptes.
 * Google renvoie vers 127.0.0.1 (ce Mac), où ce script récupère le jeton. Il ne voit jamais
 * ton mot de passe.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { finishLogin, GOOGLE_SCOPES, googleStatus, startLogin } from "../src/google/auth.ts";

if (!googleStatus().configured) {
  console.error("Il manque GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env. La marche à suivre est dans le README, section « Mail et agenda ».");
  process.exit(1);
}

const server = createServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const redirect = `http://127.0.0.1:${port}`;
const login = startLogin(redirect);

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">${title}</h1><p>${text}</p>`;

const done = new Promise<string | null>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Pas de réponse de Google en 5 minutes. Relance npm run google:login.")), 5 * 60_000);
  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", redirect);
    if (url.pathname !== "/") return void res.writeHead(404).end();
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (error || !code || url.searchParams.get("state") !== login.state) {
      res.end(page("Connexion annulée", "Clark n'est pas connecté. Tu peux fermer cet onglet et relancer la commande."));
      clearTimeout(timer);
      return reject(new Error(error ? `Google : ${error}` : "Réponse de Google invalide (state)."));
    }
    try {
      const email = await finishLogin(code, login.verifier, redirect);
      res.end(page("Clark est connecté", `Gmail et Google Agenda${email ? ` (${email})` : ""} sont branchés. Tu peux fermer cet onglet.`));
      clearTimeout(timer);
      resolve(email);
    } catch (err) {
      res.end(page("Connexion refusée", "Le détail est dans le terminal."));
      clearTimeout(timer);
      reject(err);
    }
  });
});

console.log("Ouverture de la page de connexion Google dans ton navigateur…");
console.log(`Si rien ne s'ouvre, colle ce lien dans ton navigateur :\n${login.url}\n`);
console.log(`Clark demande : lire tes mails, envoyer des mails (toujours après ton accord), lire ton agenda.`);
console.log(`(${GOOGLE_SCOPES.length} autorisations)\n`);
execFile("open", [login.url], () => {});

try {
  const email = await done;
  console.log(`Connecté${email ? ` : ${email}` : ""}. Le jeton est dans data/google/ (lisible par toi seul).`);
  console.log("Si Clark tourne en service et que tu viens de remplir .env, redémarre-le une fois : scripts/service.sh restart");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  server.close();
}
