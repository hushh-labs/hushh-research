import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";

export type DriveRequestPaymentStatus =
  | "not_required" | "preparing" | "awaiting_payment" | "checkout_open"
  | "paid" | "refunded" | "expired";

export interface DriveRequestPayment {
  status: DriveRequestPaymentStatus;
  amountCents: 0 | 1000;
  currency: "usd";
  reconciliationRequired?: boolean;
}

const CHECKOUT_HOSTS = new Set(["checkout.stripe.com", "checkout.stripe.dev"]);

function requestPath(requestId: string): string {
  if (!DOCUMENT_REQUEST_UUID.test(requestId)) throw new Error("Invalid request ID");
  return `/api/connectors/google_drive/sharing/requests/${requestId}/payment`;
}

async function paymentRequest(
  firebaseIdToken: string,
  requestId: string,
  checkout: boolean,
): Promise<Record<string, unknown>> {
  if (!firebaseIdToken) throw new Error("Sign in to view this payment");
  const response = await ApiService.apiFetch(
    `${requestPath(requestId)}${checkout ? "/checkout" : ""}`,
    {
      method: checkout ? "POST" : "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    },
  );
  if (!response.ok) throw new Error("Payment is unavailable. Try again.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid payment response");
  }
  return value as Record<string, unknown>;
}

export class DriveRequestPaymentService {
  static async status(firebaseIdToken: string, requestId: string): Promise<DriveRequestPayment> {
    const value = await paymentRequest(firebaseIdToken, requestId, false);
    if (
      !["not_required", "preparing", "awaiting_payment", "checkout_open", "paid", "refunded", "expired"].includes(String(value.status)) ||
      value.amountCents !== (value.status === "not_required" ? 0 : 1000) ||
      value.currency !== "usd"
      || (value.reconciliationRequired !== undefined && typeof value.reconciliationRequired !== "boolean")
    ) {
      throw new Error("Invalid payment response");
    }
    return value as unknown as DriveRequestPayment;
  }

  static async checkout(firebaseIdToken: string, requestId: string): Promise<string> {
    const value = await paymentRequest(firebaseIdToken, requestId, true);
    if (typeof value.checkoutUrl !== "string") throw new Error("Invalid checkout response");
    let url: URL;
    try { url = new URL(value.checkoutUrl); } catch { throw new Error("Invalid checkout response"); }
    if (url.protocol !== "https:" || !CHECKOUT_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
      throw new Error("Invalid checkout response");
    }
    return url.href;
  }
}
