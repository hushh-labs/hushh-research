"use client";

import { useEffect, useId } from "react";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { LOCATION_PKM_DOMAIN } from "@/lib/one-location/saved-locations";
import { CardTitle } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent, SurfaceCardHeader } from "@/components/app-ui/surfaces";
import { SavedLocationsSection } from "@/components/one-location/saved-locations-section";
import { PlaceRatings } from "@/components/location/ratings/place-ratings";
import { Button } from "@/components/ui/button";
import { LocationChatCircles } from "./location-chat-circles";
import { LocationChatSettings } from "./location-chat-settings";
import { LocationChatContacts } from "./location-chat-contacts";

type Mode = "circles" | "saved_places" | "ratings" | "contacts" | "settings";
const TITLES: Record<Mode, string> = { circles: "Circles", saved_places: "Saved places", ratings: "Place ratings", contacts: "Find contacts", settings: "Location settings" };

export function LocationChatWorkspace({
  mode, token, ownerId, vaultKey, suggestedCircleName, suggestedPersonName, autoApprovalIntent, suggestedAutoApprovalCircles, onBack, onChanged,
}: {
  mode: Mode;
  token: string;
  ownerId: string;
  vaultKey: string;
  suggestedCircleName?: string;
  suggestedPersonName?: string;
  autoApprovalIntent?: "enable" | "disable";
  suggestedAutoApprovalCircles?: readonly string[];
  onBack: () => void;
  onChanged?: () => void;
}) {
  const titleId = useId();
  useEffect(() => {
    if (mode !== "saved_places" || !vaultKey || !onChanged) return;
    return subscribeToPkmDomainChanges((change) => {
      if (change.userId === ownerId && change.domain === LOCATION_PKM_DOMAIN) onChanged();
    });
  }, [mode, onChanged, ownerId, vaultKey]);
  if (mode === "contacts") return <LocationChatContacts ownerId={ownerId} onBack={onBack} onChanged={onChanged} />;
  return (
    <SurfaceCard role="region" aria-labelledby={titleId} className="w-full min-w-0">
      <SurfaceCardHeader className="flex items-center justify-between gap-3 space-y-0">
        <CardTitle as="h3" id={titleId}>{autoApprovalIntent ? "Automatic Location approval" : TITLES[mode]}</CardTitle>
        <Button size="sm" variant="outline" onClick={onBack}>Done</Button>
      </SurfaceCardHeader>
      <SurfaceCardContent>
        {mode === "circles" ? (
          <LocationChatCircles token={token} ownerId={ownerId} suggestedCircleName={suggestedCircleName} suggestedPersonName={suggestedPersonName} onChanged={onChanged} />
        ) : mode === "saved_places" ? (
          vaultKey ? <SavedLocationsSection /> : <p className="text-sm">Unlock your vault to see saved places.</p>
        ) : mode === "ratings" ? (
          <PlaceRatings embeddedInChat />
        ) : (
          <LocationChatSettings token={token} ownerId={ownerId} onChanged={onChanged}
            autoApprovalIntent={autoApprovalIntent} suggestedCircles={suggestedAutoApprovalCircles} onClose={onBack} />
        )}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
