"use client";

import { AlertTriangle, CalendarClock } from "@/components/icons";

import { Button } from "@/components/ui/button";

export type CalendarProposalAction = "create" | "reschedule" | "cancel";

export type CalendarProposalConflict = {
  title: string | null;
  startAt: string | null;
};

export type AgentCalendarProposalCardProps = {
  action: CalendarProposalAction;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  attendees: string[];
  location: string | null;
  sendUpdates: boolean;
  conflicts: CalendarProposalConflict[];
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

const VERB_LABEL: Record<CalendarProposalAction, string> = {
  create: "Schedule",
  reschedule: "Reschedule",
  cancel: "Cancel",
};

function formatDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeOnly(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Sat, Sep 20, 3:00 PM – 3:30 PM"; falls back to just the start when there's no end. */
function formatRange(startAt: string | null, endAt: string | null): string {
  if (!startAt) return "";
  const start = formatDateTime(startAt);
  const end = endAt ? formatTimeOnly(endAt) : "";
  return end ? `${start} – ${end}` : start;
}

function attendeeSummary(attendees: string[]): string {
  if (attendees.length === 0) return "";
  if (attendees.length <= 3) return attendees.join(", ");
  return `${attendees.slice(0, 3).join(", ")} +${attendees.length - 3} more`;
}

/**
 * A structured, "One"-styled confirmation card for a Calendar
 * create/reschedule/cancel proposal (delegateAgentId "agent_calendar", type
 * "calendar.execute_proposal") -- replaces the generic summary-string
 * SpecialistDirectiveCard so the person sees the actual title/time/attendees
 * as distinct fields, not one flattened sentence, before confirming.
 *
 * `cancel` renders a visually distinct (destructive-toned) variant since,
 * unlike create/reschedule, it can't be undone from this card.
 */
export function AgentCalendarProposalCard({
  action,
  title,
  startAt,
  endAt,
  attendees,
  location,
  sendUpdates,
  conflicts,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: AgentCalendarProposalCardProps) {
  const isCancel = action === "cancel";
  const range = formatRange(startAt, endAt);
  const attendeeText = attendeeSummary(attendees);

  return (
    <div
      data-testid="agent-calendar-proposal-card"
      className={
        isCancel
          ? "rounded-2xl border border-destructive/25 bg-destructive/5 p-4"
          : "rounded-2xl border border-[color:var(--app-card-border-standard)] bg-muted/50 p-4"
      }
    >
      <div className="flex items-start gap-3">
        <div
          className={
            isCancel
              ? "grid h-9 w-9 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive"
              : "grid h-9 w-9 shrink-0 place-items-center rounded-full bg-foreground/5 text-foreground/70"
          }
        >
          {isCancel ? (
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          ) : (
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs text-muted-foreground">
            {VERB_LABEL[action]} on your calendar
          </p>
          <p className="truncate text-sm font-semibold text-foreground">
            {title || "Untitled event"}
          </p>
          {range ? <p className="text-sm text-foreground/80">{range}</p> : null}
          {location ? (
            <p className="truncate text-xs text-muted-foreground">{location}</p>
          ) : null}
          {attendeeText ? (
            <p className="truncate text-xs text-muted-foreground">
              {attendees.length === 1 ? "Attendee: " : "Attendees: "}
              {attendeeText}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {sendUpdates
              ? attendees.length > 0
                ? "Attendees will be notified."
                : "No attendees to notify."
              : "Attendees will not be notified."}
          </p>
          {conflicts.length > 0 ? (
            <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-2">
              <p className="text-xs font-medium text-destructive">
                Conflicts with {conflicts.length === 1 ? "an existing event" : "existing events"}:
              </p>
              <ul className="mt-1 space-y-0.5">
                {conflicts.map((conflict, index) => (
                  <li
                    key={`${conflict.title ?? "conflict"}-${index}`}
                    className="truncate text-xs text-destructive/90"
                  >
                    {conflict.title || "Untitled event"}
                    {conflict.startAt ? ` · ${formatDateTime(conflict.startAt)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          data-testid="agent-calendar-proposal-confirm"
          size="sm"
          variant={isCancel ? "destructive" : "default"}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Working…" : confirmLabel}
        </Button>
        <Button
          data-testid="agent-calendar-proposal-cancel"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
