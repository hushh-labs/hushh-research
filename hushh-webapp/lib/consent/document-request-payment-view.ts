/**
 * One requester-side view of a document request's price and payment.
 *
 * CONTRACT (owned by the request-money lane; shapes are stable). The server
 * computes `payment` once (drive_request_payment_view.py) and every surface
 * presents it through presentRequesterPayment, so the Feed, Consent Center and
 * request details can never disagree on state or countdown. `price` separates
 * the estimate the requester saw from the owner's current and final price.
 */
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
  /** e.g. "29 min left"; null when no deadline applies. */
  remaining: string | null;
  action: "pay" | "new_request" | "withdraw" | null;
};

export function parseRequesterPaymentView(value: unknown): RequesterPaymentView | null {
  void value;
  return null;
}

export function parseRequesterPriceView(value: unknown): RequesterPriceView | null {
  void value;
  return null;
}

export function presentRequesterPayment(view: RequesterPaymentView, now: number): RequesterPaymentPresentation {
  void now;
  return { title: "", line: null, remaining: null, action: view.nextAction === "pay" ? "pay" : null };
}
