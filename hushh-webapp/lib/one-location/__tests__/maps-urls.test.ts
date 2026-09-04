import { describe, expect, it } from "vitest";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import {
  googleWriteReviewUrl,
  googleMapsDirectionsUrl,
  googleMapsDirectionsEmbedUrl,
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

describe("googleMapsDirectionsEmbedUrl", () => {
  it("builds a keyless directions embed with saddr and daddr", () => {
    const url = googleMapsDirectionsEmbedUrl(
      { lat: 12.9716, lng: 77.5946 },
      { lat: 28.5562, lng: 77.1 },
    );
    expect(url).toContain("output=embed");
    expect(url).toContain(`saddr=${encodeURIComponent("12.971600,77.594600")}`);
    expect(url).toContain(`daddr=${encodeURIComponent("28.556200,77.100000")}`);
  });

  it("accepts a text address as a destination", () => {
    const url = googleMapsDirectionsEmbedUrl(
      { lat: 12.9716, lng: 77.5946 },
      "4050 E. Cotton Center Blvd., Phoenix, 85040",
    );
    expect(url).toContain(`saddr=${encodeURIComponent("12.971600,77.594600")}`);
    expect(url).toContain(
      `daddr=${encodeURIComponent("4050 E. Cotton Center Blvd., Phoenix, 85040")}`,
    );
  });

  it("accepts a text address for the single-location embed", () => {
    const url = googleMapsLocationEmbedUrl("Phoenix, 85040");
    expect(url).toContain("output=embed");
    expect(url).toContain(`q=${encodeURIComponent("Phoenix, 85040")}`);
  });
});

describe("googleWriteReviewUrl", () => {
  it("uses the lowercase key Google's composer actually accepts", () => {
    // `placeId` silently lands on Google's generic search page instead of the
    // review composer. It is exactly the kind of thing "tidied" in review, so
    // the exact string is pinned rather than described.
    expect(googleWriteReviewUrl("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe(
      "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4",
    );
  });

  it("percent-encodes a place id that would otherwise break the query", () => {
    expect(googleWriteReviewUrl("a+b/c")).toBe(
      "https://search.google.com/local/writereview?placeid=a%2Bb%2Fc",
    );
  });

  it("returns null rather than a broken link when there is no place id", () => {
    // The button is then simply absent. A disabled control explaining that we
    // could not find the place is a second failure for something nobody asked
    // for.
    expect(googleWriteReviewUrl("")).toBeNull();
    expect(googleWriteReviewUrl("   ")).toBeNull();
    expect(googleWriteReviewUrl(null)).toBeNull();
    expect(googleWriteReviewUrl(undefined)).toBeNull();
  });
});
