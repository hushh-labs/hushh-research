"use client";

import type { ReactNode } from "react";

import { driveEtaText } from "@/app/one/location/drive-eta";
import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";

import { PickupEnRouteCard } from "./cards";
import { PickupLiveRouteMap } from "./pickup-live-route-map";
import { usePickupEta } from "./use-pickup-eta";

export interface PickupEnRouteCardLiveProps {
  helperName: string;
  helperPoint: PlainLocationPoint;
  pickupPoint: PlainLocationPoint | null;
  seedEtaSeconds: number | null;
  fetchEta: (origin: LatLngLiteral, dest: LatLngLiteral) => Promise<RouteEta>;
  fallbackPreview: ReactNode;
  onCancel: () => void;
  cancelBusy?: boolean;
}

/**
 * En-route card whose ETA is recomputed on the viewer's side (usePickupEta),
 * keeping the header text and the map badge in sync from a single source. This
 * is what makes the ETA survive a helper-side refresh.
 */
export function PickupEnRouteCardLive({
  helperName,
  helperPoint,
  pickupPoint,
  seedEtaSeconds,
  fetchEta,
  fallbackPreview,
  onCancel,
  cancelBusy,
}: PickupEnRouteCardLiveProps) {
  const { eta, status } = usePickupEta({
    helperPoint,
    pickupPoint,
    seedEtaSeconds,
    fetchEta,
  });

  // Never render "ETA unavailable": show a soft updating label until we have one.
  const etaText = eta ? driveEtaText(eta.etaSeconds) : "ETA updating…";
  // Don't badge the seeded value (its distance is a placeholder 0 km).
  const badgeEta = status === "seeded" ? null : eta;

  return (
    <PickupEnRouteCard helperName={helperName} etaText={etaText} onCancel={onCancel} cancelBusy={cancelBusy}>
      <PickupLiveRouteMap
        helperPoint={helperPoint}
        pickupPoint={pickupPoint}
        eta={badgeEta}
        fallbackPreview={fallbackPreview}
      />
    </PickupEnRouteCard>
  );
}
