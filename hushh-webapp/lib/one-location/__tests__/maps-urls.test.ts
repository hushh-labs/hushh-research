import { describe, expect, it } from "vitest";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import {
  googleMapsDirectionsUrl,
  googleMapsLocationEmbedUrl,
  locationCoordinateQuery,
  locationLatLng,
} from "@/lib/one-location/maps-urls";

const point: PlainLocationPoint = {
  latitude: 12.9716,
  longitude: 77.5946,
  capturedAt: "2026-07-08T00:00:00.000Z",
  sourcePlatform: "web",
};

describe("maps-urls", () => {
  it("returns a lat/lng literal", () => {
    expect(locationLatLng(point)).toEqual({ lat: 12.9716, lng: 77.5946 });
  });

  it("formats the coordinate query to 6 decimals", () => {
    expect(locationCoordinateQuery(point)).toBe("12.971600,77.594600");
  });

  it("builds an embeddable maps url", () => {
    const url = googleMapsLocationEmbedUrl(point);
    expect(url).toContain("output=embed");
    expect(url).toContain(encodeURIComponent("12.971600,77.594600"));
  });

  it("builds a driving directions url", () => {
    const url = googleMapsDirectionsUrl(point);
    expect(url).toContain("dir/?api=1");
    expect(url).toContain("travelmode=driving");
  });
});
