"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";
import type { ColorVariant, ComponentEffect } from "@/lib/morphy-ux/types";
import { cn } from "@/lib/utils";

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
  // A pending setup is deliberately secondary, but it must retain the same
  // Foundation accent and tactile feedback as the Agent Bar. Keeping callers
  // on the existing `none` + `fade` contract avoids creating a second setup
  // action vocabulary while preventing the light-theme gray container look.
  const isQuietSetupAction = variant === "none" && effect === "fade";
  const visualVariant = isQuietSetupAction ? "blue" : variant;

  return (
    <div className="mt-10 sm:mt-12">
      <div className="relative z-20 space-y-2 bg-transparent py-2">
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
            variant={visualVariant}
            effect={effect}
            size="lg"
            fullWidth
            className={cn(
              "h-12 text-base",
              isQuietSetupAction &&
                "!border-0 !bg-transparent text-accent-strong hover:!bg-accent-surface dark:hover:!bg-accent-surface/70",
            )}
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
    </div>
  );
}
