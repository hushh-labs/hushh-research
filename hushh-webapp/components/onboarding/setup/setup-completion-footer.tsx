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
  /**
   * Looks unavailable but still accepts the tap, so `onComplete` can say what
   * is missing. Use this instead of `disabled` whenever a blocked action has a
   * reason worth speaking: a real `disabled` button swallows the event, and the
   * explanation then has to live in permanent copy nobody reads until after
   * they have already tapped.
   */
  blocked?: boolean;
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
 * Routes may show this while a prerequisite is pending, but must mark it
 * `disabled` (inert) or `blocked` (tappable, and it names what is missing)
 * until their own completion condition is verified. Either way it drops the
 * accent fill: the blue is the promise that the tap finishes setup, so it is
 * spent only on an action that can. Prefer `blocked` when there is a specific
 * reason to give -- an inert control cannot tell anyone why. The canonical
 * bottom inset keeps it above app chrome on safe-area and keyboard-resized
 * native viewports, with the same calm full-width action cadence everywhere.
 */
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
  variant = "blue-gradient",
  effect = "fill",
}: SetupCompletionFooterProps) {
  // A pending setup is deliberately secondary, but it must retain the same
  // Foundation accent and tactile feedback as the Agent Bar. Keeping callers
  // on the existing `none` + `fade` contract avoids creating a second setup
  // action vocabulary while preventing the light-theme gray container look.
  const isQuietSetupAction = variant === "none" && effect === "fade";
  const visualVariant = isQuietSetupAction ? "blue" : variant;
  // Accent means "this works". The stock disabled treatment only fades the
  // accent fill to 50%, which still reads as the blue primary action on a
  // light surface -- so a blocked finish looked tappable, absorbed the tap,
  // and explained itself only in the supporting line underneath. A blocked
  // action takes the same neutral container the quiet variant already uses.
  //
  // It keeps a border, and the border is the whole reason it stays a control.
  // In the light theme `muted` and the page surface are the same colour to
  // within 1:1 contrast (measured: rgb(242,242,245) on rgb(242,242,247)), so
  // the fill alone draws nothing -- the pill vanished and left a grey label
  // floating on the page. `border-border` is the same hairline every card on
  // this surface uses, and the enabled state already reserves 1px for a
  // transparent one, so making it visible costs no geometry.
  const isBlockedFilledAction = disabled && !busy && !isQuietSetupAction;
  // Same neutral container as above, for the case where the tap must still
  // land. Tailwind's `disabled:` variants key off the real disabled attribute
  // and never apply to an enabled button, so the blocked look is spelled out
  // unprefixed here. Hover stays put: the container is not promising passage.
  const isBlockedTappableAction =
    blocked && !disabled && !busy && !isQuietSetupAction;

  return (
    <div className="mt-6 pb-[var(--app-scroll-bottom-pad,var(--app-bottom-inset))] sm:mt-8 sm:pb-8">
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
            aria-disabled={isBlockedTappableAction || undefined}
            loading={busy}
            variant={visualVariant}
            effect={effect}
            size="lg"
            fullWidth
            className={cn(
              "h-12 text-base",
              isQuietSetupAction &&
                "!border-0 !bg-transparent !text-[var(--app-accent)] hover:!bg-[var(--app-accent-tint)] hover:!text-[var(--app-accent)] disabled:!bg-muted/35 disabled:!text-muted-foreground disabled:!opacity-100",
              isBlockedFilledAction &&
                "disabled:!border-border disabled:!bg-muted/60 disabled:!text-muted-foreground disabled:!opacity-100",
              isBlockedTappableAction &&
                "!border-border !bg-muted/60 !text-muted-foreground !opacity-100 hover:!bg-muted/60 hover:!text-muted-foreground",
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
