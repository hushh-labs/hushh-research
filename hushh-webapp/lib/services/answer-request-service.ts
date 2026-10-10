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

/** A question awaiting this owner's review, with the scopes validation allowed. */
export interface PendingAnswerRequest {
  requestId: string;
  requesterUserId: string;
  question: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** 'skipped' means the semantic resolver did not run; the owner picks by hand. */
  resolutionMode: "agent" | "skipped" | null;
  resolutionSkippedReason: string | null;
  proposedScopes: { scope: string; label: string | null }[];
}

/** One paid, approved, undelivered question the owner's device owes an answer to. */
export interface AnswerableWork {
  requestId: string;
  question: string;
  periodStart: string | null;
  periodEnd: string | null;
  approvedScopes: string[];
  scopeLabels: Record<string, string>;
  answerDeadlineAt: string | null;
  requesterUserId: string;
  /** The requester's published ECDH key, so the device can seal in one pass. */
  recipientKey: { keyId: string; publicKeyJwk: JsonWebKey; algorithm?: string | null };
}

export class AnswerRequestService {
  /** Questions this owner has been asked and has not yet answered or refused. */
  static async inbox(firebaseIdToken: string): Promise<PendingAnswerRequest[]> {
    if (!firebaseIdToken) return [];
    const response = await ApiService.apiFetch("/api/one/answer-requests/inbox", {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    });
    if (!response.ok) throw new Error("Could not load requests");
    const value = await readJson(response);
    return (Array.isArray(value.requests) ? value.requests : []) as PendingAnswerRequest[];
  }

  /** Approve the exact question, the exact scopes and a whole-dollar price. */
  static async approve(
    firebaseIdToken: string,
    requestId: string,
    scopes: string[],
    amountCents: number,
  ): Promise<{ termsDigest: string }> {
    if (!firebaseIdToken) throw new Error("Sign in to approve");
    if (!scopes.length) throw new Error("Choose the information to share");
    if (!isValidAnswerPriceCents(amountCents)) throw new Error("Choose a whole-dollar price");
    const response = await ApiService.apiFetch(`${requestPath(requestId)}/approve`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${firebaseIdToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scopes, amountCents }),
    });
    if (!response.ok) throw new Error("This request could not be approved");
    const value = await readJson(response);
    return { termsDigest: String(value.termsDigest || "") };
  }

  static async decline(firebaseIdToken: string, requestId: string): Promise<void> {
    if (!firebaseIdToken) throw new Error("Sign in to decline");
    const response = await ApiService.apiFetch(`${requestPath(requestId)}/decline`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    });
    if (!response.ok) throw new Error("This request could not be declined");
  }

  /** The requester withdraws before delivery; a paid request refunds in full. */
  static async cancel(firebaseIdToken: string, requestId: string): Promise<void> {
    if (!firebaseIdToken) throw new Error("Sign in to cancel");
    const response = await ApiService.apiFetch(`${requestPath(requestId)}/cancel`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    });
    if (!response.ok) throw new Error("This request could not be cancelled");
  }

  /** Paid work awaiting this owner's device. Scope handles only, never values. */
  static async answerable(firebaseIdToken: string): Promise<AnswerableWork[]> {
    if (!firebaseIdToken) return [];
    const response = await ApiService.apiFetch("/api/one/answer-requests/answerable", {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    });
    if (!response.ok) throw new Error("Could not load pending answers");
    const value = await readJson(response);
    const rows = Array.isArray(value.requests) ? value.requests : [];
    // Refuse a row without a usable recipient key rather than attempting to
    // seal against nothing.
    return rows.filter(
      (row: AnswerableWork) =>
        row?.recipientKey?.keyId && row?.recipientKey?.publicKeyJwk && Array.isArray(row.approvedScopes),
    ) as AnswerableWork[];
  }

  /** Post the sealed answer. Ciphertext only; the server cannot read it. */
  static async deliver(
    firebaseIdToken: string,
    requestId: string,
    body: { envelope: unknown; sourceRevisions?: unknown; hasContent: boolean },
  ): Promise<void> {
    if (!firebaseIdToken) throw new Error("Sign in to deliver this answer");
    const response = await ApiService.apiFetch(`${requestPath(requestId)}/deliver`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${firebaseIdToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("This answer could not be delivered");
  }

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

  /** The sealed answer envelope. Ciphertext; only the requester can read it. */
  static async answer(firebaseIdToken: string, requestId: string): Promise<unknown> {
    if (!firebaseIdToken) throw new Error("Sign in to open this answer");
    const response = await ApiService.apiFetch(`${requestPath(requestId)}/answer`, {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    });
    if (!response.ok) throw new Error("This answer is not available yet");
    const value = await readJson(response);
    if (!value.ciphertext || !value.iv || !value.recipientKeyId) {
      throw new Error("Invalid answer envelope");
    }
    return value;
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
