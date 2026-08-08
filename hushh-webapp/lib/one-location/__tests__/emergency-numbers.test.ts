import { beforeEach, describe, expect, it } from "vitest";

import {
  EMERGENCY_INFO_CACHE_KEY,
  EMERGENCY_LOOKUP_TIMEOUT_MS,
  emergencyInfoForCountryCode,
  readCachedEmergencyInfo,
  writeCachedEmergencyInfo,
} from "@/lib/one-location/emergency-numbers";

describe("emergency-number local cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("has a sane lookup timeout", () => {
    expect(EMERGENCY_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);
    expect(EMERGENCY_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("reads back the number written to the cache instantly (no network)", () => {
    const us = emergencyInfoForCountryCode("US")!;
    writeCachedEmergencyInfo(us);
    expect(readCachedEmergencyInfo()).toEqual(us);
  });

  it("re-validates a stale cached NUMBER against the country table", () => {
    // A tampered/stale entry claims the wrong digits for the country; the read
    // must trust the table, not the stored number.
    window.localStorage.setItem(
      EMERGENCY_INFO_CACHE_KEY,
      JSON.stringify({ countryCode: "US", number: "000", countryName: "Nope" }),
    );
    expect(readCachedEmergencyInfo()).toEqual(
      emergencyInfoForCountryCode("US"),
    );
    expect(readCachedEmergencyInfo()?.number).toBe("911");
  });

  it("returns null when nothing is cached", () => {
    expect(readCachedEmergencyInfo()).toBeNull();
  });

  it("returns null for a corrupt cache entry (graceful)", () => {
    window.localStorage.setItem(EMERGENCY_INFO_CACHE_KEY, "{not json");
    expect(readCachedEmergencyInfo()).toBeNull();
  });

  it("returns null when the cached country is no longer known", () => {
    window.localStorage.setItem(
      EMERGENCY_INFO_CACHE_KEY,
      JSON.stringify({ countryCode: "ZZ" }),
    );
    expect(readCachedEmergencyInfo()).toBeNull();
  });
});
