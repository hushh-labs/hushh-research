export interface RawConsentResponse {
  active?: boolean;
  granted?: boolean;
  status?: string | null;
  permissions?: string[];
  scopes?: string[];
  /** Schema version.  When present, must be exactly 1 or "1". */
  version?: number | string;
  /** Alias for version; evaluated identically. */
  schemaVersion?: number | string;
}

export interface NormalizedConsentState {
  isGranted: boolean;
  permissions: string[];
}

/**
 * Exhaustive set of schema versions this normalizer accepts.
 * Any other value — including future versions — returns DENY_STATE.
 */
const SUPPORTED_SCHEMA_VERSIONS = new Set<number | string>([1, "1"]);

/** Closed fallback returned whenever structural integrity cannot be confirmed. */
const DENY_STATE: NormalizedConsentState = { isGranted: false, permissions: [] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function normalizeConsentResponse(
  response: RawConsentResponse | null | undefined
): NormalizedConsentState {
  // ── Structural integrity guard (inline, default-deny) ──────────────────────
  // Intercepts payloads that show signs of tampering, type-coercion injection,
  // or prototype-pollution before any mapping logic runs.  No external import.
  //
  // A well-formed RawConsentResponse satisfies all of:
  //   • plain object (not array, not primitive)
  //   • no own "constructor" / "__proto__" keys (prototype-pollution vectors)
  //   • active / granted are boolean when present (not truthy-coerced strings)
  //   • status is string or null when present (not an object / array)
  //   • permissions / scopes are arrays when present (not stringified blobs)
  //
  // Any violation short-circuits to DENY_STATE; null/undefined is allowed
  // through unchanged (the existing mapping already handles it safely).
  if (response !== null && response !== undefined) {
    const r = response as Record<string, unknown>;
    const own = (k: string): boolean =>
      Object.prototype.hasOwnProperty.call(r, k);

    if (
      typeof r !== "object" ||
      Array.isArray(r) ||
      own("__proto__") ||
      own("constructor") ||
      (own("active")      && typeof r["active"]      !== "boolean") ||
      (own("granted")     && typeof r["granted"]     !== "boolean") ||
      (own("status")      && r["status"] !== null    && typeof r["status"] !== "string") ||
      (own("permissions") && !isStringArray(r["permissions"])) ||
      (own("scopes")      && !isStringArray(r["scopes"]))
    ) {
      return DENY_STATE;
    }

    // ── Schema version guard (inline, default-deny) ──────────────────────────
    // When a caller supplies version or schemaVersion, it must be an exact match
    // in SUPPORTED_SCHEMA_VERSIONS.  Null, empty string, wrong type, or any
    // value not in the set returns DENY_STATE immediately — before any mapping.
    if (own("version") || own("schemaVersion")) {
      const rawVersion = own("version") ? r["version"] : r["schemaVersion"];
      if (
        rawVersion === null ||
        rawVersion === undefined ||
        (typeof rawVersion !== "number" && typeof rawVersion !== "string") ||
        (typeof rawVersion === "string" && rawVersion.trim() === "") ||
        !SUPPORTED_SCHEMA_VERSIONS.has(rawVersion)
      ) {
        return DENY_STATE;
      }
    }
  }
  // ── End guards ─────────────────────────────────────────────────────────────

  const permissions = [
    ...(Array.isArray(response?.permissions) ? response.permissions : []),
    ...(Array.isArray(response?.scopes) ? response.scopes : []),
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const status = String(response?.status || "").trim().toLowerCase();

  return {
    isGranted: Boolean(
      response?.active ||
        response?.granted ||
        status === "approved" ||
        status === "active" ||
        status === "granted"
    ),
    permissions: Array.from(new Set(permissions)),
  };
}
