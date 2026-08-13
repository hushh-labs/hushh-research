import { beforeEach, describe, expect, it } from "vitest";

import {
  EMERGENCY_CACHE_TRUST_RADIUS_METERS,
  EMERGENCY_INFO_CACHE_KEY,
  EMERGENCY_LOOKUP_TIMEOUT_MS,
  emergencyInfoForCountryCode,
  isCachedEmergencyInfoUsableAt,
  isWithinEmergencyTrustRadius,
  readCachedEmergencyInfo,
  writeCachedEmergencyInfo,
} from "@/lib/one-location/emergency-numbers";

const DELHI = { latitude: 28.6139, longitude: 77.209 };
const CHICAGO = { latitude: 41.8781, longitude: -87.6298 };

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
    writeCachedEmergencyInfo(us, CHICAGO);
    expect(readCachedEmergencyInfo()).toEqual({
      ...us,
      lat: CHICAGO.latitude,
      lng: CHICAGO.longitude,
    });
    expect(readCachedEmergencyInfo()?.number).toBe("911");
  });

  it("re-validates a stale cached NUMBER against the country table", () => {
    // A tampered/stale entry claims the wrong digits for the country; the read
    // must trust the table, not the stored number.
    window.localStorage.setItem(
      EMERGENCY_INFO_CACHE_KEY,
      JSON.stringify({ countryCode: "US", number: "000", countryName: "Nope" }),
    );
    expect(readCachedEmergencyInfo()).toEqual({
      ...emergencyInfoForCountryCode("US"),
      lat: null,
      lng: null,
    });
    expect(readCachedEmergencyInfo()?.number).toBe("911");
  });

  it("trusts a cached country nearby and refuses it a continent away", () => {
    writeCachedEmergencyInfo(emergencyInfoForCountryCode("IN")!, DELHI);
    const cached = readCachedEmergencyInfo();

    expect(isCachedEmergencyInfoUsableAt(cached, DELHI)).toBe(true);
    // Same city, a few km out — still India.
    expect(
      isCachedEmergencyInfoUsableAt(cached, {
        latitude: 28.7041,
        longitude: 77.1025,
      }),
    ).toBe(true);
    // Flown to the US: showing 112 here would be the exact failure this guard
    // exists for. Chicago must fall back to "still checking", never to India.
    expect(isCachedEmergencyInfoUsableAt(cached, CHICAGO)).toBe(false);
  });

  it("never instantly trusts an origin-less entry, however valid its country", () => {
    // Entries written before the origin field existed, and any hand-written
    // one. The country may well be right — but nothing proves it is right HERE.
    window.localStorage.setItem(
      EMERGENCY_INFO_CACHE_KEY,
      JSON.stringify({ countryCode: "US" }),
    );
    const cached = readCachedEmergencyInfo();
    expect(cached?.number).toBe("911");
    expect(isCachedEmergencyInfoUsableAt(cached, CHICAGO)).toBe(false);
  });

  it("treats an unknown position as unknown, not as a match", () => {
    expect(isWithinEmergencyTrustRadius(DELHI, null)).toBe(false);
    expect(isWithinEmergencyTrustRadius(null, DELHI)).toBe(false);
    expect(
      isWithinEmergencyTrustRadius(DELHI, {
        latitude: Number.NaN,
        longitude: 77.209,
      }),
    ).toBe(false);
    expect(EMERGENCY_CACHE_TRUST_RADIUS_METERS).toBeGreaterThan(0);
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
