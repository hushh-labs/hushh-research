"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";
import type { ColorVariant, ComponentEffect } from "@/lib/morphy-ux/types";

type SetupCompletionFooterProps = {
  label: string;
  onComplete: () => void;
  busy?: boolean;
  disabled?: boolean;
  controlId: string;
  actionId?: string;
  testId?: string;
  purpose: string;
  supportingText?: string;
  /** Lets the hub make "Skip" intentionally quieter than a verified finish. */
  variant?: ColorVariant;
  /** Flat controls use the shared fade state layer in both themes. */
  effect?: ComponentEffect;
};

/**
 * Shared terminal setup action.
 *
 * Routes may show this while a prerequisite is pending, but must keep it
 * disabled until their own completion condition is verified. The canonical
 * bottom inset keeps it above app chrome on safe-area and keyboard-resized
 * native viewports, with the same calm full-width action cadence everywhere.
 */
export function SetupCompletionFooter({
  label,
  onComplete,
  busy = false,
  disabled = false,
  controlId,
  actionId,
  testId,
  purpose,
  supportingText,
  variant = "blue-gradient",
  effect = "fill",
}: SetupCompletionFooterProps) {
  return (
    <div className="sticky bottom-[calc(var(--app-bottom-inset)+var(--onboarding-agent-bar-clearance,3.75rem)+0.75rem)] z-20 mt-8 space-y-3 bg-transparent py-3 sm:mt-10">
      {supportingText ? (
        <p className="text-center text-xs text-muted-foreground">
          {supportingText}
        </p>
      ) : null}
      <div className="mx-auto w-full sm:max-w-[22rem]">
        <Button
          type="button"
          onClick={onComplete}
          disabled={disabled}
          loading={busy}
          variant={variant}
          effect={effect}
          size="lg"
          fullWidth
          className="h-12 text-base"
          data-testid={testId}
          data-voice-control-id={controlId}
          data-voice-action-id={actionId}
          data-voice-label={label}
          data-voice-purpose={purpose}
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {label}
        </Button>
      </div>
    </div>
  );
}
