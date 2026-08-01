/**
 * Reusable, testable SOS-panic core that is shared between:
 *   - The manual SOS button (app/one/location/page.tsx → handleTriggerSos)
 *   - The upcoming chat-initiated SOS path
 *
 * No React imports — pure async logic that can be unit-tested with vitest/jsdom.
 */

import { OneLocationService } from "@/lib/one-location/service";
import {
  saveSosIncident,
  type SosIncident,
} from "@/lib/one-location/sos-incident";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";
import { locationCommitStrictlyMatches } from "@/lib/one-location/location-precision";
import { boundedLocationOperationId } from "@/lib/one-location/location-operation-id";
import {
  LOCATION_REVOCATION_PENDING_MESSAGE,
  revokeLocationGrantOrQueue,
  revokeLocationGrantsOrQueue,
} from "@/lib/one-location/location-revocation-queue";
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
  OneLocationNetworkConnection,
  OneLocationRecipient,
  PlainLocationPoint,
} from "@/lib/one-location/types";

// ---------------------------------------------------------------------------
// 1. Typed error carrying any partial incident created before a failure
// ---------------------------------------------------------------------------

/**
 * Thrown by `runSosPanic` when the operation fails after at least one (or
 * zero) grants have been created. Callers should check `partialIncident`:
 * if non-null, at least one grant was created and should be surfaced in the
 * UI so the stop flow can revoke it.
 */
export class SosPanicError extends Error {
  partialIncident: SosIncident | null;
  constructor(message: string, partialIncident: SosIncident | null) {
    super(message);
    this.name = "SosPanicError";
    this.partialIncident = partialIncident;
  }
}

// ---------------------------------------------------------------------------
// 2. Share-readiness guard (type predicate)
// ---------------------------------------------------------------------------

/**
 * Narrowed recipient type — has all three fields required to receive an
 * encrypted location envelope: canReceiveLocation flag, a keyId, and a JWK.
 */
export type SosShareReadyRecipient = OneLocationRecipient & {
  keyId: string;
  publicKeyJwk: JsonWebKey;
};

/**
 * Type predicate that narrows `OneLocationRecipient` to `SosShareReadyRecipient`.
 * Mirrors the `isShareReadyRecipient` guard in page.tsx — kept here so it can
 * be imported and used without the React component context.
 */
export function isSosShareReadyRecipient(
  r: OneLocationRecipient,
): r is SosShareReadyRecipient {
  return Boolean(r.canReceiveLocation && r.keyId && r.publicKeyJwk);
}

// ---------------------------------------------------------------------------
// 3. Connection-based recipient filter
// ---------------------------------------------------------------------------

/**
 * Filters `recipients` to only those who are active One Network connections
 * of `myUserId`.
 *
 * SOS alerts only real connections (the seeded trusted-contact network), never
 * the broader phone-verified directory that `recipients` also includes.
 *
 * @param recipients        Full ranked-recipient list from state.
 * @param networkConnections `state.networkConnections` — may be undefined until
 *                          the first load completes.
 * @param myUserId          The authenticated user's id; null when not yet loaded.
 */
export function selectSosConnectedRecipients(
  recipients: OneLocationRecipient[],
  networkConnections: OneLocationNetworkConnection[] | undefined,
  myUserId: string | null,
): OneLocationRecipient[] {
  const connectedIds = new Set<string>();
  for (const connection of networkConnections ?? []) {
    if (connection.status !== "active") continue;
    // Add BOTH sides so the set is correct regardless of whether myUserId is
    // known. Self is excluded below.
    for (const id of [connection.userAId, connection.userBId]) {
      if (id && id !== myUserId) connectedIds.add(id);
    }
  }
  return recipients.filter((r) => connectedIds.has(r.userId));
}

/**
 * Returns the subset of `recipients` that are ready to receive a shared
 * location — i.e. `canReceiveLocation` is true.
 *
 * All five One Location quick actions (SOS, check-in, drive-to, pick-me-up,
 * safe-arrival) use this single connection-scoped list. Recipients are already
 * scoped to the connections graph server-side.
 */
export function selectShareReadyRecipients(
  recipients: OneLocationRecipient[],
): OneLocationRecipient[] {
  return recipients.filter((r) => r.canReceiveLocation === true);
}

/**
 * Fail-closed Save My Soul selection. An empty or unavailable membership list
 * never falls back to every connected person.
 */
export function selectSmsRecipients(
  recipients: OneLocationRecipient[],
  smsContactUserIds: string[] | undefined,
): OneLocationRecipient[] {
  const selectedIds = new Set(smsContactUserIds ?? []);
  if (selectedIds.size === 0) return [];
  return recipients.filter((recipient) => selectedIds.has(recipient.userId));
}

// ---------------------------------------------------------------------------
// 4. Panic execution
// ---------------------------------------------------------------------------

export interface RunSosPanicParams {
  userId: string;
  vaultOwnerToken: string;
  /** Only share-ready recipients — caller must pre-filter with isSosShareReadyRecipient. */
  recipients: SosShareReadyRecipient[];
  point: PlainLocationPoint;
  /** Optional short message shown in the recipient notification. */
  note?: string | null;
  operationId?: string;
  /** Prepare recipient ciphertext before the atomic grant commit. */
  prepareEnvelope: (
    recipient: SosShareReadyRecipient,
    point: PlainLocationPoint,
  ) => Promise<OneLocationEncryptedEnvelope>;
}

/**
 * Creates one atomic 8-hour SOS grant plus initial encrypted envelope per
 * recipient, persists the incident to localStorage, and returns it. Ciphertext
 * preparation happens first, so a failed recipient never receives an empty
 * permission.
 *
 * On full or partial success the incident is written via `saveSosIncident`.
 * On total failure (first atomic commit throws) nothing is persisted and a
 * SosPanicError with partialIncident === null is thrown.
 *
 * @throws {SosPanicError} Always on failure — carries the partial incident
 *   (if any grants were created) or null (if none were).
 */
export async function runSosPanic(
  params: RunSosPanicParams,
): Promise<SosIncident> {
  const { userId, vaultOwnerToken, recipients, point, prepareEnvelope, note } =
    params;
  const normalizedNote = note?.trim() || null;

  if (
    normalizedNote &&
    normalizedNote.length > ONE_LOCATION_SHARE_NOTE_MAX_LENGTH
  ) {
    throw new SosPanicError("character limit exceed", null);
  }

  if (!recipients.length) {
    throw new SosPanicError("No SMS contacts provided.", null);
  }
  try {
    assertLocationActionNotPaused(userId);
  } catch (error) {
    throw new SosPanicError(
      error instanceof Error ? error.message : String(error),
      null,
    );
  }

  // Capture a single timestamp used for both the success incident and any
  // partial incident — prevents clock skew between the two code paths.
  const startedAt = new Date().toISOString();
  const operationId = params.operationId?.trim() || createRequestId();
  const grantIds: string[] = [];
  const failures: string[] = [];

  try {
    for (const recipient of recipients) {
      try {
        await assertPreciseLocationActionAllowed(userId);
        const envelope = await prepareEnvelope(recipient, point);
        await assertPreciseLocationActionAllowed(userId);
        const response = await OneLocationService.createGrantWithEnvelope({
          vaultOwnerToken,
          recipientUserId: recipient.userId,
          recipientKeyId: recipient.keyId,
          durationHours: 8,
          clientOperationId: boundedLocationOperationId(
            "sos",
            operationId,
            recipient.userId,
          ),
          confirmedAt: startedAt,
          envelope,
          reason: normalizedNote || "sos_panic",
          shareKind: "sos",
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
            const revoked = await revokeLocationGrantOrQueue({
              userId,
              vaultOwnerToken,
              grantId,
            });
            if (!revoked) {
              grantIds.push(grantId);
              failures.push(LOCATION_REVOCATION_PENDING_MESSAGE);
              continue;
            }
          }
          throw new Error(
            "The server did not atomically preserve this Save My Soul share.",
          );
        }
        grantIds.push(response.grant.id);
      } catch (error) {
        failures.push(
          error instanceof Error ? error.message : "SOS sharing failed.",
        );
        if (readOneLocationControlState(userId).paused) break;
      }
    }

    if (readOneLocationControlState(userId).paused) {
      const rollback = await revokeLocationGrantsOrQueue({
        userId,
        vaultOwnerToken,
        grantIds,
      });
      grantIds.splice(0, grantIds.length, ...rollback.pendingGrantIds);
      throw new Error(
        grantIds.length
          ? LOCATION_REVOCATION_PENDING_MESSAGE
          : "Location was paused before SOS sharing completed.",
      );
    }
    if (!grantIds.length) {
      throw new Error(failures[0] ?? "SOS sharing failed.");
    }

    const updates = enableOneLocationAutomaticUpdates(userId);
    if (!updates.allowed) {
      const rollback = await revokeLocationGrantsOrQueue({
        userId,
        vaultOwnerToken,
        grantIds,
      });
      grantIds.splice(0, grantIds.length, ...rollback.pendingGrantIds);
      throw new Error(
        grantIds.length
          ? LOCATION_REVOCATION_PENDING_MESSAGE
          : "Location was paused before SOS updates could start.",
      );
    }

    const incident: SosIncident = { grantIds, startedAt };
    saveSosIncident(incident);
    return incident;
  } catch (error) {
    // Build partial incident from whatever grants were successfully created.
    const partial: SosIncident | null = grantIds.length
      ? { grantIds, startedAt }
      : null;

    // Best-effort persistence — if localStorage is full/unavailable the caller
    // still recovers via the SosPanicError.partialIncident field (in-memory).
    if (partial) {
      saveSosIncident(partial);
    }

    throw new SosPanicError(
      error instanceof Error ? error.message : String(error),
      partial,
    );
  }
}
