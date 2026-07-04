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

// ---------------------------------------------------------------------------
// 4. Panic execution
// ---------------------------------------------------------------------------

export interface RunSosPanicParams {
  vaultOwnerToken: string;
  /** Only share-ready recipients — caller must pre-filter with isSosShareReadyRecipient. */
  recipients: SosShareReadyRecipient[];
  point: PlainLocationPoint;
  /**
   * Caller-supplied publish function so the core stays decoupled from the
   * encrypt+store implementation (and is therefore easy to unit-test).
   */
  publish: (
    grant: OneLocationGrant,
    recipient: SosShareReadyRecipient,
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
 * On total failure (first grant creation throws) nothing is persisted and a
 * SosPanicError with partialIncident === null is thrown.
 *
 * @throws {SosPanicError} Always on failure — carries the partial incident
 *   (if any grants were created) or null (if none were).
 */
export async function runSosPanic(
  params: RunSosPanicParams,
): Promise<SosIncident> {
  const { vaultOwnerToken, recipients, point, publish } = params;

  if (!recipients.length) {
    throw new SosPanicError("No SOS recipients provided.", null);
  }

  // Capture a single timestamp used for both the success incident and any
  // partial incident — prevents clock skew between the two code paths.
  const startedAt = new Date().toISOString();
  const grantIds: string[] = [];

  try {
    for (const recipient of recipients) {
      const grant = await OneLocationService.createGrant({
        vaultOwnerToken,
        recipientUserId: recipient.userId,
        recipientKeyId: recipient.keyId,
        durationHours: 8,
        reason: "sos_panic",
      });
      // Record the grant id BEFORE publish so it is never orphaned even if
      // publish throws for this or a later recipient.
      grantIds.push(grant.id);
      await publish(grant, recipient, point);
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
