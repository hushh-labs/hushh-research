import { Capacitor } from "@capacitor/core";

/** AuthService.reauthenticateIdentity owns this rule: native apps verify Google and Apple only.
 * Recovery screens hide every provider this device can't verify instead of failing on tap. */
export function canReauthenticateIdentityHere(providerId: "google.com" | "apple.com" | "microsoft.com"): boolean {
  return providerId !== "microsoft.com" || !Capacitor.isNativePlatform();
}
