import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/testing/native-test", () => ({
  isNativeUiTestSession: () => true,
}));

import {
  isLocationMapDemoAvailable,
  isLocationMapDemoEnabled,
  locationMapDemoPeople,
} from "@/lib/testing/location-map-demo";

describe("location map demo fixture", () => {
  it("requires the explicit people fixture in a native test session", () => {
    expect(isLocationMapDemoAvailable()).toBe(true);
    expect(isLocationMapDemoEnabled("people")).toBe(true);
    expect(isLocationMapDemoEnabled(null)).toBe(false);
    expect(isLocationMapDemoEnabled("true")).toBe(false);
  });

  it("uses stable fictional people and in-memory points", () => {
    const people = locationMapDemoPeople();

    expect(people).toHaveLength(3);
    expect(new Set(people.map((person) => person.key)).size).toBe(3);
    expect(people.every((person) => person.key.startsWith("demo-"))).toBe(true);
    expect(
      people.every(
        (person) =>
          Number.isFinite(person.point.latitude) &&
          Number.isFinite(person.point.longitude),
      ),
    ).toBe(true);
  });
});
