import type { AccountIdentity } from "@/lib/services/api-service";

function hasPhoneEvidence(identity: AccountIdentity | null | undefined, userId: string | undefined): boolean {
  return Boolean(userId && identity?.user_id === userId &&
    identity.source !== "vault_bootstrap_hint" && identity.source !== "legacy_fallback");
}

/** A hint or degraded compatibility projection cannot prove a phone claim. */
export function verifiedBackendPhoneNumber(identity: AccountIdentity | null | undefined, userId: string | undefined): string | null {
  if (!hasPhoneEvidence(identity, userId) || identity?.phone_verified !== true) return null;
  return String(identity.phone_number ?? "").trim() || null;
}

/** Explicit full-record absence, including a legitimately transferred binding. */
export function backendPhoneIsMissing(identity: AccountIdentity | null | undefined, userId: string | undefined): boolean {
  return hasPhoneEvidence(identity, userId) && identity?.phone_verified === false;
}
