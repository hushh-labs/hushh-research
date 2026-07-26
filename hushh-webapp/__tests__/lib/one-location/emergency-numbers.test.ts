import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMERGENCY,
  INTERNATIONAL_EMERGENCY,
  emergencyInfoForCountryCode,
  emergencyInfoForPoint,
} from "@/lib/one-location/emergency-numbers";
import type { PlainLocationPoint } from "@/lib/one-location/types";

function point(latitude: number, longitude: number): PlainLocationPoint {
  return {
    latitude,
    longitude,
    capturedAt: new Date().toISOString(),
    sourcePlatform: "web",
  };
}

describe("emergencyInfoForPoint", () => {
  it("falls back to US 911 when there is no location", () => {
    expect(emergencyInfoForPoint(null)).toEqual(DEFAULT_EMERGENCY);
    expect(emergencyInfoForPoint(undefined)).toEqual(DEFAULT_EMERGENCY);
  });

  it("resolves India (112) from New Delhi coordinates", () => {
    const info = emergencyInfoForPoint(point(28.6139, 77.209));
    expect(info.countryCode).toBe("IN");
    expect(info.number).toBe("112");
  });

  it("resolves the UAE (999) from Dubai coordinates", () => {
    const info = emergencyInfoForPoint(point(25.2048, 55.2708));
    expect(info.countryCode).toBe("AE");
    expect(info.number).toBe("999");
  });

  it("resolves the US (911) from New York coordinates", () => {
    const info = emergencyInfoForPoint(point(40.7128, -74.006));
    expect(info.countryCode).toBe("US");
    expect(info.number).toBe("911");
  });

  it("resolves the UK (999) from London coordinates", () => {
    const info = emergencyInfoForPoint(point(51.5074, -0.1278));
    expect(info.countryCode).toBe("GB");
    expect(info.number).toBe("999");
  });

  it("resolves Australia (000) from Sydney coordinates", () => {
    const info = emergencyInfoForPoint(point(-33.8688, 151.2093));
    expect(info.countryCode).toBe("AU");
    expect(info.number).toBe("000");
  });

  it("prefers the smaller country box for Singapore over Malaysia", () => {
    const info = emergencyInfoForPoint(point(1.3521, 103.8198));
    expect(info.countryCode).toBe("SG");
    expect(info.number).toBe("999");
  });

  it("falls back to the international 112 for unmapped ocean coordinates", () => {
    const info = emergencyInfoForPoint(point(0, -140));
    expect(info).toEqual(INTERNATIONAL_EMERGENCY);
    expect(info.number).toBe("112");
  });

  it("ignores NaN coordinates and returns the default", () => {
    expect(emergencyInfoForPoint(point(Number.NaN, Number.NaN))).toEqual(
      DEFAULT_EMERGENCY,
    );
  });
});

describe("emergencyInfoForCountryCode", () => {
  it("looks up a known country by ISO code", () => {
    expect(emergencyInfoForCountryCode("in")?.number).toBe("112");
    expect(emergencyInfoForCountryCode("AE")?.number).toBe("999");
  });

  it("returns null for an unknown code", () => {
    expect(emergencyInfoForCountryCode("ZZ")).toBeNull();
    expect(emergencyInfoForCountryCode("")).toBeNull();
  });
});
