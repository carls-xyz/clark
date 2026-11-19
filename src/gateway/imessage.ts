import { OWNER_CHAT, type Hub } from "../core/hub.ts";
import { submitRequest } from "../core/submit.ts";
import type { MessagesService } from "../imessage/service.ts";

/**
 * Canal iMessage : tu écris à Clark dans ta conversation avec toi-même, depuis ton iPhone.
 * Même conversation que le web et Telegram. Pas de boutons : les accords se donnent par
 * « oui A1F3 » / « non A1F3 », les réponses aux questions par « R12 ta réponse ».
 */
export function connectIMessage(hub: Hub, svc: MessagesService) {
  svc.start({
    onRequest: (text) => {
      const r = submitRequest(hub, text, { source: "imessage" });
      if ("error" in r) void svc.say(r.error);
      else if (r.kind === "goal") void svc.say("Objectif lancé. Je te préviens quand il est atteint ou si j'ai besoin de toi.");
    },
    resolveApproval: (id, ok) => hub.resolveApproval(id, ok),
    answerQuestion: (id, text) => hub.answerQuestion(id, text),
    approve: (taskId, req) => hub.approveTask(taskId, req),
    onChange: () => hub.touch(),
  });
  if (!svc.status().self) return;
  hub.addChannel({
    name: "imessage",
    // Ce qui part sur iMessage se règle dans Réglages › Notifications (par défaut : réponses et accords).
    deliver: async (m) => {
      if (m.role !== "user" && m.chat_id === OWNER_CHAT) await svc.say(m.text);
    },
    askApproval: async (a) => void (await svc.askApproval(a.id, a.summary)),
    askQuestion: async (q) => void (await svc.askQuestion(q.id, q.agent ? `Le ${q.agent}` : "Clark", q.question)),
  });
}
