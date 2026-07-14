"use client";

/**
 * One Location redesign — Safe Arrival flow (Quick Action).
 *
 * "Let people know you got there safely." A focused, full-screen task flow for
 * the classic peace-of-mind moment: walking home late, a solo trip, a child or
 * elder heading somewhere, a first date. You pick where you're headed, choose
 * trusted people, and share your LIVE location + live ETA until you arrive — so
 * they can watch your journey and see the moment you reach your destination.
 *
 * PRESENTATION + LOCAL SELECTION STATE ONLY.
 * - Destination search reuses the same backend Places proxy + recents as Drive
 *   To (`vm.vaultOwnerToken`, `vm.recentDestinations`).
 * - The list of people is the SAME trusted circle used by SOS / Check-In
 *   (`vm.sosRecipients`).
 * - On confirm it hands destination + recipient ids + duration + a note to
 *   `vm.onSafeArrival`, which runs the exact same createGrant + encrypt + publish
 *   drive pipeline (destination + ETA ride INSIDE the encrypted envelope). No new
 *   crypto, no new consent surface — just an arrival-focused framing on top of
 *   the proven live-share path.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Clock,
  Home,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OneLocationService } from "@/lib/one-location/service";
import type { DriveDestination } from "@/lib/one-location/types";

import { TaskFlowHeader } from "./primitives";
import { CARD_SURFACE, MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";

import type { LocationHubViewModel } from "./location-redesign-hub";

/** How long the safety watch stays live (auto-stops on its own). */
const SAFE_ARRIVAL_DURATIONS: { value: string; label: string }[] = [
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "2", label: "2 hours" },
];

const SAFE_ARRIVAL_NOTE_MAX_LENGTH = 120;
const DEFAULT_SAFE_ARRIVAL_MESSAGE = "Watch me get there safely — I'll arrive soon";

// Contact list cap: trusted circles can be long, so show ~4 rows then scroll.
const CONTACT_LIST_SCROLL_CLASS =
  "max-h-[300px] space-y-2.5 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/15 dark:[&::-webkit-scrollbar-thumb]:bg-white/20";

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

function ContactRow({
  index,
  checked,
  ready,
  label,
  subtitle,
  onToggle,
}: {
  index: number;
  checked: boolean;
  ready: boolean;
  label: string;
  subtitle: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={ready ? onToggle : undefined}
      disabled={!ready}
      aria-pressed={checked}
      className={cn(
        SUBCARD_SURFACE,
        "flex w-full items-center gap-3 p-3 text-left transition-all duration-150",
        ready
          ? "hover:border-[color:var(--app-accent-ring)] active:scale-[0.99]"
          : "cursor-not-allowed opacity-60",
        checked && "border-[color:var(--app-accent)]/60 ring-1 ring-[color:var(--app-accent-ring)]",
      )}
    >
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          avatarTone(index),
        )}
        aria-hidden
      >
        {initialsOf(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">
          {label}
        </span>
        <span className={cn(MUTED_TEXT, "block truncate")}>
          {ready ? subtitle : "Not ready to receive location"}
        </span>
      </span>
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border-2 transition-colors",
          checked
            ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
            : "border-border bg-background",
        )}
      >
        {checked ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

export function SafeArrivalFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const contacts = vm.sosRecipients;
  const busy = vm.safeArrivalBusy || vm.busy === "selfLocation";

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<
    { placeId: string; text: string }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [destination, setDestination] = useState<DriveDestination | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [durationValue, setDurationValue] = useState("1");
  const [note, setNote] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);

  // No default selection: the user explicitly chooses who should know.

  // Debounced Places autocomplete via the backend proxy (same as Drive To).
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
      } catch (error) {
        if (!cancelled) {
          setSuggestions([]);
          setSearchError(OneLocationService.placesSearchErrorMessage(error));
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
  const canStart =
    Boolean(destination) && Boolean(point) && selectedReadyCount > 0;
  const effectiveMessage = note.trim() || DEFAULT_SAFE_ARRIVAL_MESSAGE;

  const startLabel = !destination
    ? "Choose your destination"
    : !point
      ? "Capture your location first"
      : selectedReadyCount === 0
        ? "Select who should know"
        : "Start Safe Arrival watch";

  const recentDestinations = vm.recentDestinations;

  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Safe Arrival"
        title="Let people know you got there safely"
        description="Share your live journey and ETA until you reach your destination."
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
            placeholder="Home, hotel, station…"
            className="h-11 w-full rounded-[14px] border border-border/70 bg-background pl-10 pr-4 text-base text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
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
                className={cn(
                  SUBCARD_SURFACE,
                  "flex w-full items-center gap-3 p-3 text-left hover:border-[color:var(--app-accent-ring)]",
                )}
              >
                <MapPin className="h-4 w-4 shrink-0 text-[color:var(--app-accent)]" />
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
                onClick={() =>
                  void selectSuggestion(suggestion.placeId, suggestion.text)
                }
                className={cn(
                  SUBCARD_SURFACE,
                  "flex w-full items-center gap-3 p-3 text-left hover:border-[color:var(--app-accent-ring)]",
                )}
              >
                <MapPin className="h-4 w-4 shrink-0 text-[color:var(--app-accent)]" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {suggestion.text}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {searching ? <p className={cn(MUTED_TEXT, "mt-2")}>Searching…</p> : null}

        {destination ? (
          <div className={cn(SUBCARD_SURFACE, "mt-3 flex items-center gap-2 p-3")}>
            <Home className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {destination.label}
            </span>
            <Check className="h-4 w-4 shrink-0 text-emerald-600" />
          </div>
        ) : null}
      </section>

      {/* YOUR LOCATION */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
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

      {/* WHO SHOULD KNOW? */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Who should know you&apos;re safe?
        </p>
        <div
          className={cn(
            contacts.length ? CONTACT_LIST_SCROLL_CLASS : "space-y-2.5",
          )}
        >
          {contacts.length ? (
            contacts.map((recipient, index) => (
              <ContactRow
                key={recipient.userId}
                index={index}
                checked={checkedIds.includes(recipient.userId)}
                ready={vm.isRecipientShareReady(recipient)}
                label={vm.recipientLabel(recipient)}
                subtitle={vm.recipientSubtitle(recipient)}
                onToggle={() => toggle(recipient.userId)}
              />
            ))
          ) : (
            <div
              className={cn(
                SUBCARD_SURFACE,
                "p-5 text-center text-sm text-muted-foreground",
              )}
            >
              No trusted contacts yet. Add people to your Circle first.
            </div>
          )}
        </div>
      </section>

      {/* DURATION */}
      <section
        className={cn(
          "rounded-[var(--app-card-radius-standard)] border border-emerald-500/20 bg-emerald-500/[0.06] p-4 dark:bg-emerald-400/[0.08]",
        )}
      >
        <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
          <Clock className="h-3.5 w-3.5" />
          Watch me for
        </p>
        <div className="flex flex-wrap gap-2">
          {SAFE_ARRIVAL_DURATIONS.map((option) => {
            const active = option.value === durationValue;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setDurationValue(option.value)}
                className={cn(
                  "h-9 rounded-full border px-4 text-sm font-medium transition-colors",
                  active
                    ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                    : "border-border/70 bg-background text-foreground hover:border-[color:var(--app-accent-ring)]",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" />
          Sharing stops automatically · no manual revoke needed
        </p>
      </section>

      {/* NOTE — optional, shown with the arrival share. */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Add a note (optional)
          </p>
          <span className="text-[11px] font-medium text-muted-foreground">
            {note.length}/{SAFE_ARRIVAL_NOTE_MAX_LENGTH}
          </span>
        </div>
        <textarea
          value={note}
          onChange={(event) =>
            setNote(event.target.value.slice(0, SAFE_ARRIVAL_NOTE_MAX_LENGTH))
          }
          rows={2}
          placeholder={DEFAULT_SAFE_ARRIVAL_MESSAGE}
          className="w-full rounded-[14px] border border-border/70 bg-background p-3 text-sm text-foreground outline-none transition-shadow focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
        />
        <p className={cn(MUTED_TEXT, "mt-2")}>
          They&apos;ll follow your live location and ETA, and can see the moment
          you reach {destination ? destination.label : "your destination"}.
        </p>
      </section>

      {/* ACTION BAR */}
      <div className="space-y-2 pt-1">
        <Button
          onClick={() =>
            destination &&
            vm.onSafeArrival(
              destination,
              checkedIds,
              durationValue,
              effectiveMessage,
            )
          }
          disabled={!canStart}
          isLoading={busy}
          className="h-12 w-full rounded-2xl bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-600/90 disabled:opacity-50"
        >
          <ShieldCheck className="mr-1.5 h-5 w-5" />
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
