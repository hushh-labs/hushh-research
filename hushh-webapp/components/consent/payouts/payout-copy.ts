import { apiErrorCode } from "@/lib/services/api-client";
import type { DocumentBankPayout, DocumentEarning } from "@/lib/services/document-payout-service";

import { money } from "./payout-format";

export function payoutErrorCopy(error: unknown, fallback: string): string {
  switch (apiErrorCode(error)) {
    case "PAYOUT_PLATFORM_SETUP_REQUIRED": return "Bank setup is unavailable. Hussh needs to turn on payouts.";
    case "PAYOUT_ACCOUNT_DISABLED": return "Your payout account needs support.";
    default: return fallback;
  }
}

export function earningStatus(item: DocumentEarning, activeMode?: "test" | "live"): string {
  if (item.stripeMode === "legacy") return "Under review";
  if (item.status === "hashcoins_credited") return "Hussh Coins credited";
  if (item.status === "hashcoins_held") return "Hussh Coins under review";
  if (item.status === "hashcoins_reversed") return "Hussh Coins reversed";
  if (item.stripeMode === "test" && activeMode === "live") return "No bank deposit";
  switch (item.status) {
    case "awaiting_delivery": return "Awaiting delivery";
    case "awaiting_refund": return "Refund pending";
    case "awaiting_fee": return "Calculating fees";
    case "awaiting_account": return "Link bank to receive";
    case "due": case "dispatching": return "Transfer pending";
    case "transferred": return "Transferred to Stripe";
    case "reversal_due": case "reversal_unknown": return "Reversal pending";
    case "reversed": return "Reversed";
    case "void": return "No earnings";
    case "unknown": case "manual_review": return "Under review";
  }
}

export function bankPayoutCopy(payout: DocumentBankPayout): string {
  const amount = money(payout.amountCents);
  switch (payout.status) {
    case "pending": return `${amount} bank payout pending.`;
    case "in_transit": return `${amount} bank payout on its way.`;
    case "paid": return `${amount} bank payout paid.`;
    case "canceled": return `${amount} bank payout canceled.`;
    case "failed": return `${amount} bank payout failed. Check your linked bank details.`;
  }
}
