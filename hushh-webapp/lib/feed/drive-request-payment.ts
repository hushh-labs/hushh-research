import { documentShareRequestId, isDocumentShareEntry } from "@/lib/consent/document-share-consent";
import { parseConsentInstant } from "@/lib/consent/consent-owner-copy";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

export interface FeedDrivePayment {
  requestId: string;
  title: string;
  description: string;
  requestedAt: number | null;
}

/** The outgoing server projection is the discovery authority, including after an app restart. */
export function projectFeedDrivePayments(entries: ConsentCenterEntry[]): FeedDrivePayment[] {
  const byRequest = new Map<string, FeedDrivePayment>();
  for (const entry of entries) {
    if (!isDocumentShareEntry(entry)) continue;
    const requestId = documentShareRequestId(entry.id);
    if (!requestId || entry.kind !== "outgoing_request" || entry.status !== "pending") continue;
    if (entry.metadata?.direction !== "outgoing") continue;
    if (
      (entry.metadata.paymentStatus !== "awaiting_payment" && entry.metadata.paymentStatus !== "checkout_open") ||
      entry.metadata.paymentAmountCents !== 1000 ||
      entry.metadata.paymentCurrency !== "usd"
    ) continue;
    byRequest.set(requestId, {
      requestId,
      title: "Pay $10 for your document request",
      description: "Your Trusted Circle request is ready. Pay $10 to continue sharing.",
      requestedAt: parseConsentInstant(entry.issued_at),
    });
  }
  return [...byRequest.values()].sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
}
