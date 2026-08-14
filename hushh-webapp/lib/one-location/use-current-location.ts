"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  LocationBus,
  type LocationBusState,
  type LocationSnapshot,
} from "@/lib/one-location/location-bus";

const SERVER_STATE: LocationBusState = {
  status: "idle",
  permission: null,
  snapshot: null,
  error: null,
  snapshotOrigin: null,
};

/**
 * Read the account's current position from the shared bus.
 *
 * `auto` resolves a position on mount when the OS has already granted
 * permission — it never triggers a first prompt. Surfaces that need the prompt
 * call `request()` from a user gesture.
 *
 * Pass `userId` to give the bus an account. With one, the previous session's
 * fix is restored before the GPS answers, so the surface opens with a position
 * instead of a spinner and keeps one if the device fails to produce a new fix.
 * Without one the hook behaves exactly as it always has — nothing is stored and
 * nothing is restored.
 */
export function useCurrentLocation(options?: {
  auto?: boolean;
  userId?: string | null;
}): LocationBusState & {
  request: () => Promise<LocationSnapshot | null>;
  refresh: () => Promise<LocationSnapshot | null>;
} {
  const auto = options?.auto ?? true;
  const userId = options?.userId ?? null;

  const state = useSyncExternalStore(
    LocationBus.subscribe,
    LocationBus.getState,
    () => SERVER_STATE,
  );

  useEffect(() => {
    if (!userId) return;
    void LocationBus.attachUser(userId);
  }, [userId]);

  useEffect(() => {
    if (!auto) return;
    let cancelled = false;
    void LocationBus.syncPermission().then((permission) => {
      if (cancelled || permission !== "granted") return;
      void LocationBus.ensure();
    });
    return () => {
      cancelled = true;
    };
  }, [auto]);

  const request = useCallback(() => LocationBus.request(), []);
  const refresh = useCallback(() => LocationBus.ensure({ maxAgeMs: 0 }), []);

  return { ...state, request, refresh };
}
