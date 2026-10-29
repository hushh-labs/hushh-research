import { Capacitor } from "@capacitor/core";

/** Mirrors AuthService.reauthenticateIdentity, which still refuses the rest itself: native apps
 * verify Google and Apple only. Recovery screens hide what this device can't verify instead of
 * failing on tap. */
export function canReauthenticateIdentityHere(providerId: "google.com" | "apple.com" | "microsoft.com"): boolean {
  return providerId !== "microsoft.com" || !Capacitor.isNativePlatform();
}
