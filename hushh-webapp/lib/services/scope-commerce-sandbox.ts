function isLocalSandboxHttpOrigin(origin: URL): boolean {
  const env = String(process.env.NEXT_PUBLIC_APP_ENV ?? "").trim().toLowerCase();
  if (env === "uat" || env === "production") return false;
  if (origin.protocol !== "http:" || (origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1")) {
    return false;
  }
  if (typeof window !== "undefined" && window.location?.hostname) {
    return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  }
  return true;
}

/** Resolve the sandbox readiness origin, admitting loopback HTTP only in non-UAT/non-prod local dev. */
export function resolveCommerceSandboxOrigin(shareableOrigin: string | null): string | null {
  if (shareableOrigin) return shareableOrigin;
  if (typeof window === "undefined" || !window.location?.origin) return null;
  try {
    const live = new URL(window.location.origin);
    return isLocalSandboxHttpOrigin(live) ? live.origin : null;
  } catch {
    return null;
  }
}

/** A server attestation for the current authenticated owner's exact app origin. */
export function verifyCommerceSandbox(value: unknown, expectedOrigin: string): true {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sandbox identity could not be verified.");
  const proof = value as Record<string, unknown>;
  const origin = new URL(expectedOrigin);
  if (!(origin.protocol === "https:" || isLocalSandboxHttpOrigin(origin)) || origin.origin !== expectedOrigin || proof.app_origin !== expectedOrigin ||
      proof.environment !== "sandbox" || proof.livemode !== false || proof.persisted_pin_matches !== true ||
      typeof proof.platform_account_id !== "string" || !/^acct_[A-Za-z0-9]+$/.test(proof.platform_account_id)) {
    throw new Error("Sandbox identity could not be verified.");
  }
  return true;
}

export function extractSandboxRemainingCents(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).reviewer_funding_remaining_cents;
  return Number.isSafeInteger(raw) && Number(raw) >= 0 ? Number(raw) : null;
}

export const COMMERCE_SANDBOX_COPY = "Sandbox test — funds are simulated.";
