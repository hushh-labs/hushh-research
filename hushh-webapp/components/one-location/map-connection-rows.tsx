"use client";

import { User, WifiOff } from "@/components/icons";
import { PersonProfileButton } from "@/components/connections/person-profile-button";
import { PersonSelectionSurface } from "@/components/connections/person-selection-surface";
import type { OneLocationGrant } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

export type MapSharingPerson = { label: string; userId?: string };

export function activeSharePeopleFromGrants(grants: OneLocationGrant[]): MapSharingPerson[] {
  return grants.filter(grant => grant.status === "active").map(grant => ({
    userId: grant.recipientUserId,
    label: grant.recipientDisplayName?.trim() || grant.recipientMaskedPhone?.trim() || "Someone",
  }));
}

export function MapPersonTrayChip({ person, initials, selectedPerson, personStale, lastSeen, selectedClassName, onFocus }: {
  person: MapSharingPerson & { key: string; tint?: { r: number; g: number; b: number; a: number } };
  initials: string; selectedPerson: boolean; personStale: boolean; lastSeen: string | null;
  selectedClassName: string; onFocus: () => void;
}) {
  return (
    <PersonSelectionSurface
      key={person.key}
      type="button"
      className={`flex h-11 shrink-0 items-center gap-2 rounded-full border px-2.5 pr-3 text-left text-sm transition-colors ${
        selectedPerson
          ? selectedClassName
          : "border-border/60 bg-muted/70 text-foreground hover:bg-muted"
      }`}
      // The live case keeps its original name exactly. Only a
      // person who has gone quiet has anything extra worth
      // announcing, and saying "sharing live" on every other
      // row would be noise in a screen reader.
      aria-label={
        lastSeen
          ? `Show ${person.label} on the map. Last seen ${lastSeen}.`
          : `Show ${person.label} on the map`
      }
      title={
        lastSeen
          ? `${person.label} — last seen ${lastSeen}`
          : `${person.label} — live now`
      }
      data-testid="one-location-map-person"
      data-stale={personStale ? "true" : "false"}
      onClick={onFocus}
    >
      <span className="relative shrink-0">
        <PersonProfileButton userId={person.userId} label={person.label} data-location-type-exception="avatar-initial"
          className={`grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold text-white transition-[filter,opacity] ${
            personStale ? "opacity-70 grayscale" : ""
          }`}
          style={{
            backgroundColor: person.tint
              ? `rgba(${person.tint.r}, ${person.tint.g}, ${person.tint.b}, ${person.tint.a / 255})`
              : "var(--app-accent)",
          }}
        >
          {initials}
        </PersonProfileButton>
        {/* Bottom-right, over the avatar's own edge. Shape as
          well as colour, so it survives being read on a
          greyscale avatar by someone who cannot rely on
          the grey itself. */}
        {personStale ? (
          <span
            className="absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-background ring-1 ring-border"
            aria-hidden="true"
          >
            <WifiOff className="h-2.5 w-2.5 text-muted-foreground" />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span data-location-type-role="row-title" className="max-w-28 truncate font-medium">
          {person.label}
        </span>
        {lastSeen ? (
          <span data-location-type-role="row-description" className={cn("max-w-28 truncate text-[11px]", selectedPerson ? "text-white" : "text-muted-foreground")}>
            {lastSeen}
          </span>
        ) : null}
      </span>
    </PersonSelectionSurface>
  );
}

/** Keep the row's map/manage action and expose a separate profile icon. */
export function MapSharingPersonRow({ person, hasPin, compact, onOpen }: {
  person: MapSharingPerson; hasPin: boolean; compact: boolean; onOpen: () => void;
}) {
  return <PersonSelectionSurface type="button"
    data-testid={compact ? "one-location-map-private-share-person" : "one-location-map-sharing-person"}
    data-has-pin={hasPin ? "true" : "false"}
    aria-label={hasPin ? `Show ${person.label} on your map` : `Manage your location share with ${person.label}`}
    className={compact
      ? "flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left text-sm transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      : "flex min-h-11 w-full items-center gap-2 rounded-[12px] px-2 py-1.5 text-left text-[15px] leading-5 transition-colors hover:bg-[var(--app-accent-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"}
    onClick={onOpen}>
    <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-accent)]" aria-hidden="true" />
    <span data-location-type-role="row-title" className="min-w-0 flex-1 truncate">{person.label}</span>
    {!compact && hasPin ? <span data-location-type-role="helper" className="shrink-0 text-[11px] font-medium text-muted-foreground" aria-hidden="true">On your map</span> : null}
    {person.userId ? <PersonProfileButton userId={person.userId} label={person.label} className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground"><User className="size-4" aria-hidden="true" /></PersonProfileButton> : null}
  </PersonSelectionSurface>;
}
