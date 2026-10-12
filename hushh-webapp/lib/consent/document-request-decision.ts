import { documentShareRequestId } from "@/lib/consent/document-share-consent";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

/** What an inline Allow or Deny sends for one incoming document request. */
export interface OwnerDocumentDecision {
  /** Lowercase request UUID, parsed from the `document_share_request:` entry id. */
  requestId: string;
  /** The revision the decision is made against. Allow and Deny both send it. */
  revision: number;
  /** The requester pays before files are shared, so Allow asks for a price. */
  paymentRequired: boolean;
  /** Sets only a trusted request quote; it cannot grant independent consent. */
  priceOnly?: true;
}

/**
 * The server alone decides that the owner can answer this request now
 * (`owner_decision_available`: someone outside the Trusted circle, still
 * pending, nothing searched yet, Drive ready). The client only refuses an
 * entry it could not act on: the wrong lane, the wrong direction, or no
 * usable request id or revision.
 */
export function ownerDocumentDecision(
  entry: ConsentCenterEntry,
): OwnerDocumentDecision | null {
  if (entry.kind !== "incoming_request") return null;
  const metadata = entry.metadata;
  if (metadata?.direction !== "incoming") return null;
  const priceOnly = metadata.owner_price_available === true;
  if (metadata.owner_decision_available !== true && !priceOnly) return null;
  const revision = metadata.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return null;
  }
  const requestId = documentShareRequestId(entry.id);
  if (!requestId) return null;
  return {
    requestId,
    revision,
    paymentRequired: metadata.payment_required === true,
    ...(priceOnly ? { priceOnly: true as const } : {}),
  };
}

/** True only for an incoming document request the owner can Allow or Deny inline. */
export function isOwnerDecidableDocumentRequest(entry: ConsentCenterEntry): boolean {
  return ownerDocumentDecision(entry) !== null;
}
