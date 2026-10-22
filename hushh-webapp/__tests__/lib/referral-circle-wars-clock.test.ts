import { describe, expect, it } from "vitest";
import { circleWarsClock, circleWarsRemainingMs } from "@/lib/referral/circle-wars-clock";
import type { CircleWarsState } from "@/lib/services/circle-wars-service";

const state: CircleWarsState = {
  period: { round_id: "round", week_start: "2026-10-12", starts_at: "2026-10-12T00:00:00+05:30",
    ends_at: "2026-10-19T00:00:00+05:30", timezone: "Asia/Kolkata",
    server_now: "2026-10-18T18:29:50Z", seconds_remaining: 10 },
  participation: null, received_at_monotonic: 1000,
};

describe("Circle Wars clock", () => {
  it("retains elapsed time during later requests without using the device wall clock", () => {
    const clock = circleWarsClock(state);
    expect(circleWarsRemainingMs(clock, 4000)).toBe(7000);
    expect(circleWarsRemainingMs(clock, 12000)).toBe(0);
  });

  it("uses the persisted server deadline and its timezone offset over a rounded duration", () => {
    expect(circleWarsRemainingMs(circleWarsClock({ ...state, period: { ...state.period, seconds_remaining: 999 } }), 1000)).toBe(10000);
  });
});
