export const CURRENT_PKM_MODEL_VERSION = 4;
export const CURRENT_READABLE_SUMMARY_VERSION = 2;
export const CURRENT_PKM_CONTRACT_VERSION = "4.1.0";
export const CURRENT_READABLE_PROJECTION_VERSION = "4.1.0";
export const CURRENT_DYNAMIC_DOMAIN_CONTRACT_VERSION = 2;
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
