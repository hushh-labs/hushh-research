import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import {
  approvedLocationCommitStrictlyMatches,
  locationCommitStrictlyMatches,
  prepareLocationPointForGrant,
  prepareLocationPointForSharing,
} from "@/lib/one-location/location-precision";
import {
  enableOneLocationAutomaticUpdates,
  readOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  ClientAction,
  LocationSharingMode,
  OneLocationAccessRequest,
  OneLocationGrant,
  ShareTarget,
} from "@/lib/one-location/types";
import { boundedLocationOperationId } from "@/lib/one-location/location-operation-id";
import {
  LOCATION_REVOCATION_PENDING_MESSAGE,
  pendingLocationRevocationGrantIds,
  revokeLocationGrantOrQueue,
  revokeLocationGrantsOrQueue,
} from "@/lib/one-location/location-revocation-queue";

const PAUSED_MESSAGE =
  "Location is paused on this device. Resume it before sharing a new point.";

export class PrivateLocationActionError extends Error {
  constructor(
    message: string,
    readonly successfulCount: number,
    readonly totalCount: number,
  ) {
    super(message);
    this.name = "PrivateLocationActionError";
  }
}

type PreparedTarget = {
  share: ShareTarget;
  legacyGrant: OneLocationGrant | null;
  recipientUserId: string;
  recipientKeyId: string;
  locationMode: LocationSharingMode;
  approximateRadiusM: number | null;
  envelope: Awaited<ReturnType<typeof encryptLocationForRecipient>>;
};

/**
 * Executes the coordinate-bearing half of a Location chat/agent proposal.
 * The agent contributes only ids and reviewed policy. This device sources the
 * recipient key from authenticated state, captures once, transforms the point,
 * encrypts per recipient, and commits grant + first envelope atomically.
 */
export async function executePrivateLocationAction({
  action,
  vaultOwnerToken,
  userId,
}: {
  action: ClientAction;
  vaultOwnerToken: string;
  userId: string | null | undefined;
}): Promise<{
  successfulCount: number;
  totalCount: number;
  failureDetails?: string[];
}> {
  if (action.type !== "publish_share") {
    throw new Error("This is not a private location-sharing action.");
  }
  const actionId = String(action.id || "").trim();
  const shares = action.shares ?? [];
  if (!actionId || !shares.length) {
    throw new Error("Location sharing proposal is incomplete.");
  }
  if (!userId) {
    throw new Error("Sign in again before sharing location.");
  }
  if (readOneLocationControlState(userId).paused) {
    throw new Error(PAUSED_MESSAGE);
  }

  const [point, state] = await Promise.all([
    OneLocationService.captureCurrentPosition(),
    OneLocationService.getState(vaultOwnerToken),
  ]);
  if (readOneLocationControlState(userId).paused) {
    throw new Error(PAUSED_MESSAGE);
  }
  // Read accuracy authorization after capture. iOS permission can be changed
  // while the prompt or app switch is in progress; a pre-capture snapshot
  // must never authorize a newly-downgraded precise share.
  const permission = await OneLocationService.getPermissionState();
  if (readOneLocationControlState(userId).paused) {
    throw new Error(PAUSED_MESSAGE);
  }

  const preparationResults = await Promise.allSettled(
    shares.map(async (share) => {
      const legacyGrant = share.grantId
        ? ((state.ownerGrants ?? []).find(
            (candidate) =>
              candidate.id === share.grantId &&
              candidate.status === "active" &&
              !pendingLocationRevocationGrantIds(userId).has(candidate.id),
          ) ?? null)
        : null;
      if (share.grantId && !legacyGrant) {
        throw new Error(
          `${share.label}'s location permission is no longer active`,
        );
      }

      const approvalRequest = share.approvalRequestId
        ? (state.requests ?? []).find(
            (request) =>
              request.id === share.approvalRequestId &&
              request.status === "pending",
          )
        : null;
      if (share.approvalRequestId && !approvalRequest) {
        throw new Error(`${share.label}'s request is no longer pending`);
      }
      const connectedRecipient = (state.recipients ?? []).find(
        (candidate) =>
          (Boolean(share.recipientKeyId) &&
            candidate.keyId === share.recipientKeyId) ||
          candidate.userId === share.recipientUserId,
      );
      const recipientUserId =
        approvalRequest?.requesterUserId ?? connectedRecipient?.userId;
      const recipientKeyId =
        approvalRequest?.requesterKeyId ?? connectedRecipient?.keyId;
      const recipientPublicKeyJwk =
        approvalRequest?.requesterPublicKeyJwk ??
        connectedRecipient?.publicKeyJwk;
      if (!recipientUserId || !recipientKeyId || !recipientPublicKeyJwk) {
        throw new Error(`${share.label} hasn't set up location sharing yet`);
      }

      const locationMode =
        share.locationMode ?? legacyGrant?.locationMode ?? "approximate";
      if (locationMode === "precise" && permission.precise === false) {
        throw new Error(
          "Turn on Precise Location in device settings to share a live location.",
        );
      }
      const sharePoint = legacyGrant
        ? prepareLocationPointForGrant(point, legacyGrant)
        : prepareLocationPointForSharing(point, locationMode);
      return {
        share,
        legacyGrant,
        recipientUserId,
        recipientKeyId,
        locationMode,
        approximateRadiusM: sharePoint.approximateRadiusM ?? null,
        envelope: await encryptLocationForRecipient({
          point: sharePoint,
          recipientPublicKeyJwk,
          recipientKeyId,
        }),
      };
    }),
  );
  const prepared: PreparedTarget[] = [];
  const failures: string[] = [];
  preparationResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      prepared.push(result.value);
      return;
    }
    const share = shares[index];
    const label = share?.label ?? "Recipient";
    const detail =
      result.reason instanceof Error
        ? result.reason.message
        : "location preparation failed";
    failures.push(
      detail.toLowerCase().startsWith(label.toLowerCase())
        ? detail
        : `${label}: ${detail}`,
    );
  });

  const confirmedAt = new Date().toISOString();
  const createdGrantIds: string[] = [];
  let successfulCount = 0;

  for (const target of prepared) {
    try {
      if (readOneLocationControlState(userId).paused) {
        throw new Error(PAUSED_MESSAGE);
      }
      if (target.legacyGrant) {
        if (
          readOneLocationControlState(userId).paused ||
          pendingLocationRevocationGrantIds(userId).has(target.legacyGrant.id)
        ) {
          throw new Error(LOCATION_REVOCATION_PENDING_MESSAGE);
        }
        await OneLocationService.storeEnvelope({
          vaultOwnerToken,
          grantId: target.legacyGrant.id,
          envelope: target.envelope,
        });
        successfulCount += 1;
        continue;
      }

      const operationId = boundedLocationOperationId(
        "location-action",
        actionId,
        target.share.approvalRequestId ?? target.recipientUserId,
      );
      const response = target.share.approvalRequestId
        ? await OneLocationService.approveRequest({
            vaultOwnerToken,
            requestId: target.share.approvalRequestId,
            durationHours: Number(target.share.durationHours) || 1,
            recipientKeyId: target.recipientKeyId,
            clientOperationId: operationId,
            confirmedAt,
            envelope: target.envelope,
            locationMode: target.locationMode,
            approximateRadiusM: target.approximateRadiusM,
          })
        : await OneLocationService.createGrantWithEnvelope({
            vaultOwnerToken,
            recipientUserId: target.recipientUserId,
            recipientKeyId: target.recipientKeyId,
            durationHours: Number(target.share.durationHours) || 4,
            clientOperationId: operationId,
            confirmedAt,
            envelope: target.envelope,
            reason: target.share.reason ?? undefined,
            shareKind: "share",
            locationMode: target.locationMode,
            approximateRadiusM: target.approximateRadiusM,
          });
      const responseMatches = target.share.approvalRequestId
        ? "request" in response &&
          approvedLocationCommitStrictlyMatches({
            requestId: target.share.approvalRequestId,
            request: response.request as OneLocationAccessRequest,
            grant: response.grant,
            envelope: response.envelope,
            locationMode: target.locationMode,
            approximateRadiusM: target.approximateRadiusM,
          })
        : locationCommitStrictlyMatches({
            grant: response.grant,
            envelope: response.envelope,
            locationMode: target.locationMode,
            approximateRadiusM: target.approximateRadiusM,
          });
      if (!responseMatches) {
        const revoked = await revokeLocationGrantOrQueue({
          userId,
          vaultOwnerToken,
          grantId: response.grant.id,
        });
        if (!revoked) {
          createdGrantIds.push(response.grant.id);
          successfulCount += 1;
          failures.push(
            `${target.share.label}: ${LOCATION_REVOCATION_PENDING_MESSAGE}`,
          );
          continue;
        }
        throw new Error(
          "The server did not atomically preserve the location approval you reviewed.",
        );
      }
      createdGrantIds.push(response.grant.id);
      successfulCount += 1;
    } catch (error) {
      failures.push(
        error instanceof Error
          ? `${target.share.label}: ${error.message}`
          : `${target.share.label}: sharing failed`,
      );
    }
  }

  if (successfulCount > 0) {
    const updates = enableOneLocationAutomaticUpdates(userId);
    if (!updates.allowed) {
      const rollback = await revokeLocationGrantsOrQueue({
        userId,
        vaultOwnerToken,
        grantIds: createdGrantIds,
      });
      successfulCount = Math.max(
        0,
        successfulCount - rollback.revokedGrantIds.length,
      );
      throw new PrivateLocationActionError(
        rollback.pendingGrantIds.length
          ? LOCATION_REVOCATION_PENDING_MESSAGE
          : PAUSED_MESSAGE,
        successfulCount,
        shares.length,
      );
    }
  }

  if (failures.length) {
    if (successfulCount > 0) {
      return {
        successfulCount,
        totalCount: shares.length,
        failureDetails: failures,
      };
    }
    throw new PrivateLocationActionError(
      failures.join(" "),
      successfulCount,
      shares.length,
    );
  }
  return { successfulCount, totalCount: shares.length };
}
