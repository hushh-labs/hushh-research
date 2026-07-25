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

  it("reverseGeocode returns the friendly address", async () => {
    vi.spyOn(apiClient, "apiJson").mockResolvedValue({
      place: {
        name: "Cubbon Park",
        formattedAddress: "Kasturba Road, Bengaluru, Karnataka 560001, India",
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
