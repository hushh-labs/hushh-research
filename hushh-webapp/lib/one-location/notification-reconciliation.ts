import type {
  OneLocationAccessRequest,
  OneLocationNetworkConnection,
  OneLocationRecipient,
  OneLocationState,
} from "@/lib/one-location/types";
import {
  buildOneLocationWorkflowHref,
  ONE_LOCATION_SMS_EMERGENCY_CATEGORY,
  ONE_LOCATION_SMS_EMERGENCY_PROFILE,
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

/**
 * Copy the ask — how much time, whether it is extra time on a live share, and
 * how much of that share is left — onto a notification payload.
 *
 * `notification_revision` is what makes a raised ask a NEW notification. The
 * provider de-duplicates by (type, id), so a person who asked for an hour and
 * then for four would otherwise have their second ask silently swallowed and
 * the owner would sit looking at the first number.
 */
function addAskValues(
  payload: OneLocationNotificationPayload,
  request: OneLocationAccessRequest,
): void {
  addValue(payload, "requested_duration_hours", request.requestedDurationHours);
  addValue(payload, "requested_duration_mode", request.requestedDurationMode);
  addValue(payload, "extends_grant_id", request.extendsGrantId);
  addValue(payload, "extends_grant_expires_at", request.extendsGrantExpiresAt);
  if (request.isExtension || request.extendsGrantId) {
    addValue(payload, "is_extension", "true");
  }
  if (Number(request.requestRevision) > 1) {
    addValue(payload, "notification_revision", request.requestRevision);
  }
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
  return connection.userAId === userId
    ? connection.userBId
    : connection.userAId;
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
    const payload: OneLocationNotificationPayload = {
      type: "location_share_created",
    };
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
    addValue(payload, "duration_mode", grant.durationMode);
    addValue(payload, "share_kind", grant.shareKind);
    addValue(payload, "share_message", grant.shareMessage);
    if (grant.shareKind === "sos") {
      addValue(
        payload,
        "notification_profile",
        ONE_LOCATION_SMS_EMERGENCY_PROFILE,
      );
      addValue(
        payload,
        "notification_category",
        ONE_LOCATION_SMS_EMERGENCY_CATEGORY,
      );
    }
    payloads.push(payload);
  }

  for (const request of state.requests ?? []) {
    if (
      request.ownerUserId === normalizedUserId &&
      request.status === "pending"
    ) {
      const payload: OneLocationNotificationPayload = {
        type: "location_access_request",
      };
      addValue(payload, "request_id", request.id);
      addValue(payload, "requester_user_id", request.requesterUserId);
      addValue(
        payload,
        "requester_display_label",
        request.requesterDisplayName ||
          recipientLabel(recipients, request.requesterUserId, "Someone"),
      );
      // The ask itself. Without these the owner's popup says only that somebody
      // wants their location, whether they asked for fifteen minutes or a day.
      addAskValues(payload, request);
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
      const payload: OneLocationNotificationPayload = {
        type: "location_access_approved",
      };
      addValue(payload, "request_id", request.id);
      addValue(payload, "grant_id", request.approvedGrantId);
      addValue(payload, "owner_user_id", request.ownerUserId);
      addValue(payload, "owner_display_label", ownerLabel);
      addAskValues(payload, request);
      const approvedGrant = (state.receivedGrants ?? []).find(
        (grant) => grant.id === request.approvedGrantId,
      );
      if (request.isExtension || request.extendsGrantId) {
        // The grant's own duration is its new TOTAL remaining time, not how
        // much this approval added -- showing that as "X more" is the bug
        // this guards against. The request already carries the extra amount
        // that was asked for (and, absent an owner override this app has no
        // control for yet, actually granted), so that is the true number.
        addValue(payload, "duration_hours", request.requestedDurationHours);
      } else if (approvedGrant) {
        // No baseline to subtract on a fresh share: the grant's total *is*
        // what was granted, read off the grant since an owner is free to
        // give less than was asked.
        addValue(payload, "duration_hours", approvedGrant.durationHours);
      }
      if (approvedGrant) {
        addValue(payload, "duration_mode", approvedGrant.durationMode);
        addValue(payload, "expires_at", approvedGrant.expiresAt);
      }
      payloads.push(payload);
    } else if (request.status === "denied") {
      const payload: OneLocationNotificationPayload = {
        type: "location_access_denied",
      };
      addValue(payload, "request_id", request.id);
      addValue(payload, "owner_user_id", request.ownerUserId);
      addValue(payload, "owner_display_label", ownerLabel);
      addAskValues(payload, request);
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
    if (
      referral.referredUserId !== normalizedUserId ||
      referral.status !== "pending"
    )
      continue;
    const payload: OneLocationNotificationPayload = {
      type: "location_referral_invite",
    };
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

  for (const invite of state.circleMemberInvites ?? []) {
    if (
      invite.inviteeUserId !== normalizedUserId ||
      invite.status !== "pending"
    ) {
      continue;
    }
    const payload: OneLocationNotificationPayload = {
      type: "location_circle_member_invite",
    };
    addValue(payload, "invite_id", invite.id);
    addValue(payload, "circle_id", invite.circleId);
    addValue(payload, "circle_name", invite.circleName);
    addValue(payload, "inviter_user_id", invite.inviterUserId);
    addValue(
      payload,
      "inviter_display_label",
      invite.inviterDisplayName ||
        recipientLabel(recipients, invite.inviterUserId, "A connection"),
    );
    addValue(
      payload,
      "deep_link",
      buildOneLocationWorkflowHref({
        circleInviteId: invite.id,
        section: "people",
      }),
    );
    payloads.push(payload);
  }

  for (const connection of state.networkConnections ?? []) {
    if (
      connection.status !== "active" ||
      (connection.userAId !== normalizedUserId &&
        connection.userBId !== normalizedUserId)
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
