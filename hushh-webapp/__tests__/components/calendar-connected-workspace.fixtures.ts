/** Shared Calendar account and day data for connected-workspace tests. */
export const status = {
  configured: true, connected: true, status: "connected" as const,
  google_email: "owner@example.com", access_level: "manage" as const,
  calendar_list_access: true, scope_csv: "calendar.events calendar.freebusy calendar.calendarlist.readonly",
};

export const dailyEvents = [
  {
    id: "future", calendar_id: "primary", title: "Next planning session", status: "confirmed",
    start: { dateTime: "2026-10-14T08:00:00Z" }, end: { dateTime: "2026-10-14T08:30:00Z" },
    can_decline: true, organizer: { email: "organizer@example.com" },
  },
  {
    id: "ongoing", calendar_id: "primary", title: "Current partner meeting", status: "confirmed",
    start: { dateTime: "2026-10-14T05:45:00Z" }, end: { dateTime: "2026-10-14T06:30:00Z" },
    description: "Review the implementation and blockers.", location: "Office",
    conference_url: "https://meet.google.com/abc-defg-hij",
    can_decline: true, organizer: { email: "organizer@example.com" },
  },
  {
    id: "all-day", calendar_id: "primary", title: "Team retreat", status: "confirmed",
    start: { date: "2026-10-14" }, end: { date: "2026-10-15" },
  },
];
