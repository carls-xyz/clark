import { redactSecrets } from "../core/redact.ts";

/**
 * Sites sensibles : l'agent n'y va jamais, ni en ouvrant la page, ni par un lien, une redirection, un
 * retour arrière ou un nouvel onglet. L'utilisateur peut y aller lui-même (vue distante, fenêtre du
 * navigateur) ; pendant et après, l'agent n'a plus la main tant que la page n'est pas quittée ou fermée,
 * et rien de ces pages n'entre dans ce que l'agent lit, ni dans le journal.
 *
 * Correspondance par domaine exact ou sous-domaine, sur des noms d'hôtes normalisés (minuscules,
 * sans point final, IDN en punycode) : bloquer banque.fr bloque connexion.banque.fr, pas fausse-banque.fr.
 */

export const SENSITIVE_CATEGORIES = ["banque", "crypto", "mots_de_passe", "identite", "comptes"] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number] | "ajout";

export const CATEGORY_NAME: Record<SensitiveCategory, string> = {
  banque: "Banque et paiement",
  crypto: "Crypto",
  mots_de_passe: "Gestionnaires de mots de passe",
  identite: "Identité et authentification",
  comptes: "Comptes Apple, Google et Microsoft",
  ajout: "Ajouté par toi",
};

export type BlockSource = "defaut" | "CLARK_BROWSER_BLOCK";
export type BlockRule = { domain: string; category: SensitiveCategory; source: BlockSource };

/** La liste par défaut de Clark. Un domaine couvre aussi tous ses sous-domaines. */
export const DEFAULT_BLOCK: Record<Exclude<SensitiveCategory, "ajout">, string[]> = {
  banque: [
    "bnpparibas", "bnpparibas.com", "bnpparibas.fr", "mabanque.bnpparibas", "hellobank.fr",
    "credit-agricole.fr", "credit-agricole.com", "societegenerale.fr", "sg.fr", "lcl.fr",
    "labanquepostale.fr", "caisse-epargne.fr", "banquepopulaire.fr", "creditmutuel.fr", "cic.fr",
    "boursobank.com", "boursorama.com", "fortuneo.fr", "monabanq.com", "ing.fr", "axa-banque.fr",
    "banque-france.fr", "n26.com", "revolut.com", "qonto.com", "shine.fr", "nickel.eu", "wise.com",
    "lydia-app.com", "sumeria.eu", "paypal.com", "paypal.me", "klarna.com", "alma.eu",
    "dashboard.stripe.com", "connect.stripe.com", "checkout.stripe.com", "americanexpress.com",
  ],
  crypto: [
    "binance.com", "coinbase.com", "kraken.com", "bitstamp.net", "crypto.com", "bitpanda.com",
    "coinhouse.com", "paymium.com", "okx.com", "bybit.com", "kucoin.com", "gemini.com",
    "blockchain.com", "ledger.com", "trezor.io", "metamask.io", "phantom.app", "exodus.com", "uniswap.org",
  ],
  mots_de_passe: [
    "1password.com", "1password.eu", "1password.ca", "bitwarden.com", "bitwarden.eu", "lastpass.com",
    "dashlane.com", "keepersecurity.com", "nordpass.com", "pass.proton.me", "roboform.com", "enpass.io",
  ],
  identite: [
    "franceconnect.gouv.fr", "ants.gouv.fr", "impots.gouv.fr", "ameli.fr", "caf.fr",
    "lidentitenumerique.laposte.fr", "account.proton.me", "okta.com", "auth0.com", "duosecurity.com", "authy.com",
  ],
  comptes: [
    "appleid.apple.com", "account.apple.com", "idmsa.apple.com", "icloud.com", "accounts.google.com",
    "myaccount.google.com", "passwords.google.com", "pay.google.com", "payments.google.com",
    "login.live.com", "account.live.com", "account.microsoft.com", "login.microsoftonline.com", "mysignins.microsoft.com",
  ],
};

/** Nom d'hôte normalisé (minuscules, punycode, sans point final), ou null pour une adresse illisible. */
export function normalizeHost(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const host = new URL(/^[a-z][\w+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname;
    return host.toLowerCase().replace(/\.+$/, "") || null;
  } catch {
    return null;
  }
}

/** banque.fr couvre banque.fr et connexion.banque.fr, jamais fausse-banque.fr ni banque.fr.evil.com. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Les domaines de CLARK_BROWSER_BLOCK (séparés par des virgules, espaces ou retours à la ligne). */
export function extraDomains(env = process.env.CLARK_BROWSER_BLOCK): string[] {
  return [...new Set((env ?? "").split(/[\s,;]+/).map((d) => normalizeHost(d.replace(/^\*\./, ""))).filter((d): d is string => !!d && d.includes(".")))];
}

/** Les règles effectives, avec leur provenance : défaut Clark, puis CLARK_BROWSER_BLOCK. */
export function blockRules(env = process.env.CLARK_BROWSER_BLOCK): BlockRule[] {
  const rules: BlockRule[] = [];
  for (const category of SENSITIVE_CATEGORIES) {
    for (const d of DEFAULT_BLOCK[category]) {
      const domain = normalizeHost(d);
      if (domain) rules.push({ domain, category, source: "defaut" });
    }
  }
  const known = new Set(rules.map((r) => r.domain));
  for (const domain of extraDomains(env)) if (!known.has(domain)) rules.push({ domain, category: "ajout", source: "CLARK_BROWSER_BLOCK" });
  return rules;
}

/**
 * La règle qui bloque cette adresse, ou null. Seules les pages http(s) sont jugées : about:blank,
 * chrome:// et data: ne sont pas des sites (et l'agent ne peut pas les ouvrir, voir safeUrl).
 */
export function blockedRule(url: string | null | undefined, rules = blockRules()): BlockRule | null {
  if (!url || !/^https?:/i.test(url.trim())) return null;
  const host = normalizeHost(url);
  if (!host) return null;
  let best: BlockRule | null = null;
  for (const r of rules) if (hostMatches(host, r.domain) && (!best || r.domain.length > best.domain.length)) best = r;
  return best;
}

/** « banque.fr (Banque et paiement, défaut Clark) » : ce que l'agent et l'interface affichent. */
export function describeRule(r: BlockRule): string {
  return `${r.domain} (${CATEGORY_NAME[r.category]}, ${r.source === "defaut" ? "défaut Clark" : "CLARK_BROWSER_BLOCK"})`;
}

/** Pour l'interface : les règles groupées par catégorie, avec leur provenance. */
export function rulesView(env = process.env.CLARK_BROWSER_BLOCK) {
  const rules = blockRules(env);
  const order: SensitiveCategory[] = [...SENSITIVE_CATEGORIES, "ajout"];
  return order
    .map((category) => ({
      category,
      name: CATEGORY_NAME[category],
      source: category === "ajout" ? ("CLARK_BROWSER_BLOCK" as const) : ("defaut" as const),
      domains: rules.filter((r) => r.category === category).map((r) => r.domain),
    }))
    .filter((g) => g.domains.length || g.category === "ajout");
}

// ── Expurgation (journal du navigateur) ─────────────────────────────────

/** L'adresse réduite à « origine + chemin » : ni paramètres ni fragment (jetons, codes, adresses mail). */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return u.protocol === "about:" ? raw.split(/[?#]/)[0] : `${u.protocol}…`;
    const path = u.pathname
      .split("/")
      .map((seg) => (/@|%40/.test(seg) || /^\d{6,}$/.test(seg) || (/^[A-Za-z0-9_-]{24,}$/.test(seg) && /\d/.test(seg)) ? "•••" : seg))
      .join("/");
    return `${u.origin}${path}`;
  } catch {
    return raw.split(/[?#]/)[0].slice(0, 200);
  }
}

const TEXT_MASKS: [RegExp, string][] = [
  [/\b(cookie|set-cookie|authorization|proxy-authorization)\s*[:=]\s*[^\n]+/gi, "$1: •••"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer •••"],
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, "[IBAN masqué]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[carte masquée]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email masqué]"],
  [/\b(code|otp|2fa|pin|cvv|cvc|mot de passe|password|passcode)\b(\s*[:=]?\s*)\S+/gi, "$1$2•••"],
  [/\b\d{6,8}\b/g, "•••"],
];

/** Un texte court du journal, sans cookies, autorisations, codes, emails, cartes ni IBAN. */
export function redactText(text: string): string {
  let out = redactSecrets(text);
  out = out.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => redactUrl(u));
  for (const [re, by] of TEXT_MASKS) out = out.replace(re, by);
  return out;
}

// ── Liste de confiance (préparée, PAS branchée) ─────────────────────────

/**
 * Plus tard, une exception précise et bornée, jamais une permission générale : un site, un type d'action,
 * une limite. Exemple : { site: "notion.so", action: "brouillon", limit: "5 par jour" }.
 * Rien ne lit ce type aujourd'hui : aucune action n'est autorisée par une liste de confiance.
 */
export type TrustRule = {
  site: string;
  action: "brouillon" | "formulaire" | "lecture_compte";
  limit: string;
};
export const TRUST_LIST_ENABLED = false as const;
