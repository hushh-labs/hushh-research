import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import {
  DOCUMENT_REQUEST_UUID,
  isDocumentShareEntry,
} from "@/lib/consent/document-share-consent";

export const DRIVE_QUERY_SOURCE = "drive_live_query_request";
export const DRIVE_QUERY_ACTION = "DRIVE_QUERY_REVIEW";
const PREFIX = "drive_query_request:";

export function driveQuerySelection(requestId: string): string {
  return `${PREFIX}${requestId}`;
}

/**
 * A question about someone's Drive is decided only by its own card. Recognition
 * is deliberately broader than parsing so a malformed row fails closed instead
 * of reaching the generic consent approve/deny path.
 */
export function isDriveQueryEntry(
  entry: Pick<ConsentCenterEntry, "id" | "action" | "metadata">,
): boolean {
  return (
    entry.metadata?.request_source === DRIVE_QUERY_SOURCE ||
    entry.action === DRIVE_QUERY_ACTION ||
    entry.id.startsWith(PREFIX)
  );
}

export function isDriveQuerySelection(
  selected: string | null | undefined,
): boolean {
  return !!selected?.startsWith(PREFIX);
}

export function driveQueryRequestId(
  selected: string | null | undefined,
): string | null {
  if (!selected?.startsWith(PREFIX)) return null;
  const id = selected.slice(PREFIX.length);
  return DOCUMENT_REQUEST_UUID.test(id) ? id.toLowerCase() : null;
}

/** Document requests and Drive questions: never a PKM grant or decision. */
export function isDriveSharingEntry(
  entry: Pick<ConsentCenterEntry, "id" | "action" | "metadata">,
): boolean {
  return isDocumentShareEntry(entry) || isDriveQueryEntry(entry);
}

export function driveSharingSelectionId(entry: ConsentCenterEntry): string {
  return isDriveSharingEntry(entry) ? entry.id : entry.request_id || entry.id;
}
