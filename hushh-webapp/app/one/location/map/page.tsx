"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import { ROUTES } from "@/lib/navigation/routes";
import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";
import { useRequireAuth } from "@/hooks/use-auth";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

// This route had no voice publisher at all -- app/one/location/page.tsx is
// the only file under Location that ever called
// usePublishVoiceSurfaceMetadata, so navigating here (the "Check in" pill on
// Your Map, a direct link, plain navigation) left voice with zero
// proactively-offered actions even though NearbyCheckInSheet's handlers are
// live on this screen exactly as they are on the hub.
const LOCATION_MAP_VOICE_ACTIONS = deriveLocationVoiceActions("one_location_map");

/** Private, immersive Map. It owns no persistent app chrome or route-local map state. */
export default function OneLocationMapPage() {
  const auth = useRequireAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const action = searchParams.get("action");
  const legacyCheckIn = isOneLocationNearbyCheckInAvailable() && (action === "check-in" || action === "event-check-in");

  useEffect(() => {
    if (!legacyCheckIn) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("action");
    const query = params.toString();
    router.replace(query ? `${ROUTES.ONE_LOCATION_CHECK_IN}?${query}` : ROUTES.ONE_LOCATION_CHECK_IN, { scroll: false });
  }, [legacyCheckIn, router, searchParams]);

  usePublishVoiceSurfaceMetadata(
    !legacyCheckIn && !auth.loading && auth.isAuthenticated
      ? {
          screenId: "one_location_map",
          title: "Your Map",
          purpose:
            "Shows where people who share location with you are right now, and lets you check in nearby.",
          spokenSubject: "Location, Your Map",
          actions: LOCATION_MAP_VOICE_ACTIONS,
          availableActions: LOCATION_MAP_VOICE_ACTIONS.map((action) => action.label),
        }
      : null,
  );

  // Every map state value is owner-scoped: renderer consent, decrypted markers,
  // nearby attendees, and pending location work must never survive an account
  // switch. A user-id key enforces that boundary before passive effects run.
  if (legacyCheckIn) return <div role="status" className="grid min-h-[100dvh] place-items-center bg-[color:var(--app-primary-surface)] text-[color:var(--app-secondary-label)]">Checking you in…</div>;
  return <LocationImmersiveMap key={auth.userId ?? "anonymous"} />;
}
