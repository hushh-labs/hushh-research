import { documentShareRequestId, isDocumentShareEntry } from "@/lib/consent/document-share-consent";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { parseConsentInstant } from "@/lib/consent/consent-owner-copy";
import {
  formatDocumentRequestPrice,
  isValidDocumentRequestPriceCents,
} from "@/lib/consent/document-request-price";
import {
  effectiveRequesterPaymentState,
  formatPaymentRemaining,
  parseRequesterPaymentView,
  REQUESTER_PAYMENT_TITLES,
  type RequesterPaymentView,
} from "@/lib/consent/document-request-payment-view";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import type { SharingRequestContext } from "@/lib/services/drive-sharing-service";

/** The one countdown formatter, shared with the request details. */
export { formatPaymentRemaining };

export type FeedDrivePaymentStatus = "ready" | "waiting_owner_setup" | "link_expired" | "expired";

export interface FeedDrivePayment {
  requestId: string;
  packageDisclosureRequired?: boolean;
  status: FeedDrivePaymentStatus;
  title: string;
  description: string;
  requestedAt: number | null;
  /** The payment order's whole-dollar price in cents, as the server projected it. */
  amountCents: number;
  /** A terminal payment stays inspectable from Feed, even without an action. */
  href?: string;
  /** Provider checkout deadline in epoch milliseconds, when one is active. */
  expiresAt: number | null;
  /**
   * The request's own deadline in epoch milliseconds, from the shared payment
   * view. It wins over an open Checkout window, as in the request details.
   */
  requestExpiresAt?: number | null;
  /** Stable owner label used to recompute concise copy as the deadline ticks. */
  ownerLabel: string | null;
}

const GENERIC_COUNTERPART_LABELS = new Set([
  "document request",
  "google drive",
  "google drive files",
  "requester",
  "someone",
]);

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Resolve an owner label while ignoring the historical generic projection label. */
function counterpartLabel(entry: ConsentCenterEntry): string | null {
  const metadata = entry.metadata || {};
  const candidates = [
    entry.counterpart_label,
    metadata.counterpart_label,
    metadata.counterpartLabel,
    metadata.owner_label,
    metadata.ownerLabel,
    metadata.requester_label,
    metadata.requesterLabel,
    metadata.subject_label,
    metadata.subjectLabel,
  ];
  for (const candidate of candidates) {
    const label = nonEmptyString(candidate);
    if (
      !label ||
      GENERIC_COUNTERPART_LABELS.has(label.toLowerCase()) ||
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(label) ||
      /^[a-z0-9_-]{20,}$/i.test(label)
    ) continue;
    return label;
  }
  return null;
}

function isTruthyMetadata(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function expiryTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const text = nonEmptyString(value);
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function paymentState(entry: ConsentCenterEntry, now = Date.now()): FeedDrivePaymentStatus | null {
  const metadata = entry.metadata || {};
  if (isTruthyMetadata(metadata.accessStopped)) return null;
  const paymentStatus = nonEmptyString(metadata.paymentStatus).toLowerCase();
  const requestStatus = nonEmptyString(entry.status).toLowerCase();
  if (requestStatus === "expired") return "expired";

  // A Stripe session may expire while the order remains `checkout_open`.
  // Accept either a server marker or its expiry instant for old/new payloads.
  const checkoutExpired = [
    metadata.paymentLinkExpired,
    metadata.payment_link_expired,
    metadata.checkoutExpired,
    metadata.checkout_expired,
  ].some(isTruthyMetadata);
  const checkoutExpiresAt = expiryTimestamp(
    metadata.paymentCheckoutExpiresAt ??
      metadata.payment_checkout_expires_at ??
      metadata.checkoutExpiresAt ??
      metadata.checkout_expires_at,
  );
  const isOpenRequest = entry.kind === "outgoing_request" && requestStatus === "pending";
  if (!isOpenRequest) return null;
  // Only a payout-enrolled order projects an explicit false. Legacy orders
  // have no readiness marker and retain their existing Checkout behavior.
  if (metadata.ownerPayoutAccountReady === false) return "waiting_owner_setup";
  if (metadata.ownerPriceRequired === true || metadata.paymentsReady === false) return null;
  // A completed/refunded order can retain the original Checkout expiry for
  // audit history. Never turn that historical timestamp back into a payment
  // action while the request projection is catching up.
  // An awaiting order has no Stripe session or deadline yet. The worker
  // creates the session before the Pay action becomes visible.
  if (paymentStatus === "awaiting_payment") return null;
  if (paymentStatus !== "checkout_open" && paymentStatus !== "expired") return null;
  if (paymentStatus === "checkout_open" && checkoutExpiresAt === null) return null;
  if (
    checkoutExpired ||
    (checkoutExpiresAt !== null && checkoutExpiresAt <= now)
  ) return "link_expired";
  // A bound Checkout expires once. The request can be inspected, but this
  // payment order cannot produce a replacement link.
  if (paymentStatus === "expired" && isOpenRequest) return "link_expired";
  return "ready";
}

/**
 * The Feed status of the server's shared payment view (one definition of
 * link vs request expiry). `null` hides the row; "settled" suppresses any
 * older duplicate of the same request.
 */
function viewPaymentState(
  view: RequesterPaymentView,
  now: number,
): FeedDrivePaymentStatus | "settled" | null {
  switch (effectiveRequesterPaymentState(view, now)) {
    case "payable":
      return "ready";
    case "link_expired":
      return "link_expired";
    case "request_expired":
      return "expired";
    case "awaiting_owner":
      return "waiting_owner_setup";
    case "paid":
    case "refund_pending":
    case "refunded":
    case "partially_refunded":
      return "settled";
    default:
      return null;
  }
}

/** Recompute copy/status from the local clock without waiting for a refetch. */
export function describeFeedDrivePayment(
  payment: Pick<
    FeedDrivePayment,
    "status" | "amountCents" | "ownerLabel" | "expiresAt" | "requestedAt" | "requestExpiresAt"
  >,
  now = Date.now(),
  context?: SharingRequestContext,
): Pick<FeedDrivePayment, "status" | "title" | "description"> {
  // The same order as effectiveRequesterPaymentState: the request's own
  // deadline first, then the Checkout window.
  const requestExpired =
    payment.status !== "expired" &&
    payment.requestExpiresAt != null &&
    payment.requestExpiresAt <= now;
  const linkExpired =
    payment.status === "ready" &&
    payment.expiresAt !== null &&
    payment.expiresAt <= now;
  const status: FeedDrivePaymentStatus = requestExpired
    ? "expired"
    : linkExpired ? "link_expired" : payment.status;
  const remainingMs =
    status === "ready" && payment.expiresAt !== null
      ? Math.max(0, payment.expiresAt - now)
      : null;
  return {
    status,
    ...paymentCopy(status, payment.amountCents, payment.ownerLabel, remainingMs, payment.requestedAt, context),
  };
}

function compactPurpose(context: SharingRequestContext): string {
  const characters = Array.from(context.purpose.purpose.replace(/\s+/g, " ").trim());
  return characters.length > 72 ? `${characters.slice(0, 71).join("")}…` : characters.join("");
}

function requestPeriod(context: SharingRequestContext): string | null {
  const { periodStart, periodEnd } = context.purpose;
  if (!periodStart || !periodEnd) return null;
  const format = (value: string) => new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
  return periodStart === periodEnd ? format(periodStart) : `${format(periodStart)}–${format(periodEnd)}`;
}

function requestedDate(requestedAt: number | null): string | null {
  return requestedAt === null || !Number.isFinite(new Date(requestedAt).getTime())
    ? null : `Requested ${new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric",
  }).format(new Date(requestedAt))}`;
}

function paymentCopy(
  status: FeedDrivePaymentStatus,
  amountCents: number,
  owner: string | null,
  remainingMs: number | null = null,
  requestedAt: number | null = null,
  context?: SharingRequestContext,
): Pick<FeedDrivePayment, "title" | "description"> {
  const price = formatDocumentRequestPrice(amountCents);
  const subject = context ? compactPurpose(context) : null;
  const deadline = remainingMs !== null && remainingMs > 0
    ? formatPaymentRemaining(remainingMs)
    : null;
  if (subject) {
    return {
      title: status === "expired" ? REQUESTER_PAYMENT_TITLES.requestExpired
        : status === "link_expired" ? REQUESTER_PAYMENT_TITLES.linkExpired
          : status === "waiting_owner_setup" ? REQUESTER_PAYMENT_TITLES.awaitingOwner
            : `Pay ${price} · ${subject}`,
      description: [
        status === "ready" ? null : subject,
        status === "waiting_owner_setup" ? `Quote ${price}` : null,
        owner ? `From ${owner}` : null,
        requestPeriod(context!),
        deadline,
      ].filter(Boolean).join(" · "),
    };
  }
  const requested = requestedDate(requestedAt);
  if (requested) {
    return {
      title: status === "expired" ? REQUESTER_PAYMENT_TITLES.requestExpired
        : status === "link_expired" ? REQUESTER_PAYMENT_TITLES.linkExpired
          : status === "waiting_owner_setup" ? REQUESTER_PAYMENT_TITLES.awaitingOwner
          : owner ? `Pay ${price} for files from ${owner}` : `Pay ${price} for your document request`,
      description: [status === "waiting_owner_setup" ? `Quote ${price}` : null,
        status !== "ready" && owner ? `From ${owner}` : null, requested, deadline]
        .filter(Boolean).join(" · "),
    };
  }
  if (status === "expired") {
    return owner
      ? {
          title: REQUESTER_PAYMENT_TITLES.requestExpired,
          description: `Your request for files from ${owner} expired before payment.`,
        }
      : {
          title: REQUESTER_PAYMENT_TITLES.requestExpired,
          description: "This request expired before payment.",
        };
  }
  if (status === "link_expired") {
    return owner
      ? {
          title: REQUESTER_PAYMENT_TITLES.linkExpired,
          description: `The ${price} link for files from ${owner} expired.`,
        }
      : {
          title: REQUESTER_PAYMENT_TITLES.linkExpired,
          description: `The ${price} link expired.`,
        };
  }
  if (status === "waiting_owner_setup") {
    return {
      title: REQUESTER_PAYMENT_TITLES.awaitingOwner,
      description: owner ? `Quote ${price} · ${owner} is setting up payouts.` : `Quote ${price} · Owner payout setup pending.`,
    };
  }
  return owner
    ? {
        title: `Pay ${price} for files from ${owner}`,
        description: deadline ? `${deadline} to pay.` : `You requested files from ${owner}. Pay to continue.`,
      }
    : {
        title: `Pay ${price} for your document request`,
        description: deadline ? `${deadline} to pay.` : "Sharing starts after payment.",
      };
}

/** The outgoing server projection is the discovery authority, including after an app restart. */
export function projectFeedDrivePayments(entries: ConsentCenterEntry[], now = Date.now()): FeedDrivePayment[] {
  const byRequest = new Map<string, FeedDrivePayment>();
  // The Consent Center can merge pages while a payment webhook is settling.
  // Once any projection says the order is paid/refunded, suppress an older
  // awaiting row too; otherwise a stale page could resurrect a Pay action.
  const settledRequestIds = new Set<string>();
  for (const entry of entries) {
    if (!isDocumentShareEntry(entry)) continue;
    const requestId = documentShareRequestId(entry.id);
    if (!requestId || entry.metadata?.direction !== "outgoing") continue;
    const metadata = entry.metadata || {};
    // The order fixes the price: an owner-set amount or the $10 Trusted Circle
    // default. A malformed amount never becomes a Pay action.
    const amountCents: unknown = metadata.paymentAmountCents;
    if (
      !isValidDocumentRequestPriceCents(amountCents) ||
      nonEmptyString(metadata.paymentCurrency).toLowerCase() !== "usd"
    ) continue;
    const paymentStatus = nonEmptyString(metadata.paymentStatus).toLowerCase();
    if (paymentStatus === "paid" || paymentStatus === "refunded") {
      settledRequestIds.add(requestId);
      byRequest.delete(requestId);
      continue;
    }
    if (settledRequestIds.has(requestId)) continue;
    // A current server also projects the shared payment view: the same state
    // and deadline the request details show. Older servers keep the legacy read.
    const view = parseRequesterPaymentView(metadata.paymentView);
    const rawPayment = metadata.paymentView && typeof metadata.paymentView === "object"
      ? metadata.paymentView as Record<string, unknown> : null;
    const packageDisclosureRequired = rawPayment?.packageDisclosureRequired === true ||
      metadata.packageDisclosureRequired === true || metadata.agentPackageRequired === true;
    let status: FeedDrivePaymentStatus | null;
    if (view) {
      const fromView = viewPaymentState(view, now);
      if (fromView === "settled") {
        settledRequestIds.add(requestId);
        byRequest.delete(requestId);
        continue;
      }
      if (
        fromView === null ||
        isTruthyMetadata(metadata.accessStopped) ||
        metadata.ownerPriceRequired === true ||
        metadata.paymentsReady === false
      ) continue;
      status = fromView;
    } else {
      status = paymentState(entry, now);
      if (!status) {
        // Expired request rows may be emitted as history, but must retain a
        // payment row if their order is still present in the projection.
        if (nonEmptyString(entry.status).toLowerCase() !== "expired") continue;
      }
    }
    const effectiveStatus = status || "expired";
    const requestedAt = parseConsentInstant(entry.issued_at);
    const ownerLabel = counterpartLabel(entry);
    const expiresAt = view
      ? view.checkoutExpiresAt === null ? null : Date.parse(view.checkoutExpiresAt)
      : expiryTimestamp(
        metadata.paymentCheckoutExpiresAt ??
          metadata.payment_checkout_expires_at ??
          metadata.checkoutExpiresAt ??
          metadata.checkout_expires_at,
      );
    const requestExpiresAt = view?.requestExpiresAt ? Date.parse(view.requestExpiresAt) : null;
    const copy = paymentCopy(
      effectiveStatus,
      amountCents,
      ownerLabel,
      effectiveStatus === "ready" && expiresAt !== null ? Math.max(0, expiresAt - now) : null,
      requestedAt,
    );
    const current = byRequest.get(requestId);
    // A merged/paginated response can duplicate a request. Prefer the newest
    // entry; equal timestamps keep terminal state over an actionable row.
    if (
      current &&
      (requestedAt ?? 0) < (current.requestedAt ?? 0)
    ) continue;
    if (
      current &&
      requestedAt === current.requestedAt &&
      effectiveStatus === "ready" &&
      current.status !== "ready"
    ) continue;
    byRequest.set(requestId, {
      requestId,
      packageDisclosureRequired,
      status: effectiveStatus,
      ...copy,
      requestedAt,
      amountCents,
      ownerLabel,
      expiresAt,
      requestExpiresAt,
      href:
        effectiveStatus === "expired" || effectiveStatus === "link_expired" || effectiveStatus === "waiting_owner_setup"
          ? buildConsentCenterHref(effectiveStatus === "expired" ? "previous" : "pending", {
              requestId: entry.id,
              from: "/one/feed",
              requestView: effectiveStatus === "link_expired" || effectiveStatus === "waiting_owner_setup" ? "sent" : undefined,
            })
          : undefined,
    });
  }
  return [...byRequest.values()].sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
}
