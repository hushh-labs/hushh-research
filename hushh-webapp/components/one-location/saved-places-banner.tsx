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
      className="grid grid-cols-[32px_minmax(0,1fr)_44px] items-center gap-x-2 gap-y-1.5 rounded-[var(--app-card-radius-standard)] border border-[var(--app-accent-border)] bg-[color:var(--app-accent-tint)] p-2.5 sm:grid-cols-[32px_minmax(0,1fr)_auto_44px] sm:p-3"
      data-testid="saved-places-banner"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]" aria-hidden="true">
        <MapPin className="h-4 w-4" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <Headline as="h2" id="saved-places-banner-title">Save your places</Headline>
        <SupportingText>Home, work and more.</SupportingText>
      </div>
      <Button type="button" size="standard" onClick={onSave} disabled={busy} aria-busy={busy || undefined} className="col-span-3 row-start-2 w-full sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:w-auto">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        {busy ? "Finding your location…" : "Save a place"}
      </Button>
      <button
        type="button"
        aria-label="Dismiss saved places reminder"
        onClick={onDismiss}
        className="col-start-3 row-start-1 flex h-11 w-11 items-center justify-center rounded-full text-[color:var(--app-secondary-label)] hover:bg-[color:var(--app-neutral-fill)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)] disabled:opacity-50 sm:col-start-4"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </aside>
  );
}
