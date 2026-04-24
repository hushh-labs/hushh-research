import { resolveAppEnvironment } from "@/lib/app-env";
import { ROUTES } from "@/lib/navigation/routes";

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

export function shouldRequirePhoneMandate(params: {
  phoneNumber?: string | null;
  hasVault: boolean;
  exemptVaultUsers?: boolean;
  hostname?: string | null;
}): boolean {
  if (hasVerifiedPhoneNumber(params.phoneNumber)) {
    return false;
  }

  if (shouldBypassPhoneMandateForLocalhost(params.hostname)) {
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
  const normalized = String(pathname ?? "").trim();
  return normalized === ROUTES.PHONE_MANDATE;
}
