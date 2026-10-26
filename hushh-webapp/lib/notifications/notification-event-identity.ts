export function notificationEventDedupKey(
  msgType: string | undefined,
  data: Record<string, string>,
): string | null {
  const normalizedType = String(msgType || "unknown").trim() || "unknown";
  const messageId = String(data.message_id || "").trim();
  if (messageId) return `${normalizedType}:message:${messageId}`;

  const revision = String(
    data.notification_revision ||
      data.notification_sequence ||
      data.request_revision ||
      "",
  ).trim();
  const entityId = String(
    data.request_id ||
      data.bundle_id ||
      data.grant_id ||
      data.approved_grant_id ||
      data.submission_id ||
      data.referral_id ||
      data.connection_id ||
      data.invite_id ||
      data.transfer_id ||
      data.notification_tag ||
      "",
  ).trim();

  // An entity id identifies the subject, not the delivery. Repeated valid
  // events can target the same grant/request, so only pair it with an explicit
  // producer revision or sequence when suppressing a replay.
  if (!revision || !entityId) return null;
  return `${normalizedType}:entity:${entityId}:revision:${revision}`;
}
