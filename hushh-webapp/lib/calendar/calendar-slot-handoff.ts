/** Memory-only selection from a successful availability read; never write authority. */
export type CalendarSlotHandoff = {
  ownerId: string;
  accountEmail: string;
  date: string;
  windowStart: string;
  windowEnd: string;
  durationMinutes: 15 | 30 | 60;
  timeZone: string;
};

export function earliestCalendarSlot(slot: CalendarSlotHandoff, now = Date.now()) {
  const start = Math.max(Date.parse(slot.windowStart), Math.ceil(now / 60000) * 60000);
  const end = start + slot.durationMinutes * 60000;
  if (![15, 30, 60].includes(slot.durationMinutes) || !Number.isFinite(start) ||
      !Number.isFinite(Date.parse(slot.windowEnd)) || end > Date.parse(slot.windowEnd)) return null;
  return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
}

export function calendarSlotInstruction(slot: CalendarSlotHandoff, now = Date.now()): string | null {
  const suggested = earliestCalendarSlot(slot, now);
  if (!suggested) return null;
  return [
    "Calendar Free time selection (context only, not authorization to create an event):",
    JSON.stringify({ date: slot.date, windowStart: slot.windowStart, windowEnd: slot.windowEnd,
      durationMinutes: slot.durationMinutes, timeZone: slot.timeZone, accountEmail: slot.accountEmail, ...suggested }),
    "The user was asked Who should join? Their message supplies the attendee or changes this request.",
    "The selected window and duration are mandatory constraints. Every proposal must fit entirely inside that window with exactly the selected duration. Use the suggested earliest fitting time unless the user chooses another fitting start. Default the title to Meeting with the attendee; do not ask for a title.",
    "Resolve the attendee through existing tools if needed. Recheck availability and show the existing Calendar proposal with exact time, duration, title and attendees for explicit confirmation. Never create or send an invitation from this context alone.",
  ].join("\n");
}

/** UI constraint check only; execution still uses the server-persisted proposal and conflict recheck. */
export function calendarSlotProposalError(slot: CalendarSlotHandoff, payload: Record<string, unknown>, now = Date.now()): string | null {
  const start = typeof payload.startAt === "string" ? Date.parse(payload.startAt) : NaN;
  const end = typeof payload.endAt === "string" ? Date.parse(payload.endAt) : NaN;
  if (payload.action !== "create" || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < Date.parse(slot.windowStart) || end > Date.parse(slot.windowEnd) ||
      end - start !== slot.durationMinutes * 60000) {
    return "This proposal does not fit your selected window and duration. Choose a fitting time before scheduling.";
  }
  if (start < now || (typeof payload.expiresAt === "string" && Date.parse(payload.expiresAt) <= now)) {
    return "This proposed time has expired. Ask One to check a new time before scheduling.";
  }
  if (!Array.isArray(payload.attendees) || !payload.attendees.length || payload.attendees.some(value => typeof value !== "string" || !value.trim()) ||
      typeof payload.title !== "string" || !payload.title.trim()) {
    return "Ask One to finish the meeting title and attendee details before scheduling.";
  }
  if (Array.isArray(payload.conflicts) && payload.conflicts.length) {
    return "This time is no longer free. Ask One to check newly available times.";
  }
  return null;
}

/** Offer quarter-hour steps from the earliest fitting minute, bounded by the real window. */
export function calendarSlotStarts(slot: CalendarSlotHandoff, now = Date.now()): string[] {
  const first = earliestCalendarSlot(slot, now);
  if (!first) return [];
  const starts: string[] = [];
  const last = Date.parse(slot.windowEnd) - slot.durationMinutes * 60000;
  for (let start = Date.parse(first.startAt); start <= last && starts.length < 101; start += 15 * 60000) starts.push(new Date(start).toISOString());
  return starts;
}
