import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

export const DOCUMENT_SHARE_SOURCE = "drive_document_share_request";
const PREFIX = "document_share_request:";
export const DOCUMENT_REQUEST_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
