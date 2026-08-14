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

  /**
   * This case previously asserted that a UAT-stamped build shows the fixture.
   * That assertion was the bug: the public App Store and Play Store builds are
   * stamped `NEXT_PUBLIC_APP_ENV=uat` because they ship against the UAT backend
   * (`release-ios-appstore.yml`, `ship-android-playstore-v1.yml`), so "UAT means
   * safe to show fifty fictional people" put them on real users' maps.
   *
   * The contract is now explicit opt-in, and this test guards the store case
   * directly.
   */
  it("stays hidden in any build that has not opted in, including store builds", () => {
    const previousEnvironment = process.env.NEXT_PUBLIC_APP_ENV;
    const previousFlag = process.env.NEXT_PUBLIC_LOCATION_MAP_DEMO;
    try {
      nativeTestHarness.enabled = false;
      delete process.env.NEXT_PUBLIC_LOCATION_MAP_DEMO;

      // The exact shape of a public App Store / Play Store build.
      process.env.NEXT_PUBLIC_APP_ENV = "uat";
      expect(isLocationMapDemoAvailable()).toBe(false);

      process.env.NEXT_PUBLIC_APP_ENV = "production";
      expect(isLocationMapDemoAvailable()).toBe(false);

      // Operators opt in explicitly, independent of which backend is targeted.
      process.env.NEXT_PUBLIC_APP_ENV = "uat";
      process.env.NEXT_PUBLIC_LOCATION_MAP_DEMO = "true";
      expect(isLocationMapDemoAvailable()).toBe(true);

      // ...but a production build refuses regardless of the flag. The opt-in
      // narrows who sees the fixture; this floor means a copied .env or an
      // inherited build-args block can never put fabricated people in front of
      // real users.
      process.env.NEXT_PUBLIC_APP_ENV = "production";
      expect(isLocationMapDemoAvailable()).toBe(false);
      delete process.env.NEXT_PUBLIC_LOCATION_MAP_DEMO;

      // Local development keeps the fixture without any flag.
      process.env.NEXT_PUBLIC_APP_ENV = "development";
      expect(isLocationMapDemoAvailable()).toBe(true);

      // Native UI tests keep it regardless of environment.
      process.env.NEXT_PUBLIC_APP_ENV = "uat";
      nativeTestHarness.enabled = true;
      expect(isLocationMapDemoAvailable()).toBe(true);
    } finally {
      process.env.NEXT_PUBLIC_APP_ENV = previousEnvironment;
      if (previousFlag === undefined) {
        delete process.env.NEXT_PUBLIC_LOCATION_MAP_DEMO;
      } else {
        process.env.NEXT_PUBLIC_LOCATION_MAP_DEMO = previousFlag;
      }
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
