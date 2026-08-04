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
};

/**
 * Read the account's current position from the shared bus.
 *
 * `auto` resolves a position on mount when the OS has already granted
 * permission — it never triggers a first prompt. Surfaces that need the prompt
 * call `request()` from a user gesture.
 */
export function useCurrentLocation(options?: { auto?: boolean }): LocationBusState & {
  request: () => Promise<LocationSnapshot | null>;
  refresh: () => Promise<LocationSnapshot | null>;
} {
  const auto = options?.auto ?? true;

  const state = useSyncExternalStore(
    LocationBus.subscribe,
    LocationBus.getState,
    () => SERVER_STATE,
  );

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
