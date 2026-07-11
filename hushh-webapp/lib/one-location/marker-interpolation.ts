export interface LatLngLiteral {
  lat: number;
  lng: number;
}

function clamp01(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/** Linear interpolation between two coordinates. `t` is clamped to [0,1]. */
export function lerpLatLng(
  from: LatLngLiteral,
  to: LatLngLiteral,
  t: number,
): LatLngLiteral {
  const k = clamp01(t);
  return {
    lat: from.lat + (to.lat - from.lat) * k,
    lng: from.lng + (to.lng - from.lng) * k,
  };
}

/** Ease-in-out so the marker accelerates then settles. In/out in [0,1]. */
export function easeInOutQuad(t: number): number {
  const k = clamp01(t);
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}

/** Great-circle distance in metres between two coordinates. */
export function haversineMeters(a: LatLngLiteral, b: LatLngLiteral): number {
  const R = 6_371_000; // Earth radius (m)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Jumps larger than this (metres) are treated as a teleport / first GPS fix and
 * snapped instantly rather than animated across the map.
 */
export const SNAP_DISTANCE_METERS = 2000;

export function shouldSnap(from: LatLngLiteral, to: LatLngLiteral): boolean {
  return haversineMeters(from, to) > SNAP_DISTANCE_METERS;
}
