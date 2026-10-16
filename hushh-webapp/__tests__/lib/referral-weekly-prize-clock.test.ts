import { describe, expect, it } from "vitest";
import type { WeeklyChallenge } from "@/lib/services/referral-service";
import { formatWeeklyPrizeCountdown, weeklyPrizeRemainingMs } from "@/lib/referral/weekly-prize-clock";

const challenge: WeeklyChallenge = {
  active: true, campaign_active: true, weekly_prizes_enabled: true,
  week_started_at: "2026-10-12T00:00:00+05:30", cutoff_at: "2026-10-19T00:00:00+05:30",
  timezone: "Asia/Kolkata", server_now: "2026-10-18T18:29:50Z", received_at_monotonic: 1000,
};

describe("weekly prize clock", () => {
  it("uses elapsed monotonic time and estimated transport instead of the device date", () => {
    expect(weeklyPrizeRemainingMs({ ...challenge, estimated_transit_ms: 250 }, 2500)).toBe(8250);
    expect(weeklyPrizeRemainingMs(challenge, 12000)).toBe(0);
  });

  it.each([
    { weekly_prizes_enabled: false }, { weekly_prizes_enabled: undefined },
    { campaign_active: false }, { campaign_active: undefined }, { active: false },
    { server_now: "invalid" }, { cutoff_at: "invalid" }, { received_at_monotonic: undefined },
    { received_at_monotonic: Infinity }, { estimated_transit_ms: -1 },
  ])("does not invent a running countdown for %j", (change) => {
    expect(weeklyPrizeRemainingMs({ ...challenge, ...change }, 1000)).toBeNull();
  });

  it("rejects a monotonic timestamp from a different page session", () => {
    expect(weeklyPrizeRemainingMs(challenge, 500)).toBeNull();
  });

  it("shows explicit units and never a negative or invalid duration", () => {
    expect(formatWeeklyPrizeCountdown((56 * 3600 + 21 * 60 + 21) * 1000)).toBe("2d 08h 21m 21s");
    expect(formatWeeklyPrizeCountdown(-1)).toBe("00h 00m 00s");
    expect(formatWeeklyPrizeCountdown(NaN)).toBe("—");
  });
});
