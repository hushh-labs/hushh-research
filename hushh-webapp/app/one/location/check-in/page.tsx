"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import { useRequireAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";

/**
 * Nearby check-in, as its own destination.
 *
 * It shares the map renderer because the flow genuinely needs a map — the 500 m
 * area, where you are, and the venue you picked — but it is not Your Map. That
 * screen answers "where are the people who share with me"; this one answers
 * "who else is at this place". Rendered as a drawer over Your Map they looked
 * like the same feature, so `surface="check-in"` drops the private-share pins
 * and the people tray, which belong to the map alone.
 *
 * This is the single destination for check-in: the hub, the Check in pill on
 * Your Map, the private-check-in back button, the resume href and One's own
 * `location.open_check_in` all name it directly. Nothing routes through Your
 * Map to reach it any more.
 */
export default function OneLocationCheckInPage() {
  const auth = useRequireAuth();
  const router = useRouter();
  // Being the one destination means being the one place that answers for a
  // build where nearby check-in is switched off. Every button leading here is
  // already gated; a bookmark, a shared link or an old notification is not,
  // and without this they opened a place list the backend would refuse. The
  // hub still renders the plain check-in, so that is where those arrivals go.
  const nearbyAvailable = isOneLocationNearbyCheckInAvailable();

  useEffect(() => {
    if (nearbyAvailable) return;
    router.replace(`${ROUTES.ONE_LOCATION}?action=check-in`, { scroll: false });
  }, [nearbyAvailable, router]);

  // Held before the map renders rather than inside it. The whole point of the
  // change is that a screen which cannot show check-in never gets built to be
  // redirected off a frame later.
  if (!nearbyAvailable) return null;

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
