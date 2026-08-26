import { Capacitor } from "@capacitor/core";
import { resolveAppEnvironment } from "@/lib/app-env";
import {
  normalizeStaticExportPathname,
  ROUTES,
} from "@/lib/navigation/routes";

const LOCAL_PHONE_MANDATE_BYPASS_HOSTS = new Set(["localhost", "127.0.0.1"]);

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
  return (
    resolveAppEnvironment() === "development" &&
    LOCAL_PHONE_MANDATE_BYPASS_HOSTS.has(normalizeHostname(hostname))
  );
}

function shouldBypassPhoneMandateForNativeRouteAudit(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  // SECURITY: `window.__HUSHH_NATIVE_TEST__` is page-writable. Without the
  // native-platform check, any injected script on the web origin could set
  // `{ enabled: true, expectedUserId }` itself and bypass the phone mandate.
  // See isTrustedNativeTestBridge in lib/testing/native-test.ts.
  if (!Capacitor.isNativePlatform()) {
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
