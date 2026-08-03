"use client";

import { useEffect, useId, useState } from "react";
import {
  Briefcase,
  Check,
  Home,
  Loader2,
  MapPin,
  Pencil,
  Search,
  X,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { SavedLocationCategory } from "@/lib/one-location/saved-locations";

export type SavedLocationPlaceSuggestion = {
  placeId: string;
  text: string;
};

export type SaveLocationModalProps = {
  open: boolean;
  /** Reverse-geocoded address for display. */
  address?: string | null;
  /** True while the location capture is still resolving. */
  loadingAddress?: boolean;
  /** True while a save is in flight. */
  saving?: boolean;
  /** Authenticated Maps search; selected place details replace point + copy. */
  onSearchPlaces?: (
    input: string,
  ) => Promise<SavedLocationPlaceSuggestion[]>;
  onSelectPlace?: (placeId: string) => Promise<void>;
  onSave: (category: SavedLocationCategory, label: string) => void;
  onSkip: () => void;
};

const CATEGORY_OPTIONS: {
  category: SavedLocationCategory;
  label: string;
  Icon: typeof Home;
}[] = [
  { category: "home", label: "Home", Icon: Home },
  { category: "work", label: "Work", Icon: Briefcase },
  { category: "other", label: "Other", Icon: MapPin },
];

/**
 * SaveLocationModal — a focused, responsive prompt shown during Location
 * onboarding after access is ready. The owner can correct the captured place
 * before tagging it as Home / Work / Other. The shared dialog primitive owns
 * focus trapping, focus restoration, Escape handling, and screen-reader
 * semantics.
 */
export function SaveLocationModal({
  open,
  address,
  loadingAddress = false,
  saving = false,
  onSearchPlaces,
  onSelectPlace,
  onSave,
  onSkip,
}: SaveLocationModalProps) {
  const [category, setCategory] = useState<SavedLocationCategory | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [editingPlace, setEditingPlace] = useState(false);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeSuggestions, setPlaceSuggestions] = useState<
    SavedLocationPlaceSuggestion[]
  >([]);
  const [placeSearching, setPlaceSearching] = useState(false);
  const [placeSearchError, setPlaceSearchError] = useState<string | null>(null);
  const [selectingPlaceId, setSelectingPlaceId] = useState<string | null>(null);
  const descriptionId = useId();

  // Reset internal selection each time the modal (re)opens.
  useEffect(() => {
    if (open) {
      setCategory(null);
      setCustomLabel("");
      setEditingPlace(false);
      setPlaceQuery("");
      setPlaceSuggestions([]);
      setPlaceSearching(false);
      setPlaceSearchError(null);
      setSelectingPlaceId(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !editingPlace || !onSearchPlaces) return;
    const input = placeQuery.trim();
    if (input.length < 2) {
      setPlaceSuggestions([]);
      setPlaceSearching(false);
      setPlaceSearchError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPlaceSearching(true);
      setPlaceSearchError(null);
      void onSearchPlaces(input)
        .then((suggestions) => {
          if (cancelled) return;
          setPlaceSuggestions(suggestions);
          if (suggestions.length === 0) {
            setPlaceSearchError("No matching places found.");
          }
        })
        .catch(() => {
          if (cancelled) return;
          setPlaceSuggestions([]);
          setPlaceSearchError("Could not search places. Please try again.");
        })
        .finally(() => {
          if (!cancelled) setPlaceSearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editingPlace, onSearchPlaces, open, placeQuery]);

  const resolvedAddress = (address && address.trim()) || null;
  const changingPlace = selectingPlaceId !== null;
  const interactionBusy = saving || changingPlace;
  const canEditPlace = Boolean(onSearchPlaces && onSelectPlace);
  const canSave =
    category !== null &&
    !saving &&
    !loadingAddress &&
    !editingPlace &&
    !changingPlace;

  const handleSelectPlace = async (placeId: string) => {
    if (!onSelectPlace || changingPlace) return;
    setSelectingPlaceId(placeId);
    setPlaceSearchError(null);
    try {
      await onSelectPlace(placeId);
      setEditingPlace(false);
      setPlaceQuery("");
      setPlaceSuggestions([]);
    } catch {
      setPlaceSearchError("Could not update this place. Please try again.");
    } finally {
      setSelectingPlaceId(null);
    }
  };

  const handleSave = () => {
    if (!category || !canSave) return;
    const label =
      category === "other" ? customLabel.trim() || "Other" : undefined;
    onSave(category, label ?? "");
  };

  return (
    <Dialog
      open={open}
      modal
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !interactionBusy) onSkip();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="save-location-modal"
        aria-describedby={descriptionId}
        overlayClassName="z-[559] bg-black/45 backdrop-blur-[6px]"
        onEscapeKeyDown={(event) => {
          if (interactionBusy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (interactionBusy) event.preventDefault();
        }}
        className={cn(
          "z-[560] bottom-0 top-auto max-h-[min(92dvh,760px)] w-full max-w-[420px] translate-y-0 gap-5 overflow-y-auto",
          "rounded-b-none rounded-t-[28px] sm:bottom-auto sm:top-[50%] sm:translate-y-[-50%] sm:rounded-[24px]",
          "border border-black/[0.06] bg-white p-6 pb-[calc(env(safe-area-inset-bottom,0px)+22px)] sm:pb-6",
          "shadow-[0_-8px_40px_rgba(16,24,40,0.18)] sm:shadow-[0_20px_60px_rgba(16,24,40,0.24)]",
          "dark:border-white/[0.08] dark:bg-[#141922]",
        )}
      >
        <button
          type="button"
          onClick={onSkip}
          disabled={interactionBusy}
          aria-label="Close"
          className="press-scale absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.05] text-[#4b5563] transition-colors hover:bg-black/[0.08] disabled:opacity-45 dark:bg-white/[0.08] dark:text-[#aeb8c7]"
        >
          <X className="h-4.5 w-4.5" strokeWidth={2.4} />
        </button>

        <header className="pr-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[color:var(--app-accent-tint,#e7f0fd)] text-[color:var(--app-accent,#087ff5)]">
            <MapPin className="h-6 w-6" strokeWidth={2.2} />
          </span>
          <DialogTitle
            className="mt-3.5 text-[22px] font-bold leading-[1.15] tracking-[-0.01em] text-[#0b1220] dark:text-[#f4f7fb]"
          >
            Save this place
          </DialogTitle>
          <p
            id={descriptionId}
            className="mt-1.5 text-[14px] leading-[1.45] text-[#5b6472] dark:text-[#9aa6b6]"
          >
            Tag where you are so One can personalise your experience. It stays
            encrypted in your vault and is shared only when you approve
            location access.
          </p>
        </header>

        <div className="flex items-center gap-2.5 rounded-2xl bg-[#f4f6fa] px-3.5 py-3 dark:bg-white/[0.05]">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-[color:var(--app-accent,#087ff5)] shadow-sm dark:bg-[#1c2430]">
            <MapPin className="h-4 w-4" strokeWidth={2.4} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#8b93a1] dark:text-[#7f8a99]">
              Current location
            </p>
            {loadingAddress ? (
              <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-[#5b6472] dark:text-[#9aa6b6]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding your
                address…
              </span>
            ) : (
              <p className="mt-0.5 truncate text-[14px] font-semibold text-[#111827] dark:text-[#e9eef7]">
                {resolvedAddress || "Address unavailable"}
              </p>
            )}
          </div>
          {canEditPlace && !loadingAddress ? (
            <button
              type="button"
              onClick={() => {
                setEditingPlace(true);
                setPlaceQuery("");
                setPlaceSuggestions([]);
                setPlaceSearchError(null);
              }}
              disabled={interactionBusy}
              className="press-scale inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-white px-2.5 text-[12px] font-bold text-[color:var(--app-accent-deep,#0b62c4)] shadow-sm disabled:opacity-45 dark:bg-white/[0.08] dark:text-[#9bc7f5]"
              aria-label="Change captured location"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Change
            </button>
          ) : null}
        </div>

        {editingPlace ? (
          <div className="space-y-2.5 [animation:saveLocFadeIn_.2s_ease-out_both]">
            <label
              htmlFor="saved-location-place-search"
              className="block text-[13px] font-semibold text-[#374151] dark:text-[#c4cdda]"
            >
              Search for another place
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8b93a1]"
                aria-hidden
              />
              <input
                id="saved-location-place-search"
                type="search"
                value={placeQuery}
                onChange={(event) => setPlaceQuery(event.target.value)}
                disabled={interactionBusy}
                autoComplete="off"
                placeholder="Search address or place"
                className="h-12 w-full rounded-2xl border border-black/[0.1] bg-white pl-10 pr-10 text-[15px] text-[#111827] outline-none transition-colors placeholder:text-[#9aa2b0] focus:border-[color:var(--app-accent,#087ff5)] focus:ring-2 focus:ring-[color:var(--app-accent,#087ff5)]/25 dark:border-white/[0.12] dark:bg-white/[0.05] dark:text-[#e9eef7]"
              />
              {placeSearching || changingPlace ? (
                <Loader2
                  className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[#8b93a1]"
                  aria-label="Searching places"
                />
              ) : null}
            </div>

            {placeSuggestions.length > 0 ? (
              <div
                className="max-h-40 overflow-y-auto rounded-2xl border border-black/[0.08] bg-white p-1 shadow-sm dark:border-white/[0.1] dark:bg-[#1b2230]"
                aria-label="Location suggestions"
              >
                {placeSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.placeId}
                    type="button"
                    onClick={() => void handleSelectPlace(suggestion.placeId)}
                    disabled={interactionBusy}
                    className="flex min-h-11 w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium text-[#273142] hover:bg-black/[0.04] disabled:opacity-45 dark:text-[#dce5f2] dark:hover:bg-white/[0.06]"
                  >
                    <MapPin
                      className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--app-accent,#087ff5)]"
                      aria-hidden
                    />
                    <span>{suggestion.text}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {placeSearchError ? (
              <p
                role="alert"
                className="text-[12px] font-medium text-[#b42318] dark:text-[#ff9b91]"
              >
                {placeSearchError}
              </p>
            ) : null}

            <button
              type="button"
              onClick={() => {
                setEditingPlace(false);
                setPlaceQuery("");
                setPlaceSuggestions([]);
                setPlaceSearchError(null);
              }}
              disabled={interactionBusy}
              className="text-[13px] font-semibold text-[#5b6472] disabled:opacity-45 dark:text-[#9aa6b6]"
            >
              Keep current location
            </button>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-[13px] font-semibold text-[#374151] dark:text-[#c4cdda]">
            What kind of place is this?
          </p>
          <div className="grid grid-cols-3 gap-2.5">
            {CATEGORY_OPTIONS.map(({ category: value, label, Icon }) => {
              const selected = category === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setCategory(value)}
                  disabled={interactionBusy}
                  className={cn(
                    "press-scale flex flex-col items-center justify-center gap-2 rounded-2xl border-2 px-2 py-4 transition-colors disabled:opacity-45",
                    selected
                      ? "border-[color:var(--app-accent,#087ff5)] bg-[color:var(--app-accent-tint,#e7f0fd)] text-[color:var(--app-accent-deep,#0b62c4)] dark:bg-[color:var(--app-accent,#087ff5)]/15"
                      : "border-black/[0.08] bg-white text-[#4b5563] hover:border-black/20 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-[#aeb8c7]",
                  )}
                >
                  <Icon className="h-6 w-6" strokeWidth={2.1} />
                  <span className="text-[13px] font-bold">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {category === "other" ? (
          <div className="[animation:saveLocFadeIn_.2s_ease-out_both]">
            <label
              htmlFor="saved-location-custom-label"
              className="mb-1.5 block text-[13px] font-semibold text-[#374151] dark:text-[#c4cdda]"
            >
              Give it a name
            </label>
            <input
              id="saved-location-custom-label"
              type="text"
              value={customLabel}
              onChange={(event) => setCustomLabel(event.target.value)}
              disabled={interactionBusy}
              maxLength={40}
              placeholder="e.g. Gym, Mom's house, Cafe"
              className="h-12 w-full rounded-2xl border border-black/[0.1] bg-white px-4 text-[15px] text-[#111827] outline-none transition-colors placeholder:text-[#9aa2b0] focus:border-[color:var(--app-accent,#087ff5)] focus:ring-2 focus:ring-[color:var(--app-accent,#087ff5)]/25 dark:border-white/[0.12] dark:bg-white/[0.05] dark:text-[#e9eef7]"
            />
          </div>
        ) : null}

        <div className="mt-1 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            aria-busy={saving || undefined}
            className={cn(
              "press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[16px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              "bg-[color:var(--app-accent,#087ff5)] text-[color:var(--app-accent-fg,#ffffff)] hover:bg-[color:var(--app-accent-hover,#0b62c4)]",
            )}
          >
            {saving ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            ) : (
              <Check className="h-5 w-5" strokeWidth={2.6} aria-hidden />
            )}
            Save location
          </button>
          <button
            type="button"
            onClick={onSkip}
            disabled={interactionBusy}
            className="h-11 w-full rounded-full text-[15px] font-semibold text-[#6b7280] transition-colors hover:text-[#374151] disabled:opacity-50 dark:text-[#9aa6b6] dark:hover:text-[#c4cdda]"
          >
            Skip for now
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
