type ResolvePasskeyRpIdOptions = {
  isNative: boolean;
  hostname?: string | null;
};

export const CANONICAL_NATIVE_PASSKEY_RP_ID = "kai.hushh.ai";

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
