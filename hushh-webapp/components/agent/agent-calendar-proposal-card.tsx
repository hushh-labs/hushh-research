"use client";

import {
  AlertTriangle,
  CalendarClock,
  CameraIcon,
  MapPinIcon,
  UsersThreeIcon,
} from "@/components/icons";

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
  googleMeet?: boolean;
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
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Sat, Sep 20, 3:00 PM – 3:30 PM"; falls back to just the start when there's no end. */
function formatRange(startAt: string | null, endAt: string | null): string {
  if (!startAt) return "";
  const start = formatDateTime(startAt);
  const end = endAt ? formatTimeOnly(endAt) : "";
  return end ? `${start} – ${end}` : start;
}

function attendeeSummary(attendees: string[]): string {
  return attendees.join(", ");
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
  googleMeet = false,
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
          ? "w-full rounded-[var(--app-card-radius-compact)] bg-destructive/5 p-4 sm:p-5"
          : "w-full rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-compact)] p-4 sm:p-5"
      }
    >
      <div className="flex items-start gap-3">
        <div
          className={
            isCancel
              ? "grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive"
              : "grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]"
          }
        >
          {isCancel ? (
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          ) : (
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {isCancel
              ? "Ready to cancel"
              : `Ready to ${VERB_LABEL[action].toLowerCase()}`}
          </p>
          <p className="mt-1 break-words text-base font-semibold text-foreground">
            {title || "Untitled event"}
          </p>
          {range ? (
            <p className="mt-1 text-sm text-foreground/75">{range}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 space-y-2 border-t border-[color:var(--app-separator)] pt-3 text-sm">
        {googleMeet ? (
          <div className="flex items-start gap-2.5 text-foreground">
            <CameraIcon className="mt-0.5 size-4 shrink-0 text-[color:var(--app-accent)]" />
            <p>
              <span className="font-semibold">Google Meet link will be included</span>
              <span className="text-muted-foreground">
                {" "}
                · created and shared in the Calendar invite after scheduling
              </span>
            </p>
          </div>
        ) : null}
        {attendeeText ? (
          <div className="flex items-start gap-2.5 text-foreground">
            <UsersThreeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="break-words text-muted-foreground">
              {attendees.length === 1 ? "Guest: " : "Guests: "}
              {attendeeText}
              {sendUpdates
                ? " · invite will be emailed"
                : " · invite will not be emailed"}
            </p>
          </div>
        ) : null}
        {location ? (
          <div className="flex items-start gap-2.5 text-muted-foreground">
            <MapPinIcon className="mt-0.5 size-4 shrink-0" />
            <p className="break-words">{location}</p>
          </div>
        ) : null}
        {!attendeeText ? (
          <p className="text-muted-foreground">
            {sendUpdates
              ? "No guests to notify."
              : "Guests will not be notified."}
          </p>
        ) : null}
      </div>

      {conflicts.length > 0 ? (
        <div className="mt-4 rounded-xl bg-destructive/10 px-3 py-3">
          <p className="text-sm font-semibold text-destructive">
            Conflicts with{" "}
            {conflicts.length === 1 ? "an existing event" : "existing events"}
          </p>
          <ul className="mt-1.5 space-y-1">
            {conflicts.map((conflict, index) => (
              <li
                key={`${conflict.title ?? "conflict"}-${index}`}
                className="break-words text-sm text-destructive/90"
              >
                {conflict.title || "Untitled event"}
                {conflict.startAt
                  ? ` · ${formatDateTime(conflict.startAt)}`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          data-testid="agent-calendar-proposal-cancel"
          size="standard"
          variant="secondary"
          disabled={busy}
          className="w-full sm:w-auto"
          onClick={onCancel}
        >
          Not now
        </Button>
        <Button
          data-testid="agent-calendar-proposal-confirm"
          size="standard"
          variant={isCancel ? "destructive" : "default"}
          disabled={busy}
          className="w-full sm:w-auto"
          onClick={onConfirm}
        >
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
