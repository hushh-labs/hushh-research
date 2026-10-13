"use client";

import { MapPin, Loader2, X } from "@/components/icons";
import { Headline, SupportingText } from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";

export type SavedPlacesBannerProps = {
  busy: boolean;
  onSave: () => void;
  onDismiss: () => void;
};

export function SavedPlacesBanner({ busy, onSave, onDismiss }: SavedPlacesBannerProps) {
  return (
    <aside
      aria-labelledby="saved-places-banner-title"
      className="relative rounded-[var(--app-card-radius-standard)] border border-[var(--app-accent-border)] bg-[color:var(--app-accent-tint)] p-4 sm:p-5"
      data-testid="saved-places-banner"
    >
      <button
        type="button"
        aria-label="Dismiss saved places reminder"
        onClick={onDismiss}
        className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-[color:var(--app-secondary-label)] hover:bg-[color:var(--app-neutral-fill)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)] disabled:opacity-50"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      <div className="flex items-start gap-3 pr-7">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]" aria-hidden="true">
          <MapPin className="h-5 w-5" />
        </span>
        <div className="min-w-0 space-y-1">
          <Headline as="h2" id="saved-places-banner-title">Keep your favourite places handy</Headline>
          <SupportingText>Save home, work, or a favourite spot for next time.</SupportingText>
        </div>
      </div>
      <Button type="button" onClick={onSave} disabled={busy} aria-busy={busy || undefined} className="mt-3 min-h-11 w-full sm:w-auto sm:ml-[52px]">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        {busy ? "Finding your location…" : "Save a place"}
      </Button>
    </aside>
  );
}
