import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCalendarSetupOAuthReturn,
  consumeCalendarSetupOAuthReturn,
  markCalendarSetupOAuthReturn,
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
});
