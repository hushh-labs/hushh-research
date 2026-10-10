import type {
  BackgroundShareGrant,
  BackgroundShareSession,
} from "@/lib/capacitor";
import type { LocationPublishPrecision } from "@/lib/location/coarsen";
import type {
  OneLocationGrant,
  OneLocationRecipient,
} from "@/lib/one-location/types";

/**
 * Build the native background-share session from the owner's active grants and
 * known recipients. Mirrors the foreground publish path: for each active grant
 * we resolve the recipient by (userId, keyId) and include it only when both the
 * recipient keyId and public key are present — the exact precondition
 * `publishEnvelope` enforces before encrypting. The result is handed to the
 * native plugin, which reproduces the ECIES envelope offline.
 *
 * Approximate precision: the native publisher encrypts the raw fix and tags no
 * precision, and the backend rejects an untagged envelope from an Approximate
 * owner (409 LOCATION_PRECISION_MISMATCH) -- so every background update was
 * silently dropped. Until the native publisher coarsens and tags points, an
 * Approximate session carries only SOS grants, which are always precise and
 * exempt from the preference; everything else stays on the foreground path,
 * which coarsens correctly.
 */
export function buildBackgroundShareSession(params: {
  activeGrants: OneLocationGrant[];
  recipients: OneLocationRecipient[];
  vaultOwnerToken: string;
  backendBaseUrl: string;
  minMoveMeters: number;
  minIntervalMs: number;
  precision?: LocationPublishPrecision;
}): BackgroundShareSession {
  const sosOnly = params.precision === "approximate";
  const grants: BackgroundShareGrant[] = [];
  for (const grant of params.activeGrants) {
    if (grant.status !== "active") continue;
    if (sosOnly && grant.shareKind !== "sos") continue;
    const recipient = params.recipients.find(
      (candidate) =>
        candidate.userId === grant.recipientUserId &&
        candidate.keyId === grant.recipientKeyId,
    );
    if (!recipient?.keyId || !recipient.publicKeyJwk) continue;
    grants.push({
      grantId: grant.id,
      recipientKeyId: recipient.keyId,
      recipientPublicKeyJwk: recipient.publicKeyJwk,
    });
  }
  return {
    vaultOwnerToken: params.vaultOwnerToken,
    backendBaseUrl: params.backendBaseUrl,
    minMoveMeters: params.minMoveMeters,
    minIntervalMs: params.minIntervalMs,
    grants,
  };
}
