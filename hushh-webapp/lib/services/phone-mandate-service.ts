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

// LOCALHOST ONLY — deliberately narrower than this bypass once was.
//
// `dev.one.hushh.ai` used to be in this set, and that produced a dead loop a
// person could not escape through the product: the client never asked for a
// phone while the SERVER kept requiring `phone_verified is True` before
// recording a cloud or provisioning an agent (ai_connection_gate,
// `_reserve_pending_agent_record`), so the cloud save 409'd "verify your phone
// first" with no reachable way to comply (observed on dev.one.hushh.ai,
// 2026-08-19, with a freshly re-created account). The dev deployment must ask,
// exactly like production; its server carries the fictitious-number lane
// (+1 555 0100-0199, no SMS, no captcha) so the screen is cheap to pass there.
//
// Localhost stays exempt for one concrete reason: Firebase phone auth's
// reCAPTCHA does not complete on localhost (known auth limitation,
// founder-verified 2026-08-20), so a forced screen there cannot be passed with
// a real number and would strand local sessions. This grants NOTHING
// server-side — a localhost session that needs a verified phone (the BYOC cloud
// save) still rehearses that journey on dev, or visits /register-phone
// explicitly and uses the fictitious-number lane, which the local backend also
// carries. /register-phone itself never host-redirects away (that auto-bounce
// was the second half of the dead loop and stays deleted).
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
