/**
 * The requester's side of a document request after it is sent: the price line
 * (estimate, owner price, final price), what happened to undelivered files,
 * and the owner's notice once the requester asks for a review.
 *
 * Pure parsers and copy for GET /delivery (server:
 * drive_request_recovery_view.py) and the price view. A malformed block is
 * dropped (null), so no Request review action and no refund claim is ever
 * shown for it. An unknown provider outcome is "pending", never a refund.
 */
import {
  formatDocumentRequestPrice,
  isValidDocumentRequestPriceCents,
} from "@/lib/consent/document-request-price";
import {
  formatPaymentMoney,
  type RequesterPriceView,
} from "@/lib/consent/document-request-payment-view";

export type OwnerRetryState = "available" | "requested" | "retrying" | "unavailable";
export type RecoveryRefundState = "none" | "pending" | "succeeded" | "manual_review" | "failed";

export type RequesterRecovery = {
  undeliveredCount: number;
  reasons: { reasonCode: string; count: number }[];
  ownerRetry: { state: OwnerRetryState; retryableCount: number; requestedAt: string | null };
  refund: {
    state: RecoveryRefundState;
    amountCents: number | null;
    grossCents: number | null;
    expectedFiles: number | null;
    confirmedFiles: number | null;
  };
};

export type OwnerReviewRequest = {
  requestedAt: string;
  count: number;
  unsharedCount: number;
  refund: { state: RecoveryRefundState; amountCents: number | null };
};

export type ReviewRequestResult = {
  requestId: string;
  reviewRequestedAt: string | null;
  ownerRetry: { state: OwnerRetryState; retryableCount: number };
  refund: { state: RecoveryRefundState; amountCents: number | null };
};

const RETRY_STATES: ReadonlySet<string> = new Set<OwnerRetryState>([
  "available",
  "requested",
  "retrying",
  "unavailable",
]);
const REFUND_STATES: ReadonlySet<string> = new Set<RecoveryRefundState>([
  "none",
  "pending",
  "succeeded",
  "manual_review",
  "failed",
]);
const MAX_FILES = 10_000;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_FILES
    ? value
    : undefined;
}

function optionalCount(value: unknown): number | null | undefined {
  return value === null ? null : count(value);
}

/** Refunds can be prorated, so any whole cent amount from 1 to $500. */
function optionalCents(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 50_000
    ? value
    : undefined;
}

function optionalInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function refundOf(value: unknown) {
  const raw = record(value);
  if (!raw || typeof raw.state !== "string" || !REFUND_STATES.has(raw.state)) return null;
  const amountCents = optionalCents(raw.amountCents);
  if (amountCents === undefined) return null;
  return { state: raw.state as RecoveryRefundState, amountCents };
}

function retryOf(value: unknown) {
  const raw = record(value);
  if (!raw || typeof raw.state !== "string" || !RETRY_STATES.has(raw.state)) return null;
  const retryableCount = count(raw.retryableCount);
  return retryableCount === undefined
    ? null
    : { state: raw.state as OwnerRetryState, retryableCount };
}

export function parseRequesterRecovery(value: unknown): RequesterRecovery | null {
  const raw = record(value);
  if (!raw) return null;
  const undeliveredCount = count(raw.undeliveredCount);
  const retry = retryOf(raw.ownerRetry);
  const requestedAt = optionalInstant(record(raw.ownerRetry)?.requestedAt ?? null);
  const refundRaw = record(raw.refund);
  const refund = refundOf(raw.refund);
  const grossCents = optionalCents(refundRaw?.grossCents ?? null);
  const expectedFiles = optionalCount(refundRaw?.expectedFiles ?? null);
  const confirmedFiles = optionalCount(refundRaw?.confirmedFiles ?? null);
  if (
    undeliveredCount === undefined ||
    !retry ||
    requestedAt === undefined ||
    !refund ||
    grossCents === undefined ||
    expectedFiles === undefined ||
    confirmedFiles === undefined ||
    !Array.isArray(raw.reasons) ||
    raw.reasons.length > 20
  )
    return null;
  const reasons: RequesterRecovery["reasons"] = [];
  for (const item of raw.reasons) {
    const reason = record(item);
    const reasonCount = count(reason?.count);
    if (
      !reason ||
      typeof reason.reasonCode !== "string" ||
      !/^[a-z_]{1,64}$/.test(reason.reasonCode) ||
      reasonCount === undefined
    )
      return null;
    reasons.push({ reasonCode: reason.reasonCode, count: reasonCount });
  }
  return {
    undeliveredCount,
    reasons,
    ownerRetry: { ...retry, requestedAt },
    refund: { ...refund, grossCents, expectedFiles, confirmedFiles },
  };
}

export function parseOwnerReviewRequest(value: unknown): OwnerReviewRequest | null {
  const raw = record(value);
  const requestedAt = optionalInstant(raw?.requestedAt ?? null);
  const asks = count(raw?.count);
  const unsharedCount = count(raw?.unsharedCount);
  const refund = refundOf(raw?.refund);
  if (!raw || !requestedAt || asks === undefined || unsharedCount === undefined || !refund)
    return null;
  return { requestedAt, count: asks, unsharedCount, refund };
}

export function parseReviewRequestResult(
  value: unknown,
  requestId: string,
): ReviewRequestResult | null {
  const raw = record(value);
  const reviewRequestedAt = optionalInstant(raw?.reviewRequestedAt ?? null);
  const ownerRetry = retryOf(raw?.ownerRetry);
  const refund = refundOf(raw?.refund);
  if (!raw || raw.requestId !== requestId || reviewRequestedAt === undefined || !ownerRetry || !refund)
    return null;
  return { requestId, reviewRequestedAt, ownerRetry, refund };
}

function files(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "file" : "files"}`;
}

/** The refund basis when delivery was finalized, otherwise the undelivered count. */
function unshared(recovery: RequesterRecovery): number {
  const { expectedFiles, confirmedFiles } = recovery.refund;
  return expectedFiles !== null && confirmedFiles !== null && expectedFiles > confirmedFiles
    ? expectedFiles - confirmedFiles
    : recovery.undeliveredCount;
}

/**
 * The requester's recovery line and next step. Request review is offered only
 * while the owner can still retry; a refund is claimed only once it succeeded.
 */
export function presentRequesterRecovery(recovery: RequesterRecovery): {
  title: string;
  line: string | null;
  action: "request_review" | null;
} {
  const { refund, ownerRetry } = recovery;
  const amount = refund.amountCents === null ? null : formatPaymentMoney(refund.amountCents);
  const title =
    refund.state === "succeeded" && amount
      ? `${files(unshared(recovery))} not shared · ${amount} refunded`
      : `${files(unshared(recovery))} not shared`;
  const line =
    ownerRetry.state === "requested"
      ? "Review requested"
      : ownerRetry.state === "retrying"
        ? "Owner retrying"
        : refund.state === "pending" && amount
          ? `Refund of ${amount} pending`
          : (refund.state === "manual_review" || refund.state === "failed") && amount
            ? `Refund of ${amount} is taking longer than usual`
            : null;
  return { title, line, action: ownerRetry.state === "available" ? "request_review" : null };
}

/** The owner's notice line; whether a retry can run stays with their own batch view. */
export function presentOwnerReviewRequest(notice: OwnerReviewRequest, canRetry: boolean): string {
  if (canRetry) return "They asked you to retry the files that weren't shared.";
  const amount =
    notice.refund.amountCents === null ? null : formatPaymentMoney(notice.refund.amountCents);
  if (notice.refund.state === "succeeded" && amount)
    return `Nothing to retry; the requester was refunded ${amount} for ${files(notice.unsharedCount)}.`;
  if (notice.refund.state === "pending" && amount)
    return `Nothing to retry; a ${amount} refund for ${files(notice.unsharedCount)} is on its way to the requester.`;
  return "Nothing to retry.";
}

/**
 * One price line for every requester surface: "Estimate $10", then
 * "Price $25 · estimate was $10", then "Final price $25". Never "locked":
 * the owner may set the price until an order freezes it.
 */
export function requesterPriceLine(price: RequesterPriceView): string | null {
  const { estimateCents: estimate, currentCents: current, finalCents: final } = price;
  if (price.state === "final")
    return final === null ? null : `Final price ${formatDocumentRequestPrice(final)}`;
  if (price.state === "awaiting_owner") return "The owner sets the price";
  if (current === null) return null;
  if (price.state === "estimate") return `Estimate ${formatDocumentRequestPrice(current)}`;
  return estimate !== null && estimate !== current
    ? `Price ${formatDocumentRequestPrice(current)} · estimate was ${formatDocumentRequestPrice(estimate)}`
    : `Price ${formatDocumentRequestPrice(current)}`;
}

/**
 * The same view from Consent Center metadata, which carries the owner's price,
 * the order amount once one exists and, from newer servers, the estimate.
 */
export function priceViewFromEntryMetadata(
  metadata: Record<string, unknown> | undefined | null,
): RequesterPriceView | null {
  if (!metadata || metadata.paymentRequired !== true) return null;
  const valid = (value: unknown) => (isValidDocumentRequestPriceCents(value) ? value : null);
  const current = valid(metadata.quotedAmountCents);
  const final = metadata.paymentStatus == null ? null : valid(metadata.paymentAmountCents);
  const known = "estimateCents" in metadata;
  const estimate = valid(metadata.estimateCents);
  if (final !== null)
    return { estimateCents: estimate, currentCents: current ?? final, finalCents: final, state: "final" };
  if (current === null) return null;
  // Older servers omit the estimate; until the owner allows, their price is the one shown.
  const ownerSet =
    metadata.owner_allowed === true || (known ? estimate !== current : false);
  return {
    estimateCents: known ? estimate : ownerSet ? null : current,
    currentCents: current,
    finalCents: null,
    state: ownerSet ? "owner_set" : "estimate",
  };
}
