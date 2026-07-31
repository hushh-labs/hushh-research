import type {
  BackgroundShareGrant,
  BackgroundShareSession,
} from "@/lib/capacitor";
import type {
  OneLocationGrant,
  OneLocationRecipient,
} from "@/lib/one-location/types";
import { grantLocationMode } from "@/lib/one-location/location-precision";

/**
 * Build the native background-share session from the owner's active grants and
 * known recipients. Mirrors the foreground publish path: for each active grant
 * we resolve the recipient by (userId, keyId) and include it only when both the
 * recipient keyId and public key are present — the exact precondition
 * `publishEnvelope` enforces before encrypting. The result is handed to the
 * native plugin, which reproduces the ECIES envelope offline.
 */
export function buildBackgroundShareSession(params: {
  activeGrants: OneLocationGrant[];
  recipients: OneLocationRecipient[];
  vaultOwnerToken: string;
  backendBaseUrl: string;
  minMoveMeters: number;
  minIntervalMs: number;
  approximateIntervalMs: number;
}): BackgroundShareSession {
  const grants: BackgroundShareGrant[] = [];
  for (const grant of params.activeGrants) {
    if (grant.status !== "active") continue;
    const recipient = params.recipients.find(
      (candidate) =>
        candidate.userId === grant.recipientUserId &&
        candidate.keyId === grant.recipientKeyId,
    );
    if (!recipient?.keyId || !recipient.publicKeyJwk) continue;
    const locationMode = grantLocationMode(grant);
    const approximateRadiusM = grant.approximateRadiusM ?? null;
    if (locationMode === "approximate" && approximateRadiusM === null) {
      continue;
    }
    grants.push({
      grantId: grant.id,
      recipientKeyId: recipient.keyId,
      recipientPublicKeyJwk: recipient.publicKeyJwk,
      locationMode,
      approximateRadiusM,
      lastPublishedAt: grant.latestEnvelopeId
        ? (grant.updatedAt ?? null)
        : null,
    });
  }
  return {
    vaultOwnerToken: params.vaultOwnerToken,
    backendBaseUrl: params.backendBaseUrl,
    minMoveMeters: params.minMoveMeters,
    minIntervalMs: params.minIntervalMs,
    approximateIntervalMs: params.approximateIntervalMs,
    grants,
  };
}
