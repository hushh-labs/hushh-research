/**
 * One requester-side view of a document request's price and payment.
 *
 * CONTRACT (owned by the request-money lane; shapes are stable). The server
 * computes `payment` once (drive_request_payment_view.py) and every surface
 * presents it through presentRequesterPayment, so the Feed, Consent Center and
 * request details can never disagree on state or countdown. `price` separates
 * the estimate the requester saw from the owner's current and final price.
 */
import { parseDrivePackageDisclosure, type DrivePackageDisclosure } from "@/lib/consent/drive-package-disclosure";
import { isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";

export type RequesterPaymentState =
  | "none"
  | "awaiting_owner"
  | "preparing"
  | "payable"
  | "link_expired"
  | "request_expired"
  | "paid"
  | "refund_pending"
  | "refunded"
  | "partially_refunded"
  | "closed";

export type RequesterRefundStatus = "queued" | "pending" | "succeeded" | "manual_review" | "failed";

export type RequesterPaymentView = {
  state: RequesterPaymentState;
  amountCents: number | null;
  currency: string;
  /** Only while state is "payable". */
  checkoutExpiresAt: string | null;
  requestExpiresAt: string | null;
  refund: { status: RequesterRefundStatus; amountCents: number } | null;
  nextAction: "pay" | "wait_owner" | "new_request" | "none";
  /** True once the requester withdrew the request. Absent from older servers. */
  withdrawn?: boolean;
  /** Marked agent packets require their sealed buyer disclosure before Pay. */
  packageDisclosureRequired?: boolean;
  packageDisclosure?: DrivePackageDisclosure | null;
  /**
   * Autoshare: payment is asked when the owner allows, before files are found;
   * files stream after payment and what is not sent is refunded. Absent on
   * older requests, which keep their own copy.
   */
  autoshare?: boolean;
  /** Autoshare, "preparing" only: the order exists and its payment link is being made. */
  checkoutPending?: boolean;
};

export type RequesterPriceState = "estimate" | "owner_set" | "final" | "awaiting_owner";

export type RequesterPriceView = {
  /** What the requester saw when sending; null for requests made before estimates existed. */
  estimateCents: number | null;
  /** The owner's current price, before an order exists. */
  currentCents: number | null;
  /** The amount actually payable or paid. */
  finalCents: number | null;
  state: RequesterPriceState;
};

export type RequesterPaymentPresentation = {
  title: string;
  line: string | null;
  /** e.g. "29m left"; null when no deadline applies. */
  remaining: string | null;
  action: "pay" | "new_request" | "withdraw" | null;
};

const STATES: ReadonlySet<string> = new Set<RequesterPaymentState>([
  "none",
  "awaiting_owner",
  "preparing",
  "payable",
  "link_expired",
  "request_expired",
  "paid",
  "refund_pending",
  "refunded",
  "partially_refunded",
  "closed",
]);
const REFUND_STATUSES: ReadonlySet<string> = new Set<RequesterRefundStatus>([
  "queued",
  "pending",
  "succeeded",
  "manual_review",
  "failed",
]);
const NEXT_ACTIONS: ReadonlySet<string> = new Set(["pay", "wait_owner", "new_request", "none"]);
const PRICE_STATES: ReadonlySet<string> = new Set<RequesterPriceState>([
  "estimate",
  "owner_set",
  "final",
  "awaiting_owner",
]);
/** Before payment, while the request can still be paid or withdrawn. */
const OPEN_STATES: ReadonlySet<RequesterPaymentState> = new Set<RequesterPaymentState>([
  "awaiting_owner",
  "preparing",
  "payable",
  "link_expired",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function instant(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalInstant(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return instant(value) === null ? undefined : (value as string);
}

function optionalPrice(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return isValidDocumentRequestPriceCents(value) ? value : undefined;
}

function refundCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 50_000;
}

/**
 * The server's payment view, or null when absent or malformed. A malformed
 * view fails closed: no Pay action and no refund claim is ever shown for it.
 */
export function parseRequesterPaymentView(value: unknown): RequesterPaymentView | null {
  const raw = record(value);
  if (!raw || typeof raw.state !== "string" || !STATES.has(raw.state)) return null;
  if (raw.currency !== "usd" || typeof raw.nextAction !== "string" || !NEXT_ACTIONS.has(raw.nextAction))
    return null;
  const amountCents = optionalPrice(raw.amountCents);
  const checkoutExpiresAt = optionalInstant(raw.checkoutExpiresAt);
  const requestExpiresAt = optionalInstant(raw.requestExpiresAt);
  if (amountCents === undefined || checkoutExpiresAt === undefined || requestExpiresAt === undefined)
    return null;
  const state = raw.state as RequesterPaymentState;
  // Pay needs a real price and a real deadline.
  if (state === "payable" && (amountCents === null || checkoutExpiresAt === null)) return null;
  let refund: RequesterPaymentView["refund"] = null;
  if (raw.refund !== null && raw.refund !== undefined) {
    const item = record(raw.refund);
    if (!item || typeof item.status !== "string" || !REFUND_STATUSES.has(item.status) || !refundCents(item.amountCents))
      return null;
    refund = { status: item.status as RequesterRefundStatus, amountCents: item.amountCents };
  }
  if (raw.withdrawn !== undefined && typeof raw.withdrawn !== "boolean") return null;
  if (raw.packageDisclosureRequired !== undefined && typeof raw.packageDisclosureRequired !== "boolean") return null;
  if (raw.autoshare !== undefined && typeof raw.autoshare !== "boolean") return null;
  if (raw.checkoutPending !== undefined && typeof raw.checkoutPending !== "boolean") return null;
  const autoshare = raw.autoshare === true;
  return {
    state,
    amountCents,
    currency: "usd",
    checkoutExpiresAt: state === "payable" ? checkoutExpiresAt : null,
    requestExpiresAt,
    refund,
    nextAction: raw.nextAction as RequesterPaymentView["nextAction"],
    withdrawn: raw.withdrawn === true,
    ...(raw.packageDisclosureRequired === undefined ? {} : { packageDisclosureRequired: raw.packageDisclosureRequired as boolean }),
    ...(raw.packageDisclosure === undefined ? {} : { packageDisclosure: parseDrivePackageDisclosure(raw.packageDisclosure) }),
    ...(autoshare ? { autoshare: true } : {}),
    ...(autoshare && state === "preparing" && raw.checkoutPending === true ? { checkoutPending: true } : {}),
  };
}

export function parseRequesterPriceView(value: unknown): RequesterPriceView | null {
  const raw = record(value);
  if (!raw || typeof raw.state !== "string" || !PRICE_STATES.has(raw.state)) return null;
  const estimateCents = optionalPrice(raw.estimateCents);
  const currentCents = optionalPrice(raw.currentCents);
  const finalCents = optionalPrice(raw.finalCents);
  if (estimateCents === undefined || currentCents === undefined || finalCents === undefined) return null;
  return { estimateCents, currentCents, finalCents, state: raw.state as RequesterPriceState };
}

/**
 * One vocabulary for the states the Feed and the request details both show.
 * The Feed's titles came first and are what people already see, so the
 * details use the same words.
 */
export const REQUESTER_PAYMENT_TITLES = {
  awaitingOwner: "Waiting for owner setup",
  linkExpired: "Payment link expired",
  requestExpired: "Document request expired",
} as const;

/**
 * Where to go once this request can no longer be paid. Checkout gives one
 * window per request, so the only way forward is a new request.
 */
export function requesterNewRequestLine(ownerName?: string | null): string {
  const owner = ownerName?.trim();
  return owner ? `Ask ${owner} again from their profile.` : "Ask the owner again from their profile.";
}

/** Compact deadline copy that stays readable in a narrow row. One formatter for every surface. */
export function formatPaymentRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h left`;
}

/** "$25" for whole dollars, "$8.33" for a prorated refund. */
export function formatPaymentMoney(cents: number): string {
  return cents % 100 === 0
    ? `$${(cents / 100).toLocaleString("en-US")}`
    : `$${(cents / 100).toFixed(2)}`;
}

/**
 * The state as of `now`: deadlines pass on the device without a refetch.
 * The request's own expiry wins over the payment window, as on the server.
 */
export function effectiveRequesterPaymentState(
  view: RequesterPaymentView,
  now: number,
): RequesterPaymentState {
  if (!OPEN_STATES.has(view.state)) return view.state;
  const requestDeadline = instant(view.requestExpiresAt);
  if (requestDeadline !== null && requestDeadline <= now) return "request_expired";
  if (view.state !== "payable") return view.state;
  const checkoutDeadline = instant(view.checkoutExpiresAt);
  return checkoutDeadline === null || checkoutDeadline <= now ? "link_expired" : "payable";
}

/** Withdraw is offered only before any payment and while the request is open. */
export function requesterPaymentWithdrawable(view: RequesterPaymentView, now: number): boolean {
  const state = effectiveRequesterPaymentState(view, now);
  return OPEN_STATES.has(state) && view.withdrawn !== true;
}

/**
 * How often a view's presentation can change on its own: every second while a
 * countdown shows, every 30 s while an open request can still expire, and
 * never (null) once nothing depends on the clock.
 */
export function requesterPaymentTickMs(view: RequesterPaymentView): number | null {
  if (view.state === "payable") return 1_000;
  return OPEN_STATES.has(view.state) && instant(view.requestExpiresAt) !== null ? 30_000 : null;
}

/** Autoshare asks for payment before files are found; the server refunds what is not sent. */
const AUTOSHARE_REFUND_LINE = "If nothing matches, you get a full refund.";

export function presentRequesterPayment(
  view: RequesterPaymentView,
  now: number,
  options: { ownerName?: string | null } = {},
): RequesterPaymentPresentation {
  const state = effectiveRequesterPaymentState(view, now);
  const price = view.amountCents === null ? null : formatPaymentMoney(view.amountCents);
  const refund = view.refund ? formatPaymentMoney(view.refund.amountCents) : null;
  const present = (
    title: string,
    line: string | null = null,
    action: RequesterPaymentPresentation["action"] = null,
    remaining: string | null = null,
  ): RequesterPaymentPresentation => ({ title, line, remaining, action });
  const autoshare = view.autoshare === true;
  // Autoshare settles by delivery: a full refund means no file was sent, a
  // smaller one is for the files that were not. Only the server's refund counts.
  const refundReason = !autoshare || !view.refund || view.amountCents === null
    ? null
    : view.refund.amountCents < view.amountCents
      ? "For files not sent."
      : "No files were sent.";
  switch (state) {
    case "none":
      return present("");
    case "awaiting_owner":
      return present(REQUESTER_PAYMENT_TITLES.awaitingOwner, "You can pay once they finish setup.", "withdraw");
    case "preparing":
      if (autoshare)
        return view.checkoutPending === true
          ? present("Getting your payment ready", AUTOSHARE_REFUND_LINE, "withdraw")
          : present("No payment due yet", `You pay before files are sent. ${AUTOSHARE_REFUND_LINE}`, "withdraw");
      return present("No payment due yet", "You pay only if files are found.", "withdraw");
    case "payable": {
      const deadline = instant(view.checkoutExpiresAt) as number;
      return present(
        "Payment due",
        autoshare ? `Files start arriving right after you pay. ${AUTOSHARE_REFUND_LINE}` : "Sharing starts after payment.",
        "pay",
        formatPaymentRemaining(deadline - now),
      );
    }
    case "link_expired":
      return present(REQUESTER_PAYMENT_TITLES.linkExpired, requesterNewRequestLine(options.ownerName), "new_request");
    case "request_expired":
      return present(REQUESTER_PAYMENT_TITLES.requestExpired, requesterNewRequestLine(options.ownerName), "new_request");
    case "paid":
      return present(price ? `Paid ${price}` : "Paid");
    case "refund_pending": {
      const pending = refund ? `Refund of ${refund} pending` : "Refund pending";
      if (view.withdrawn) return present("Payment received after you withdrew", pending);
      const slow = view.refund?.status === "manual_review" || view.refund?.status === "failed";
      return present(pending, slow ? "This is taking longer than usual." : refundReason ?? (price ? `Paid ${price}` : null));
    }
    case "refunded":
      return present(refund ? `Refunded ${refund}` : "Refunded", refundReason);
    case "partially_refunded":
      return present(price ? `Paid ${price}` : "Paid",
        refund ? autoshare ? `${refund} refunded for files not sent.` : `${refund} refunded` : null);
    case "closed":
      return view.withdrawn ? present("Request withdrawn") : present("Request closed", "Nothing to pay.");
  }
}
