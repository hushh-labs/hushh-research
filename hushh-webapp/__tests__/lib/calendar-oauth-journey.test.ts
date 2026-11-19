import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCalendarSetupOAuthReturn,
  consumeCalendarSetupOAuthReturn,
  markCalendarSetupOAuthReturn,
  markCalendarMeetingOAuthReturn,
  consumeCalendarMeetingOAuthReturn,
} from "@/lib/calendar/calendar-oauth-journey";

describe("Calendar OAuth setup continuation", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    clearCalendarSetupOAuthReturn();
  });

  it("returns to setup exactly once after setup-originated authorization", () => {
    markCalendarSetupOAuthReturn();

    expect(consumeCalendarSetupOAuthReturn()).toBe(true);
    expect(consumeCalendarSetupOAuthReturn()).toBe(false);
  });

  it("does not redirect a normal Calendar connection through setup", () => {
    expect(consumeCalendarSetupOAuthReturn()).toBe(false);
  });

  it("restores only the matching owner's exact meeting library coordinates once", () => {
    const context = { accountId: "calendar-2", day: "2026-10-27", timeZone: "Asia/Kolkata",
      filter: "notes" as const, query: "Growth Sync" };
    markCalendarMeetingOAuthReturn("owner", context);
    expect(consumeCalendarMeetingOAuthReturn("other-owner")).toBeNull();
    expect(consumeCalendarMeetingOAuthReturn("owner")).toBeNull();
    markCalendarMeetingOAuthReturn("owner", context);
    expect(consumeCalendarMeetingOAuthReturn("owner")).toEqual(context);
    expect(consumeCalendarMeetingOAuthReturn("owner")).toBeNull();
  });

  it("restores the open meeting and the chosen files with the day, and rejects malformed ones", () => {
    const context = { accountId: "calendar-2", day: "2026-10-27", timeZone: "Asia/Kolkata", filter: "all" as const,
      query: "", occurrenceId: "a".repeat(64), requestedTypes: ["recording" as const, "notes" as const] };
    markCalendarMeetingOAuthReturn("owner", context);
    expect(consumeCalendarMeetingOAuthReturn("owner")).toEqual(context);

    const base = { accountId: "calendar-2", day: "2026-10-27", timeZone: "UTC", filter: "all" as const, query: "" };
    for (const bad of [
      { ...base, occurrenceId: "../etc" }, { ...base, occurrenceId: 7 },
      { ...base, requestedTypes: ["video"] }, { ...base, requestedTypes: ["notes", "notes", "notes"] },
      { ...base, requestedTypes: "notes" },
    ]) {
      markCalendarMeetingOAuthReturn("owner", bad as never);
      expect(consumeCalendarMeetingOAuthReturn("owner")).toBeNull();
    }
    // A context from before these fields existed still restores the day.
    markCalendarMeetingOAuthReturn("owner", base);
    expect(consumeCalendarMeetingOAuthReturn("owner")).toEqual(base);
  });
});
