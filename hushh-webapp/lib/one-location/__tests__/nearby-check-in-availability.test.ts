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

  it("mounts in production so the backend capability remains authoritative", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    expect(isOneLocationNearbyCheckInAvailable()).toBe(true);
  });
});
