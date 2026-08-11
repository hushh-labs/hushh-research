"use client";

import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import { useRequireAuth } from "@/hooks/use-auth";

/**
 * Nearby check-in, as its own destination.
 *
 * It shares the map renderer because the flow genuinely needs a map — the 500 m
 * area, where you are, and the venue you picked — but it is not Your Map. That
 * screen answers "where are the people who share with me"; this one answers
 * "who else is at this place". Rendered as a drawer over Your Map they looked
 * like the same feature, so `surface="check-in"` drops the private-share pins
 * and the people tray, which belong to the map alone.
 */
export default function OneLocationCheckInPage() {
  const auth = useRequireAuth();

  return (
    <>
      {/* Its own marker rather than the map's: native route auditing should be
          able to tell these two screens apart, which is the whole point of
          giving check-in its own route. */}
      <NativeRouteMarker
        routeId="/one/location/check-in"
        marker="native-route-one-location-check-in"
        authState={
          auth.loading
            ? "pending"
            : auth.isAuthenticated
              ? "authenticated"
              : "anonymous"
        }
        dataState="loaded"
      />
      {/* Owner-scoped like the map route: decrypted markers, nearby attendees
          and pending location work must never survive an account switch. */}
      <LocationImmersiveMap
        key={auth.userId ?? "anonymous"}
        surface="check-in"
      />
    </>
  );
}
