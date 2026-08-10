"use client";

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

  // Owner-scoped like the map route: decrypted markers, nearby attendees and
  // pending location work must never survive an account switch.
  return (
    <LocationImmersiveMap
      key={auth.userId ?? "anonymous"}
      surface="check-in"
    />
  );
}
