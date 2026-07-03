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
import type {
  OneLocationGrant,
  OneLocationNetworkConnection,
  OneLocationRecipient,
  PlainLocationPoint,
} from "@/lib/one-location/types";

// ---------------------------------------------------------------------------
// 1. Share-readiness guard
// ---------------------------------------------------------------------------

/**
 * Returns true when a recipient has all three fields required to receive an
 * encrypted location envelope: canReceiveLocation flag, a keyId, and a JWK.
 *
 * Mirrors the `isShareReadyRecipient` type-guard in page.tsx — kept here as a
 * plain boolean helper so it can be used without the React component context.
 */
export function isSosShareReadyRecipient(r: OneLocationRecipient): boolean {
  return Boolean(r.canReceiveLocation && r.keyId && r.publicKeyJwk);
}

// ---------------------------------------------------------------------------
// 2. Connection-based recipient filter
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
    const otherId =
      connection.userAId === myUserId
        ? connection.userBId
        : connection.userAId;
    if (otherId && otherId !== myUserId) connectedIds.add(otherId);
  }
  return recipients.filter((r) => connectedIds.has(r.userId));
}

// ---------------------------------------------------------------------------
// 3. Panic execution
// ---------------------------------------------------------------------------

export interface RunSosPanicParams {
  vaultOwnerToken: string;
  /** Only share-ready recipients — caller must pre-filter with isSosShareReadyRecipient. */
  recipients: OneLocationRecipient[];
  point: PlainLocationPoint;
  /**
   * Caller-supplied publish function so the core stays decoupled from the
   * encrypt+store implementation (and is therefore easy to unit-test).
   */
  publish: (
    grant: OneLocationGrant,
    recipient: OneLocationRecipient,
    point: PlainLocationPoint,
  ) => Promise<void>;
}

/**
 * Creates one 8-hour SOS grant per recipient, publishes an encrypted location
 * envelope, persists the incident to localStorage, and returns it.
 *
 * Grant ids are pushed to the partial list BEFORE the corresponding publish
 * call so that a partial incident (publish failure mid-loop) still contains
 * every grant id that was created and can be revoked by handleStopSos.
 *
 * On full or partial success the incident is written via `saveSosIncident`.
 * On total failure (first grant creation throws) nothing is persisted and the
 * error re-throws.
 */
export async function runSosPanic(
  params: RunSosPanicParams,
): Promise<SosIncident> {
  const { vaultOwnerToken, recipients, point, publish } = params;
  const grantIds: string[] = [];

  try {
    for (const recipient of recipients) {
      const grant = await OneLocationService.createGrant({
        vaultOwnerToken,
        recipientUserId: recipient.userId,
        recipientKeyId: recipient.keyId as string,
        durationHours: 8,
        reason: "sos_panic",
      });
      // Record the grant id BEFORE publish so it is never orphaned even if
      // publish throws for this or a later recipient.
      grantIds.push(grant.id);
      await publish(grant, recipient, point);
    }

    const incident: SosIncident = {
      grantIds,
      startedAt: new Date().toISOString(),
    };
    saveSosIncident(incident);
    return incident;
  } catch (error) {
    if (grantIds.length) {
      // At least one grant was created before the failure — persist a partial
      // incident so the stop flow can revoke everything that was opened.
      const partial: SosIncident = {
        grantIds,
        startedAt: new Date().toISOString(),
      };
      saveSosIncident(partial);
    }
    throw error;
  }
}
