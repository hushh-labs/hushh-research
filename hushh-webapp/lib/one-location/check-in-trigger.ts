import { OneLocationService } from "@/lib/one-location/service";
import { locationCommitStrictlyMatches } from "@/lib/one-location/location-precision";
import { boundedLocationOperationId } from "@/lib/one-location/location-operation-id";
import {
  assertLocationActionNotPaused,
  assertPreciseLocationActionAllowed,
} from "@/lib/one-location/location-action-guard";
import {
  enableOneLocationAutomaticUpdates,
  readOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import { createRequestId } from "@/lib/observability/request-id";
import type {
  OneLocationEncryptedEnvelope,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import type { SosShareReadyRecipient } from "@/lib/one-location/sos-trigger";

export interface RunCheckInParams {
  userId: string;
  vaultOwnerToken: string;
  /** Only share-ready recipients — caller pre-filters with isSosShareReadyRecipient. */
  recipients: SosShareReadyRecipient[];
  point: PlainLocationPoint;
  durationHours: number;
  note?: string | null;
  operationId?: string;
  prepareEnvelope: (
    recipient: SosShareReadyRecipient,
    point: PlainLocationPoint,
  ) => Promise<OneLocationEncryptedEnvelope>;
}

/** Non-emergency check-in: bounded share to the user's ready trusted contacts.
 * Unlike SOS it uses a caller-chosen duration + note and records no SOS incident. */
export async function runCheckIn(params: RunCheckInParams): Promise<string[]> {
  const {
    userId,
    vaultOwnerToken,
    recipients,
    point,
    durationHours,
    note,
    prepareEnvelope,
  } = params;
  if (!recipients.length) throw new Error("No check-in recipients provided.");
  assertLocationActionNotPaused(userId);
  const reason = (note ?? "").trim() || "Checking in";
  const confirmedAt = new Date().toISOString();
  const operationId = params.operationId?.trim() || createRequestId();
  const grantIds: string[] = [];
  const failures: string[] = [];
  for (const recipient of recipients) {
    try {
      await assertPreciseLocationActionAllowed(userId);
      const envelope = await prepareEnvelope(recipient, point);
      await assertPreciseLocationActionAllowed(userId);
      const response = await OneLocationService.createGrantWithEnvelope({
        vaultOwnerToken,
        recipientUserId: recipient.userId,
        recipientKeyId: recipient.keyId,
        durationHours,
        clientOperationId: boundedLocationOperationId(
          "check-in",
          operationId,
          recipient.userId,
        ),
        confirmedAt,
        envelope,
        reason,
        shareKind: "check_in",
        locationMode: "precise",
        approximateRadiusM: null,
      });
      if (
        !locationCommitStrictlyMatches({
          grant: response.grant,
          envelope: response.envelope,
          locationMode: "precise",
          approximateRadiusM: null,
        })
      ) {
        const grantId = response?.grant?.id;
        if (grantId) {
          await OneLocationService.revokeGrant({
            vaultOwnerToken,
            grantId,
          }).catch(() => undefined);
        }
        throw new Error(
          "The server did not atomically preserve this private check-in.",
        );
      }
      grantIds.push(response.grant.id);
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "Private check-in failed.",
      );
      if (readOneLocationControlState(userId).paused) break;
    }
  }
  if (readOneLocationControlState(userId).paused) {
    await Promise.allSettled(
      grantIds.map((grantId) =>
        OneLocationService.revokeGrant({ vaultOwnerToken, grantId }),
      ),
    );
    throw new Error("Location was paused before check-in completed.");
  }
  if (!grantIds.length) {
    throw new Error(failures[0] ?? "Private check-in failed.");
  }
  const updates = enableOneLocationAutomaticUpdates(userId);
  if (!updates.allowed) {
    await Promise.allSettled(
      grantIds.map((grantId) =>
        OneLocationService.revokeGrant({ vaultOwnerToken, grantId }),
      ),
    );
    throw new Error("Location was paused before check-in updates could start.");
  }
  return grantIds;
}
