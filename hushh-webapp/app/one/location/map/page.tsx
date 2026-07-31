"use client";

import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import { useRequireAuth } from "@/hooks/use-auth";

/** Private, immersive Map. It owns no persistent app chrome or route-local map state. */
export default function OneLocationMapPage() {
  const auth = useRequireAuth();

  // Every map state value is owner-scoped: renderer consent, decrypted markers,
  // nearby attendees, and pending location work must never survive an account
  // switch. A user-id key enforces that boundary before passive effects run.
  return <LocationImmersiveMap key={auth.userId ?? "anonymous"} />;
}
