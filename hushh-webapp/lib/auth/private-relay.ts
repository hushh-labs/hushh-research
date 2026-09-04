/**
 * Detects Apple "Hide My Email" private relay addresses
 * (`*@privaterelay.appleid.com`). Sign-in-with-Apple can hand back one of
 * these instead of the user's real email, which breaks anything that needs
 * to verify replies against a real, reachable inbox (e.g. drafting from
 * one@hushh.ai on the user's behalf).
 */
export function isApplePrivateRelayEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith("@privaterelay.appleid.com");
}
