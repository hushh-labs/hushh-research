import type { PlainLocationPoint } from "@/lib/one-location/types";

const METERS_PER_LATITUDE_DEGREE = 111_320;
const MIN_LONGITUDE_SCALE = 0.2;

/**
 * Reduce coordinate precision before encryption. The backend still receives
 * ciphertext only, while recipients see an intentionally coarse point.
 */
export function approximateLocationPoint(
  point: PlainLocationPoint,
  gridMeters = 1_000,
): PlainLocationPoint {
  const boundedGridMeters = Math.max(250, Math.min(gridMeters, 5_000));
  const latitudeStep = boundedGridMeters / METERS_PER_LATITUDE_DEGREE;
  const longitudeScale = Math.max(
    MIN_LONGITUDE_SCALE,
    Math.cos((point.latitude * Math.PI) / 180),
  );
  const longitudeStep =
    boundedGridMeters / (METERS_PER_LATITUDE_DEGREE * longitudeScale);

  return {
    ...point,
    latitude: Number(
      (Math.round(point.latitude / latitudeStep) * latitudeStep).toFixed(6),
    ),
    longitude: Number(
      (Math.round(point.longitude / longitudeStep) * longitudeStep).toFixed(6),
    ),
    accuracyM: Math.max(point.accuracyM ?? 0, boundedGridMeters),
  };
}

export function pointForConnectionVisibility(
  point: PlainLocationPoint,
  precision: "precise" | "approximate",
): PlainLocationPoint {
  return precision === "approximate" ? approximateLocationPoint(point) : point;
}
