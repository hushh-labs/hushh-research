"use client";

import { Loader2 } from "@/components/icons";

import { Button } from "@/lib/morphy-ux/button";
import type { ColorVariant, ComponentEffect } from "@/lib/morphy-ux/types";
import { cn } from "@/lib/utils";

type SetupCompletionFooterProps = {
  label: string;
  onComplete: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** A prerequisite that keeps the shared primary action disabled. */
  blocked?: boolean;
  controlId: string;
  actionId?: string;
  testId?: string;
  purpose: string;
  supportingText?: string;
  /**
   * Whether this footer reserves space for the bottom app chrome itself.
   *
   * True is right when the footer sits directly under the scroll root. It is
   * WRONG when the footer is nested inside a host that already reserved the
   * same token: on the Finance questionnaire the wizard's main already carries
   * pb-[var(--app-scroll-bottom-pad)], so this added a second ~142px band and
   * the three question screens each scrolled into empty space below the Skip
   * control.
   *
   * The inset belongs to whichever box is outermost. Passing false lets a host
   * that already owns it say so, rather than every nested footer guessing.
   */
  insetBottom?: boolean;
  /** Lets the hub make "Skip" intentionally quieter than a verified finish. */
  variant?: ColorVariant;
  /** Flat controls use the shared fade state layer in both themes. */
  effect?: ComponentEffect;
};

/** Shared primary action for setup flows. */
export function SetupCompletionFooter({
  label,
  onComplete,
  busy = false,
  disabled = false,
  blocked = false,
  controlId,
  actionId,
  testId,
  purpose,
  supportingText,
  insetBottom = true,
  variant = "blue",
  effect = "fill",
}: SetupCompletionFooterProps) {
  const isQuietSetupAction = variant === "none" && effect === "fade";
  const visualVariant = variant === "blue-gradient" ? "blue" : variant;

  return (
    <div
      className={cn(
        "mt-4",
        insetBottom
          ? "pb-[calc(var(--app-scroll-bottom-pad,var(--onboarding-agent-bar-clearance,4rem))+3rem)] sm:pb-14"
          : "pb-[calc(var(--onboarding-agent-bar-clearance,4rem)+1.5rem)] sm:pb-10",
      )}
    >
      <div className="relative z-20 space-y-2 bg-transparent">
        {supportingText ? (
          <p className="text-center text-[13px] leading-5 text-muted-foreground">
            {supportingText}
          </p>
        ) : null}
        <div className="mx-auto w-full">
          <Button
            type="button"
            onClick={onComplete}
            disabled={disabled || blocked}
            loading={busy}
            variant={visualVariant}
            effect={effect}
            size="prominent"
            fullWidth
            className={isQuietSetupAction ? "!border-0 !bg-transparent !text-[var(--app-accent)]" : undefined}
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
