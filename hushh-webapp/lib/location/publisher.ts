/**
 * Publish one position to a set of owner grants — pure orchestration.
 *
 * Relocated from the Location hub's watch loop so the app-level publisher
 * bridge (mounted once while Live is on) and any screen share one path:
 *
 *   resolve recipient key -> coarsen -> encrypt -> store, per grant
 *
 * Per-grant isolation is the important property: one recipient without a key
 * or one failed store must never hold back the others, and the caller gets a
 * typed failure per grant instead of a thrown error for the batch.
 *
 * `encrypt` and `store` are injected so this module has no I/O of its own.
 * In the app they are `encryptLocationForRecipient` and
 * `OneLocationService.storeEnvelope`.
 */

import {
  coarsenPoint,
  type LocationPublishPrecision,
} from "@/lib/location/coarsen";
import type {
  OneLocationEncryptedEnvelope,
  OneLocationGrant,
  OneLocationRecipient,
  OneLocationStoredEnvelope,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";

export type PublishFailureCode =
  "permission_denied" | "no_recipient_key" | "stale_fix" | "store_failed";

export type PublishFailure = {
  grantId: string;
  code: PublishFailureCode;
  /** Server `detail.code` or a short local reason; never rendered as success. */
  reason?: string | null;
};

export type PublishedGrant = {
  grantId: string;
  recipientUserId: string;
  precision: LocationPublishPrecision;
  capturedAt: string;
  /** Only the SOS route reports delivery; `null` means "not reported". */
  recipientAlerted: boolean | null;
};

export type PublishPointToGrantsResult = {
  published: PublishedGrant[];
  failures: PublishFailure[];
  precision: LocationPublishPrecision;
  capturedAt: string;
};

/**
 * A grant is publishable only while the recipient's CURRENT key is the one
 * the grant was minted for. Mirrors the hub's `recipientForGrant`.
 */
export type RecipientLookup =
  | ReadonlyMap<string, OneLocationRecipient>
  | Readonly<Record<string, OneLocationRecipient>>;

export type EncryptForRecipient = (params: {
  point: PlainLocationPoint;
  recipientPublicKeyJwk: JsonWebKey;
  recipientKeyId: string;
}) => Promise<OneLocationEncryptedEnvelope>;

export type StoreEnvelope = (params: {
  vaultOwnerToken: string;
  grantId: string;
  envelope: OneLocationEncryptedEnvelope;
}) => Promise<OneLocationStoredEnvelope>;

export type PublishPointToGrantsParams = {
  point: PlainLocationPoint;
  grants: readonly OneLocationGrant[];
  recipientsByUserId: RecipientLookup;
  precision: LocationPublishPrecision;
  vaultOwnerToken: string;
  encrypt: EncryptForRecipient;
  store: StoreEnvelope;
  /** SOS forces a precise point regardless of `precision`. */
  sos?: boolean;
  /**
   * Oldest fix the server accepts between capture and confirmation. The
   * backend allows 60 s; the default keeps a margin under it.
   */
  maxFixAgeMs?: number;
  /**
   * Privacy boundary written on every envelope. A private share is eligible
   * for the recipient's map (that is what the grant agreed to); background
   * publishes from native stay `private_background`.
   */
  publicationContext?: OneLocationEncryptedEnvelope["publicationContext"];
  now?: () => number;
};

export const DEFAULT_MAX_FIX_AGE_MS = 55_000;

function lookupRecipient(
  recipients: RecipientLookup,
  userId: string,
): OneLocationRecipient | null {
  if (recipients instanceof Map) return recipients.get(userId) ?? null;
  const record = recipients as Readonly<Record<string, OneLocationRecipient>>;
  return Object.prototype.hasOwnProperty.call(record, userId)
    ? (record[userId] ?? null)
    : null;
}

function fixAgeMs(capturedAt: string, now: number): number | null {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return null;
  return now - capturedMs;
}

function classifyStoreFailure(error: unknown): {
  code: PublishFailureCode;
  reason: string | null;
} {
  const serverCode = apiErrorCode(error);
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { code: "permission_denied", reason: serverCode };
    }
    if (serverCode === "LOCATION_SHARING_OFF") {
      return { code: "permission_denied", reason: serverCode };
    }
  }
  return {
    code: "store_failed",
    reason:
      serverCode ??
      (error instanceof Error && error.message ? error.message : null),
  };
}

/**
 * Publish `point` to every grant, encrypting once per recipient key.
 *
 * Never throws for a per-grant problem; the result lists what was published
 * and what was not, with a code the UI can act on:
 *  - `stale_fix`         the fix is older than the server would accept
 *  - `no_recipient_key`  the recipient has no current key matching the grant
 *  - `permission_denied` the server refused (sharing off, not the owner)
 *  - `store_failed`      encryption or the store call failed
 */
export async function publishPointToGrants(
  params: PublishPointToGrantsParams,
): Promise<PublishPointToGrantsResult> {
  const now = params.now ?? Date.now;
  const maxFixAgeMs = params.maxFixAgeMs ?? DEFAULT_MAX_FIX_AGE_MS;
  const precision: LocationPublishPrecision = params.sos
    ? "precise"
    : params.precision;
  const point = coarsenPoint(params.point, precision, { sos: params.sos });
  const publicationContext =
    params.publicationContext ?? "foreground_map_visible";

  const published: PublishedGrant[] = [];
  const failures: PublishFailure[] = [];

  const age = fixAgeMs(point.capturedAt, now());
  const stale = age === null || age < -maxFixAgeMs || age > maxFixAgeMs;
  if (stale) {
    for (const grant of params.grants) {
      failures.push({ grantId: grant.id, code: "stale_fix", reason: null });
    }
    return { published, failures, precision, capturedAt: point.capturedAt };
  }

  // One ciphertext per recipient key. Every grant to the same person shares
  // the envelope bytes, which also keeps SOS fan-out to N contacts cheap.
  const envelopeByKeyId = new Map<
    string,
    Promise<OneLocationEncryptedEnvelope>
  >();
  const envelopeFor = (recipient: OneLocationRecipient) => {
    const keyId = String(recipient.keyId);
    let pending = envelopeByKeyId.get(keyId);
    if (!pending) {
      pending = params
        .encrypt({
          point,
          recipientPublicKeyJwk: recipient.publicKeyJwk as JsonWebKey,
          recipientKeyId: keyId,
        })
        .then((envelope) => ({
          ...envelope,
          publicationContext,
          metadata: {
            ...(envelope.metadata ?? {}),
            // Plaintext tag; the server rejects a mismatch with the stored
            // preference and cannot read the coordinate to check otherwise.
            precision,
          },
        }));
      envelopeByKeyId.set(keyId, pending);
    }
    return pending;
  };

  await Promise.all(
    params.grants.map(async (grant) => {
      if (grant.status !== "active") {
        failures.push({
          grantId: grant.id,
          code: "store_failed",
          reason: "grant_not_active",
        });
        return;
      }
      const recipient = lookupRecipient(
        params.recipientsByUserId,
        grant.recipientUserId,
      );
      if (
        !recipient?.keyId ||
        !recipient.publicKeyJwk ||
        recipient.keyId !== grant.recipientKeyId
      ) {
        failures.push({
          grantId: grant.id,
          code: "no_recipient_key",
          reason: recipient?.keyId ? "key_mismatch" : "key_missing",
        });
        return;
      }
      try {
        const envelope = await envelopeFor(recipient);
        const stored = await params.store({
          vaultOwnerToken: params.vaultOwnerToken,
          grantId: grant.id,
          envelope,
        });
        published.push({
          grantId: grant.id,
          recipientUserId: grant.recipientUserId,
          precision,
          capturedAt: point.capturedAt,
          recipientAlerted: stored.recipientAlerted ?? null,
        });
      } catch (error) {
        const { code, reason } = classifyStoreFailure(error);
        failures.push({ grantId: grant.id, code, reason });
      }
    }),
  );

  // Stable order for callers and tests: by the order the grants were given.
  const order = new Map(params.grants.map((grant, index) => [grant.id, index]));
  const rank = (grantId: string) =>
    order.get(grantId) ?? Number.MAX_SAFE_INTEGER;
  published.sort((a, b) => rank(a.grantId) - rank(b.grantId));
  failures.sort((a, b) => rank(a.grantId) - rank(b.grantId));

  return { published, failures, precision, capturedAt: point.capturedAt };
}

/** Recipients keyed by user id, the shape `publishPointToGrants` reads. */
export function indexRecipientsByUserId(
  recipients: readonly OneLocationRecipient[] | null | undefined,
): Map<string, OneLocationRecipient> {
  const map = new Map<string, OneLocationRecipient>();
  for (const recipient of recipients ?? []) {
    if (recipient?.userId) map.set(recipient.userId, recipient);
  }
  return map;
}
