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

const WEB_MERCATOR_EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const APPROXIMATE_AREA_OVERLAY_RADIUS_PX = 64;

export function approximateAreaMapZoom(
  point: PlainLocationPoint,
  radiusM: number,
): number {
  const safeRadius = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 1_000;
  const latitude = Math.max(-85, Math.min(85, point.latitude));
  const metresPerPixelAtZoomZero =
    (WEB_MERCATOR_EARTH_CIRCUMFERENCE_M *
      Math.cos((latitude * Math.PI) / 180)) /
    256;
  const zoom = Math.round(
    Math.log2(
      (metresPerPixelAtZoomZero * APPROXIMATE_AREA_OVERLAY_RADIUS_PX) /
        safeRadius,
    ),
  );
  return Math.max(2, Math.min(18, zoom));
}

/**
 * Centres a keyless map without a query marker. Approximate-area surfaces add
 * their own radius overlay, so a provider pin must not imply an exact position.
 */
export function googleMapsAreaEmbedUrl(
  point: PlainLocationPoint,
  radiusM = 1_000,
): string {
  const center = encodeURIComponent(locationCoordinateQuery(point));
  const zoom = approximateAreaMapZoom(point, radiusM);
  return `https://www.google.com/maps?ll=${center}&z=${zoom}&output=embed`;
}

export function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  const destination = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}

export function googleMapsDirectionsEmbedUrl(
  origin: LatLngLiteral,
  destination: LatLngLiteral,
): string {
  const saddr = encodeURIComponent(
    `${formatCoordinate(origin.lat)},${formatCoordinate(origin.lng)}`,
  );
  const daddr = encodeURIComponent(
    `${formatCoordinate(destination.lat)},${formatCoordinate(destination.lng)}`,
  );
  return `https://www.google.com/maps?saddr=${saddr}&daddr=${daddr}&output=embed`;
}
