"use client";

import { useId, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2, MapPin, Pencil } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SHELL_ICON_BUTTON_CLASSNAME } from "@/components/app-ui/shell-action-surface-base";
import { OnboardingOptionSheet } from "./onboarding-option-sheet";
import { cn } from "@/lib/utils";

export function OnboardingPlaceScreen({
  map,
  routeId,
  nativeMapShowing = false,
  address,
  loadingAddress,
  categoryPicker,
  details,
  hasPoint,
  canSave,
  busy,
  capturing,
  saved,
  error,
  onBack,
  onRequestLocation,
  onSave,
  onLater,
}: {
  map: ReactNode;
  routeId?: string;
  nativeMapShowing?: boolean;
  address: string;
  loadingAddress: boolean;
  categoryPicker: ReactNode;
  details: ReactNode;
  hasPoint: boolean;
  canSave: boolean;
  busy: boolean;
  capturing: boolean;
  saved: boolean;
  error: string | null;
  onBack: () => void;
  onRequestLocation: () => void;
  onSave: () => void;
  onLater: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const addressSummaryId = useId();
  return (
    <div
      data-testid="one-location-onboarding-place-screen"
      className={cn("flex h-full min-h-0 flex-col overflow-y-auto px-4 pb-[max(env(safe-area-inset-bottom,0px),12px)] pt-[max(var(--app-safe-area-top-effective,0px),8px)] sm:px-6", nativeMapShowing ? "bg-transparent" : "bg-[color:var(--app-grouped-background)]")}
    >
      <header className="bg-[color:var(--app-grouped-background)] flex h-11 shrink-0 items-center gap-3">
        <button type="button" aria-label="Go back" onClick={onBack} disabled={busy} className={cn(SHELL_ICON_BUTTON_CLASSNAME, "!h-11 !w-11 shrink-0")}>
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <h1 data-location-type-role="flow-title" className="ui-text-page-title text-[color:var(--app-label)]">Your place.</h1>
      </header>
      <p data-location-type-role="row-description" className="bg-[color:var(--app-grouped-background)] mb-3 mt-2 shrink-0 text-muted-foreground">Share live. Check in. Send an SOS.</p>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(136px,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1fr)_340px] md:grid-rows-1 md:gap-6">
        <div className="relative min-h-0 overflow-hidden rounded-[20px]" data-testid="onboarding-place-map">
          {hasPoint ? map : (
            <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-[20px] bg-[color:var(--app-secondary-surface)] px-5 text-center text-muted-foreground">
              {capturing ? <Loader2 className="h-7 w-7 animate-spin" aria-hidden /> : <MapPin className="h-7 w-7" aria-hidden />}
              <p data-location-type-role="row-description">{capturing ? "Finding your location…" : "Choose a starting point. Nothing is shared."}</p>
            </div>
          )}
        </div>
        <div className="bg-[color:var(--app-grouped-background)] flex min-h-0 flex-col justify-center gap-2" data-testid="onboarding-place-controls">
          <button
            type="button"
            aria-label="Edit address details"
            aria-describedby={addressSummaryId}
            disabled={busy || saved}
            onClick={() => setEditing(true)}
            className="flex min-h-16 w-full items-center gap-3 rounded-[16px] border border-border/60 bg-[color:var(--app-primary-surface)] px-3 py-2 text-left disabled:opacity-60"
          >
            <MapPin className="h-5 w-5 shrink-0 text-[color:var(--app-accent)]" aria-hidden />
            <span className="min-w-0 flex-1">
              <span data-location-type-role="row-description" className="block text-muted-foreground">Your place</span>
              <span id={addressSummaryId} data-location-type-role="row-title" className="line-clamp-2 block" title={address}>
                {address || (loadingAddress ? "Finding this address…" : hasPoint ? "Add an address" : "Use your current location")}
              </span>
            </span>
            <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
          {!saved ? categoryPicker : null}
          <p data-location-type-role="row-description" className="text-center text-muted-foreground">{saved ? "Place saved." : "Private until you share."}</p>
          {error ? <p role="status" data-location-type-role="status" className="text-center text-[color:var(--app-destructive)]">{error}</p> : null}
          <footer className="shrink-0 pt-1">
            <Button
              type="button"
              size="prominent"
              data-location-type-role="primary-action"
              onClick={!hasPoint ? onRequestLocation : onSave}
              disabled={busy || (hasPoint && !saved && !canSave)}
              aria-busy={busy || undefined}
              className="mx-auto flex w-full max-w-[244px]"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {capturing ? "Finding location…" : busy ? "Saving…" : saved ? "Continue" : !hasPoint ? "Use my location" : error ? "Try saving again" : "Save & continue"}
            </Button>
            <button type="button" onClick={onLater} disabled={busy} data-location-type-role="utility-action" className="mx-auto block min-h-11 px-5 text-[color:var(--app-accent)] disabled:opacity-50">Set up later</button>
          </footer>
        </div>
      </div>
      <OnboardingOptionSheet routeId={routeId} overPlace open={editing} onClose={() => setEditing(false)} title="Address details" busy={busy}>
        <div className="space-y-4">{details}</div>
        <Button type="button" size="standard" className="mx-auto mt-5 flex" onClick={() => setEditing(false)}>Done</Button>
      </OnboardingOptionSheet>
    </div>
  );
}
