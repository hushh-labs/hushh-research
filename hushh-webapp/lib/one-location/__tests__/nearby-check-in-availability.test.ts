import { afterEach, describe, expect, it, vi } from "vitest";

import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";

describe("nearby check-in availability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is available in local development without a flag", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);
  });

  /**
   * This case previously asserted that any UAT-stamped build offers the flow,
   * and that the flag is *ignored* outside production. Both assertions were the
   * bug: the public App Store and Play Store binaries are stamped
   * `NEXT_PUBLIC_APP_ENV=uat` because they ship against the UAT backend
   * (`release-ios-appstore.yml`, `ship-android-playstore-v1.yml`), so "not
   * production means safe to offer" put a presence feature the architecture doc
   * calls a simulation in front of real store users — and against the UAT
   * backend it does not fail closed the way production does.
   *
   * The contract is now explicit opt-in everywhere but local development, and
   * this test guards the store case directly.
   */
  it("stays hidden in any build that has not opted in, including store builds", () => {
    // The exact shape of a public App Store / Play Store / TestFlight build:
    // UAT-stamped, and no lane sets the flag.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(false);
  });

  it("opens in the deployed web lanes, which do pass the flag", () => {
    // `deploy-uat.yml` sends `_ONE_LOCATION_NEARBY_CHECK_IN=true`, and
    // `deploy-production.yml` sends it from the cohort dispatch input. Neither
    // deployed web surface changes behaviour under the new contract.
    vi.stubEnv("NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN", "true");

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);
  });

  it("treats anything but an exact opt-in as off, in every shipped environment", () => {
    // Only the two environments a shipped build can carry. `resolveAppEnvironment`
    // maps anything unrecognised back to development via NODE_ENV, so passing a
    // made-up value here would assert the fallback, not this gate.
    for (const environment of ["uat", "production"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", environment);
      for (const value of ["", "false", "0", "yes", "on", "1", "TRUE "]) {
        vi.stubEnv("NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN", value);
        expect(isOneLocationNearbyCheckInAvailable()).toBe(
          value.trim().toLowerCase() === "true",
        );
      }
    }
  });

  it("keeps local development open regardless of the flag", () => {
    // Turning the flow off for the people building it buys nothing; the
    // backend still admits by cohort.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN", "false");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);
  });
});
