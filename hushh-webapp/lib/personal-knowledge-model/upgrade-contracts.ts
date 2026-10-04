export const CURRENT_PKM_MODEL_VERSION = 6;
export const CURRENT_READABLE_SUMMARY_VERSION = 6;
export const CURRENT_PKM_CONTRACT_VERSION = "6.0.0";
export const CURRENT_READABLE_PROJECTION_VERSION = "6.0.0";
export const CURRENT_DYNAMIC_DOMAIN_CONTRACT_VERSION = 4;
export const DEFAULT_DOMAIN_CONTRACT_VERSION = CURRENT_DYNAMIC_DOMAIN_CONTRACT_VERSION;

export type PkmSemanticVersion = {
  major: number;
  minor: number;
  patch: number;
};

export type PkmContractVersion = {
  modelVersion: number;
  contractVersion: string;
  readableProjectionVersion: string;
};

export const CURRENT_PKM_CONTRACT: PkmContractVersion = {
  modelVersion: CURRENT_PKM_MODEL_VERSION,
  contractVersion: CURRENT_PKM_CONTRACT_VERSION,
  readableProjectionVersion: CURRENT_READABLE_PROJECTION_VERSION,
};

/**
 * Encrypted preservation storage inside a domain: information an upgrade could
 * not place with certainty is kept here, never dropped, and never offered for
 * sharing (the manifest keeps it private and the server refuses to scope it).
 * The spelling is a cross-runtime contract with
 * `consent-protocol/db/migrations/098_pkm_v7_recovery_foundation.sql`.
 */
export const PKM_QUARANTINE_SEGMENT_ID = "__quarantine_v1" as const;

/**
 * The reserved-branch relocation moves agent-written entries out of the
 * branches an app feature owns (`contracts/pkm/reserved-branches.v1.json`)
 * into that feature's `agent_memory` sibling. It runs on every upgrade of the
 * domains below and is recorded by a manifest marker, not by a domain contract
 * version: builds in TestFlight and the App Store refuse to write any domain
 * whose stored version is newer than their own ("Update the app before
 * changing it"), so a version bump would lock their Finance and Location saves
 * the moment the web app touched the domain. Those builds never read the
 * marker. The server offers the step only to clients that report a current
 * `x-hushh-client-version`, and keeps the marker across ordinary writes.
 * The Python twin is in `consent-protocol/hushh_mcp/services/domain_contracts.py`;
 * a parity test reads both.
 */
export const RESERVED_BRANCH_MIGRATION_VERSION = 1;
export const RESERVED_BRANCH_MIGRATION_MARKER = "reserved_branch_migration_version" as const;
export const RESERVED_BRANCH_MIGRATION_DOMAINS: readonly string[] = [
  "financial",
  "identity",
  "location",
  "professional",
  "ria",
  "shopping",
  "wallet",
];

export const DOMAIN_CONTRACT_VERSION_MAP: Record<string, number> = {};

export function parsePkmSemanticVersion(version: string | null | undefined): PkmSemanticVersion {
  const parts = String(version || "0.0.0")
    .trim()
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return {
    major: Number.isFinite(major) && major >= 0 ? major : 0,
    minor: Number.isFinite(minor) && minor >= 0 ? minor : 0,
    patch: Number.isFinite(patch) && patch >= 0 ? patch : 0,
  };
}

export function comparePkmSemanticVersions(left: string, right: string): number {
  const a = parsePkmSemanticVersion(left);
  const b = parsePkmSemanticVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return 0;
}

export function isPkmSemanticVersionOlder(
  current: string | null | undefined,
  target = CURRENT_PKM_CONTRACT_VERSION
): boolean {
  return comparePkmSemanticVersions(String(current || "0.0.0"), target) < 0;
}

export function currentDomainContractVersion(domain: string): number {
  const normalized = String(domain || "").trim().toLowerCase();
  return DOMAIN_CONTRACT_VERSION_MAP[normalized] || DEFAULT_DOMAIN_CONTRACT_VERSION;
}

export function currentPkmContractVersion(): PkmContractVersion {
  return CURRENT_PKM_CONTRACT;
}
