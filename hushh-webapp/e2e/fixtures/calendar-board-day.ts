/** Synthetic three-account provider response shared by the rendered board rehearsal. */
export function calendarBoardDayFixture({ day, zone, durationMinutes, now, busy, instant }: {
  day: string; zone: string; durationMinutes: number; now: number; busy: boolean;
  instant: (day: string, clock: string, zone: string) => number;
}) {
  const event = (account_id: string, id: string, title: string, first: string, last: string) => ({
    account_id, id, calendar_id: "primary", title, etag: `etag-${id}`,
    start: { dateTime: new Date(instant(day, first, zone)).toISOString() },
    end: { dateTime: new Date(instant(day, last, zone)).toISOString() },
    organizer: { email: `organizer-${id}@example.test` }, can_decline: true,
    attendees: [{ email: `qa-${account_id}@example.com`, response_status: "needsAction" }],
  });
  const first = event("default", "design", "QA Design Review", "10:00", "11:00");
  const second = event("work", "client", "QA Client Call", "10:30", "11:30");
  const third = event("projects", "focus", "QA Project Focus", "13:00", "14:00");
  const accountEvents = (firstEvent: ReturnType<typeof event>) => busy
    ? Array.from({ length: firstEvent.account_id === "default" ? 3 : firstEvent.account_id === "work" ? 4 : 12 }, (_, index) => ({ ...firstEvent, id: `${firstEvent.id}-${index}`,
      title: `${firstEvent.title} ${index + 1}`, conference_url: "https://meet.google.com/abc-defg-hij",
      ...(firstEvent.account_id === "work" && index === 3 ? { event_type: "fromGmail", transparency: "transparent", conference_url: null } : {}),
      attendees: [{ email: `qa-${firstEvent.account_id}@example.com`, self: true,
        response_status: index % 2 ? "tentative" : "needsAction" }] }))
    : [firstEvent];
  const opening = [{ start_at: new Date(instant(day, "15:00", zone)).toISOString(), end_at: new Date(instant(day, "16:00", zone)).toISOString() }];
  return { date: day, time_zone: zone, duration_minutes: durationMinutes,
    checked_at: new Date(now).toISOString(), complete: true, conflicts_complete: true,
    shared_free_windows: opening,
    conflicts: [{ left: { account_id: "default", calendar_id: "primary", event_id: "design" }, right: { account_id: "work", calendar_id: "primary", event_id: "client" }, start_at: second.start.dateTime, end_at: first.end.dateTime }],
    accounts: [
      { account_id: "default", google_email: "qa-owner@example.com", connection_status: "connected", status: "complete", checked_at: new Date(now).toISOString(), events: accountEvents(first), free_windows: opening, unreadable_calendars: [] },
      { account_id: "work", google_email: "qa-work@example.com", connection_status: "connected", status: "complete", checked_at: new Date(now).toISOString(), events: accountEvents(second), free_windows: opening, unreadable_calendars: [] },
      { account_id: "projects", google_email: "qa-projects@example.com", connection_status: "connected", status: "complete", checked_at: new Date(now).toISOString(), events: accountEvents(third), free_windows: opening, unreadable_calendars: [] },
    ],
  };
}
