import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasServerClockOffset, observeServerDate, resetServerClock, serverNow } from "@/lib/agent/server-clock";

describe("server clock", () => {
  const deviceNow = Date.parse("2026-01-01T12:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(deviceNow);
    resetServerClock();
  });
  afterEach(() => {
    resetServerClock();
    vi.useRealTimers();
  });

  it("falls back to the device clock until a server date is observed", () => {
    expect(serverNow()).toBe(deviceNow);
  });

  it("corrects a device clock that is ahead of the server", () => {
    // Device says 12:00:00, the server says 11:55:00.
    observeServerDate("Thu, 01 Jan 2026 11:55:00 GMT", deviceNow);
    expect(serverNow()).toBe(deviceNow - 5 * 60_000 + 500);
  });

  it("corrects a device clock that is behind the server", () => {
    observeServerDate("Thu, 01 Jan 2026 12:10:00 GMT", deviceNow);
    expect(serverNow()).toBe(deviceNow + 10 * 60_000 + 500);
  });

  it("keeps tracking the server as time passes", () => {
    observeServerDate("Thu, 01 Jan 2026 11:55:00 GMT", deviceNow);
    vi.advanceTimersByTime(30_000);
    expect(serverNow()).toBe(deviceNow - 5 * 60_000 + 500 + 30_000);
  });

  it("ignores a missing, malformed or implausible header", () => {
    observeServerDate(null, deviceNow);
    observeServerDate("not a date", deviceNow);
    observeServerDate("Thu, 01 Jan 2020 00:00:00 GMT", deviceNow);
    expect(serverNow()).toBe(deviceNow);
    expect(hasServerClockOffset()).toBe(false);
  });

  it("reports whether a server date has been learned", () => {
    expect(hasServerClockOffset()).toBe(false);
    observeServerDate("Thu, 01 Jan 2026 12:00:00 GMT", deviceNow);
    expect(hasServerClockOffset()).toBe(true);
    resetServerClock();
    expect(hasServerClockOffset()).toBe(false);
  });
});
