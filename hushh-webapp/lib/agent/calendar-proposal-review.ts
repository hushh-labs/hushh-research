export type CalendarWeeklyReview = { count: number; lastDate: string; conflictCoverage: "all_occurrences" };
export type CalendarReminderReview = { useDefault: false; overrides: { method: "popup" | "email"; minutes: number }[] };

/** Validate the existing review envelope before any Calendar confirmation. */
export function calendarProposalReviewError(payload: Record<string, unknown>): string | null {
  const incomplete = "This Calendar review is incomplete. Ask One to show the exact meeting details again.";
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (payload.type !== "calendar.execute_proposal" || !text(payload.proposalId) ||
      !["create", "reschedule", "cancel"].includes(String(payload.action)) ||
      !text(payload.title) || !text(payload.accountId) || !text(payload.calendarId) ||
      (payload.action === "create" && payload.calendarId !== "primary") ||
      (payload.calendarId !== "primary" && !text(payload.calendarLabel)) ||
      !text(payload.timeZone) || typeof payload.sendUpdates !== "boolean" ||
      !Array.isArray(payload.attendees) || payload.attendees.some(value => !text(value) || !value.includes("@")) ||
      !Array.isArray(payload.conflicts) || !text(payload.expiresAt) ||
      !text(payload.startAt) || !text(payload.endAt)) return incomplete;
  if (payload.action !== "create" && !text(payload.eventId)) return incomplete;
  if (payload.reviewContract !== undefined && payload.reviewContract !== 1) return incomplete;
  if (payload.metadataOnly !== undefined && (typeof payload.metadataOnly !== "boolean" ||
      payload.metadataOnly && (payload.action !== "reschedule" || payload.reviewContract !== 1))) return incomplete;
  if (payload.allDay !== undefined && typeof payload.allDay !== "boolean") return incomplete;
  if (payload.allDay && (!isCalendarCivilDate(payload.startAt) || !isCalendarCivilDate(payload.endAt))) return incomplete;
  if (payload.weeklyRecurrence !== undefined) {
    const weekly = payload.weeklyRecurrence as Partial<CalendarWeeklyReview> | null;
    if (payload.action !== "create" || payload.reviewContract !== 1 || !weekly ||
        !Number.isInteger(weekly.count) || Number(weekly.count) < 1 || Number(weekly.count) > 52 ||
        !isCalendarCivilDate(weekly.lastDate) || weekly.conflictCoverage !== "all_occurrences") return incomplete;
  }
  if (payload.reminders !== undefined) {
    const reminders = payload.reminders as Partial<CalendarReminderReview> | null;
    if (payload.reviewContract !== 1 || !reminders || reminders.useDefault !== false ||
        !Array.isArray(reminders.overrides) || reminders.overrides.length > 5 ||
        reminders.overrides.some(item => !item || !["popup", "email"].includes(item.method) ||
          !Number.isInteger(item.minutes) || item.minutes < 0 || item.minutes > 40320)) return incomplete;
  }
  if (payload.remindersReplacesDefaults !== undefined && (
      typeof payload.remindersReplacesDefaults !== "boolean" || payload.reminders === undefined)) return incomplete;
  if (payload.action === "reschedule" && (
      !Array.isArray(payload.attendeesAdded) || payload.attendeesAdded.some(value => !text(value)) ||
      !Array.isArray(payload.attendeesRemoved) || payload.attendeesRemoved.some(value => !text(value)) ||
      typeof payload.locationCleared !== "boolean" || typeof payload.descriptionCleared !== "boolean" ||
      payload.locationCleared !== (payload.location === "") || payload.descriptionCleared !== (payload.description === ""))) return incomplete;

  if (payload.conflicts.some(value => !value || typeof value !== "object" ||
      !text(value.title) || !text(value.startAt) || !Number.isFinite(Date.parse(value.startAt)))) return incomplete;
  try { new Intl.DateTimeFormat("en", { timeZone: payload.timeZone }).format(); }
  catch { return incomplete; }
  const boundary = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const start = Date.parse(payload.startAt), end = Date.parse(payload.endAt);
  if (!boundary(payload.startAt) || !boundary(payload.endAt) || !Number.isFinite(start) ||
      !Number.isFinite(end) || start >= end || !Number.isFinite(Date.parse(payload.expiresAt))) return incomplete;
  if (Date.parse(payload.expiresAt) <= Date.now()) return "This Calendar review expired. Ask One to check the meeting again.";
  return null;
}

export function isCalendarCivilDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Invalid envelopes show the blocking error without rendering unchecked extras. */
export function calendarProposalReviewExtras(payload: Record<string, unknown>) {
  if (calendarProposalReviewError(payload)) return {};
  return {
    metadataOnly: payload.metadataOnly === true,
    weeklyRecurrence: payload.weeklyRecurrence as CalendarWeeklyReview | undefined,
    reminders: payload.reminders as CalendarReminderReview | undefined,
    remindersReplacesDefaults: payload.remindersReplacesDefaults === true,
    attendeesAdded: Array.isArray(payload.attendeesAdded) ? payload.attendeesAdded as string[] : [],
  };
}

/** Older tools must provide the same review facts; absent facts never become defaults. */
export function legacyCalendarProposalPayload(result: Record<string, unknown>, action: string): Record<string, unknown> {
  const plan = result.plan && typeof result.plan === "object" ? result.plan as Record<string, unknown> : {};
  const current = plan.current_event && typeof plan.current_event === "object" ? plan.current_event as Record<string, unknown> : {};
  const flat = (value: unknown) => {
    if (value && typeof value === "object") {
      const boundary = value as Record<string, unknown>;
      return boundary.dateTime ?? boundary.date;
    }
    return value;
  };
  const changes = plan.attendee_change && typeof plan.attendee_change === "object" ? plan.attendee_change as Record<string, unknown> : null;
  const currentGuests = Array.isArray(current.attendees) ? current.attendees.map(item => item && typeof item === "object" ? (item as Record<string, unknown>).email : undefined) : undefined;
  const removed = Array.isArray(changes?.removed) ? changes.removed : [];
  const added = Array.isArray(changes?.added) ? changes.added : [];
  const attendees = action === "create" ? plan.attendees : action === "cancel" ? currentGuests :
    Object.hasOwn(plan, "attendees") && !changes ? undefined :
    currentGuests?.filter(email => !removed.includes(email)).concat(added);
  const conflicts = plan.conflicts ?? result.conflicts;
  const verb = action === "cancel" ? "Cancel" : action === "reschedule" ? "Reschedule" : "Schedule";
  return {
    type: "calendar.execute_proposal", proposalId: result.proposal_id, action,
    accountId: plan.account_id, calendarId: plan.calendar_id, eventId: plan.event_id,
    calendarLabel: plan.calendar_label,
    recurringEventId: plan.recurring_event_id, originalStartTime: plan.original_start_time,
    title: action === "cancel" ? current.title : plan.title ?? current.title,
    startAt: action === "cancel" ? flat(current.start) : plan.start_date ?? flat(plan.start_at),
    endAt: action === "cancel" ? flat(current.end) : plan.end_date ?? flat(plan.end_at),
    timeZone: plan.time_zone ?? (current.start && typeof current.start === "object" ? (current.start as Record<string, unknown>).timeZone : undefined) ??
      (current.end && typeof current.end === "object" ? (current.end as Record<string, unknown>).timeZone : undefined),
    attendees, sendUpdates: plan.send_updates,
    location: action === "cancel" ? current.location : plan.location ?? current.location,
    description: action === "cancel" ? current.description : plan.description ?? current.description,
    locationCleared: action === "reschedule" && plan.location === "",
    descriptionCleared: action === "reschedule" && plan.description === "",
    attendeesAdded: added, attendeesRemoved: removed,
    conflicts: Array.isArray(conflicts) ? conflicts.map(item => {
      const event = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { title: event.title, startAt: flat(event.start) };
    }) : undefined,
    expiresAt: result.expires_at, googleMeet: action === "create" && (plan.meeting_type ?? "google_meet") === "google_meet",
    ...(plan.review_contract === 1 ? { reviewContract: 1, metadataOnly: plan.preserve_time === true } : {}),
    ...(plan.all_day === true ? { allDay: true } : {}),
    ...(plan.weekly_recurrence && typeof plan.weekly_recurrence === "object" ? {
      weeklyRecurrence: { count: (plan.weekly_recurrence as Record<string, unknown>).count,
        lastDate: plan.recurrence_last_date, conflictCoverage: "all_occurrences" },
    } : {}),
    ...(plan.reminders ? { reminders: plan.reminders, remindersReplacesDefaults: plan.reminders_replaces_defaults === true } : {}),
    summary: `${verb} “${String(plan.title ?? current.title ?? "") }”`,
    confirmLabel: Array.isArray(conflicts) && conflicts.length ? `${verb} anyway` : action === "create" ? "Schedule meeting" : verb,
  };
}
