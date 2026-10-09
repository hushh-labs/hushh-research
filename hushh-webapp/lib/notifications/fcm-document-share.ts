import {
  documentShareNotificationCopy,
  documentShareNotificationRequestId,
  isDocumentShareNotificationCandidate,
  isDocumentShareNotificationType,
} from "@/lib/consent/document-share-consent";

export function normalizedDocumentShareType(
  data: Record<string, unknown> | undefined,
): string {
  return typeof data?.type === "string" ? data.type.trim().toLowerCase() : "";
}

/**
 * A Drive-sharing transport payload is deliberately reduced before it crosses
 * the FCM boundary. The route is derived from the reviewed UUID alone; all
 * provider URLs and content fields are discarded.
 */
export function sanitizeDocumentShareNotificationData(
  data: Record<string, unknown> | undefined,
): Record<string, string> | null {
  // Even an unknown `document_share_*` payload must not reach logs or UI
  // unchanged. It remains unacknowledged by the Consent provider below, but
  // the transport boundary still reduces it to the non-sensitive type.
  if (!isDocumentShareNotificationCandidate(data)) return null;

  const safe: Record<string, string> = {
    type: normalizedDocumentShareType(data),
  };
  if (!isDocumentShareNotificationType(data)) return safe;
  const requestId = documentShareNotificationRequestId(data);
  if (requestId) safe.request_id = requestId;

  // Retain only the addressed identity for the existing signed-in-user fence.
  // It is never rendered, logged here, or used to construct a URL.
  const userId = typeof data?.user_id === "string" ? data.user_id.trim() : "";
  if (userId && userId.length <= 128) safe.user_id = userId;
  return safe;
}

export function sanitizeDocumentShareNotificationDetail<T>(detail: T): T {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return detail;
  }
  const record = detail as Record<string, unknown>;
  const data =
    record.data &&
    typeof record.data === "object" &&
    !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : record.notification &&
          typeof record.notification === "object" &&
          !Array.isArray(record.notification) &&
          (record.notification as Record<string, unknown>).data &&
          typeof (record.notification as Record<string, unknown>).data ===
            "object" &&
          !Array.isArray((record.notification as Record<string, unknown>).data)
        ? ((record.notification as Record<string, unknown>).data as Record<
            string,
            unknown
          >)
        : undefined;
  const safeData = sanitizeDocumentShareNotificationData(data);
  if (!safeData) return detail;

  const notification =
    record.notification &&
    typeof record.notification === "object" &&
    !Array.isArray(record.notification)
      ? {
          ...(record.notification as Record<string, unknown>),
          data: safeData,
          ...documentShareNotificationCopy(safeData),
        }
      : record.notification;
  return {
    ...record,
    data: safeData,
    ...(notification ? { notification } : {}),
  } as T;
}
