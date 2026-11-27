import { snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { AccountIdentityService } from "./account-identity-service";
import { AuthService } from "./auth-service";

export const ACCOUNT_CONTEXT_TOOL = "read_account_context";
export const ACCOUNT_CONTEXT_CONTRACT = 1;
export type AccountContextRequest = { section: "identity" };

export function parseAccountContextRequest(value: unknown): AccountContextRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.section === "identity" ? { section: "identity" } : null;
}

/** Existing read-only identity endpoint; no provider refresh, new store or mutation. */
export async function readAccountContext(userId: string, isCurrent: () => boolean) {
  const unavailable = { status: "unavailable", reason: "identity_unavailable" } as const;
  const principal = snapshotValidatedAuthSessionPrincipal();
  if (!isCurrent() || principal?.ownerId !== userId) return unavailable;
  const token = await AuthService.getIdTokenWithRetry({ expectedUserId: principal.firebaseUid, retries: 0 });
  if (!token || !isCurrent()) return unavailable;
  let identity;
  try {
    identity = await AccountIdentityService.refreshIdentityForSession(userId, token, { readOnly: true, requireSuccess: true });
  } catch {
    return unavailable;
  }
  if (!isCurrent() || identity?.user_id !== userId) return unavailable;
  const name = identity.display_name?.trim();
  const email = identity.email?.trim();
  const domain = email?.split("@");
  const digits = identity.phone_number?.replace(/\D/g, "");
  const observed = identity.last_synced_at;
  return {
    status: "ok", source: "committed_account_identity",
    identity: {
      display_name: name && name.length <= 60 && !/[\x00-\x1f\x7f@]|:\/\/|www\./i.test(name) ? name : null,
      masked_email: domain?.length === 2 && typeof domain[1] === "string" && /^[^@\s/\x00-\x1f]{1,250}$/.test(domain[1]) ? `***@${domain[1]}` : null,
      masked_phone: digits ? digits.length >= 7 ? `••• ${digits.slice(-4)}` : "••••" : null,
      email_verified: typeof identity.email_verified === "boolean" ? identity.email_verified : null,
      phone_verified: typeof identity.phone_verified === "boolean" ? identity.phone_verified : null,
      has_photo: typeof identity.photo_url === "string" ? Boolean(identity.photo_url.trim()) : identity.photo_url === null ? false : null,
      last_synced_at: observed && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(observed) && Number.isFinite(Date.parse(observed)) ? new Date(observed).toISOString() : null,
    },
  };
}
