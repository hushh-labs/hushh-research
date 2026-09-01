"use client";

import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import { useRequireAuth } from "@/hooks/use-auth";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

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

  usePublishVoiceSurfaceMetadata(
    !auth.loading && auth.isAuthenticated
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
  return <LocationImmersiveMap key={auth.userId ?? "anonymous"} />;
}
