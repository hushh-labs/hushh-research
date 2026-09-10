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
  const normalizedHost = normalizeRpHost(hostname);
  const normalizedRpId = normalizeRpHost(rpId);
  if (!normalizedHost || !normalizedRpId) return false;
  if (isLikelyIpAddress(normalizedHost) || isLikelyIpAddress(normalizedRpId)) {
    return false;
  }
  return (
    normalizedHost === normalizedRpId ||
    normalizedHost.endsWith(`.${normalizedRpId}`)
  );
}

/** True when the string looks like an IPv4 or IPv6 address. */
function isLikelyIpAddress(host: string): boolean {
  if (!host) return false;
  // IPv4 pattern
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv6 bracketed or bare
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    if (/^[0-9a-fA-F:]+$/.test(inner) && inner.includes(":")) return true;
  }
  if (host.includes(":") && /^[0-9a-fA-F:]+$/.test(host)) return true;
  return false;
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
