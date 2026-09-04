import { describe, expect, it } from "vitest";

import { nearestCheckInDurationMinutes } from "@/components/one-location/nearby-check-in/nearby-check-in-sheet";

describe("nearestCheckInDurationMinutes", () => {
  it("maps an exact match straight through", () => {
    expect(nearestCheckInDurationMinutes("30")).toBe(30);
    expect(nearestCheckInDurationMinutes("60")).toBe(60);
    expect(nearestCheckInDurationMinutes("120")).toBe(120);
  });

  it("rounds to the nearest of the three fixed options the sheet offers", () => {
    expect(nearestCheckInDurationMinutes("45")).toBe(30);
    expect(nearestCheckInDurationMinutes("46")).toBe(60);
    expect(nearestCheckInDurationMinutes("90")).toBe(60);
    expect(nearestCheckInDurationMinutes("91")).toBe(120);
    expect(nearestCheckInDurationMinutes("500")).toBe(120);
  });

  it("never returns a free-form number outside 30/60/120", () => {
    const result = nearestCheckInDurationMinutes("75");
    expect([30, 60, 120]).toContain(result);
  });

  it("returns null rather than guessing when nothing usable was said", () => {
    expect(nearestCheckInDurationMinutes(undefined)).toBeNull();
    expect(nearestCheckInDurationMinutes("")).toBeNull();
    expect(nearestCheckInDurationMinutes("a while")).toBeNull();
    expect(nearestCheckInDurationMinutes("-30")).toBeNull();
    expect(nearestCheckInDurationMinutes("0")).toBeNull();
  });
});
