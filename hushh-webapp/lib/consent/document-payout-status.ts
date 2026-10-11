import type { OwnerDocumentPayout, OwnerDocumentPayoutStatus } from "@/lib/services/drive-sharing-service";

const STATUS_COPY: Record<OwnerDocumentPayoutStatus, string> = {
  awaiting_delivery: "Payout pending · Waiting for delivery",
  awaiting_refund: "Payout pending · Finalizing refund",
  awaiting_fee: "Payout pending · Calculating processing fee",
  awaiting_account: "Payout pending · Set up US payouts",
  due: "Payout pending",
  dispatching: "Payout pending · Sending to Stripe",
  unknown: "Payout pending · Checking transfer",
  manual_review: "Payout needs review",
  transferred: "Sent to Stripe",
  hashcoins_credited: "Hussh Coins credited",
  hashcoins_held: "Hussh Coins under review",
  hashcoins_reversed: "Hussh Coins reversed",
  reversal_due: "Payout needs review",
  reversal_unknown: "Payout needs review",
  reversed: "Transfer reversed",
  void: "No payout due",
};

export function isOwnerDocumentPayoutStatus(value: unknown): value is OwnerDocumentPayoutStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STATUS_COPY, value);
}

export function documentPayoutStatusLabel(status: OwnerDocumentPayoutStatus): string {
  return STATUS_COPY[status];
}

export function documentPayoutNetEarnings(cents: number | null): string | null {
  return cents === null ? null : `$${(cents / 100).toFixed(2)}`;
}

export function documentPayoutStatusCopy(payout: OwnerDocumentPayout): {
  status: string;
  earnings: string | null;
} {
  return {
    status: documentPayoutStatusLabel(payout.status),
    earnings: payout.ownerEarningCents === null
      ? null
      : `Your net earnings: ${documentPayoutNetEarnings(payout.ownerEarningCents)}`,
  };
}
