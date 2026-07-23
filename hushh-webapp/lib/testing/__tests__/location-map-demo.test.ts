import { describe, expect, it, vi } from "vitest";

const nativeTestHarness = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/lib/testing/native-test", () => ({
  isNativeUiTestSession: () => nativeTestHarness.enabled,
}));

import {
  isLocationMapDemoAvailable,
  isLocationMapDemoEnabled,
  locationMapDemoPeople,
} from "@/lib/testing/location-map-demo";

describe("location map demo fixture", () => {
  it("requires the explicit people fixture in a native test session", () => {
    nativeTestHarness.enabled = true;
    expect(isLocationMapDemoAvailable()).toBe(true);
    expect(isLocationMapDemoEnabled("people")).toBe(true);
    expect(isLocationMapDemoEnabled(null)).toBe(false);
    expect(isLocationMapDemoEnabled("true")).toBe(false);
  });

  it("is available in UAT but stays hidden in ordinary production", () => {
    const previousEnvironment = process.env.NEXT_PUBLIC_APP_ENV;
    try {
      nativeTestHarness.enabled = false;
      process.env.NEXT_PUBLIC_APP_ENV = "uat";
      expect(isLocationMapDemoAvailable()).toBe(true);
      process.env.NEXT_PUBLIC_APP_ENV = "production";
      expect(isLocationMapDemoAvailable()).toBe(false);
      nativeTestHarness.enabled = true;
      expect(isLocationMapDemoAvailable()).toBe(true);
    } finally {
      process.env.NEXT_PUBLIC_APP_ENV = previousEnvironment;
      nativeTestHarness.enabled = true;
    }
  });

  it("uses stable fictional people and in-memory points", () => {
    const people = locationMapDemoPeople();

    expect(people).toHaveLength(50);
    expect(new Set(people.map((person) => person.key)).size).toBe(50);
    expect(new Set(people.map((person) => person.label)).size).toBe(50);
    expect(people.every((person) => person.key.startsWith("demo-"))).toBe(true);
    expect(
      people.every(
        (person) =>
          Number.isFinite(person.point.latitude) &&
          Number.isFinite(person.point.longitude),
      ),
    ).toBe(true);
    expect(people.some((person) => person.point.latitude < 0)).toBe(true);
    expect(people.some((person) => person.point.latitude > 0)).toBe(true);
    expect(people.some((person) => person.point.longitude < -100)).toBe(true);
    expect(people.some((person) => person.point.longitude > 100)).toBe(true);
  });
});
