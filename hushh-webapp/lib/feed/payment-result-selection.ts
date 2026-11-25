import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import type { FeedItem } from "@/lib/services/feed-service";

const RECEIPT_EVENTS = new Set(["document_share_payment_confirmed", "document_share_payment_refunded"]);
export type FeedPaymentSelection = { requestId: string; audience: "owner" | "requester" };

/** Only a payment-only search match selects a receipt. A person-only match
 * continues to open the workflow's current request or delivery. */
export function isFeedPaymentMatch(item: FeedItem): boolean {
  const requestId = item.metadata.request_id;
  return typeof requestId === "string" && DOCUMENT_REQUEST_UUID.test(requestId) &&
    item.activity_group_id === `document:${requestId}` &&
    Boolean(item.search_events?.length) && item.search_events!.every(event => RECEIPT_EVENTS.has(event));
}

/** A search hint is a selection, never payment or participant authority. */
export function feedPaymentSelection(original: FeedItem, current: FeedItem): FeedPaymentSelection | null {
  if (!isFeedPaymentMatch(original)) return null;
  const requestId = original.metadata.request_id as string;
  if (current.metadata.request_id !== requestId || current.activity_group_id !== `document:${requestId}`) return null;
  const audience = current.metadata.feed_audience;
  return audience === "owner" ? { requestId, audience } : audience === "recipient" || audience === "requester" ? { requestId, audience: "requester" } : null;
}
