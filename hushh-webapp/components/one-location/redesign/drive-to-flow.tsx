"use client";

/**
 * One Location redesign — Drive To flow (Quick Action).
 *
 * "Share your route and ETA." Search a destination (Google Places via the
 * backend proxy), pick trusted connections, and share live location + a
 * live-updating ETA. Destination + ETA travel inside the encrypted envelope;
 * this component only collects intent and calls `vm.onDriveTo`.
 */

import { useEffect, useMemo, useState } from "react";
import { Car, Check, MapPin, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OneLocationService } from "@/lib/one-location/service";
import type { DriveDestination, RouteEta } from "@/lib/one-location/types";

import { TaskFlowHeader } from "./primitives";
import { CARD_SURFACE, MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
import { DriveRouteMap } from "./drive-route-map";
import type { LocationHubViewModel } from "./location-redesign-hub";

// Drive-to shares default to a 2-hour window (no per-flow duration picker).
const DRIVE_DURATION_HOURS = "2";

function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  }
  return (words[0]?.slice(0, 1) || "?").toUpperCase();
}

function avatarTone(index: number): string {
  const tones = [
    "bg-red-500 text-white",
    "bg-sky-500 text-white",
    "bg-violet-500 text-white",
    "bg-emerald-500 text-white",
    "bg-amber-500 text-white",
  ];
  return tones[index % tones.length]!;
}

export function DriveToFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const contacts = vm.sosRecipients;
  const busy = vm.driveBusy || vm.busy === "selfLocation";

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<{ placeId: string; text: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [destination, setDestination] = useState<DriveDestination | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [eta, setEta] = useState<RouteEta | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // No default selection: the user explicitly chooses who to share with.

  // Debounced Places autocomplete via the backend proxy.
  useEffect(() => {
    const token = vm.vaultOwnerToken;
    const q = query.trim();
    if (!token || q.length < 2 || destination?.label === q) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const handle = setTimeout(async () => {
      try {
        const results = await OneLocationService.placesAutocomplete({
          vaultOwnerToken: token,
          input: q,
        });
        if (!cancelled) setSuggestions(results);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setSearchError("Couldn't search places. Check your connection.");
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, vm.vaultOwnerToken, destination?.label]);

  const selectSuggestion = async (placeId: string, text: string) => {
    const token = vm.vaultOwnerToken;
    if (!token) return;
    setQuery(text);
    setSuggestions([]);
    try {
      const details = await OneLocationService.placeDetails({
        vaultOwnerToken: token,
        placeId,
      });
      setDestination(details);
    } catch {
      setSearchError("Couldn't load that place. Try another.");
    }
  };

  const selectRecent = (recent: DriveDestination) => {
    setDestination(recent);
    setQuery(recent.label);
    setSuggestions([]);
  };

  // Fetch a live ETA whenever both origin and destination are known.
  useEffect(() => {
    const token = vm.vaultOwnerToken;
    const origin = vm.myLocationPoint;
    if (!token || !origin || !destination) {
      setEta(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const result = await OneLocationService.routeEta({
          vaultOwnerToken: token,
          originLat: origin.latitude,
          originLng: origin.longitude,
          destLat: destination.latitude,
          destLng: destination.longitude,
        });
        if (!cancelled) setEta(result);
      } catch {
        if (!cancelled) setEta(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [vm.vaultOwnerToken, vm.myLocationPoint, destination]);

  const toggle = (id: string) =>
    setCheckedIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );

  const selectedReadyCount = useMemo(
    () =>
      contacts.filter(
        (r) => checkedIds.includes(r.userId) && vm.isRecipientShareReady(r),
      ).length,
    [contacts, checkedIds, vm],
  );

  const point = vm.myLocationPoint;
  const canStart = Boolean(destination) && Boolean(point) && selectedReadyCount > 0;

  const startLabel = !destination
    ? "Choose a destination"
    : !point
      ? "Capture your location first"
      : selectedReadyCount === 0
        ? "Select who to share with"
        : "Start Sharing Route";

  const recentDestinations = vm.recentDestinations;

  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Drive To"
        title="Share your route and ETA"
        onBack={onClose}
      />

      {/* WHERE ARE YOU HEADED? */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Where are you headed?
        </p>
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setDestination(null);
            }}
            placeholder="Where are you headed?"
            className="h-11 w-full rounded-[14px] border border-border/70 bg-background pl-10 pr-4 text-base text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-[#007aff]/25"
          />
        </div>

        {searchError ? (
          <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-300">
            {searchError}
          </p>
        ) : null}

        {/* Recents (shown when not actively searching) */}
        {!query.trim() && recentDestinations.length > 0 ? (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Recent
            </p>
            {recentDestinations.map((recent) => (
              <button
                key={recent.placeId ?? recent.label}
                type="button"
                onClick={() => selectRecent(recent)}
                className={cn(SUBCARD_SURFACE, "flex w-full items-center gap-3 p-3 text-left hover:border-[#007aff]/40")}
              >
                <MapPin className="h-4 w-4 shrink-0 text-[#007aff]" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {recent.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Autocomplete suggestions */}
        {suggestions.length > 0 ? (
          <div className="mt-3 space-y-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.placeId}
                type="button"
                onClick={() => void selectSuggestion(suggestion.placeId, suggestion.text)}
                className={cn(SUBCARD_SURFACE, "flex w-full items-center gap-3 p-3 text-left hover:border-[#007aff]/40")}
              >
                <MapPin className="h-4 w-4 shrink-0 text-[#007aff]" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {suggestion.text}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {searching ? <p className={cn(MUTED_TEXT, "mt-2")}>Searching…</p> : null}
      </section>

      {/* ROUTE PREVIEW (once destination + origin are known) */}
      {destination && point ? (
        <section className={cn(CARD_SURFACE, "overflow-hidden p-0")}>
          <DriveRouteMap
            origin={{ lat: point.latitude, lng: point.longitude }}
            destination={destination}
            eta={eta}
            className="h-[160px] w-full"
          />
          <div className="px-4">
            <div className="flex items-center gap-3 border-b border-black/5 py-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#007aff]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Starting from</p>
                <p className="truncate text-[15px] font-semibold text-foreground">
                  Live location
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 py-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#1d1d1f]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Heading to</p>
                <p className="truncate text-[15px] font-semibold text-foreground">
                  {destination.label}
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* YOUR LOCATION */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#007aff]/12 text-[#007aff]">
            <MapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Starting from
            </p>
            <p className="mt-0.5 text-[15px] font-semibold text-foreground">
              {point ? "Live location ready" : "Location not captured yet"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={vm.onShowMyLocation}
            isLoading={vm.busy === "selfLocation"}
            className="h-9 shrink-0 rounded-full px-3 text-xs"
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {point ? "Refresh" : "Capture"}
          </Button>
        </div>
        {vm.myLocationError ? (
          <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-300">
            {vm.myLocationError}
          </p>
        ) : null}
      </section>

      {/* WHO SHOULD SEE IT? */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Who should see your drive?
        </p>
        <div className="space-y-2.5">
          {contacts.length ? (
            contacts.map((recipient, index) => {
              const ready = vm.isRecipientShareReady(recipient);
              const checked = checkedIds.includes(recipient.userId);
              return (
                <button
                  key={recipient.userId}
                  type="button"
                  onClick={ready ? () => toggle(recipient.userId) : undefined}
                  disabled={!ready}
                  aria-pressed={checked}
                  className={cn(
                    SUBCARD_SURFACE,
                    "flex w-full items-center gap-3 p-3 text-left transition-all duration-150",
                    ready ? "hover:border-[#007aff]/40 active:scale-[0.99]" : "cursor-not-allowed opacity-60",
                    checked && "border-[#007aff]/60 ring-1 ring-[#007aff]/30",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                      avatarTone(index),
                    )}
                    aria-hidden
                  >
                    {initialsOf(vm.recipientLabel(recipient))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {vm.recipientLabel(recipient)}
                    </span>
                    <span className={cn(MUTED_TEXT, "block truncate")}>
                      {ready ? vm.recipientSubtitle(recipient) : "Not ready to receive location"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border-2 transition-colors",
                      checked ? "border-[#007aff] bg-[#007aff] text-white" : "border-border bg-background",
                    )}
                  >
                    {checked ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
                  </span>
                </button>
              );
            })
          ) : (
            <div className={cn(SUBCARD_SURFACE, "p-5 text-center text-sm text-muted-foreground")}>
              No trusted contacts yet. Add people to your Circle first.
            </div>
          )}
        </div>
      </section>

      {/* ACTION BAR */}
      <div className="space-y-2 pt-1">
        <Button
          onClick={() =>
            destination && vm.onDriveTo(destination, checkedIds, DRIVE_DURATION_HOURS)
          }
          disabled={!canStart}
          isLoading={busy}
          className="h-12 w-full rounded-2xl bg-sky-600 text-base font-semibold text-white hover:bg-sky-600/90 disabled:opacity-50"
        >
          <Car className="mr-1.5 h-5 w-5" />
          {startLabel}
        </Button>
        <Button
          variant="ghost"
          onClick={onClose}
          className="h-10 w-full rounded-2xl text-sm text-muted-foreground"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
