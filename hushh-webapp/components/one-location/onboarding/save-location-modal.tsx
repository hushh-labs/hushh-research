"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Briefcase, Check, Home, Loader2, MapPin, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SavedLocationCategory } from "@/lib/one-location/saved-locations";

export type SaveLocationModalProps = {
  open: boolean;
  /** Reverse-geocoded address for display; falls back to coordinates. */
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** True while the location capture is still resolving. */
  loadingAddress?: boolean;
  /** True while a save is in flight. */
  saving?: boolean;
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

function coordinateLabel(
  latitude?: number | null,
  longitude?: number | null,
): string | null {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    Number.isNaN(latitude) ||
    Number.isNaN(longitude)
  ) {
    return null;
  }
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/**
 * SaveLocationModal — a focused, responsive prompt shown once during Location
 * onboarding, right after the user grants access, asking them to tag the place
 * they're at (Home / Work / Other). Rendered INSIDE the onboarding takeover so
 * it stacks above it without portal/z-index fights.
 */
export function SaveLocationModal({
  open,
  address,
  latitude,
  longitude,
  loadingAddress = false,
  saving = false,
  onSave,
  onSkip,
}: SaveLocationModalProps) {
  const [category, setCategory] = useState<SavedLocationCategory | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const titleId = useId();
  const descId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Reset internal selection each time the modal (re)opens.
  useEffect(() => {
    if (open) {
      setCategory(null);
      setCustomLabel("");
    }
  }, [open]);

  // Close on Escape (counts as Skip). Only while open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSkip();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onSkip]);

  // Move focus into the modal when it opens.
  useEffect(() => {
    if (open) cardRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const resolvedAddress =
    (address && address.trim()) || coordinateLabel(latitude, longitude);
  const canSave =
    category !== null && !saving && (category !== "other" || true);

  const handleSave = () => {
    if (!category || saving) return;
    const label =
      category === "other" ? customLabel.trim() || "Other" : undefined;
    onSave(category, label ?? "");
  };

  return (
    <div
      className="fixed inset-0 z-[560] flex items-end justify-center sm:items-center"
      data-testid="save-location-modal"
    >
      <button
        type="button"
        aria-label="Skip saving this location"
        onClick={onSkip}
        className="absolute inset-0 h-full w-full cursor-default bg-black/45 backdrop-blur-[6px]"
        tabIndex={-1}
      />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className={cn(
          "relative z-10 flex w-full max-w-[420px] flex-col gap-5 outline-none",
          "rounded-t-[28px] sm:rounded-[24px]",
          "border border-black/[0.06] bg-white p-6 pb-[calc(env(safe-area-inset-bottom,0px)+22px)] sm:pb-6",
          "shadow-[0_-8px_40px_rgba(16,24,40,0.18)] sm:shadow-[0_20px_60px_rgba(16,24,40,0.24)]",
          "dark:border-white/[0.08] dark:bg-[#141922]",
          "[animation:saveLocSheetIn_.28s_cubic-bezier(0.22,1,0.36,1)_both]",
        )}
      >
        <button
          type="button"
          onClick={onSkip}
          aria-label="Close"
          className="press-scale absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.05] text-[#4b5563] transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08] dark:text-[#aeb8c7]"
        >
          <X className="h-4.5 w-4.5" strokeWidth={2.4} />
        </button>

        <header className="pr-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[color:var(--app-accent-tint,#e7f0fd)] text-[color:var(--app-accent,#087ff5)]">
            <MapPin className="h-6 w-6" strokeWidth={2.2} />
          </span>
          <h2
            id={titleId}
            className="mt-3.5 text-[22px] font-bold leading-[1.15] tracking-[-0.01em] text-[#0b1220] dark:text-[#f4f7fb]"
          >
            Save this place
          </h2>
          <p
            id={descId}
            className="mt-1.5 text-[14px] leading-[1.45] text-[#5b6472] dark:text-[#9aa6b6]"
          >
            Tag where you are so One can personalise your experience. Only you
            can see this.
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
            {loadingAddress && !resolvedAddress ? (
              <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-[#5b6472] dark:text-[#9aa6b6]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding your
                address…
              </span>
            ) : (
              <p className="mt-0.5 truncate text-[14px] font-semibold text-[#111827] dark:text-[#e9eef7]">
                {resolvedAddress || "Location captured"}
              </p>
            )}
          </div>
        </div>

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
                  className={cn(
                    "press-scale flex flex-col items-center justify-center gap-2 rounded-2xl border-2 px-2 py-4 transition-colors",
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
              htmlFor={`${titleId}-label`}
              className="mb-1.5 block text-[13px] font-semibold text-[#374151] dark:text-[#c4cdda]"
            >
              Give it a name
            </label>
            <input
              id={`${titleId}-label`}
              type="text"
              value={customLabel}
              onChange={(event) => setCustomLabel(event.target.value)}
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
            disabled={saving}
            className="h-11 w-full rounded-full text-[15px] font-semibold text-[#6b7280] transition-colors hover:text-[#374151] disabled:opacity-50 dark:text-[#9aa6b6] dark:hover:text-[#c4cdda]"
          >
            Skip for now
          </button>
        </div>
      </div>

      <style>{`
        @keyframes saveLocSheetIn {
          from { opacity: 0; transform: translateY(18px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes saveLocFadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-testid="save-location-modal"] [role="dialog"] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}
