import { describe, expect, it, vi, beforeEach } from "vitest";

import { OneLocationService } from "@/lib/one-location/service";
import * as apiClient from "@/lib/services/api-client";

describe("OneLocationService maps methods", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("placesAutocomplete posts input and returns suggestions", async () => {
    const spy = vi
      .spyOn(apiClient, "apiJson")
      .mockResolvedValue({ suggestions: [{ placeId: "p1", text: "SB" }] } as never);
    const out = await OneLocationService.placesAutocomplete({
      vaultOwnerToken: "t",
      input: "SB",
    });
    expect(out).toEqual([{ placeId: "p1", text: "SB" }]);
    expect(spy).toHaveBeenCalledWith(
      "/api/one/location/maps/autocomplete",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("strictly restricts check-in autocomplete to the current search area", async () => {
    const spy = vi
      .spyOn(apiClient, "apiJson")
      .mockResolvedValue({ suggestions: [] } as never);

    await OneLocationService.placesAutocomplete({
      vaultOwnerToken: "t",
      input: "clinic",
      lat: 12.9716,
      lng: 77.5946,
      nearbyOnly: true,
    });

    expect(spy).toHaveBeenCalledWith(
      "/api/one/location/maps/autocomplete",
      expect.objectContaining({
        body: JSON.stringify({
          input: "clinic",
          lat: 12.9716,
          lng: 77.5946,
          nearbyOnly: true,
        }),
      }),
    );
  });

  it("placeDetails returns a DriveDestination", async () => {
    vi.spyOn(apiClient, "apiJson").mockResolvedValue({
      place: { placeId: "p1", label: "SB", latitude: 1, longitude: 2 },
    } as never);
    const out = await OneLocationService.placeDetails({
      vaultOwnerToken: "t",
      placeId: "p1",
    });
    expect(out).toEqual({ placeId: "p1", label: "SB", latitude: 1, longitude: 2 });
  });

  it("loads nearby places around a transient foreground point", async () => {
    const spy = vi.spyOn(apiClient, "apiJson").mockResolvedValue({
      suggestions: [{ placeId: "p1", text: "Demo Hall", distanceMeters: 42 }],
    } as never);

    const out = await OneLocationService.nearbyPlaces({
      vaultOwnerToken: "t",
      lat: 12.9716,
      lng: 77.5946,
      category: "health",
    });

    expect(out[0]?.text).toBe("Demo Hall");
    expect(spy).toHaveBeenCalledWith(
      "/api/one/location/maps/nearby-places",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          lat: 12.9716,
          lng: 77.5946,
          category: "health",
        }),
      }),
    );
  });

  it("checks in nearby with a transient foreground point and bounded duration", async () => {
    const spy = vi.spyOn(apiClient, "apiJson").mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        allowConnectionRequests: true,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: "2026-07-30T10:00:00Z",
        expiresAt: "2026-07-30T12:00:00Z",
        placeLabel: "Demo Hall",
      },
      attendees: [],
    } as never);

    const out = await OneLocationService.checkInNearby({
      vaultOwnerToken: "t",
      placeId: "p1",
      point: {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracyM: 15,
        capturedAt: "2026-07-30T10:00:00Z",
        sourcePlatform: "web",
      },
      durationMinutes: 60,
      consentAccepted: true,
      allowConnectionRequests: true,
    });

    expect(out.presence?.placeLabel).toBe("Demo Hall");
    expect(spy).toHaveBeenCalledWith(
      "/api/one/location/nearby-presence/check-in",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"placeId":"p1"'),
      }),
    );
    expect(spy.mock.calls[0]?.[1]?.body).toContain('"durationMinutes":60');
    expect(spy.mock.calls[0]?.[1]?.body).not.toContain("eventCode");
  });

  it("requests a connection using only the nearby participant alias", async () => {
    const spy = vi
      .spyOn(apiClient, "apiJson")
      .mockResolvedValue({ relationship: "pending_outgoing" } as never);

    const out = await OneLocationService.requestNearbyConnection({
      vaultOwnerToken: "t",
      participantAlias: "alias/with spaces",
    });

    expect(out.relationship).toBe("pending_outgoing");
    expect(spy).toHaveBeenCalledWith(
      "/api/one/location/nearby-presence/connection-request",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ participantAlias: "alias/with spaces" }),
      }),
    );
  });

  it("maps stable nearby check-in errors to actionable recovery", () => {
    const details = OneLocationService.nearbyCheckInErrorDetails(
      new apiClient.ApiError("too coarse", 422, {
        detail: { code: "NEARBY_PRESENCE_LOCATION_TOO_COARSE" },
      }),
    );

    expect(details).toEqual({
      message: "Turn on precise location, then try again.",
      retryLocation: true,
      openAppSettings: true,
    });
  });

  it("maps an invalidated place to a nearby-place refresh", () => {
    const details = OneLocationService.nearbyCheckInErrorDetails(
      new apiClient.ApiError("not check-inable", 422, {
        detail: { code: "ONE_LOCATION_PLACE_NOT_CHECK_INABLE" },
      }),
    );

    expect(details).toEqual({
      message: "This place is no longer available. Choose another nearby place.",
      retryLocation: false,
      openAppSettings: false,
      retryPlaces: true,
    });
  });

  it("refreshes nearby places when confirmation detects that the user moved", () => {
    const details = OneLocationService.nearbyCheckInErrorDetails(
      new apiClient.ApiError("outside", 422, {
        detail: { code: "NEARBY_PRESENCE_OUTSIDE_RADIUS" },
      }),
    );

    expect(details).toEqual({
      message: "You moved outside that place's range. Choose a nearby place again.",
      retryLocation: false,
      openAppSettings: false,
      retryPlaces: true,
    });
  });

  it("reverseGeocode returns the friendly address", async () => {
    vi.spyOn(apiClient, "apiJson").mockResolvedValue({
      place: {
        name: "Cubbon Park",
        formattedAddress: "Kasturba Road, Bengaluru, Karnataka 560001, India",
        countryCode: "IN",
      },
    } as never);
    const out = await OneLocationService.reverseGeocode({
      vaultOwnerToken: "t",
      lat: 12.9763,
      lng: 77.5929,
    });
    expect(out).toEqual({
      name: "Cubbon Park",
      formattedAddress: "Kasturba Road, Bengaluru, Karnataka 560001, India",
      countryCode: "IN",
    });
  });

  it("routeEta returns eta seconds + distance", async () => {
    vi.spyOn(apiClient, "apiJson").mockResolvedValue({
      eta: { etaSeconds: 600, distanceMeters: 5000 },
    } as never);
    const out = await OneLocationService.routeEta({
      vaultOwnerToken: "t",
      originLat: 1,
      originLng: 1,
      destLat: 2,
      destLng: 2,
    });
    expect(out).toEqual({ etaSeconds: 600, distanceMeters: 5000 });
  });
});
