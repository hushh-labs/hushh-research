import { describe, expect, it } from "vitest";

import { nearestCheckInDurationMinutes } from "@/components/one-location/nearby-check-in/nearby-check-in-sheet";

describe("nearestCheckInDurationMinutes", () => {
  it("maps an exact match straight through", () => {
    expect(nearestCheckInDurationMinutes("30")).toBe(30);
    expect(nearestCheckInDurationMinutes("60")).toBe(60);
    expect(nearestCheckInDurationMinutes("120")).toBe(120);
  });

  it.each(["20", "45", "46", "75", "90", "91", "500"])("requires an explicit choice for unsupported %s minutes", (duration) => {
    expect(nearestCheckInDurationMinutes(duration)).toBeNull();
  });

  it("returns null rather than guessing when nothing usable was said", () => {
    expect(nearestCheckInDurationMinutes(undefined)).toBeNull();
    expect(nearestCheckInDurationMinutes("")).toBeNull();
    expect(nearestCheckInDurationMinutes("a while")).toBeNull();
    expect(nearestCheckInDurationMinutes("-30")).toBeNull();
    expect(nearestCheckInDurationMinutes("0")).toBeNull();
  });
});
