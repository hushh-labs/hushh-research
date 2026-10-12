/**
 * Why money is under review, in plain words, from a closed server vocabulary.
 *
 * The server never sends provider text, dispute reasons, buyer identity or
 * charge IDs; only these codes. An unknown code reads as a neutral check and is
 * never presented as a refund.
 */
export const HOLD_REASONS = [
  "payment_disputed",
  "payment_check",
  "refund_check",
  "transfer_reversed",
  "transfer_check",
  "refund_recovery",
  "recovery_review",
  "negative_balance",
  "under_review",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const HOLD_NEXT_STEPS = ["none", "wait_for_bank", "contact_support", "update_bank", "verify_details"] as const;
export type HoldNextStep = (typeof HOLD_NEXT_STEPS)[number];

export function parseHoldReason(value: unknown): HoldReason {
  return (HOLD_REASONS as readonly unknown[]).includes(value) ? (value as HoldReason) : "under_review";
}

export function parseHoldNextStep(value: unknown): HoldNextStep {
  return (HOLD_NEXT_STEPS as readonly unknown[]).includes(value) ? (value as HoldNextStep) : "none";
}

// Hussh runs the payment, refund and transfer checks; Stripe's data is what disagreed.
const REASON_COPY: Record<HoldReason, string> = {
  payment_disputed: "The buyer's bank is reviewing this payment.",
  payment_check: "Hussh is checking this payment.",
  refund_check: "Hussh is checking a refund on this payment.",
  transfer_reversed: "Stripe reversed this transfer.",
  transfer_check: "Hussh is checking this transfer.",
  refund_recovery: "This payment was refunded after you redeemed it.",
  recovery_review: "Recovering this refund needs a manual check.",
  negative_balance: "A refund left your balance below zero.",
  under_review: "Hussh is checking this.",
};

// Short enough for a row's trailing value.
const NEXT_STEP_COPY: Record<HoldNextStep, string> = {
  none: "No action needed",
  wait_for_bank: "Wait for the bank",
  contact_support: "Contact support",
  update_bank: "Update your bank",
  verify_details: "Verify details",
};

export function holdReasonCopy(reason: HoldReason): string {
  return REASON_COPY[reason];
}

export function holdNextStepCopy(step: HoldNextStep): string {
  return NEXT_STEP_COPY[step];
}
