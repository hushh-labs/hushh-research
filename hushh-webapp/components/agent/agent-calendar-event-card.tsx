"use client";

import { Button } from "@/components/ui/button";
import type { RedactedCalendarEvent } from "@/lib/calendar/use-calendar-upcoming-events";

export type AgentCalendarEventCardProps = {
  events: RedactedCalendarEvent[];
  onDismiss: () => void;
};

function eventTimeMs(event: RedactedCalendarEvent): number {
  const raw = event.start?.dateTime ?? event.start?.date;
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** "in Xh"/"in Xm" from a dateTime; "All day" for a date-only (all-day) event. */
function timeUntil(event: RedactedCalendarEvent): string {
  if (!event.start?.dateTime) return event.start?.date ? "All day" : "";
  const then = new Date(event.start.dateTime).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((then - Date.now()) / 60000);
  if (minutes < 1) return "starting now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function EventRow({ event }: { event: RedactedCalendarEvent }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3.5 py-3">
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm font-semibold text-foreground">{event.title}</p>
        <p className="truncate text-xs text-muted-foreground">{timeUntil(event)}</p>
      </div>
    </div>
  );
}

/**
 * A one-time, inline proactive-event card for a fresh Agent One chat when
 * Calendar is connected and has real upcoming events (see
 * lib/calendar/use-calendar-upcoming-events.ts). Unlike
 * AgentGmailNudgeCard's "upcoming_meeting" nudges (parsed from .ics
 * invites, hedged copy, has a Join link), these are a direct, live Google
 * Calendar API read -- copy here is confident, not hedged. There is no
 * Join button: the redaction contract (title/start/end/status only) never
 * carries a conferencing link across the hook boundary, and the underlying
 * service never even requests one.
 */
export function AgentCalendarEventCard({ events, onDismiss }: AgentCalendarEventCardProps) {
  const sorted = [...events].sort((a, b) => eventTimeMs(a) - eventTimeMs(b)).slice(0, 3);

  if (sorted.length === 0) return null;

  const lead = sorted.length === 1 ? "One thing coming up:" : "A few things coming up:";

  return (
    <div
      data-testid="agent-calendar-event-card"
      className="rounded-2xl border border-[color:var(--app-card-border-standard)] bg-muted/50 p-4"
    >
      <p className="text-xs text-muted-foreground">Checked your calendar just now.</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{lead}</p>
      <div className="mt-3 space-y-2">
        {sorted.map((event, index) => (
          <EventRow
            key={`${event.title}-${event.start?.dateTime ?? event.start?.date ?? index}`}
            event={event}
          />
        ))}
      </div>
      <div className="mt-3">
        <Button
          data-testid="agent-calendar-event-dismiss"
          size="sm"
          variant="ghost"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
