/** A server attestation for the current authenticated owner's exact app origin. */
export function verifyCommerceSandbox(value: unknown, expectedOrigin: string): true {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sandbox identity could not be verified.");
  const proof = value as Record<string, unknown>;
  const origin = new URL(expectedOrigin);
  if (origin.protocol !== "https:" || origin.origin !== expectedOrigin || proof.app_origin !== expectedOrigin ||
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
