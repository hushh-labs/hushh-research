import type {
  OneLocationNetworkConnection,
  OneLocationRecipient,
  OneLocationState,
} from "@/lib/one-location/types";
import {
  privacySafeOneLocationNotificationLabel,
  type OneLocationWorkflowNotificationType,
} from "@/lib/one-location/notifications";

export type OneLocationNotificationPayload = Record<string, string> & {
  type: OneLocationWorkflowNotificationType;
};

type ReconciliationOptions = {
  isGrantUnwatched?: (grantId: string) => boolean;
};

function addValue(
  payload: OneLocationNotificationPayload,
  key: string,
  value: string | number | null | undefined,
): void {
  const normalized = String(value ?? "").trim();
  if (normalized) payload[key] = normalized;
}

function recipientLabel(
  recipients: OneLocationRecipient[],
  userId: string,
  fallback: string,
): string {
  return privacySafeOneLocationNotificationLabel(
    recipients.find((recipient) => recipient.userId === userId)?.displayName,
    fallback,
  );
}

function networkCounterpartyId(
  connection: OneLocationNetworkConnection,
  userId: string,
): string {
  return connection.userAId === userId ? connection.userBId : connection.userAId;
}

export function buildOneLocationNotificationPayloads(
  state: OneLocationState,
  userId: string,
  options: ReconciliationOptions = {},
): OneLocationNotificationPayload[] {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return [];

  const payloads: OneLocationNotificationPayload[] = [];
  const recipients = state.recipients ?? [];
  const approvedGrantIds = new Set(
    (state.requests ?? [])
      .filter(
        (request) =>
          request.requesterUserId === normalizedUserId &&
          request.status === "approved",
      )
      .map((request) => String(request.approvedGrantId || "").trim())
      .filter(Boolean),
  );
  const activeOwnerIds = new Set(
    (state.receivedGrants ?? [])
      .filter((grant) => grant.status === "active")
      .map((grant) => String(grant.ownerUserId || "").trim())
      .filter(Boolean),
  );

  for (const grant of state.receivedGrants ?? []) {
    if (
      grant.status !== "active" ||
      approvedGrantIds.has(grant.id) ||
      // SMS grants are created immediately before their first encrypted
      // envelope. Do not tell the recipient that live location is available
      // until the backend has durably linked that first envelope.
      (grant.shareKind === "sos" && !grant.latestEnvelopeId) ||
      options.isGrantUnwatched?.(grant.id)
    ) {
      continue;
    }
    const payload: OneLocationNotificationPayload = { type: "location_share_created" };
    addValue(payload, "grant_id", grant.id);
    addValue(payload, "owner_user_id", grant.ownerUserId);
    addValue(
      payload,
      "owner_display_label",
      privacySafeOneLocationNotificationLabel(
        grant.ownerDisplayName ||
          recipientLabel(recipients, grant.ownerUserId, "A trusted person"),
      ),
    );
    addValue(payload, "expires_at", grant.expiresAt);
    addValue(payload, "duration_hours", grant.durationHours);
    addValue(payload, "share_kind", grant.shareKind);
    addValue(payload, "share_message", grant.shareMessage);
    payloads.push(payload);
  }

  for (const request of state.requests ?? []) {
    if (request.ownerUserId === normalizedUserId && request.status === "pending") {
      const payload: OneLocationNotificationPayload = { type: "location_access_request" };
      addValue(payload, "request_id", request.id);
      addValue(payload, "requester_user_id", request.requesterUserId);
      addValue(
        payload,
        "requester_display_label",
        request.requesterDisplayName ||
          recipientLabel(recipients, request.requesterUserId, "Someone"),
      );
      payloads.push(payload);
      continue;
    }

    if (
      request.requesterUserId !== normalizedUserId ||
      request.ownerUserId === normalizedUserId
    ) {
      continue;
    }

    const ownerLabel = recipientLabel(
      recipients,
      request.ownerUserId,
      "Location owner",
    );
    if (request.status === "approved" && request.approvedGrantId) {
      const payload: OneLocationNotificationPayload = { type: "location_access_approved" };
      addValue(payload, "request_id", request.id);
      addValue(payload, "grant_id", request.approvedGrantId);
      addValue(payload, "owner_user_id", request.ownerUserId);
      addValue(payload, "owner_display_label", ownerLabel);
      payloads.push(payload);
    } else if (request.status === "denied") {
      const payload: OneLocationNotificationPayload = { type: "location_access_denied" };
      addValue(payload, "request_id", request.id);
      addValue(payload, "owner_user_id", request.ownerUserId);
      addValue(payload, "owner_display_label", ownerLabel);
      payloads.push(payload);
    }
  }

  for (const grant of state.receivedGrants ?? []) {
    if (
      (grant.status !== "revoked" && grant.status !== "expired") ||
      activeOwnerIds.has(String(grant.ownerUserId || "").trim()) ||
      options.isGrantUnwatched?.(grant.id)
    ) {
      continue;
    }
    const payload: OneLocationNotificationPayload = {
      type:
        grant.status === "revoked"
          ? "location_share_revoked"
          : "location_share_expired",
    };
    addValue(payload, "grant_id", grant.id);
    addValue(payload, "owner_user_id", grant.ownerUserId);
    addValue(
      payload,
      "owner_display_label",
      grant.ownerDisplayName ||
        recipientLabel(recipients, grant.ownerUserId, "A trusted person"),
    );
    payloads.push(payload);
  }

  for (const referral of state.referrals ?? []) {
    if (referral.referredUserId !== normalizedUserId || referral.status !== "pending") continue;
    const payload: OneLocationNotificationPayload = { type: "location_referral_invite" };
    addValue(payload, "referral_id", referral.id);
    addValue(payload, "request_id", referral.requestId);
    addValue(payload, "grant_id", referral.grantId);
    addValue(payload, "owner_user_id", referral.ownerUserId);
    addValue(
      payload,
      "owner_display_label",
      recipientLabel(recipients, referral.ownerUserId, "Location owner"),
    );
    addValue(payload, "referring_user_id", referral.referringUserId);
    addValue(
      payload,
      "referring_display_label",
      recipientLabel(recipients, referral.referringUserId, "A trusted person"),
    );
    payloads.push(payload);
  }

  for (const submission of state.publicInviteSubmissions ?? []) {
    if (submission.ownerUserId !== normalizedUserId) continue;
    const payload: OneLocationNotificationPayload = {
      type: "location_public_invite_submitted",
    };
    addValue(payload, "submission_id", submission.id);
    addValue(payload, "request_id", submission.requestId);
    addValue(payload, "visitor_display_label", submission.visitorDisplayName);
    payloads.push(payload);
  }

  for (const connection of state.networkConnections ?? []) {
    if (
      connection.status !== "active" ||
      (connection.userAId !== normalizedUserId && connection.userBId !== normalizedUserId)
    ) {
      continue;
    }
    const counterpartId = networkCounterpartyId(connection, normalizedUserId);
    const payload: OneLocationNotificationPayload = {
      type: "location_one_network_joined",
    };
    addValue(payload, "connection_id", connection.id);
    addValue(payload, "invite_id", connection.inviteId);
    addValue(payload, "network_user_id", counterpartId);
    addValue(
      payload,
      "network_display_label",
      recipientLabel(recipients, counterpartId, "A trusted person"),
    );
    payloads.push(payload);
  }

  return payloads;
}
