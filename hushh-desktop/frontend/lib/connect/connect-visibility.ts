/**
 * lib/connect/connect-visibility.ts
 *
 * Visibility helpers for Connect candidate discovery.
 * Implements conservative frontend-layer filtering — private profiles
 * and non-discoverable profiles are excluded from browse/search.
 * Backend filtering is preferred where available; this is a defensive layer.
 */

import type {
  ConnectCandidate,
  ConnectCandidateKind,
  ConnectCandidateSource,
  ConnectVisibilityPosture,
} from "./types";

// ─── Visibility Posture Logic ─────────────────────────────────────────────────

const PRIVATE_POSTURES: ConnectVisibilityPosture[] = ["private"];
const DISCOVERABLE_POSTURES: ConnectVisibilityPosture[] = [
  "default_available",
  "public",
  "limited",
];

/**
 * Returns true if the given visibility posture allows the profile to appear
 * in Connect browse/search results.
 *
 * Conservative: missing/unknown posture → not discoverable for generic user
 * profiles. RIA and investor profiles from the marketplace APIs are already
 * filtered server-side, so we treat them as discoverable unless explicitly private.
 */
export function isVisibilityPostureDiscoverable(
  posture: ConnectVisibilityPosture | null | undefined,
  kind: ConnectCandidateKind,
): boolean {
  if (!posture) {
    // Marketplace RIA/investor profiles are filtered by the backend search API.
    // Treat them as discoverable unless explicitly marked private.
    if (kind === "ria" || kind === "investor" || kind === "public_profile") {
      return true;
    }
    // Generic hushh user profile with unknown posture — conservative: exclude.
    return false;
  }

  const normalized = posture.toLowerCase().trim();
  if (PRIVATE_POSTURES.includes(normalized as ConnectVisibilityPosture)) {
    return false;
  }
  return DISCOVERABLE_POSTURES.some((p) => p === normalized) || !PRIVATE_POSTURES.includes(normalized as ConnectVisibilityPosture);
}

/**
 * Returns true if the candidate should appear in Connect discover/browse/search.
 *
 * Rules:
 * 1. exposure_enabled === false → never show in discovery.
 * 2. visibility_posture === "private" → never show in discovery.
 * 3. Active/pending/previous connections may still appear in Connections section
 *    regardless of public discoverability (handled by section logic).
 * 4. Test profiles → skip regular visibility rules (they are always controlled by allowTestProfiles flag).
 */
export function isDiscoverable(candidate: ConnectCandidate): boolean {
  // Test profiles are controlled by the allowTestProfiles environment flag
  if (candidate.isTestProfile) return true;

  // Already has connection status data — eligible even if not public
  const connectedStatuses: ConnectCandidate["connectionStatus"][] = [
    "connected",
    "pending",
    "previous",
    "shortlisted",
    "connect_requested",
  ];
  if (connectedStatuses.includes(candidate.connectionStatus)) {
    return true;
  }

  // Explicitly not discoverable
  if (candidate.exposureEnabled === false) return false;

  // Private visibility posture
  if (!isVisibilityPostureDiscoverable(candidate.visibilityPosture, candidate.kind)) {
    return false;
  }

  return candidate.isDiscoverable;
}

// ─── Candidate ID Helpers ─────────────────────────────────────────────────────

/**
 * Build a stable, deterministic candidate ID.
 *
 * Priority:
 *   1. userId → "user:<userId>"
 *   2. publicProfileId → "public:<sourceType>:<publicProfileId>"
 *   3. fallback label → "contact:<stableLocalId>"
 */
export function buildCandidateId(options: {
  userId?: string | null;
  publicProfileId?: string | number | null;
  sourceType?: string | null;
  fallbackLabel?: string | null;
}): string {
  const { userId, publicProfileId, sourceType, fallbackLabel } = options;

  if (userId && String(userId).trim()) {
    return `user:${String(userId).trim()}`;
  }

  if (publicProfileId != null && String(publicProfileId).trim()) {
    const st = String(sourceType || "public").trim().toLowerCase();
    return `public:${st}:${String(publicProfileId).trim()}`;
  }

  const label = String(fallbackLabel || "unknown")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .slice(0, 64);
  return `contact:${label}`;
}

// ─── Source Type Helpers ──────────────────────────────────────────────────────

/**
 * Combine source types from multiple merges without duplicates.
 */
export function mergeSourceTypes(
  existing: ConnectCandidateSource[],
  incoming: ConnectCandidateSource[],
): ConnectCandidateSource[] {
  const seen = new Set(existing);
  for (const src of incoming) {
    seen.add(src);
  }
  return Array.from(seen);
}

/**
 * Returns true if the candidate's sources indicate a real user connection
 * (active, pending, or previous) — used to allow showing in Connections
 * section even if the profile is not publicly discoverable.
 */
export function hasConnectionSource(sources: ConnectCandidateSource[]): boolean {
  return sources.some((s) =>
    ["active_connection", "pending_connection", "previous_connection"].includes(s),
  );
}
