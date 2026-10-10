import { documentShareRequestId, isDocumentShareEntry } from "@/lib/consent/document-share-consent";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { parseConsentInstant } from "@/lib/consent/consent-owner-copy";
import {
  formatDocumentRequestPrice,
  isValidDocumentRequestPriceCents,
} from "@/lib/consent/document-request-price";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import type { SharingRequestContext } from "@/lib/services/drive-sharing-service";

export type FeedDrivePaymentStatus = "ready" | "link_expired" | "expired";

export interface FeedDrivePayment {
  requestId: string;
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

/** Compact deadline copy that stays readable in a narrow Feed row. */
export function formatPaymentRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h left`;
}

/** Recompute copy/status from the local clock without waiting for a refetch. */
export function describeFeedDrivePayment(
  payment: Pick<FeedDrivePayment, "status" | "amountCents" | "ownerLabel" | "expiresAt" | "requestedAt">,
  now = Date.now(),
  context?: SharingRequestContext,
): Pick<FeedDrivePayment, "status" | "title" | "description"> {
  const locallyExpired =
    payment.status === "ready" &&
    payment.expiresAt !== null &&
    payment.expiresAt <= now;
  const status: FeedDrivePaymentStatus = locallyExpired ? "link_expired" : payment.status;
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
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
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
      title: status === "expired" ? "Document request expired"
        : status === "link_expired" ? "Payment link expired" : `Pay ${price} · ${subject}`,
      description: [
        status === "ready" ? null : subject,
        owner ? `From ${owner}` : null,
        requestPeriod(context!),
        deadline,
      ].filter(Boolean).join(" · "),
    };
  }
  const requested = requestedDate(requestedAt);
  if (requested) {
    return {
      title: status === "expired" ? "Document request expired"
        : status === "link_expired" ? "Payment link expired"
          : owner ? `Pay ${price} for files from ${owner}` : `Pay ${price} for your document request`,
      description: [status !== "ready" && owner ? `From ${owner}` : null, requested, deadline]
        .filter(Boolean).join(" · "),
    };
  }
  if (status === "expired") {
    return owner
      ? {
          title: "Document request expired",
          description: `Your request for files from ${owner} expired before payment.`,
        }
      : {
          title: "Document request expired",
          description: "This request expired before payment.",
        };
  }
  if (status === "link_expired") {
    return owner
      ? {
          title: "Payment link expired",
          description: `The ${price} link for files from ${owner} expired.`,
        }
      : {
          title: "Payment link expired",
          description: `The ${price} link expired.`,
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
    const status = paymentState(entry, now);
    if (!status) {
      // Expired request rows may be emitted as history, but must retain a
      // payment row if their order is still present in the projection.
      if (nonEmptyString(entry.status).toLowerCase() !== "expired") continue;
    }
    const effectiveStatus = status || "expired";
    const requestedAt = parseConsentInstant(entry.issued_at);
    const ownerLabel = counterpartLabel(entry);
    const expiresAt = expiryTimestamp(
      metadata.paymentCheckoutExpiresAt ??
        metadata.payment_checkout_expires_at ??
        metadata.checkoutExpiresAt ??
        metadata.checkout_expires_at,
    );
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
      status: effectiveStatus,
      ...copy,
      requestedAt,
      amountCents,
      ownerLabel,
      expiresAt,
      href:
        effectiveStatus === "expired" || effectiveStatus === "link_expired"
          ? buildConsentCenterHref(effectiveStatus === "expired" ? "previous" : "pending", {
              requestId: entry.id,
              from: "/one/feed",
              requestView: effectiveStatus === "link_expired" ? "sent" : undefined,
            })
          : undefined,
    });
  }
  return [...byRequest.values()].sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
}
