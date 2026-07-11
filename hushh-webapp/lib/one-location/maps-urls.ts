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

export function googleMapsLocationEmbedUrl(point: PlainLocationPoint): string {
  const query = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps?q=${query}&z=16&output=embed`;
}

export function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  const destination = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}
