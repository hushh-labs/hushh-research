import { describe, expect, it } from "vitest";

import { snapToWheelDurationHours } from "@/components/one-location/redesign/duration-wheel-picker";

/**
 * The live share time editor opens on what the share has left, which is a
 * measured number (0.53 hours) rather than a chosen one. The wheel only stops
 * on 15-minute steps, so it will display 30 min for that value whatever the
 * caller is holding in state.
 *
 * Without snapping first, the two disagree: the screen reads 30 min and Save
 * sends 0.53 hours -- a change the person neither made nor saw.
 */
describe("snapToWheelDurationHours", () => {
  it("lands on the wheel's own 15-minute steps", () => {
    expect(snapToWheelDurationHours(0.5)).toBe("0.5");
    expect(snapToWheelDurationHours(1)).toBe("1");
    expect(snapToWheelDurationHours(4)).toBe("4");
  });

  it("snaps a measured remainder to the nearest step", () => {
    // 31m 48s left on a 30-minute share.
    expect(snapToWheelDurationHours(0.53)).toBe("0.5");
    // 36 minutes is nearer 30 than 45.
    expect(snapToWheelDurationHours(0.6)).toBe("0.5");
    // 40 minutes is nearer 45.
    expect(snapToWheelDurationHours(0.67)).toBe("0.75");
    // 1h 55m.
    expect(snapToWheelDurationHours(1.92)).toBe("2");
  });

  it("clamps to the grid's own ends, not to a written-down number", () => {
    // A share with three minutes left still has to open on a valid value; the
    // wheel's floor is 15 minutes and the server's is the same.
    expect(snapToWheelDurationHours(0.05)).toBe("0.25");
    // 24h0m is the ceiling: the backend caps at `le=24`, which 24.0 exactly
    // satisfies and 24h15m does not.
    //
    // This pair is the regression guard. The clamp was first written against a
    // 23h45m ceiling, the wheel gained 24h0m days later, and a hardcoded bound
    // would have quietly snapped a real 24-hour share down to 23.75.
    expect(snapToWheelDurationHours(24)).toBe("24");
    expect(snapToWheelDurationHours(30)).toBe("24");
  });

  it("falls to the shortest step for a number it cannot read", () => {
    // `grantRemainingHours` returns null for a grant with no readable expiry,
    // and a NaN reaching the wheel is a blank column.
    //
    // The floor, not the ceiling, is the right answer for "no idea": a
    // duration nobody could read must never open the editor pre-loaded on the
    // longest share the product allows.
    expect(snapToWheelDurationHours(Number.NaN)).toBe("0.25");
    expect(snapToWheelDurationHours(Number.POSITIVE_INFINITY)).toBe("0.25");
    expect(snapToWheelDurationHours(Number.NEGATIVE_INFINITY)).toBe("0.25");
  });
});
