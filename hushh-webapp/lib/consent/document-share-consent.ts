import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

export const DOCUMENT_SHARE_SOURCE = "drive_document_share_request";
const PREFIX = "document_share_request:";
export const DOCUMENT_REQUEST_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * This is a closed transport vocabulary, not a prefix convention. A newly
 * added backend event cannot gain client-side navigation merely by starting
 * with `document_share_`; it needs an explicit review here first.
 */
const DOCUMENT_SHARE_NOTIFICATION_TYPES = new Set([
  "document_share_request",
  "document_share_review_ready",
  "document_share_decided",
  "document_share_outcome",
  "document_share_revoked",
  "document_share_revocation_outcome",
]);

function notificationType(data: Record<string, unknown> | undefined): string {
  return typeof data?.type === "string" ? data.type.trim().toLowerCase() : "";
}

/** True for both known and unknown document-share-shaped push messages. */
export function isDocumentShareNotificationCandidate(
  data: Record<string, unknown> | undefined,
): boolean {
  return notificationType(data).startsWith("document_share_");
}

/** A typed push is accepted only when it belongs to the reviewed vocabulary. */
export function isDocumentShareNotificationType(
  data: Record<string, unknown> | undefined,
): boolean {
  return DOCUMENT_SHARE_NOTIFICATION_TYPES.has(notificationType(data));
}

/**
 * Push data is only a wake-up hint. The one opaque identifier that can select
 * a document review must be an exact UUID; names, recipient details, provider
 * links and arbitrary URLs never participate in routing.
 */
export function documentShareNotificationRequestId(
  data: Record<string, unknown> | undefined,
): string | null {
  if (!isDocumentShareNotificationType(data)) return null;
  const raw =
    typeof data?.request_id === "string" ? data.request_id.trim() : "";
  return DOCUMENT_REQUEST_UUID.test(raw) ? raw.toLowerCase() : null;
}

/** Recognition is deliberately broader than parsing so malformed rows fail closed. */
export function isDocumentShareEntry(
  entry: Pick<ConsentCenterEntry, "id" | "metadata">,
): boolean {
  return (
    entry.metadata?.request_source === DOCUMENT_SHARE_SOURCE ||
    entry.id.startsWith(PREFIX)
  );
}

export function documentShareRequestId(
  selected: string | null | undefined,
): string | null {
  if (!selected?.startsWith(PREFIX)) return null;
  const id = selected.slice(PREFIX.length);
  return DOCUMENT_REQUEST_UUID.test(id) ? id.toLowerCase() : null;
}

export function isDocumentShareSelection(
  selected: string | null | undefined,
): boolean {
  return !!selected?.startsWith(PREFIX);
}

export function documentShareSelectionId(entry: ConsentCenterEntry): string {
  return isDocumentShareEntry(entry) ? entry.id : entry.request_id || entry.id;
}
