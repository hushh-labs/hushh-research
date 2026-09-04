import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
import type { PlainLocationPoint } from "@/lib/one-location/types";

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : "0.000000";
}

export function locationLatLng(point: PlainLocationPoint): LatLngLiteral {
  return { lat: point.latitude, lng: point.longitude };
}

export function locationCoordinateQuery(point: PlainLocationPoint): string {
  return [
    formatCoordinate(point.latitude),
    formatCoordinate(point.longitude),
  ].join(",");
}

/**
 * Anything the keyless Google Maps embeds accept as a place: a coordinate we
 * hold, or a free-text address we only know as words. Surfaces that read an
 * address out of a record (an adviser's registered office, a saved place) never
 * have a lat/lng, and the embed geocodes the text for them — so the helpers
 * take either rather than forcing a caller to geocode first.
 */
export type MapsPlace = LatLngLiteral | PlainLocationPoint | string;

function placeQuery(place: MapsPlace): string {
  if (typeof place === "string") return place.trim();
  if ("lat" in place) {
    return `${formatCoordinate(place.lat)},${formatCoordinate(place.lng)}`;
  }
  return locationCoordinateQuery(place);
}

export function googleMapsLocationEmbedUrl(place: MapsPlace): string {
  const query = encodeURIComponent(placeQuery(place));
  return `https://www.google.com/maps?q=${query}&z=16&output=embed`;
}

export function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  const destination = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}

/**
 * A keyless directions embed. Google draws the route, both markers and fits the
 * viewport to them itself, so callers do not compute bounds.
 */
export function googleMapsDirectionsEmbedUrl(
  origin: MapsPlace,
  destination: MapsPlace,
): string {
  const saddr = encodeURIComponent(placeQuery(origin));
  const daddr = encodeURIComponent(placeQuery(destination));
  return `https://www.google.com/maps?saddr=${saddr}&daddr=${daddr}&output=embed`;
}

/**
 * Google's own review composer, for one place.
 *
 * Google has never shipped a write API for consumer reviews: the Places API is
 * read-only on them, and the Business Profile API only lets a business owner
 * reply on its own listing. This URL is the whole sanctioned integration. It
 * opens Google's composer — the Maps app on a phone, a web page otherwise —
 * where the person types and submits under their own Google account. Nothing
 * can be prefilled, which is why the copy beside the button has to say so.
 *
 * The query key is lowercase `placeid`. `placeId` silently lands on Google's
 * generic search page instead of the composer, so it is exactly the sort of
 * thing that gets "tidied" in review — hence the test that pins it.
 */
export function googleWriteReviewUrl(
  placeId: string | null | undefined,
): string | null {
  const normalized = String(placeId ?? "").trim();
  if (!normalized) return null;
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(normalized)}`;
}
