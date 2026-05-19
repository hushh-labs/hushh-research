import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: () => Promise.reject(new Error("apiFetch is not used in this contract test")),
    getAuthHeaders: () => ({}),
  },
}));

import {
  createLocationPointFromPosition,
  hasCoordinatesInMetadata,
  isLocationAccessRequestStatus,
  isLocationContactTier,
  isLocationShareStatus,
  isPublicLocationShareState,
  isValidLocationPoint,
} from "@/lib/location-sharing/contract";
import {
  DEFAULT_PUBLIC_LIVE_POLL_INTERVAL_MS,
  buildLocationShareMessage,
  buildMapsUrls,
  buildOpenStreetMapEmbedUrl,
  buildSharedLocationUrl,
  buildWhatsAppShareUrl,
} from "@/lib/location-sharing/service";

describe("KAI location sharing contract", () => {
  it("validates bounded enum values", () => {
    expect(isLocationContactTier("family")).toBe(true);
    expect(isLocationContactTier("coworker")).toBe(false);
    expect(isLocationShareStatus("deactivated")).toBe(true);
    expect(isLocationShareStatus("pending")).toBe(false);
    expect(isLocationAccessRequestStatus("auto_approved")).toBe(true);
    expect(isLocationAccessRequestStatus("revoked")).toBe(false);
    expect(isPublicLocationShareState("invalid")).toBe(true);
  });

  it("validates latest-only GPS points", () => {
    expect(
      isValidLocationPoint({
        latitude: 37.7749,
        longitude: -122.4194,
        accuracyM: 12,
        capturedAt: "2026-05-19T00:00:00.000Z",
        sourcePlatform: "web",
      })
    ).toBe(true);

    expect(
      isValidLocationPoint({
        latitude: 120,
        longitude: -122.4194,
        capturedAt: "2026-05-19T00:00:00.000Z",
        sourcePlatform: "web",
      })
    ).toBe(false);
  });

  it("creates sanitized web location points from browser coordinates", () => {
    const point = createLocationPointFromPosition(
      {
        coords: {
          latitude: 12.9716,
          longitude: 77.5946,
          accuracy: 9,
          altitude: null,
          altitudeAccuracy: null,
          heading: Number.NaN,
          speed: null,
        },
        timestamp: Date.parse("2026-05-19T01:02:03.000Z"),
      } as GeolocationPosition,
      "web"
    );

    expect(point).toMatchObject({
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyM: 9,
      headingDeg: null,
      speedMps: null,
      capturedAt: "2026-05-19T01:02:03.000Z",
      sourcePlatform: "web",
    });
  });

  it("detects coordinate keys inside notification or event metadata", () => {
    expect(
      hasCoordinatesInMetadata({
        requestId: "req_1",
        nested: [{ note: "safe" }, { longitude: -122.4194 }],
      })
    ).toBe(true);
    expect(hasCoordinatesInMetadata({ requestId: "req_1", route: "/kai/location" })).toBe(false);
  });

  it("builds bearer share and maps URLs without exposing extra state", () => {
    const point = { latitude: 37.7749, longitude: -122.4194 };
    const url = buildSharedLocationUrl("token with spaces");
    const maps = buildMapsUrls(point);
    const osm = buildOpenStreetMapEmbedUrl(point);
    const message = buildLocationShareMessage(url);
    const whatsAppUrl = buildWhatsAppShareUrl(url);

    expect(url).toContain("/location/shared?token=token%20with%20spaces");
    expect(message).toContain(url);
    expect(message).toContain("24 hours");
    expect(whatsAppUrl).toBe(`https://wa.me/?text=${encodeURIComponent(message)}`);
    expect(DEFAULT_PUBLIC_LIVE_POLL_INTERVAL_MS).toBe(10_000);
    expect(maps.google).toBe("https://www.google.com/maps?q=37.7749%2C-122.4194");
    expect(maps.apple).toContain("https://maps.apple.com/");
    expect(maps.osmEmbed).toBe(osm);
    expect(osm).toContain("openstreetmap.org/export/embed.html");
    expect(osm).toContain("marker=37.7749%2C-122.4194");
  });
});
