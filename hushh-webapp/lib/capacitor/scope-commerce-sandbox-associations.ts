import { resolveServerAppFrontendOrigin } from "@/lib/runtime/settings";
import { exactSandboxFrontendOrigin, SANDBOX_ANDROID_APP_ID, SANDBOX_IOS_APP_ID } from "./scope-commerce-sandbox-links.mjs";
import { sandboxAssociationDocuments } from "@/scripts/native/scope-commerce-sandbox-artifacts.mjs";

/** Hosted public claims reuse the sandbox artifact owner; never delegate credentials. */
export function scopeCommerceSandboxAssociations() {
  const iosAppId = process.env.NEXT_PUBLIC_IOS_BUNDLE_ID;
  const androidAppId = process.env.NEXT_PUBLIC_ANDROID_APP_ID;
  if (iosAppId !== SANDBOX_IOS_APP_ID && androidAppId !== SANDBOX_ANDROID_APP_ID) return null;
  const origin = exactSandboxFrontendOrigin(resolveServerAppFrontendOrigin());
  const teamId = process.env.APPLE_TEAM_ID || process.env.NEXT_PUBLIC_APPLE_TEAM_ID || "";
  const fingerprints = (process.env.ANDROID_SHA256_CERT_FINGERPRINTS || "").split(",").map(value => value.trim().toUpperCase());
  if (iosAppId !== SANDBOX_IOS_APP_ID || androidAppId !== SANDBOX_ANDROID_APP_ID ||
      !/^[A-Z0-9]{10}$/.test(teamId) || !fingerprints.length ||
      fingerprints.some(value => !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value))) {
    throw new Error("Sandbox link associations are not configured.");
  }
  return sandboxAssociationDocuments({ host: new URL(origin).hostname, teamId, fingerprints });
}
