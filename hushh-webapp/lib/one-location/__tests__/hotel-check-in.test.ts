import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isOneHotelCheckInEnabled,
  isOneHotelCheckInUatDemoEnabled,
  resolveOneHotelCheckInEligibility,
} from "@/lib/one-location/hotel-check-in";

describe("hotel check-in eligibility", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed by default", async () => {
    expect(isOneHotelCheckInEnabled()).toBe(false);
    await expect(
      resolveOneHotelCheckInEligibility({
        userId: "user-1",
        stayId: "stay-1",
      }),
    ).resolves.toEqual({
      eligible: false,
      reason: "feature_disabled",
    });
  });

  it("does not enable UAT demo behavior without the explicit demo flag", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("ONE_HOTEL_CHECK_IN_ENABLED", "true");
    expect(isOneHotelCheckInEnabled()).toBe(true);
    expect(isOneHotelCheckInUatDemoEnabled()).toBe(false);
  });

  it("keeps the default provider fail-closed after the feature flag opens", async () => {
    vi.stubEnv("ONE_HOTEL_CHECK_IN_ENABLED", "true");

    await expect(
      resolveOneHotelCheckInEligibility({
        userId: "user-1",
        stayId: "opaque-stay",
      }),
    ).resolves.toEqual({
      eligible: false,
      reason: "provider_unavailable",
    });
  });

  it("requires an opaque stay id and a signed-in user", async () => {
    vi.stubEnv("ONE_HOTEL_CHECK_IN_ENABLED", "true");

    await expect(
      resolveOneHotelCheckInEligibility({
        userId: "user-1",
        stayId: "",
      }),
    ).resolves.toEqual({ eligible: false, reason: "missing_stay" });
    await expect(
      resolveOneHotelCheckInEligibility({
        userId: null,
        stayId: "opaque-stay",
      }),
    ).resolves.toEqual({ eligible: false, reason: "missing_stay" });
  });
});
