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

/** Closed fallback returned whenever a pre-condition guard fails. */
const DENY_STATE: NormalizedConsentState = { isGranted: false, permissions: [] };

export function normalizeConsentResponse(
  response: RawConsentResponse | null | undefined
): NormalizedConsentState {
  // ── Schema version guard (inline, default-deny) ─────────────────────────────
  // When a caller supplies version or schemaVersion, it must be an exact match
  // in SUPPORTED_SCHEMA_VERSIONS.  Null, empty string, wrong type, or any
  // value not in the set returns DENY_STATE immediately — before any mapping.
  //
  // Payloads that omit both fields pass through unchanged, preserving backward
  // compatibility with callers that predate schema versioning.
  if (response !== null && response !== undefined) {
    const r = response as Record<string, unknown>;
    const own = (k: string): boolean => Object.prototype.hasOwnProperty.call(r, k);

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
  // ── End version guard ────────────────────────────────────────────────────────

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
