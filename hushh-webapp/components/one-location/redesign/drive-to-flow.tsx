"use client";

/**
 * One Location redesign — Drive To flow (Quick Action).
 *
 * "Drive to." Share your live location + a live-updating ETA and route with
 * trusted people. Layout follows the Apple Blue v2 reference: a single card with
 * the live map on top (source → destination route + ETA badge) and the
 * "Starting from / Heading to" rows below, then "Who sees your drive".
 *
 * The map reuses the same live-location map component as the home screen: when a
 * live fix is available it renders the interactive map (with the route once a
 * destination is chosen); otherwise it prompts the user to capture their
 * location. Destination + ETA travel inside the encrypted envelope — this
 * component only collects intent and calls `vm.onDriveTo`.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, LocateFixed, Navigation } from "lucide-react";

import { cn } from "@/lib/utils";
import { OneLocationService } from "@/lib/one-location/service";
import { LiveMap } from "@/components/one-location/live-map";
import type { DriveDestination, RouteEta } from "@/lib/one-location/types";

import { CARD_SURFACE } from "./tokens";
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

  const point = vm.myLocationPoint;

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

  const clearDestination = () => {
    setDestination(null);
    setQuery("");
    setSuggestions([]);
    setEta(null);
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

  const canStart =
    Boolean(destination) && Boolean(point) && selectedReadyCount > 0 && !busy;

  const recentDestinations = vm.recentDestinations;
  const showSuggestions =
    !destination &&
    (suggestions.length > 0 ||
      searching ||
      Boolean(searchError) ||
      (!query.trim() && recentDestinations.length > 0));

  return (
    <div className="space-y-4">
      {/* HEADER — "Drive to" + Cancel */}
      <div className="flex items-center justify-between">
        <h2 className="text-[24px] font-semibold leading-tight tracking-[-0.3px] text-foreground">
          Drive to
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-[15px] text-[#007aff]"
        >
          Cancel
        </button>
      </div>

      {/* ROUTE CARD — map on top, then Starting from / Heading to */}
      <section className={cn(CARD_SURFACE, "overflow-hidden p-0")}>
        <div className="relative h-[150px] bg-[#eceef2] dark:bg-white/5">
          {point && destination ? (
            <DriveRouteMap
              origin={{ lat: point.latitude, lng: point.longitude }}
              destination={destination}
              eta={eta}
              className="absolute inset-0 h-full w-full"
            />
          ) : point ? (
            <LiveMap point={point} className="absolute inset-0" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                Turn on your live location to share your drive.
              </p>
              <button
                type="button"
                onClick={vm.onShowMyLocation}
                disabled={vm.busy === "selfLocation"}
                className="inline-flex items-center gap-2 rounded-full bg-[#007aff] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                <LocateFixed className="h-4 w-4" />
                {vm.busy === "selfLocation" ? "Capturing…" : "Capture location"}
              </button>
            </div>
          )}
        </div>

        <div className="px-4">
          {/* Starting from */}
          <div className="flex items-center gap-3 border-b border-black/[0.06] py-[11px] dark:border-white/10">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#007aff]" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted-foreground">Starting from</div>
              {point ? (
                <div className="truncate text-[15px] font-semibold text-foreground">
                  Live location
                </div>
              ) : (
                <button
                  type="button"
                  onClick={vm.onShowMyLocation}
                  className="truncate text-[15px] font-semibold text-[#007aff]"
                >
                  Capture your location
                </button>
              )}
            </div>
          </div>

          {/* Heading to */}
          <div className="flex items-center gap-3 py-[11px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#1d1d1f] dark:bg-white" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted-foreground">Heading to</div>
              {destination ? (
                <button
                  type="button"
                  onClick={clearDestination}
                  className="block w-full truncate text-left text-[15px] font-semibold text-foreground"
                >
                  {destination.label}
                </button>
              ) : (
                <input
                  type="text"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setDestination(null);
                  }}
                  placeholder="Where are you headed?"
                  className="w-full bg-transparent text-[15px] font-semibold text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground"
                />
              )}
            </div>
          </div>
        </div>
      </section>

      {/* DESTINATION SUGGESTIONS / RECENTS (only while choosing) */}
      {showSuggestions ? (
        <section className={cn(CARD_SURFACE, "p-2")}>
          {searchError ? (
            <p className="px-2 py-1.5 text-xs font-medium text-red-600 dark:text-red-300">
              {searchError}
            </p>
          ) : null}
          {searching && suggestions.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Searching…</p>
          ) : null}
          {suggestions.length > 0
            ? suggestions.map((suggestion) => (
                <button
                  key={suggestion.placeId}
                  type="button"
                  onClick={() => void selectSuggestion(suggestion.placeId, suggestion.text)}
                  className="flex w-full items-center gap-3 rounded-[11px] px-2 py-2.5 text-left hover:bg-[#007aff]/10"
                >
                  <Navigation className="h-4 w-4 shrink-0 rotate-90 text-[#007aff]" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {suggestion.text}
                  </span>
                </button>
              ))
            : !query.trim()
              ? recentDestinations.map((recent) => (
                  <button
                    key={recent.placeId ?? recent.label}
                    type="button"
                    onClick={() => selectRecent(recent)}
                    className="flex w-full items-center gap-3 rounded-[11px] px-2 py-2.5 text-left hover:bg-[#007aff]/10"
                  >
                    <Navigation className="h-4 w-4 shrink-0 rotate-90 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {recent.label}
                    </span>
                  </button>
                ))
              : null}
        </section>
      ) : null}

      {/* WHO SEES YOUR DRIVE */}
      <div>
        <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          Who sees your drive
        </p>
        <section className={cn(CARD_SURFACE, "px-4")}>
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
                    "flex w-full items-center gap-[13px] py-3 text-left",
                    index < contacts.length - 1 &&
                      "border-b border-black/[0.06] dark:border-white/10",
                    !ready && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                      avatarTone(index),
                    )}
                    aria-hidden
                  >
                    {initialsOf(vm.recipientLabel(recipient))}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[16px] font-semibold text-foreground">
                    {vm.recipientLabel(recipient)}
                  </span>
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                      checked
                        ? "border-[#007aff] bg-[#007aff] text-white"
                        : "border-border bg-transparent",
                    )}
                  >
                    {checked ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="py-5 text-center text-sm text-muted-foreground">
              No trusted contacts yet. Add people to your Circle first.
            </p>
          )}
        </section>
      </div>

      {/* START SHARING DRIVE */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() =>
            destination && vm.onDriveTo(destination, checkedIds, DRIVE_DURATION_HOURS)
          }
          disabled={!canStart}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-[#007aff] py-4 text-[17px] font-medium text-white transition-opacity disabled:opacity-40"
        >
          <Navigation className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={0} />
          {busy ? "Starting…" : "Start sharing drive"}
        </button>
      </div>
    </div>
  );
}
