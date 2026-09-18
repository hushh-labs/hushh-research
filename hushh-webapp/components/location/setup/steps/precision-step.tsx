"use client";

import { Check, Crosshair, Grid2x2 } from "@/components/icons";

import {
  HelperText,
  MediumRowLabel,
  RowDescription,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import type { LocationPrecision } from "@/lib/location/account-settings";
import { cn } from "@/lib/utils";

export type PrecisionStepProps = {
  busy: boolean;
  /** The current choice (server value when resuming, otherwise the draft). */
  value: LocationPrecision;
  onChange: (precision: LocationPrecision) => void;
  /** Calls the same `set_precision` PATCH the `advance_location_setup(step=precision)` tool calls. */
  onContinue: () => void;
};

/** Honest, and the same words the consent step used. */
export const APPROXIMATE_SENTENCE =
  "Approximate is applied on this device before it's encrypted.";

const OPTIONS: Array<{
  value: LocationPrecision;
  icon: typeof Crosshair;
  title: string;
  body: string;
}> = [
  {
    value: "precise",
    icon: Crosshair,
    title: "Precise",
    body: "Your exact position, as the device reports it. Best for meeting up or a drive.",
  },
  {
    value: "approximate",
    icon: Grid2x2,
    title: "Approximate",
    body: "Snapped to a grid of about a kilometre. People see the area you're in, not the door.",
  },
];

export function PrecisionStep({
  busy,
  value,
  onChange,
  onContinue,
}: PrecisionStepProps) {
  return (
    <div className="space-y-6" data-testid="location-setup-precision">
      <div
        role="radiogroup"
        aria-label="Sharing precision"
        className="space-y-3"
      >
        {OPTIONS.map(({ value: option, icon: Icon, title, body }) => {
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option)}
              disabled={busy}
              data-testid={`location-setup-precision-${option}`}
              className={cn(
                "press-scale flex min-h-[64px] w-full items-center gap-3 rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3 text-left ring-1 ring-[color:var(--app-separator)] transition-colors disabled:opacity-60",
                selected &&
                  "bg-[color:var(--app-accent-surface)] ring-[color:var(--app-accent)]",
              )}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <MediumRowLabel as="span" className="block">
                  {title}
                </MediumRowLabel>
                <RowDescription as="span" className="mt-0.5 block">
                  {body}
                </RowDescription>
              </span>
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors",
                  selected
                    ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                    : "border-[color:var(--app-separator)] bg-transparent text-transparent",
                )}
                aria-hidden
              >
                <Check className="h-4 w-4" />
              </span>
            </button>
          );
        })}
      </div>

      <HelperText data-testid="location-setup-precision-note">
        {APPROXIMATE_SENTENCE} Hussh only stores which one you chose; it can
        never see or adjust a coordinate. Save My Soul is always precise.
      </HelperText>

      <Button
        type="button"
        size="lg"
        className="w-full"
        onClick={onContinue}
        isLoading={busy}
        disabled={busy}
        data-testid="location-setup-precision-continue"
      >
        Continue
      </Button>
    </div>
  );
}
