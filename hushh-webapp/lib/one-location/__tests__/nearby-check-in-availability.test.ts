import { afterEach, describe, expect, it, vi } from "vitest";

import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";

describe("nearby check-in availability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is available in development and UAT", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);
  });

  it("fails closed in production", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(false);
  });

  it("stays closed in production for anything but an explicit opt-in", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    for (const value of ["", "false", "0", "yes", "on", "1", "TRUE "]) {
      vi.stubEnv("NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN", value);
      expect(isOneLocationNearbyCheckInAvailable()).toBe(
        value.trim().toLowerCase() === "true",
      );
    }
  });

  it("opens in production only when the build opts in", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN", "true");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);
  });

  it("ignores the flag outside production", () => {
    // The backend admits by cohort regardless, so a non-production build has
    // nothing to gain from being able to switch this off here.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN", "false");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);
  });
});
