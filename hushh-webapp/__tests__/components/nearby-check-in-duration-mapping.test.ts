import { describe, expect, it } from "vitest";

import { checkInActivityLabel, nearestCheckInDurationMinutes } from "@/components/one-location/nearby-check-in/nearby-check-in-sheet";

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

describe("checkInActivityLabel", () => {
  it("journals the venue's structured name, never an address-only prediction", () => {
    expect(checkInActivityLabel({ name: "Blue Bottle Coffee" })).toBe("Blue Bottle Coffee");
    const addressOnly = { placeId: "p1", text: "742 Evergreen Terrace, Springfield, OR, USA", name: null };
    expect(checkInActivityLabel(addressOnly)).toBeNull();
    expect(checkInActivityLabel({ name: "  " })).toBeNull();
    expect(checkInActivityLabel(null)).toBeNull();
  });

  it("drops a venue named by its own street address but keeps a premise its address opens with", () => {
    expect(checkInActivityLabel({ name: "1 Market St", address: "1 Market St, San Francisco, CA 94105" })).toBeNull();
    expect(checkInActivityLabel({ name: "Phoenix Marketcity", address: "Phoenix Marketcity, Viman Nagar Road, Pune" })).toBe("Phoenix Marketcity");
  });
});
