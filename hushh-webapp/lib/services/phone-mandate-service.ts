import { ROUTES } from "@/lib/navigation/routes";

export function hasVerifiedPhoneNumber(phoneNumber?: string | null): boolean {
  return String(phoneNumber ?? "").trim().length > 0;
}

export function shouldRequirePhoneMandate(params: {
  phoneNumber?: string | null;
  hasVault: boolean;
  exemptVaultUsers?: boolean;
}): boolean {
  if (hasVerifiedPhoneNumber(params.phoneNumber)) {
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
