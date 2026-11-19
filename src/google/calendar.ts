import { googleFetch } from "./auth.ts";

/** Google Agenda, en lecture seule : les événements de tes agendas affichés, sur une période. */
const API = "https://www.googleapis.com/calendar/v3";

export type CalendarEvent = { calendar: string; title: string; start: string; end: string; allDay: boolean; location: string; description: string; attendees: string[] };

export async function listEvents(from: Date, to: Date, fetchImpl?: typeof fetch): Promise<CalendarEvent[]> {
  const cals = await googleFetch<{ items?: { id: string; summary: string; selected?: boolean; primary?: boolean }[] }>(`${API}/users/me/calendarList?minAccessRole=reader`, {}, fetchImpl);
  const shown = (cals.items ?? []).filter((c) => c.selected || c.primary).slice(0, 10);
  const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "100" });
  const lists = await Promise.all(
    shown.map(async (c) => {
      const r = await googleFetch<{ items?: any[] }>(`${API}/calendars/${encodeURIComponent(c.id)}/events?${params}`, {}, fetchImpl);
      return (r.items ?? [])
        .filter((e) => e.status !== "cancelled")
        .map(
          (e): CalendarEvent => ({
            calendar: c.primary ? "principal" : c.summary,
            title: e.summary ?? "(sans titre)",
            start: e.start?.dateTime ?? e.start?.date ?? "",
            end: e.end?.dateTime ?? e.end?.date ?? "",
            allDay: !e.start?.dateTime,
            location: e.location ?? "",
            description: (e.description ?? "").slice(0, 500),
            attendees: (e.attendees ?? []).map((a: any) => a.displayName || a.email).slice(0, 15),
          }),
        );
    }),
  );
  return lists.flat().sort((a, b) => a.start.localeCompare(b.start));
}

export function formatEvents(events: CalendarEvent[]): string {
  if (!events.length) return "Aucun événement sur cette période.";
  const fmt = (iso: string, allDay: boolean) =>
    allDay
      ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })
      : new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return events
    .map((e) => {
      const when = e.allDay ? `${fmt(e.start, true)} (journée)` : `${fmt(e.start, false)} → ${new Date(e.end).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })}`;
      const extra = [e.location && `lieu : ${e.location}`, e.attendees.length && `avec : ${e.attendees.join(", ")}`, e.calendar !== "principal" && `agenda : ${e.calendar}`].filter(Boolean).join(" ; ");
      return `- ${when} — ${e.title}${extra ? ` (${extra})` : ""}${e.description ? `\n  ${e.description.replace(/\s+/g, " ")}` : ""}`;
    })
    .join("\n");
}
