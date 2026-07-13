"use client";

/**
 * One Location redesign — Pick Me Up flow (Quick Action).
 *
 * Ask ONE trusted person to come to your pickup spot. The spot defaults to your
 * live location (reverse-geocoded for a human label) and can be Adjusted to a
 * fixed searched place. Distance to a contact is shown only when they are
 * currently sharing their live location with you. On confirm it hands the chosen
 * recipient + note (+ optional fixed pickup point) to `vm.onPickMeUp`.
 */

import { useEffect, useState } from "react";
import { Check, Navigation } from "lucide-react";

import { cn } from "@/lib/utils";
import { OneLocationService } from "@/lib/one-location/service";
import { LiveMap } from "@/components/one-location/live-map";
import { haversineMeters } from "@/lib/one-location/marker-interpolation";
import type { PlainLocationPoint } from "@/lib/one-location/types";

import { CARD_SURFACE } from "./tokens";
import type { LocationHubViewModel } from "./location-redesign-hub";

const PICKUP_DURATION_HOURS = "4"; // "until picked up"
const NOTE_MAX = 160;

function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
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

type FixedSpot = { latitude: number; longitude: number; label: string };

export function PickMeUpFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const contacts = vm.sosRecipients;
  const busy = vm.busy === "share" || vm.busy === "selfLocation";
  const livePoint = vm.myLocationPoint;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [fixedSpot, setFixedSpot] = useState<FixedSpot | null>(null);
  const [geoLabel, setGeoLabel] = useState<string | null>(null);

  // Adjust search state
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<{ placeId: string; text: string }[]>([]);

  // The point we actually share: fixed spot if adjusted, else the live location.
  const pickupPoint: { latitude: number; longitude: number } | null = fixedSpot
    ? { latitude: fixedSpot.latitude, longitude: fixedSpot.longitude }
    : livePoint
      ? { latitude: livePoint.latitude, longitude: livePoint.longitude }
      : null;

  // Reverse-geocode the LIVE location for the default label (skip when adjusted).
  useEffect(() => {
    const token = vm.vaultOwnerToken;
    if (!token || fixedSpot || !livePoint) {
      setGeoLabel(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const place = await OneLocationService.reverseGeocode({
          vaultOwnerToken: token,
          lat: livePoint.latitude,
          lng: livePoint.longitude,
        });
        if (cancelled) return;
        const label = place.name
          ? place.formattedAddress
            ? `${place.name} · ${place.formattedAddress}`
            : place.name
          : place.formattedAddress;
        setGeoLabel(label ?? null);
      } catch {
        if (!cancelled) setGeoLabel(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vm.vaultOwnerToken, livePoint, fixedSpot]);

  // Debounced Places autocomplete for Adjust.
  useEffect(() => {
    const token = vm.vaultOwnerToken;
    const q = query.trim();
    if (!token || !adjustOpen || q.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const results = await OneLocationService.placesAutocomplete({
          vaultOwnerToken: token,
          input: q,
        });
        if (!cancelled) setSuggestions(results);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, adjustOpen, vm.vaultOwnerToken]);

  const selectPlace = async (placeId: string) => {
    const token = vm.vaultOwnerToken;
    if (!token) return;
    try {
      const place = await OneLocationService.placeDetails({ vaultOwnerToken: token, placeId });
      setFixedSpot({ latitude: place.latitude, longitude: place.longitude, label: place.label });
      setAdjustOpen(false);
      setQuery("");
      setSuggestions([]);
    } catch {
      /* leave adjust open; user can retry */
    }
  };

  const pickupLabel = fixedSpot
    ? fixedSpot.label
    : geoLabel ?? "Live location";

  const selectedContact = contacts.find((c) => c.userId === selectedId) ?? null;
  const selectedName = selectedContact ? vm.recipientLabel(selectedContact) : null;
  const canAsk = Boolean(pickupPoint) && Boolean(selectedContact) && !busy;

  function distanceLabel(userId: string): string | null {
    if (!pickupPoint) return null;
    const p = vm.recipientLivePoint(userId);
    if (!p) return null;
    const meters = haversineMeters(
      { lat: pickupPoint.latitude, lng: pickupPoint.longitude },
      { lat: p.latitude, lng: p.longitude },
    );
    return `${(meters / 1000).toFixed(1)} km away`;
  }

  const mapPoint: PlainLocationPoint | null = fixedSpot
    ? { latitude: fixedSpot.latitude, longitude: fixedSpot.longitude, capturedAt: new Date().toISOString(), sourcePlatform: "web" }
    : livePoint;

  return (
    <div className="space-y-4">
      {/* HEADER */}
      <div className="flex items-center justify-between">
        <h2 className="text-[24px] font-semibold leading-tight tracking-[-0.3px] text-foreground">
          Pick me up
        </h2>
        <button type="button" onClick={onClose} className="text-[15px] text-[#007aff]">
          Cancel
        </button>
      </div>

      {/* PICKUP CARD */}
      <section className={cn(CARD_SURFACE, "overflow-hidden p-0")}>
        <div className="relative h-[150px] bg-[#eceef2] dark:bg-white/5">
          {mapPoint ? (
            <LiveMap point={mapPoint} className="absolute inset-0" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                Turn on your live location so they know where to come.
              </p>
              <button
                type="button"
                onClick={vm.onShowMyLocation}
                disabled={vm.busy === "selfLocation"}
                className="inline-flex items-center gap-2 rounded-full bg-[#007aff] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {vm.busy === "selfLocation" ? "Capturing…" : "Capture location"}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground">Your pickup spot</div>
            <div className="truncate text-sm text-muted-foreground">{pickupLabel}</div>
          </div>
          {fixedSpot ? (
            <button
              type="button"
              onClick={() => setFixedSpot(null)}
              className="shrink-0 text-[15px] text-[#007aff]"
            >
              Use live
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setAdjustOpen((v) => !v)}
              className="shrink-0 text-[15px] text-[#007aff]"
            >
              Adjust
            </button>
          )}
        </div>
      </section>

      {/* ADJUST SEARCH */}
      {adjustOpen ? (
        <section className={cn(CARD_SURFACE, "p-3")}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a pickup place…"
            className="h-10 w-full rounded-[12px] border border-border/70 bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[#007aff]/25"
          />
          {suggestions.length ? (
            <div className="mt-2 space-y-1">
              {suggestions.map((s) => (
                <button
                  key={s.placeId}
                  type="button"
                  onClick={() => void selectPlace(s.placeId)}
                  className="flex w-full items-center gap-2 rounded-[11px] px-2 py-2 text-left hover:bg-[#007aff]/10"
                >
                  <Navigation className="h-4 w-4 shrink-0 rotate-90 text-[#007aff]" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{s.text}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* WHO DO YOU ASK */}
      <div>
        <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          Who do you ask
        </p>
        <section className={cn(CARD_SURFACE, "px-4")}>
          {contacts.length ? (
            contacts.map((recipient, index) => {
              const ready = vm.isRecipientShareReady(recipient);
              const selected = selectedId === recipient.userId;
              const dist = distanceLabel(recipient.userId);
              return (
                <button
                  key={recipient.userId}
                  type="button"
                  onClick={ready ? () => setSelectedId(recipient.userId) : undefined}
                  disabled={!ready}
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-center gap-[13px] py-3 text-left",
                    index < contacts.length - 1 && "border-b border-black/[0.06] dark:border-white/10",
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
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-semibold text-foreground">
                      {vm.recipientLabel(recipient)}
                    </span>
                    {dist ? (
                      <span className="block truncate text-sm text-muted-foreground">{dist}</span>
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                      selected ? "border-[#007aff] bg-[#007aff] text-white" : "border-border",
                    )}
                  >
                    {selected ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
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

      {/* NOTE */}
      <div>
        <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          Note
        </p>
        <section className={cn(CARD_SURFACE, "p-3")}>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
            placeholder="Meet me at the main entrance."
            className="w-full bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </section>
      </div>

      <p className="px-1 text-center text-sm text-muted-foreground">
        {fixedSpot
          ? "They see your pickup spot until you're picked up or cancel."
          : "They see your live pickup spot until you're picked up or cancel."}
      </p>

      {/* ACTION */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() =>
            selectedContact &&
            vm.onPickMeUp(
              [selectedContact.userId],
              PICKUP_DURATION_HOURS,
              note.trim() || undefined,
              fixedSpot ?? undefined,
            )
          }
          disabled={!canAsk}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-[#007aff] py-4 text-[17px] font-medium text-white transition-opacity disabled:opacity-40"
        >
          <Navigation className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={0} />
          {busy ? "Asking…" : selectedName ? `Ask ${selectedName} to pick me up` : "Select who to ask"}
        </button>
      </div>
    </div>
  );
}
