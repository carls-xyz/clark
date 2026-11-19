#!/usr/bin/env node
// Faux GitHub CLI pour la démo et les tests : PR, CI, reviews, issues, sans réseau.
// L'état vit dans FAKE_GH_STATE (JSON) ; le dépôt « origin » est un dépôt nu local (FAKE_GH_ORIGIN).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_GH_STATE;
const origin = process.env.FAKE_GH_ORIGIN;
const state = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { prs: {}, next: 7 };
const save = () => file && writeFileSync(file, JSON.stringify(state, null, 2));
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sha = (branch) => {
  try {
    return execFileSync("git", ["--git-dir", origin, "rev-parse", branch], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));

const ISSUES = [
  { number: 12, title: "Ajouter un pied de page avec l'adresse mail", body: "Le site n'a aucun moyen de contact visible.\nAjouter un pied de page avec charles@exemple.fr, centré, en texte secondaire.", url: "https://github.com/demo/site-demo/issues/12", author: { login: "julie-studio" }, labels: [{ name: "contenu" }], updatedAt: "2026-11-18T10:00:00Z" },
  { number: 15, title: "Le titre principal est trop petit sur mobile", body: "Sur iPhone, le h1 fait la même taille que le texte. Le passer à 2rem sous 600 px.", url: "https://github.com/demo/site-demo/issues/15", author: { login: "charles" }, labels: [{ name: "mobile" }, { name: "css" }], updatedAt: "2026-11-19T08:00:00Z" },
];

const [a, b] = args;
if (a === "auth" && b === "status") out("Logged in to github.com as demo\n");
else if (a === "pr" && b === "create") {
  const n = state.next++;
  const head = arg("--head");
  state.prs[n] = { head, createdSha: sha(head), title: arg("--title") };
  save();
  out(`https://github.com/demo/site-demo/pull/${n}\n`);
} else if (a === "pr" && b === "view") {
  const n = Number(String(args[2]).split("/").pop());
  const pr = state.prs[n] ?? { head: "main", createdSha: null };
  // La CI échoue sur la version d'origine ; une fois une correction poussée, tout passe.
  const fixed = pr.createdSha && sha(pr.head) && sha(pr.head) !== pr.createdSha;
  out({
    state: pr.merged ? "MERGED" : "OPEN",
    isDraft: false,
    number: n,
    headRefName: pr.head,
    reviewDecision: fixed ? "APPROVED" : "CHANGES_REQUESTED",
    statusCheckRollup: [
      { name: "lint", conclusion: fixed ? "SUCCESS" : "FAILURE", detailsUrl: "https://github.com/demo/site-demo/actions/runs/111/job/222" },
      { name: "tests", conclusion: "SUCCESS", detailsUrl: "https://github.com/demo/site-demo/actions/runs/111/job/223" },
    ],
    reviews: [{ id: 501, author: { login: "julie-studio" }, state: "CHANGES_REQUESTED", body: "Bien vu pour le contraste. Ajoute aussi un commentaire CSS qui dit pourquoi cette couleur.", submittedAt: "2026-11-19T09:00:00Z" }],
    comments: [],
  });
} else if (a === "api" && /pulls\/\d+\/comments$/.test(b)) {
  out([{ id: 901, user: { login: "julie-studio" }, path: "style.css", line: 2, body: "Évite les couleurs en dur : une variable --muted serait plus simple à changer.", created_at: "2026-11-19T09:01:00Z" }]);
} else if (a === "run" && b === "view") {
  out("lint\tRun stylelint\t2026-11-19T09:00:00Z style.css\nlint\tRun stylelint\t2026-11-19T09:00:01Z   2:3  ✖  Unexpected hex color \"#595959\": use a custom property (color-no-hex)\nlint\tRun stylelint\t2026-11-19T09:00:01Z ✖ 1 problem (1 error, 0 warnings)\nlint\tRun stylelint\t2026-11-19T09:00:01Z Process completed with exit code 2.\n");
} else if (a === "issue" && b === "list") out(ISSUES);
else if (a === "issue" && b === "view") {
  const i = ISSUES.find((x) => x.number === Number(args[2]));
  if (!i) {
    process.stderr.write(`GraphQL: Could not resolve to an issue with the number of ${args[2]}.\n`);
    process.exit(1);
  }
  out(i);
} else {
  process.stderr.write(`faux gh : commande non prise en charge (${args.join(" ")})\n`);
  process.exit(1);
}
