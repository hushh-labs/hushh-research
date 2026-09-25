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
  // Drive questions (drive_query_events): their request_id is a question.
  "document_share_question",
  "document_share_answered",
  "document_share_declined",
]);

const DRIVE_QUESTION_NOTIFICATION_TYPES = new Set([
  "document_share_question",
  "document_share_answered",
  "document_share_declined",
]);

/**
 * Fixed local copy per reviewed type; never a file name, person, purpose or
 * provider text. Keep aligned with the backend worker and the web worker.
 */
export const DOCUMENT_SHARE_NOTIFICATION_COPY_BY_TYPE: Readonly<
  Record<string, { title: string; body: string }>
> = {
  document_share_request: {
    title: "Document request",
    body: "Open One to review.",
  },
  document_share_review_ready: {
    title: "Files ready to review",
    body: "Open One to choose what to share.",
  },
  document_share_decided: {
    title: "Drive sharing update",
    body: "Open One to see the latest.",
  },
  document_share_outcome: {
    title: "Drive sharing finished",
    body: "Open One to see the shared files.",
  },
  document_share_revoked: {
    title: "Drive access changed",
    body: "Open One to see what changed.",
  },
  document_share_revocation_outcome: {
    title: "Drive access changed",
    body: "Open One to see what changed.",
  },
  document_share_question: {
    title: "Drive question",
    body: "Someone asked about your Drive. Open One to review.",
  },
  document_share_answered: {
    title: "Drive question answered",
    body: "Open One to see the answer.",
  },
  document_share_declined: {
    title: "Drive question declined",
    body: "Open One for details.",
  },
};

const DOCUMENT_SHARE_GENERIC_COPY = {
  title: "Document request",
  body: "Open One to review.",
} as const;

/** Copy for a push: reviewed types get their own words, anything else the generic line. */
export function documentShareNotificationCopy(
  data: Record<string, unknown> | undefined,
): { title: string; body: string } {
  return (
    DOCUMENT_SHARE_NOTIFICATION_COPY_BY_TYPE[notificationType(data)] ??
    DOCUMENT_SHARE_GENERIC_COPY
  );
}

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

/**
 * The Consent Center selection a reviewed push opens: a Drive question's card
 * for question types, otherwise the document share request.
 */
export function documentShareNotificationSelection(
  data: Record<string, unknown> | undefined,
): string | null {
  const requestId = documentShareNotificationRequestId(data);
  if (!requestId) return null;
  return DRIVE_QUESTION_NOTIFICATION_TYPES.has(notificationType(data))
    ? `drive_query_request:${requestId}`
    : `${PREFIX}${requestId}`;
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
