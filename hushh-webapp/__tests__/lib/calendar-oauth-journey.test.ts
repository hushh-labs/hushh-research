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
});
