import type { Config } from "../config.ts";
import { dueSlot, type Automation, type Automations } from "./automations.ts";
import type { Store } from "../memory/store.ts";

const BRIEF_PROMPT = `C'est l'heure du brief du matin. Sans que Charles ait rien demandé :
- cherche dans ta mémoire (recall) les échéances, rendez-vous, rappels et projets en cours qui concernent aujourd'hui ou les prochains jours ;
- regarde son agenda du jour et du lendemain (calendar_events, days: 2) et ses mails non lus des dernières 24 h (mail_search « is:unread newer_than:1d ») ; signale ceux qui demandent une réponse ;
- fais-en un brief de 5 lignes maximum, le plus urgent en premier ;
- termine par une seule suggestion concrète pour sa journée, si tu en as une utile.
Si Google n'est pas connecté, dis-le en une ligne et n'invente rien. S'il n'y a rien de notable, dis-le en une ligne.`;

/**
 * Conversation à part du brief : il ne s'écrit plus dans la tienne, il se lit dans le
 * Calendrier (au-delà des plages des objectifs, du dev et des automatisations).
 */
export const BRIEF_CHAT = 7_000_000;
export const BRIEF_LABEL = "brief";

/**
 * Proactivité, version MVP : un tour d'horloge par minute, et le brief du matin
 * à l'heure choisie, une fois par jour (même après un redémarrage).
 * Le heartbeat « qu'est-ce qui mérite mon attention ? » arrive en V1.
 */
type Enqueue = (chatId: number, prompt: string, label: string, source?: string, opts?: { onCreated?: (taskId: number) => void }) => Promise<unknown>;

/**
 * Lance les automatisations dues. Chaque occurrence est réservée (claimSlot) avant
 * d'être lancée : jamais deux fois, même si Clark s'arrête juste après.
 */
export type Launch = (a: Automation, slot: string) => unknown;

export function runDueAutomations(automations: Automations, launch: Launch, now = new Date()): number {
  let launched = 0;
  for (const a of automations.list()) {
    const slot = dueSlot(a, now);
    if (!slot || !automations.claimSlot(a.id, slot)) continue;
    launched++;
    void launch(a, slot);
  }
  return launched;
}

/**
 * Proactivité : un tour d'horloge par minute. Le brief du matin à l'heure choisie
 * (une fois par jour, même après un redémarrage) et les automatisations planifiées.
 */
export function startScheduler(deps: { config: Config; store: Store; enqueue: Enqueue; automations?: Automations; launch?: Launch }) {
  const { config, store, enqueue, automations, launch } = deps;

  const tick = () => {
    if (automations && launch) runDueAutomations(automations, launch);
    if (config.briefHour === null) return;
    const hour = Number(new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", hour: "numeric" }));
    if (hour !== config.briefHour || store.ranToday(BRIEF_LABEL)) return;
    // Marque le brief tout de suite pour ne pas le relancer à la minute suivante.
    store.addSpend(0, BRIEF_LABEL);
    void enqueue(BRIEF_CHAT, BRIEF_PROMPT, BRIEF_LABEL);
  };

  tick();
  const timer = setInterval(tick, 60_000);
  return () => clearInterval(timer);
}
