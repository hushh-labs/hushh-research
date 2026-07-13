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
 * location. Destination search uses the shared Command-based PlaceSearchDialog.
 * Destination + ETA travel inside the encrypted envelope — this component only
 * collects intent and calls `vm.onDriveTo`.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, LocateFixed, Navigation } from "lucide-react";

import { cn } from "@/lib/utils";
import { OneLocationService } from "@/lib/one-location/service";
import { LiveMap } from "@/components/one-location/live-map";
import type { DriveDestination, RouteEta } from "@/lib/one-location/types";

import { CARD_SURFACE } from "./tokens";
import { DriveRouteMap } from "./drive-route-map";
import { PlaceSearchDialog } from "./place-search-dialog";
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

  const [destination, setDestination] = useState<DriveDestination | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [eta, setEta] = useState<RouteEta | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const point = vm.myLocationPoint;

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

          {/* Heading to — opens the Command place-search dialog */}
          <div className="flex items-center gap-3 py-[11px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#1d1d1f] dark:bg-white" />
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="text-xs text-muted-foreground">Heading to</div>
              {destination ? (
                <div className="text-[15px] font-semibold text-foreground">
                  {destination.label}
                </div>
              ) : (
                <div className="text-[15px] font-semibold text-muted-foreground">
                  Where are you headed?
                </div>
              )}
            </button>
            {destination ? (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="shrink-0 text-[13px] font-medium text-[#007aff]"
              >
                Change
              </button>
            ) : null}
          </div>
        </div>
      </section>

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

      <PlaceSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        vaultOwnerToken={vm.vaultOwnerToken}
        recents={vm.recentDestinations}
        onSelect={(dest) => setDestination(dest)}
        title="Where are you headed?"
        placeholder="Search a destination…"
      />
    </div>
  );
}
