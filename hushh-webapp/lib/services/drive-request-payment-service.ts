import { traceDriveRequest } from "@/lib/consent/drive-request-diagnostics";
import { parseDrivePackageDisclosure, type DrivePackageDisclosure } from "@/lib/consent/drive-package-disclosure";
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";
import { ApiService } from "@/lib/services/api-service";

export type DriveRequestPaymentStatus =
  | "not_required" | "preparing" | "awaiting_payment" | "checkout_open"
  | "paid" | "refunded" | "expired";

export interface DriveRequestPayment {
  status: DriveRequestPaymentStatus;
  /** Null while the owner must set a price; 0 only when payment is not required. */
  amountCents: number | null;
  currency: "usd";
  ownerPriceRequired?: boolean;
  ownerPayoutAccountReady?: boolean;
  paymentsReady?: boolean;
  reconciliationRequired?: boolean;
  paymentLinkExpired?: boolean;
  checkoutExpiresAt?: string | null;
  packageDisclosureRequired?: boolean;
  packageDisclosure?: DrivePackageDisclosure | null;
}

export class DriveRequestPaymentError extends Error {
  constructor(readonly code: "request_already_accessible" | "package_existing_access_requires_review") {
    super(code === "request_already_accessible"
      ? "You already have access. No payment was taken."
      : "You already have access to part of this packet. Checkout is paused.");
    this.name = "DriveRequestPaymentError";
  }
}

export function drivePaymentErrorMessage(cause: unknown): string {
  return cause instanceof DriveRequestPaymentError
    ? cause.message : "Checkout couldn't open. Try again.";
}

const CHECKOUT_HOSTS = new Set(["checkout.stripe.com", "checkout.stripe.dev"]);

function validPaymentAmount(status: unknown, amountCents: unknown, ownerPriceRequired: unknown): boolean {
  if (amountCents === null) {
    return (status === "preparing" || status === "expired") && ownerPriceRequired === true;
  }
  return status === "not_required" ? amountCents === 0 : isValidDocumentRequestPriceCents(amountCents);
}

function requestPath(requestId: string): string {
  if (!DOCUMENT_REQUEST_UUID.test(requestId)) throw new Error("Invalid request ID");
  return `/api/connectors/google_drive/sharing/requests/${requestId}/payment`;
}

async function paymentRequest(
  firebaseIdToken: string,
  requestId: string,
  checkout: boolean,
  acceptance?: { acceptedTermsRevision: number; acceptedTermsDigest: string; acceptedPackageDigest: string },
): Promise<Record<string, unknown>> {
  if (!firebaseIdToken) throw new Error("Sign in to view this payment");
  const target = `${requestPath(requestId)}${checkout ? "/checkout" : ""}`;
  return traceDriveRequest(target, checkout ? "POST" : "GET", async (diagnosticHeaders, observe) => {
    const response = await ApiService.apiFetch(
      `${requestPath(requestId)}${checkout ? "/checkout" : ""}`,
      {
        method: checkout ? "POST" : "GET",
        cache: "no-store",
        headers: { ...diagnosticHeaders, Authorization: `Bearer ${firebaseIdToken}`, ...(acceptance ? { "Content-Type": "application/json" } : {}) },
        ...(acceptance ? { body: JSON.stringify(acceptance) } : {}),
      },
    );
    observe(response);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      observe(response, body);
      const detail = body && typeof body === "object" && "detail" in body ? body.detail : null;
      const code = detail && typeof detail === "object" && "code" in detail ? detail.code : null;
      if (response.status === 409 && (code === "request_already_accessible" || code === "package_existing_access_requires_review")) {
        throw new DriveRequestPaymentError(code);
      }
      throw new Error("Payment is unavailable. Try again.");
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid payment response");
    }
    observe(response, value);
    return value as Record<string, unknown>;
  });
}

export class DriveRequestPaymentService {
  static async status(firebaseIdToken: string, requestId: string): Promise<DriveRequestPayment> {
    const value = await paymentRequest(firebaseIdToken, requestId, false);
    if (
      !["not_required", "preparing", "awaiting_payment", "checkout_open", "paid", "refunded", "expired"].includes(String(value.status)) ||
      !validPaymentAmount(value.status, value.amountCents, value.ownerPriceRequired) ||
      value.currency !== "usd"
      || (value.ownerPriceRequired !== undefined && typeof value.ownerPriceRequired !== "boolean")
      || (value.ownerPayoutAccountReady !== undefined && typeof value.ownerPayoutAccountReady !== "boolean")
      || (value.paymentsReady !== undefined && typeof value.paymentsReady !== "boolean")
      || (value.reconciliationRequired !== undefined && typeof value.reconciliationRequired !== "boolean")
      || (value.paymentLinkExpired !== undefined && typeof value.paymentLinkExpired !== "boolean")
      || (value.checkoutExpiresAt !== undefined
        && value.checkoutExpiresAt !== null
        && typeof value.checkoutExpiresAt !== "string")
    ) {
      throw new Error("Invalid payment response");
    }
    if (value.packageDisclosureRequired !== undefined && typeof value.packageDisclosureRequired !== "boolean")
      throw new Error("Invalid payment response");
    if (value.packageDisclosure != null) {
      const disclosure = parseDrivePackageDisclosure(value.packageDisclosure);
      if (!disclosure) throw new Error("Invalid payment response");
      value.packageDisclosure = disclosure;
    }
    return value as unknown as DriveRequestPayment;
  }

  static async checkout(firebaseIdToken: string, requestId: string, acceptance?: { acceptedTermsRevision: number; acceptedTermsDigest: string; acceptedPackageDigest: string }): Promise<string | { requestId: string; existingAccess: true }> {
    const value = await paymentRequest(firebaseIdToken, requestId, true, acceptance);
    if (value.existingAccess === true && value.requestId === requestId && value.checkoutUrl === undefined) {
      return { requestId, existingAccess: true };
    }
    if (value.existingAccess !== undefined) throw new Error("Invalid checkout response");
    if (typeof value.checkoutUrl !== "string") throw new Error("Invalid checkout response");
    let url: URL;
    try { url = new URL(value.checkoutUrl); } catch { throw new Error("Invalid checkout response"); }
    if (url.protocol !== "https:" || !CHECKOUT_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
      throw new Error("Invalid checkout response");
    }
    return url.href;
  }
}
