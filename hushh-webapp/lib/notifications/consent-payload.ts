import type { PendingConsent } from "@/lib/consent";
import { resolveConsentRequesterLabel } from "@/lib/consent/consent-display";

/**
 * Build a PendingConsent object from an FCM data payload.
 * The push is a bare wake-up (identifiers and the requester's name only); scope,
 * purpose and grant details are never in it and load after unlock from the
 * owner-scoped pending list, so the scope fields here are normally empty.
 */
export function consentFromFCMPayload(
  data: Record<string, string>,
): PendingConsent | null {
  const requestId = data.request_id;
  if (!requestId) return null;
  return {
    id: requestId,
    developer: resolveConsentRequesterLabel({
      requesterLabel: data.requester_label,
      counterpartLabel: data.counterpart_label,
      developer: data.agent_label,
      counterpartEmail: data.requester_email,
      counterpartSecondaryLabel: data.requester_secondary_label,
      counterpartId: data.requester_entity_id,
      agentId: data.agent_id,
    }),
    developerImageUrl: data.requester_image_url || undefined,
    developerWebsiteUrl: data.requester_website_url || undefined,
    scope: data.scope || "",
    scopeDescription: data.scope_description || undefined,
    requestedAt: Date.now(),
    approvalTimeoutAt: data.approval_timeout_at
      ? Number(data.approval_timeout_at)
      : undefined,
    expiryHours: data.expiry_hours ? Number(data.expiry_hours) : undefined,
    bundleId: data.bundle_id || undefined,
    requestUrl: data.request_url || data.deep_link || undefined,
    reason: data.reason || undefined,
    isScopeUpgrade: data.is_scope_upgrade === "true",
    existingGrantedScopes: data.existing_granted_scopes
      ? String(data.existing_granted_scopes)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    additionalAccessSummary: data.additional_access_summary || undefined,
  };
}
