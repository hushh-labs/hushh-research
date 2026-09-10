type ResolvePasskeyRpIdOptions = {
  isNative: boolean;
  hostname?: string | null;
};

export const CANONICAL_NATIVE_PASSKEY_RP_ID = "one.hushh.ai";

function extractHost(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      return parsed.hostname || null;
    }
  } catch {
    // Fall through to host-like parsing.
  }

  const withoutPath = trimmed.split("/")[0] ?? "";
  if (!withoutPath) return null;
  const withoutPort = withoutPath.split(":")[0] ?? "";
  return withoutPort || null;
}

export function normalizeRpHost(host: string | null | undefined): string | null {
  const extracted = extractHost(host);
  if (!extracted) return null;
  const normalized = extracted.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "127.0.0.1") return "localhost";
  return normalized;
}

/**
 * A WebAuthn RP ID may be the current host or one of its registrable suffixes.
 * Keep this check centralized so wrapper selection and trusted-device flows
 * apply the same origin-boundary rule.
 */
export function isPasskeyRpIdCompatibleWithHost(
  hostname: string | null | undefined,
  rpId: string | null | undefined,
): boolean {
  if (isLikelyIpAddress(hostname) || isLikelyIpAddress(rpId)) return false;
  const normalizedHost = normalizeRpHost(hostname);
  const normalizedRpId = normalizeRpHost(rpId);
  if (!normalizedHost || !normalizedRpId) return false;
  return (
    normalizedHost === normalizedRpId ||
    normalizedHost.endsWith(`.${normalizedRpId}`)
  );
}

/** WebAuthn RPs are registrable domains; bare IP addresses are never valid. */
function isLikelyIpAddress(value: string | null | undefined): boolean {
  const raw = value?.trim() ?? "";
  if (!raw) return false;
  const host = raw.startsWith("[") ? raw : extractHost(raw) || raw;
  const unbracketed = host.replace(/^\[|\]$/g, "");
  const ipv4Parts = unbracketed.split(".");
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return true;
  }
  return unbracketed.includes(":") && /^[0-9a-fA-F:]+$/.test(unbracketed);
}
export function resolvePasskeyRpId(options: ResolvePasskeyRpIdOptions): string {
  const explicitRp = normalizeRpHost(process.env.NEXT_PUBLIC_PASSKEY_RP_ID);
  if (explicitRp) {
    return explicitRp;
  }

  if (options.isNative) {
    return CANONICAL_NATIVE_PASSKEY_RP_ID;
  }

  const runtimeHost = normalizeRpHost(options.hostname);
  if (runtimeHost) {
    return runtimeHost;
  }

  if (typeof window !== "undefined") {
    const windowHost = normalizeRpHost(window.location.hostname);
    if (windowHost) {
      return windowHost;
    }
  }

  return "localhost";
}
