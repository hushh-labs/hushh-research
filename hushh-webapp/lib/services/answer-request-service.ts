/**
 * Client for the paid-answer lane: ask a connected person's private agent a
 * question, then pay for the answer once they approve the scopes and price.
 *
 * Direct-to-backend with a Firebase bearer, matching
 * `drive-request-payment-service.ts`. The money path has no `app/api` proxy:
 * the Stripe webhook needs the exact signed bytes, and the status and checkout
 * endpoints stay on the same origin as it.
 *
 * Responses are validated here rather than trusted. A paid flow that renders
 * an unvalidated `status` would let a malformed response look like a settled
 * payment.
 */

import { ApiService } from "@/lib/services/api-service";

const REQUEST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MIN_ANSWER_PRICE_CENTS = 100;
export const MAX_ANSWER_PRICE_CENTS = 50_000;

export const ANSWER_REQUEST_HELPER =
  "They approve the question, the exact information it uses, and the price before you pay.";

export type AnswerRequestStatus =
  | "pending_resolution"
  | "awaiting_owner"
  | "approved"
  | "declined"
  | "answering"
  | "answered"
  | "expired"
  | "cancelled";

export type AnswerOrderStatus =
  | "awaiting_payment"
  | "checkout_open"
  | "paid"
  | "refunded"
  | "expired";

export interface AnswerRequestTerms {
  question: string;
  /** ISO dates, or null when the question does not cover a period. */
  periodStart: string | null;
  periodEnd: string | null;
}

export interface AnswerPaymentView {
  requestStatus: AnswerRequestStatus;
  orderStatus: AnswerOrderStatus | null;
  amountCents: number | null;
  currency: "usd";
  checkoutUrl: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  /** Quoted BEFORE checkout: the answer is produced on the owner's device. */
  fulfilment: "owner_device";
  answerDeadlineAt: string | null;
  answerDeadlineHours: number;
}

const CHECKOUT_HOSTS = new Set(["checkout.stripe.com", "checkout.stripe.dev"]);

export function isValidAnswerPriceCents(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_ANSWER_PRICE_CENTS &&
    value <= MAX_ANSWER_PRICE_CENTS &&
    value % 100 === 0
  );
}

/** A period is either absent entirely or complete and correctly ordered. */
export function validAnswerPeriod(start: string | null, end: string | null): boolean {
  if (!start && !end) return true;
  if (!start || !end) return false;
  return start <= end;
}

export function validAnswerRequest(terms: AnswerRequestTerms): boolean {
  const question = terms.question.trim();
  return (
    question.length >= 8 &&
    question.length <= 2000 &&
    validAnswerPeriod(terms.periodStart, terms.periodEnd)
  );
}

function requestPath(requestId: string): string {
  if (!REQUEST_UUID.test(requestId)) throw new Error("Invalid request ID");
  return `/api/one/answer-requests/${requestId}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid response");
  }
  return value as Record<string, unknown>;
}

export class AnswerRequestService {
  /** Submit a question. Returns the new request id; resolution happens server-side. */
  static async create(
    firebaseIdToken: string,
    personRef: string,
    terms: AnswerRequestTerms,
  ): Promise<{ requestId: string }> {
    if (!firebaseIdToken) throw new Error("Sign in to send this request");
    if (!validAnswerRequest(terms)) throw new Error("Check the question and dates");
    const response = await ApiService.apiFetch("/api/one/answer-requests", {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${firebaseIdToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personRef,
        question: terms.question.trim(),
        periodStart: terms.periodStart,
        periodEnd: terms.periodEnd,
      }),
    });
    if (!response.ok) {
      const code = response.status;
      if (code === 403) throw new Error("You need an active connection with this person.");
      if (code === 422) throw new Error("Check the question and dates.");
      throw new Error("This request could not be sent. Try again.");
    }
    const value = await readJson(response);
    const requestId = String(value.requestId || "");
    if (!REQUEST_UUID.test(requestId)) throw new Error("Invalid response");
    return { requestId };
  }

  /** Payment and fulfilment state, including the wait the requester is accepting. */
  static async payment(
    firebaseIdToken: string,
    requestId: string,
  ): Promise<AnswerPaymentView> {
    if (!firebaseIdToken) throw new Error("Sign in to view this payment");
    const response = await ApiService.apiFetch(`${requestPath(requestId)}/payment`, {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    });
    if (!response.ok) throw new Error("Payment is unavailable. Try again.");
    const value = await readJson(response);
    if (value.currency !== "usd" || value.fulfilment !== "owner_device") {
      throw new Error("Invalid payment response");
    }
    if (value.amountCents !== null && !isValidAnswerPriceCents(value.amountCents)) {
      throw new Error("Invalid payment response");
    }
    return value as unknown as AnswerPaymentView;
  }

  /** Open hosted Checkout. Only ever returns a Stripe-hosted URL. */
  static async checkout(firebaseIdToken: string, requestId: string): Promise<string> {
    if (!firebaseIdToken) throw new Error("Sign in to pay");
    const response = await ApiService.apiFetch(`${requestPath(requestId)}/payment/checkout`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    });
    if (!response.ok) throw new Error("Checkout is unavailable. Try again.");
    const value = await readJson(response);
    const url = String(value.checkoutUrl || "");
    // Never follow a redirect target the backend did not intend.
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      throw new Error("Invalid checkout response");
    }
    if (!CHECKOUT_HOSTS.has(host)) throw new Error("Invalid checkout response");
    return url;
  }
}
