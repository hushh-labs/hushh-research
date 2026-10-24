"use client";

import { useMemo, useRef, useState, type ComponentType, type ReactNode, type SyntheticEvent } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Check } from "@/components/icons";
import {
  ProfileInnerProgressIcon,
  ProfileInnerReviewIcon,
  ProfileInnerSuccessIcon,
  ProfileInnerWarningIcon,
} from "@/components/profile/profile-inner-icons";
import { ProfilePaneCopyIcon } from "@/components/profile/profile-pane-icons";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { holdNextStepCopy, holdReasonCopy, type HoldNextStep } from "@/lib/payouts/review-copy";
import type { PayoutReview } from "@/lib/services/payout-activity-service";
import { copyToClipboard } from "@/lib/utils/clipboard";

/**
 * Returns focus to the row that opened a sheet once it closes. A click's
 * target is recorded in the capture phase (rows do not expose their button),
 * remembered when the sheet opens and focused again after it closes.
 */
export function useOpenerFocus() {
  const pressed = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  return useMemo(() => ({
    capture(event: SyntheticEvent) {
      const target = event.target;
      pressed.current = target instanceof Element ? target.closest<HTMLElement>("button") : null;
    },
    remember() {
      opener.current = pressed.current;
    },
    restore() {
      const element = opener.current;
      opener.current = null;
      if (!element) return;
      // After the frame and after the dialog's own unmount focus (a 0 ms task), so ours wins.
      const focus = () => window.setTimeout(() => { if (element.isConnected) element.focus({ preventScroll: true }); }, 0);
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(focus);
      else focus();
    },
  }), []);
}

export type StageTone = "done" | "waiting" | "problem" | "review";
const STAGE_ICONS: Record<StageTone, ComponentType<object>> = {
  done: ProfileInnerSuccessIcon,
  waiting: ProfileInnerProgressIcon,
  problem: ProfileInnerWarningIcon,
  review: ProfileInnerReviewIcon,
};

/** One step of a money movement and when it happened. */
export function ReceiptStageRow({ title, description, value, tone, onOpen }: {
  title: string; description?: string | null; value?: string | null; tone: StageTone; onOpen?: () => void;
}) {
  return (
    <SettingsRow icon={STAGE_ICONS[tone]} iconTone="capability" title={title} description={description ?? undefined}
      trailing={value ? <span data-consent-role="fact-value" className="tabular-nums">{value}</span> : undefined}
      chevron={Boolean(onOpen)} onClick={onOpen} />
  );
}

/** A label with an amount or fact on the trailing side. */
export function ReceiptValueRow({ title, value, icon, description, onOpen }: {
  title: ReactNode; value?: string | null; icon?: ComponentType<object>; description?: string | null; onOpen?: () => void;
}) {
  return (
    <SettingsRow icon={icon} iconTone="capability" title={title} description={description ?? undefined}
      trailing={value ? <span data-consent-role="fact-value" className="tabular-nums">{value}</span> : undefined}
      chevron={Boolean(onOpen)} onClick={onOpen} />
  );
}

/** A reference the owner can quote to support, with a copy button. */
export function ReceiptReferenceRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(value)) {
      setCopied(true);
      morphyToast.success("Copied.");
    } else {
      morphyToast.error("Couldn't copy. Try again.");
    }
  };
  return (
    <SettingsRow title={label} trailing={
      <span className="flex min-w-0 items-center justify-end gap-1">
        <span data-consent-role="fact-value" className="min-w-0 break-all text-right tabular-nums">{value}</span>
        <button type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy()}
          className="-my-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[color:var(--app-accent)] hover:bg-[color:var(--app-neutral-fill)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-accent)]">
          {copied ? <Check className="size-4" aria-hidden="true" /> : <ProfilePaneCopyIcon className="size-4" />}
        </button>
      </span>
    } />
  );
}

/**
 * A next step the Payouts screen can take for the owner: its own bank rows'
 * Stripe actions. Never a redemption, transfer or money check.
 */
export type PayoutReceiptAction = "manage_bank" | "verify";
const NEXT_STEP_ACTIONS: Partial<Record<HoldNextStep, PayoutReceiptAction>> = {
  update_bank: "manage_bank",
  verify_details: "verify",
};

/**
 * Why money is held and what, if anything, the owner should do. With onAction,
 * a step the owner can take ("Update your bank", "Verify details") is the row's
 * one control; every other step only reads.
 */
export function ReceiptReviewSection({ review, onAction }: {
  review: PayoutReview; onAction?: (action: PayoutReceiptAction) => void;
}) {
  const step = holdNextStepCopy(review.nextStep);
  const action = onAction ? NEXT_STEP_ACTIONS[review.nextStep] : undefined;
  return (
    <SettingsGroup title="Under review">
      <SettingsRow icon={ProfileInnerReviewIcon} iconTone="capability" title={holdReasonCopy(review.reason)} />
      {onAction && action ? (
        <SettingsRow title="Next step" ariaLabel={step} chevron onClick={() => onAction(action)}
          trailing={<span className="profile-account-inline-action">{step}</span>} />
      ) : <SettingsRow title="Next step" trailing={step} />}
    </SettingsGroup>
  );
}
