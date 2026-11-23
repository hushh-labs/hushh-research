import type { GoogleCalendarStatus } from "@/lib/services/google-calendar-service";

export type CalendarPermission = {
  id: string;
  label: string;
  status: "Allowed" | "Allowed · review required" | "Not enabled";
};

/** Presentation only: these rows never grant permission or authorize an action. */
export function calendarPermissionRows(access: {
  read: boolean;
  manage: boolean;
  availability?: boolean;
  calendarList?: boolean;
  invitations?: boolean;
}): CalendarPermission[] {
  const row = (id: string, label: string, allowed: boolean, review = false): CalendarPermission => ({
    id, label, status: allowed ? review ? "Allowed · review required" : "Allowed" : "Not enabled",
  });
  return [
    row("read", "Read events", access.read),
    ...(access.availability !== undefined ? [row("availability", "Check availability", access.availability)] : []),
    ...(access.calendarList !== undefined ? [row("calendars", "View calendars", access.calendarList)] : []),
    row("create", "Create events", access.manage, true),
    row("reschedule", "Reschedule events", access.manage, true),
    row("cancel", "Cancel events", access.manage, true),
    ...(access.invitations !== undefined ? [row("invitations", "Respond to invitations", access.invitations, true)] : []),
  ];
}

/** Project the active provider grant, including older broad Google grants. */
export function googleCalendarPermissions(status: GoogleCalendarStatus | null): {
  rows: CalendarPermission[];
  manage: boolean;
} {
  const active = status?.connected === true && status.status === "connected";
  const scopes = new Set((status?.scope_csv ?? "").split(/\s+/));
  const has = (...names: string[]) => active && names.some(name => scopes.has(`https://www.googleapis.com/auth/${name}`));
  const manage = status?.access_level === "manage" && has("calendar.events", "calendar");
  return {
    manage,
    rows: calendarPermissionRows({
      read: has("calendar.events.readonly", "calendar.events", "calendar.readonly", "calendar"),
      manage,
      availability: has("calendar.freebusy", "calendar.events.freebusy", "calendar.readonly", "calendar"),
      calendarList: active && status?.calendar_list_access === true,
      invitations: manage,
    }),
  };
}
