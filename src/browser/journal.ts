import { redactText, redactUrl } from "./sensitive.ts";
import type { ControlEvent } from "./service.ts";

/**
 * Le journal du navigateur, lu dans les étapes des tâches (aucune autre source) : quelle action, sur quelle
 * page (origine + chemin, adresse finale après redirection), et ce qu'a donné l'accord. Jamais le contenu
 * des pages : il est retiré des étapes dès leur écriture (browserStepOutput), et les valeurs tapées sont masquées.
 */

const ACTIONS = ["open", "read", "click", "type", "select", "scroll", "back"] as const;
type Action = (typeof ACTIONS)[number];
const TOOL = /browser_(open|read|click|type|select|scroll|back)$/;

/** Outil du navigateur (Claude : mcp__memory__browser_open ; Codex : son propre préfixe). */
export const browserAction = (tool: string): Action | null => (TOOL.exec(tool)?.[1] as Action | undefined) ?? null;

/** Ce qu'une page lue contient, repéré par l'avertissement que formatView place en tête. */
const PAGE_MARK = "(Contenu d'une page web";

/** La sortie d'une étape du navigateur, telle qu'elle est gardée : la note et l'adresse, jamais la page. */
export function browserStepOutput(out: string): string {
  if (!out.includes(PAGE_MARK)) return redactText(out).slice(0, 400);
  const at = out.indexOf("Page : ");
  const note = at > 0 ? out.slice(0, at).trim() : "";
  const first = (at >= 0 ? out.slice(at) : out).split("\n")[0];
  const url = first.includes(" — ") ? first.slice(first.lastIndexOf(" — ") + 3).trim() : "";
  return `${note ? `${redactText(note).slice(0, 300)} ` : ""}Page : ${url ? redactUrl(url) : "(adresse inconnue)"}`;
}

/** Ce qui est gardé de la demande : l'adresse réduite, et les textes tapés passés au masque. */
export function browserStepInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const o = { ...(input as Record<string, unknown>) };
  if (typeof o.url === "string") o.url = redactUrl(/^[a-z][\w+.-]*:\/\//i.test(o.url) ? o.url : `https://${o.url}`);
  if (typeof o.text === "string") o.text = redactText(o.text);
  if (typeof o.value === "string") o.value = redactText(o.value);
  return o;
}

export type BrowserStepRow = { id: number; task_id: number; tool: string; input: string; status: string; output: string | null; created_at: string };

export type BrowserStatus = "fait" | "en_cours" | "accord_demande" | "accord_donne" | "refuse" | "expire" | "agent_arrete" | "bloque" | "erreur";
export const STATUS_LABEL: Record<BrowserStatus, string> = {
  fait: "Fait",
  en_cours: "En cours",
  accord_demande: "Accord demandé",
  accord_donne: "Accord donné",
  refuse: "Refusé",
  expire: "Expiré",
  agent_arrete: "Agent arrêté",
  bloque: "Site sensible bloqué",
  erreur: "Erreur",
};

export type BrowserEntry =
  | { kind: "action"; at: string; taskId: number; action: string; target: string | null; finalUrl: string | null; status: BrowserStatus; label: string }
  | { kind: "controle"; at: string; label: string };

const VERB: Record<Action, string> = {
  open: "Ouvre",
  read: "Lit la page",
  click: "Clique",
  type: "Remplit un champ",
  select: "Choisit une option",
  scroll: "Fait défiler",
  back: "Revient en arrière",
};

function statusOf(row: BrowserStepRow, awaiting: boolean): BrowserStatus {
  const out = row.output ?? "";
  if (row.status === "running" || row.status === "awaiting_approval") return awaiting ? "accord_demande" : "en_cours";
  if (row.status === "denied") return "refuse";
  if (row.status === "expired") return "expire";
  if (row.status === "error") return "erreur";
  if (out.startsWith("Charles a arrêté l'agent")) return "agent_arrete";
  if (out.startsWith("Charles a refusé")) return "refuse";
  if (out.startsWith("Pas de réponse de Charles")) return "expire";
  if (/^Site bloqué|site sensible/.test(out)) return "bloque";
  if (out.startsWith("Accord de Charles reçu")) return "accord_donne";
  return "fait";
}

const parse = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

/** L'adresse finale (après redirection), lue dans la sortie gardée : « … Page : https://site/chemin ». */
const finalUrlOf = (out: string | null) => {
  const m = out?.match(/Page : (?:[^\n]* — )?((?:https?|about):[^\s]*)/);
  return m ? redactUrl(m[1]) : null;
};

/** Le journal : les étapes du navigateur (les plus récentes d'abord) et les prises de contrôle, sans détail. */
export function browserJournal(rows: BrowserStepRow[], opts: { awaitingTasks?: Set<number>; control?: ControlEvent[] } = {}): BrowserEntry[] {
  const entries: (BrowserEntry & { sort: number })[] = [];
  for (const row of rows) {
    const action = browserAction(row.tool);
    if (!action) continue;
    const input = parse(row.input);
    const status = statusOf(row, opts.awaitingTasks?.has(row.task_id) ?? false);
    const target = action === "open" && typeof input.url === "string" ? redactUrl(input.url) : action === "click" && typeof input.ref === "string" ? input.ref : null;
    const finalUrl = finalUrlOf(row.output);
    entries.push({ kind: "action", at: row.created_at, taskId: row.task_id, action: VERB[action], target, finalUrl, status, label: STATUS_LABEL[status], sort: Date.parse(`${row.created_at.replace(" ", "T")}Z`) || 0 });
  }
  for (const e of opts.control ?? []) {
    const at = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
    entries.push({ kind: "controle", at, label: e.kind === "repris" ? "Contrôle repris par Charles" : "Contrôle rendu", sort: e.at });
  }
  return entries.sort((a, b) => b.sort - a.sort).map(({ sort: _s, ...e }) => e as BrowserEntry);
}
