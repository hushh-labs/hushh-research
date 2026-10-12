import { isNative } from "@/lib/capacitor/platform";
import { apiErrorCode } from "@/lib/services/api-client";
import type { DocumentPayoutAccount, HashcoinBalance, HashcoinRedemption } from "@/lib/services/document-payout-service";

import type { PayoutAccountState } from "./payout-bank-row";

export function redemptionError(error: unknown, mode: "test" | "live"): string {
  if (mode === "live") {
    switch (apiErrorCode(error)) {
      case "HASHCOINS_INSUFFICIENT": return "Balance changed. Try again.";
      case "HASHCOINS_HELD": return "Balance under review.";
      case "PAYOUT_ACCOUNT_REQUIRED": return "Finish bank setup, then try again.";
      case "REDEMPTION_SOURCE_UNAVAILABLE": return "Earning changed. Refresh and try again.";
      case "REDEMPTION_CONFLICT": return "This redemption needs review.";
      case "LIVE_FUNDS_UNAVAILABLE": case "PAYOUT_FUNDS_UNAVAILABLE": return "Payment funds are settling. Try again later.";
      default: return "Couldn't confirm the transfer. Check its status before retrying.";
    }
  }
  switch (apiErrorCode(error)) {
    case "HASHCOINS_INSUFFICIENT": return "Test balance changed. Try again.";
    case "HASHCOINS_HELD": return "Test balance is under review.";
    case "PAYOUT_ACCOUNT_REQUIRED": return "Link a test bank first.";
    case "SANDBOX_FUNDS_UNAVAILABLE": return "Stripe test funds are unavailable. Try again later.";
    case "REDEMPTION_CONFLICT": return "This test redemption needs review.";
    default: return "Couldn't confirm the test redemption. Retry to check its status.";
  }
}
export function redemptionCopy(item: HashcoinRedemption): string {
  if (item.stripeMode === "live") {
    // A newer server state this build can't name is never presented as a refund.
    if (item.reversalStatus === "unrecognized") return "Transfer status updating.";
    if (item.reversalStatus === "due" || item.reversalStatus === "unknown") return "Refunded payment. Transfer recovery pending.";
    if (item.reversalStatus === "reversed") return "Refunded payment. Transfer reversed.";
    if (item.reversalStatus === "manual_review") return "Refund needs review.";
    switch (item.status) {
      case "succeeded": return "Sent to Stripe. Bank deposit follows your payout settings.";
      case "failed": return "Transfer failed. Coins are available again.";
      case "pending": return "Transfer pending.";
      case "unknown": return "Checking transfer. Coins are reserved.";
    }
  }
  switch (item.status) {
    case "succeeded": return "Sent to your test Stripe balance. No real money moved.";
    case "failed": return "Test redemption failed. Your test balance was released.";
    case "pending": return "Test redemption pending.";
    case "unknown": return "Checking test redemption. Your test balance is reserved.";
  }
}
type AccountBlock = "link" | "bank" | "verify" | "review" | "unavailable";

/**
 * What stops a live payout account taking a new cash-out; null once it's ready.
 * The bank row asks for a bank first. When Stripe pauses payouts over
 * verification, the "Verify details" row is the fix, so the reason points there.
 */
function accountBlock(account: DocumentPayoutAccount | null): AccountBlock | null {
  if (!account) return "link";
  if (account.ready) return null;
  if (account.bankStatus === "missing" || account.bankStatus === "needs_attention") return "bank";
  switch (account.verification?.state) {
    case "due": case "past_due": case "disabled": return "verify";
    case "in_review": return "review";
  }
  return account.bankStatus === "unavailable" ? "unavailable" : "bank";
}

const BLOCK_REASON: Record<AccountBlock, string> = {
  link: "Link a bank to redeem",
  bank: "Fix your bank to redeem",
  verify: "Verify your details to redeem",
  review: "Stripe is reviewing your details",
  unavailable: "Bank check unavailable",
};

/**
 * Why a new live redemption can't start yet; null once the bank is ready. The
 * bank and Verify details rows name the state, so this only points to the
 * one to fix. The server checks again.
 */
export function cashOutBlock(bank: PayoutAccountState | null, openTransferUnreadable: boolean): string | null {
  // This build couldn't read the open transfer; a newer one can.
  if (openTransferUnreadable) return isNative() ? "Checking a transfer. Update the app to see it." : "Checking a transfer. Coins stay reserved.";
  if (!bank || bank.loading) return "Checking your bank…";
  if (bank.failed || bank.stripeMode === "test") return "Bank check unavailable";
  const block = accountBlock(bank.account);
  return block ? BLOCK_REASON[block] : null;
}

/**
 * What ready coins wait on while the last bank read says payouts can't go out.
 * Null while the bank is ready, unread or unknown, so "ready to redeem" stands.
 */
export function readyCoinsWait(bank: PayoutAccountState | null): string | null {
  if (!bank || bank.loading || bank.failed || bank.stripeMode === "test") return null;
  switch (accountBlock(bank.account)) {
    case "link": case "bank": return "waiting on your bank";
    case "verify": case "review": return "waiting on Stripe";
    default: return null;
  }
}

/**
 * Coins ready to redeem now, one paid request at a time. A server without
 * redeemableCoins sends only the next amount; then the available balance
 * stands in for the total, and nothing is ready when no next amount is.
 */
export function readyCoins(live: HashcoinBalance): number {
  const next = live.nextRedeemCoins ?? 0;
  if (live.redeemableCoins !== undefined) return Math.max(live.redeemableCoins, next);
  return next >= 1 ? Math.max(live.availableCoins, next) : 0;
}
