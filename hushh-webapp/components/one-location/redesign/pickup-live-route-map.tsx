"use client";

import type { ReactNode } from "react";

import { locationLatLng } from "@/lib/one-location/maps-urls";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

import { DriveRouteMap } from "./drive-route-map";

export interface PickupLiveRouteMapProps {
  /** The helper's live position (route origin). */
  helperPoint: PlainLocationPoint;
  /** The requester's pickup destination, or null when not yet known. */
  pickupPoint: PlainLocationPoint | null;
  /** Recomputed ETA to badge on the map, or null while none is available. */
  eta: RouteEta | null;
  /** Single-point preview used when pickupPoint is unknown (no regression). */
  fallbackPreview: ReactNode;
  className?: string;
}

/**
 * Viewer-side pickup map: shows the helper AND the requester's pickup point with
 * the driving route + a recomputed ETA badge. Falls back to the caller-supplied
 * single-point preview when the pickup point is unavailable.
 */
export function PickupLiveRouteMap({
  helperPoint,
  pickupPoint,
  eta,
  fallbackPreview,
  className,
}: PickupLiveRouteMapProps) {
  if (!pickupPoint) {
    return <>{fallbackPreview}</>;
  }
  return (
    <DriveRouteMap
      origin={locationLatLng(helperPoint)}
      destination={{
        label: "Pickup",
        latitude: pickupPoint.latitude,
        longitude: pickupPoint.longitude,
      }}
      eta={eta}
      className={cn("h-44 w-full overflow-hidden rounded-2xl", className)}
    />
  );
}
