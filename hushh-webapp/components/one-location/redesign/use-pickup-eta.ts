"use client";

import { useEffect, useRef, useState } from "react";

import { locationLatLng } from "@/lib/one-location/maps-urls";
import { shouldRecomputeEta } from "@/lib/one-location/eta-recompute";
import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";

export type PickupEtaStatus = "idle" | "seeded" | "updating" | "live" | "stale";

export interface PickupEtaState {
  eta: RouteEta | null;
  status: PickupEtaStatus;
}

/**
 * Viewer-side ETA for a pickup: recomputes routeEta(helper -> pickup) as the
 * helper moves, throttled by shouldRecomputeEta. Seeds from the helper's last
 * shipped ETA and NEVER downgrades a good value to null on a failed refresh, so
 * the requester never sees "ETA unavailable" once an ETA exists.
 */
export function usePickupEta(params: {
  helperPoint: PlainLocationPoint | null;
  pickupPoint: PlainLocationPoint | null;
  seedEtaSeconds: number | null;
  fetchEta: (origin: LatLngLiteral, dest: LatLngLiteral) => Promise<RouteEta>;
}): PickupEtaState {
  const { helperPoint, pickupPoint, seedEtaSeconds, fetchEta } = params;

  const [state, setState] = useState<PickupEtaState>(() =>
    seedEtaSeconds != null && Number.isFinite(seedEtaSeconds)
      ? { eta: { etaSeconds: seedEtaSeconds, distanceMeters: 0 }, status: "seeded" }
      : { eta: null, status: "idle" },
  );

  const lastComputedAtRef = useRef<number | null>(null);
  const lastOriginRef = useRef<LatLngLiteral | null>(null);
  const etaRef = useRef<RouteEta | null>(state.eta);
  etaRef.current = state.eta;

  const helperLat = helperPoint?.latitude ?? null;
  const helperLng = helperPoint?.longitude ?? null;
  const pickupLat = pickupPoint?.latitude ?? null;
  const pickupLng = pickupPoint?.longitude ?? null;

  useEffect(() => {
    if (!helperPoint || !pickupPoint) return;
    const origin = locationLatLng(helperPoint);
    const dest = locationLatLng(pickupPoint);
    if (
      !shouldRecomputeEta({
        lastComputedAt: lastComputedAtRef.current,
        lastOrigin: lastOriginRef.current,
        nextOrigin: origin,
        now: Date.now(),
      })
    ) {
      return;
    }

    let cancelled = false;
    setState((s) => ({ eta: s.eta, status: "updating" }));
    fetchEta(origin, dest)
      .then((eta) => {
        if (cancelled) return;
        lastComputedAtRef.current = Date.now();
        lastOriginRef.current = origin;
        setState({ eta, status: "live" });
      })
      .catch(() => {
        if (cancelled) return;
        // Keep the last-known ETA; a failed refresh must not show "unavailable".
        setState({ eta: etaRef.current, status: etaRef.current ? "stale" : "idle" });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helperLat, helperLng, pickupLat, pickupLng, fetchEta]);

  return state;
}
