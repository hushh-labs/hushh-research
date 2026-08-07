import { resolveAppEnvironment } from "@/lib/app-env";
import {
  normalizeStaticExportPathname,
  ROUTES,
} from "@/lib/navigation/routes";

const LOCAL_PHONE_MANDATE_BYPASS_HOSTS = new Set(["localhost", "127.0.0.1"]);

// The hosted development deployment, which is meant to behave like localhost for
// end-to-end testing. It is matched by EXACT hostname and nothing else: not a
// suffix, not a pattern. `uat.one.hushh.ai` and `one.hushh.ai` must never match,
// and a suffix test on "one.hushh.ai" would match both.
const DEV_PHONE_MANDATE_BYPASS_HOSTS = new Set(["dev.one.hushh.ai"]);

function normalizeHostname(hostname?: string | null): string {
  return String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

export function hasVerifiedPhoneNumber(phoneNumber?: string | null): boolean {
  return String(phoneNumber ?? "").trim().length > 0;
}

export function shouldBypassPhoneMandateForLocalhost(hostname?: string | null): boolean {
  const host = normalizeHostname(hostname);

  // Localhost: unchanged, and still gated on the environment as well as the host.
  if (resolveAppEnvironment() === "development" && LOCAL_PHONE_MANDATE_BYPASS_HOSTS.has(host)) {
    return true;
  }

  // The dev deployment, matched on HOSTNAME ALONE — deliberately, and this is the
  // one part worth explaining.
  //
  // `resolveAppEnvironment()` cannot be used here. The dev frontend is built with
  // `_APP_ENV=uat` so its behaviour gates replicate UAT exactly, which means it
  // reports "uat" on dev and "uat" on real UAT and cannot separate them. Requiring
  // "development" would refuse the very environment this exists to serve; accepting
  // "uat" would open real UAT. The hostname is the only signal that tells them
  // apart, and it is not spoofable into the bundle: this reads
  // `window.location.hostname`, so it is true only when the page is genuinely
  // served from that host.
  //
  // What this does NOT do: grant a verified phone. This is the client-side mandate
  // that routes an unverified user to the phone screen. Every server-side control
  // is untouched — the AI-connection gate still reads `phone_verified is True` from
  // the identity record before it will provision anything.
  return DEV_PHONE_MANDATE_BYPASS_HOSTS.has(host);
}

function shouldBypassPhoneMandateForNativeRouteAudit(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const bridge = (
    window as Window & {
      __HUSHH_NATIVE_TEST__?: {
        enabled?: boolean;
        expectedUserId?: string;
      };
    }
  ).__HUSHH_NATIVE_TEST__;

  return (
    bridge?.enabled === true &&
    typeof bridge.expectedUserId === "string" &&
    bridge.expectedUserId.trim().length > 0
  );
}

export function shouldBypassPhoneMandateForRoute(pathname?: string | null): boolean {
  return normalizeStaticExportPathname(String(pathname ?? "").trim()) === ROUTES.RIA_ONBOARDING;
}

export function shouldRequirePhoneMandate(params: {
  phoneNumber?: string | null;
  phoneVerified?: boolean | null;
  hasVault: boolean;
  exemptVaultUsers?: boolean;
  hostname?: string | null;
  pathname?: string | null;
}): boolean {
  if (params.phoneVerified === true || hasVerifiedPhoneNumber(params.phoneNumber)) {
    return false;
  }

  if (shouldBypassPhoneMandateForRoute(params.pathname)) {
    return false;
  }

  if (shouldBypassPhoneMandateForLocalhost(params.hostname)) {
    return false;
  }

  if (shouldBypassPhoneMandateForNativeRouteAudit()) {
    return false;
  }

  if (params.exemptVaultUsers && params.hasVault) {
    return false;
  }

  return true;
}

export function maskPhoneNumber(phoneNumber?: string | null): string {
  const normalized = String(phoneNumber ?? "").trim();
  if (!normalized) return "";

  const digits = normalized.replace(/\D/g, "");
  if (digits.length <= 4) {
    return normalized;
  }

  const suffix = digits.slice(-4);
  const prefixLength = Math.max(0, digits.length - 6);
  const prefix = prefixLength > 0 ? `${digits.slice(0, prefixLength)} ` : "";
  return `${prefix}•• •• ${suffix}`.trim();
}

export function isPhoneMandatePath(pathname?: string | null): boolean {
  const normalized = normalizeStaticExportPathname(
    String(pathname ?? "").trim(),
  );
  return normalized === ROUTES.PHONE_MANDATE;
}
