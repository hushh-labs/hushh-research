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

import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { ApiService } from "@/lib/services/api-service";
import { AnswerPayoutService } from "./answer-payout-service";

const REQUEST_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  "awaiting_payment" | "checkout_open" | "paid" | "refunded" | "expired";

export interface AnswerRequestTerms {
  question: string;
  /** Optional ISO dates; a supplied range must be complete. */
  periodStart?: string | null;
  periodEnd?: string | null;
}

/**
 * The lane's rollout gates, read once per surface.
 *
 * Independent on purpose: `payments` false with `requests` true is the
 * supported state where questions are accepted and nothing can be charged.
 */
export interface AnswerLaneGates {
  requests: boolean;
  payments: boolean;
  /** Payout setup reachability; its own Connect-mode rule, not `payments`. */
  payouts: boolean;
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
  preparationStatus: "preparing" | "ready" | "empty" | "retry_required";
  reconciliationRequired: boolean;
  /** Quoted BEFORE checkout: the answer is produced on the owner's device. */
  fulfilment: "owner_device";
  answerDeadlineAt: string | null;
  answerDeadlineHours: number;
}

export interface AnswerRequestCoverage {
  included: { scope: string; label: string | null }[];
  notIncluded: { scope: string; label: string | null }[];
}

export interface AnswerRequestState {
  role: string;
  requestStatus: string;
  question: string;
  /** Present only after the owner fixes the priced scope set. No values or absence claim. */
  coverage?: AnswerRequestCoverage;
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
export function validAnswerPeriod(
  start?: string | null,
  end?: string | null,
): boolean {
  const absent = (value: unknown) => value == null || value === "";
  if (absent(start) && absent(end)) return true;
  if (!start || !end) return false;
  const isoDate = (value: string) => {
    if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))
      return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  return isoDate(start) && isoDate(end) && start <= end;
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

/** One approved preparation or historical paid recovery for the owner's device. */
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
  recipientKey: {
    keyId: string;
    publicKeyJwk: JsonWebKey;
    algorithm?: string | null;
  };
  /**
   * The owner's own public identity, as the requester already sees it on the
   * profile. Carried so the answer's memory document is a record of a person
   * rather than a bag of fields.
   */
  ownerIdentity?: {
    displayName?: string | null;
    email?: string | null;
    photoUrl?: string | null;
  } | null;
}

export class AnswerRequestService {
  /**
   * The lane's two independent gates.
   *
   * `requests` admits the question form and the owner's review; `payments`
   * admits checkout. They are separate because asking a connected person a
   * question moves no money: a deployment with payments still paused can
   * take questions, and reading one flag for both is what previously hid the
   * form behind the paywall.
   *
   * Throws rather than returning all-false on a transport or HTTP failure.
   * "We could not ask" and "the answer was no" need different words on
   * screen, and collapsing them told people a feature was switched off when
   * their connection had simply dropped. Both gates still fail closed: an
   * absent or non-boolean field is `false`, so an older backend that reports
   * only `enabled` never reads as permission.
   */
  static async gates(firebaseIdToken: string): Promise<AnswerLaneGates> {
    if (!firebaseIdToken) throw new Error("Sign in to send this request.");
    const response = await ApiService.apiFetch(
      "/api/one/answer-requests/availability",
      {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      },
    );
    if (!response.ok) throw new Error("Could not check whether this can be sent.");
    const value = await readJson(response);
    return {
      requests: value.requests === true,
      payments: value.payments === true,
      payouts: value.payouts === true,
    };
  }

  static payoutAccount = AnswerPayoutService.account;
  static payoutLink = AnswerPayoutService.link;
  static payoutOnboarding = AnswerPayoutService.onboarding;

  /** Questions this owner has been asked and has not yet answered or refused. */
  static async inbox(firebaseIdToken: string): Promise<PendingAnswerRequest[]> {
    if (!firebaseIdToken) return [];
    const response = await ApiService.apiFetch(
      "/api/one/answer-requests/inbox",
      {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      },
    );
    if (!response.ok) throw new Error("Could not load requests");
    const value = await readJson(response);
    return (
      Array.isArray(value.requests) ? value.requests : []
    ) as PendingAnswerRequest[];
  }

  static async state(
    token: string,
    requestId: string,
  ): Promise<AnswerRequestState> {
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/state`,
      { cache: "no-store", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error("Request unavailable");
    const value = await readJson(response);
    if (typeof value.role !== "string" || typeof value.requestStatus !== "string" || typeof value.question !== "string")
      throw new Error("Invalid request response");
    if (value.coverage !== undefined) {
      const coverage = value.coverage as Partial<AnswerRequestCoverage> | null;
      const validRows = (rows: unknown): rows is AnswerRequestCoverage["included"] =>
        Array.isArray(rows) && rows.length <= 12 && rows.every(row =>
          row && typeof row === "object" && typeof row.scope === "string" &&
          /^attr\.[a-z0-9_]+(?:\.[a-z0-9_*]+)+$/.test(row.scope) &&
          (row.label === null || typeof row.label === "string" && row.label.length <= 160));
      if (!coverage || !validRows(coverage.included) || !validRows(coverage.notIncluded))
        throw new Error("Invalid request coverage");
    }
    return value as unknown as AnswerRequestState;
  }

  static async retryResolution(token: string, requestId: string): Promise<void> {
    const response = await ApiService.apiFetch(`${requestPath(requestId)}/resolve`, {
      method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error("This question could not be matched. Try again.");
  }

  /** Approve the exact question, the exact scopes and a whole-dollar price. */
  static async approve(
    firebaseIdToken: string,
    requestId: string,
    scopes: string[],
    amountCents: number,
    modelProcessingConsent: boolean,
  ): Promise<{ termsDigest: string }> {
    if (!firebaseIdToken) throw new Error("Sign in to approve");
    if (!modelProcessingConsent)
      throw new Error("Agree to model processing for this question.");
    if (!scopes.length) throw new Error("Choose the information to share");
    if (!isValidAnswerPriceCents(amountCents))
      throw new Error("Choose a whole-dollar price");
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/approve`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${firebaseIdToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scopes, amountCents, modelProcessingConsent }),
      },
    );
    if (!response.ok) throw new Error("This request could not be approved");
    const value = await readJson(response);
    dispatchConsentStateChanged({ requestId: `answer_request:${requestId}` });
    return { termsDigest: String(value.termsDigest || "") };
  }

  static async decline(
    firebaseIdToken: string,
    requestId: string,
  ): Promise<void> {
    if (!firebaseIdToken) throw new Error("Sign in to decline");
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/decline`,
      {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      },
    );
    if (!response.ok) throw new Error("This request could not be declined");
  }

  /** The requester withdraws before delivery; a paid request refunds in full. */
  static async cancel(
    firebaseIdToken: string,
    requestId: string,
  ): Promise<void> {
    if (!firebaseIdToken) throw new Error("Sign in to cancel");
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/cancel`,
      {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      },
    );
    if (!response.ok) throw new Error("This request could not be cancelled");
  }

  /** Preparation and paid recovery awaiting this owner's device. Scope handles only. */
  static async answerable(firebaseIdToken: string): Promise<AnswerableWork[]> {
    if (!firebaseIdToken) return [];
    const response = await ApiService.apiFetch(
      "/api/one/answer-requests/answerable",
      {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      },
    );
    if (!response.ok) throw new Error("Could not load pending answers");
    const value = await readJson(response);
    const rows = Array.isArray(value.requests) ? value.requests : [];
    // Refuse a row without a usable recipient key rather than attempting to
    // seal against nothing.
    return rows.filter(
      (row: AnswerableWork) =>
        row?.recipientKey?.keyId &&
        row?.recipientKey?.publicKeyJwk &&
        Array.isArray(row.approvedScopes),
    ) as AnswerableWork[];
  }

  /**
   * Have the answer written from the projection this device just built.
   *
   * The projection is the approved scopes and dates only, and nothing is
   * persisted server-side. A successful Gemini answer carries a request-bound
   * composition receipt for staging; a model failure remains retryable.
   */
  static async compose(
    firebaseIdToken: string,
    requestId: string,
    projection: {
      memory: string;
      values: Record<string, unknown>;
      sourceFreshness?: import("@/lib/pkm/memory-scope-retrieval").ApprovedMemoryRetrieval["sourceFreshness"];
    },
  ): Promise<{
    answerMode: "agent" | "projection";
    answer: string | null;
    covers?: string[];
    gaps?: string[];
    compositionReceipt?: string;
  }> {
    if (!firebaseIdToken) throw new Error("Sign in to compose this answer");
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/compose`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${firebaseIdToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projection }),
      },
    );
    if (!response.ok) return { answerMode: "projection", answer: null };
    const value = await readJson(response);
    const mode = value.answerMode === "agent" ? "agent" : "projection";
    const answer =
      typeof value.answer === "string" && value.answer.trim()
        ? value.answer
        : null;
    // An 'agent' mode with no answer is not an agent answer.
    if (mode === "agent" && answer && Array.isArray(value.gaps) && value.gaps.length === 0 && typeof value.compositionReceipt === "string" && value.compositionReceipt.trim()) {
      return {
        answerMode: "agent",
        answer,
        compositionReceipt: value.compositionReceipt,
        covers: Array.isArray(value.covers) ? (value.covers as string[]) : [],
        gaps: Array.isArray(value.gaps) ? (value.gaps as string[]) : [],
      };
    }
    return { answerMode: "projection", answer: null };
  }

  /** Post the sealed answer. Ciphertext only; the server cannot read it. */
  static async deliver(
    firebaseIdToken: string,
    requestId: string,
    body: { envelope: unknown; sourceRevisions?: unknown; hasContent: boolean; compositionReceipt?: string },
  ): Promise<void> {
    if (!firebaseIdToken) throw new Error("Sign in to deliver this answer");
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/deliver`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${firebaseIdToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error("This answer could not be delivered");
    dispatchConsentStateChanged({ requestId: `answer_request:${requestId}` });
  }

  /** Submit a question. An unchanged retry can reuse the existing request id. */
  static async create(
    firebaseIdToken: string,
    personRef: string,
    terms: AnswerRequestTerms,
    options?: { clientRequestId: string; isEffectCurrent?: () => boolean },
  ): Promise<{ requestId: string }> {
    if (!firebaseIdToken) throw new Error("Sign in to send this request");
    if (!validAnswerRequest(terms))
      throw new Error("Check the request details");
    const response = await ApiService.apiFetch("/api/one/answer-requests", {
      isEffectCurrent: options?.isEffectCurrent,
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${firebaseIdToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(options ? { clientRequestId: options.clientRequestId } : {}),
        personRef,
        question: terms.question.trim(),
        periodStart: terms.periodStart,
        periodEnd: terms.periodEnd,
      }),
    });
    if (!response.ok) {
      const code = response.status;
      if (code === 403)
        throw new Error("You need an active connection with this person.");
      if (code === 422) throw new Error("Check the request details.");
      throw new Error("This request could not be sent. Try again.");
    }
    const value = await readJson(response);
    const requestId = String(value.requestId || "");
    if (!REQUEST_UUID.test(requestId)) throw new Error("Invalid response");
    dispatchConsentStateChanged({ requestId: `answer_request:${requestId}` });
    return { requestId };
  }

  /** Payment and fulfilment state, including the wait the requester is accepting. */
  static async payment(
    firebaseIdToken: string,
    requestId: string,
  ): Promise<AnswerPaymentView> {
    if (!firebaseIdToken) throw new Error("Sign in to view this payment");
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/payment`,
      {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      },
    );
    if (!response.ok) throw new Error("Payment is unavailable. Try again.");
    const value = await readJson(response);
    if (value.currency !== "usd" || value.fulfilment !== "owner_device") {
      throw new Error("Invalid payment response");
    }
    if (
      value.amountCents !== null &&
      !isValidAnswerPriceCents(value.amountCents)
    ) {
      throw new Error("Invalid payment response");
    }
    const statuses = new Set(["pending_resolution", "awaiting_owner", "approved", "declined", "answering", "answered", "expired", "cancelled"]);
    const orders = new Set(["awaiting_payment", "checkout_open", "paid", "refunded", "expired"]);
    if (!statuses.has(String(value.requestStatus)) ||
        (value.orderStatus !== null && !orders.has(String(value.orderStatus)))) {
      throw new Error("Invalid payment response");
    }
    // Older deployments cannot prove preparation; never offer checkout from an absent field.
    value.preparationStatus = ["preparing", "ready", "empty", "retry_required"].includes(String(value.preparationStatus))
      ? value.preparationStatus : "preparing";
    value.reconciliationRequired = value.reconciliationRequired !== false;
    if (["paid", "refunded"].includes(String(value.orderStatus)) &&
        (typeof value.paidAt !== "string" || !Number.isFinite(Date.parse(value.paidAt)))) {
      throw new Error("Invalid payment response");
    }
    return value as unknown as AnswerPaymentView;
  }

  /** The sealed answer envelope. Ciphertext; only the requester can read it. */
  static async answer(
    firebaseIdToken: string,
    requestId: string,
  ): Promise<unknown> {
    if (!firebaseIdToken) throw new Error("Sign in to open this answer");
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/answer`,
      {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      },
    );
    if (!response.ok) throw new Error("This answer is not available yet");
    const value = await readJson(response);
    if (!value.ciphertext || !value.iv || !value.recipientKeyId) {
      throw new Error("Invalid answer envelope");
    }
    return value;
  }

  /** Open hosted Checkout. Only ever returns a Stripe-hosted URL. */
  static async checkout(
    firebaseIdToken: string,
    requestId: string,
  ): Promise<string> {
    if (!firebaseIdToken) throw new Error("Sign in to pay");
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}/payment/checkout`,
      {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      },
    );
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
