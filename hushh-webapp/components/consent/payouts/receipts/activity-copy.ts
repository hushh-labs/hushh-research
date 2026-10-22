import type {
  AdjustmentType,
  DepositActivityStatus,
  DepositContentItem,
  EarningActivityStatus,
  PayoutActivityItem,
  PayoutActivityKind,
  PayoutMaskedBank,
  RedemptionActivityStatus,
  ReversalStatus,
} from "@/lib/services/payout-activity-service";

/**
 * Words for payout activity rows and receipts. One short state per row; a
 * transfer to Stripe is never called a bank deposit, and a state this build
 * cannot name reads "Status updating", never a refund.
 */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MINUS = "−";
const unsigned = (cents: number) => usd.format(Math.abs(cents) / 100);

/** "$9.11", or "−$9.11" for a deduction. */
export function dollars(cents: number): string {
  return cents < 0 ? `${MINUS}${unsigned(cents)}` : unsigned(cents);
}

/** A coin movement: "+$9.11" or "−$9.11". 1 coin = 1 cent. */
export function signedDollars(cents: number): string {
  return cents > 0 ? `+${unsigned(cents)}` : dollars(cents);
}

/** Row dates: "Oct 10", in the viewer's time zone. */
export function rowDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Receipt times: "Oct 10, 2026, 5:04 PM". */
export function receiptDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** Stripe's expected and available dates are calendar days at midnight UTC. */
export function receiptDay(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));
}

export function maskedBankLabel(bank: PayoutMaskedBank | null): string | null {
  if (!bank) return null;
  return [bank.name, bank.last4 ? `•••• ${bank.last4}` : null].filter(Boolean).join(" ") || null;
}

export function kindLabel(kind: PayoutActivityKind): string {
  switch (kind) {
    case "earning": return "Earning";
    case "redemption": return "Redemption";
    case "deposit": return "Bank deposit";
    case "adjustment": return "Adjustment";
  }
}

export function earningTitle(status: EarningActivityStatus): string {
  switch (status) {
    case "pending": return "Earning pending";
    case "credited": return "Earned";
    case "held": return "Under review";
    case "reversed": return "Reversed";
    case "no_earning": return "No earnings";
    case "unrecognized": return "Status updating";
  }
}

export function redemptionTitle(status: RedemptionActivityStatus, reversal: ReversalStatus | null = null): string {
  switch (reversal) {
    case "unrecognized": return "Status updating";
    case "reversed": return "Transfer reversed";
    case "manual_review": return "Refund under review";
    case "due": case "unknown": return "Recovery pending";
  }
  switch (status) {
    case "succeeded": return "Sent to Stripe";
    case "failed": return "Transfer failed";
    case "pending": return "Transfer pending";
    case "unknown": return "Checking transfer";
    case "unrecognized": return "Status updating";
  }
}

export function depositTitle(status: DepositActivityStatus): string {
  switch (status) {
    case "pending": return "Bank payout scheduled";
    case "in_transit": return "On the way";
    case "paid": return "Bank payout completed";
    case "failed": return "Bank payout failed";
    case "canceled": return "Bank payout canceled";
    case "unrecognized": return "Status updating";
  }
}

export function adjustmentTitle(type: AdjustmentType): string {
  return type === "earning_reversed" ? "Earning reversed" : "Coins returned";
}

export function adjustmentReason(type: AdjustmentType): string {
  return type === "earning_reversed"
    ? "The buyer's payment was refunded, disputed or failed."
    : "The Stripe transfer was reversed, so its coins came back.";
}

export function activityTitle(item: PayoutActivityItem): string {
  switch (item.kind) {
    case "earning": return item.review && item.status !== "reversed" ? "Under review" : earningTitle(item.status);
    case "redemption":
      return item.review && (item.reversalStatus ?? "none") === "none" ? "Under review"
        : redemptionTitle(item.status, item.reversalStatus);
    case "deposit": return depositTitle(item.status);
    case "adjustment": return adjustmentTitle(item.type);
  }
}

/** "{request or bank} · Oct 10", plus the running balance in the coin view. */
export function activityDescription(item: PayoutActivityItem, showBalance = false): string {
  const test = item.test ? (item.kind === "earning" ? "Test payment" : "Test") : null;
  const subject = item.kind === "deposit" ? maskedBankLabel(item.bank) : item.request?.label ?? null;
  const balance = showBalance && item.balanceAfterCoins !== null ? `Balance ${dollars(item.balanceAfterCoins)}` : null;
  return [test, subject, rowDate(item.occurredAt), balance].filter(Boolean).join(" · ");
}

/** Signed only when the coin balance moved; never "$0.00" for nothing. */
export function activityAmount(item: PayoutActivityItem): string | null {
  if (item.coinsDelta !== null) return signedDollars(item.coinsDelta);
  return item.amountCents ? dollars(item.amountCents) : null;
}

export function contentLabel(item: DepositContentItem): string {
  if (item.requestLabel) return item.requestLabel;
  switch (item.type) {
    case "cash_out": return "Redemption";
    case "document_transfer": return "Document earning";
    case "returned_deposit": return "Returned deposit";
    case "refund": return "Refund";
    case "other": return "Other";
  }
}

export const ACTIVITY_FILTER_LABELS = {
  all: "All",
  earning: "Earnings",
  redemption: "Redemptions",
  deposit: "Deposits",
  adjustment: "Adjustments",
  coins: "Hussh Coins",
} as const;
