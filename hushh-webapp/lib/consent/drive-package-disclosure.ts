/** Owner-approved, buyer-safe terms for one exact packet revision. */
export type DrivePackageDisclosure = {
  schemaVersion: 1;
  packageDigest: string;
  packageRevision: number;
  selectedCount: number;
  coverageStatus: "complete" | "partial" | "unknown";
  periods: { start: string; end: string }[];
  limitations: string[];
  confidenceBasis?: "provider_search";
};

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const stamp = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value;
}

export function parseDrivePackageDisclosure(value: unknown): DrivePackageDisclosure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.packageDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.packageDigest) ||
      !Number.isSafeInteger(raw.packageRevision) || Number(raw.packageRevision) < 1 ||
      !Number.isSafeInteger(raw.selectedCount) || Number(raw.selectedCount) < 1 || Number(raw.selectedCount) > 120 ||
      typeof raw.coverageStatus !== "string" || !["complete", "partial", "unknown"].includes(raw.coverageStatus) ||
      raw.confidenceBasis !== undefined && raw.confidenceBasis !== "provider_search" ||
      !Array.isArray(raw.periods) || raw.periods.length > 120 ||
      !Array.isArray(raw.limitations) || raw.limitations.length > 24 ||
      raw.limitations.some(item => typeof item !== "string" || !item.trim() || item.length > 300) ||
      raw.confidenceBasis === "provider_search" && (raw.coverageStatus !== "unknown" || raw.periods.length !== 0) ||
      (raw.coverageStatus !== "complete" && raw.limitations.length === 0)) return null;
  const periods: DrivePackageDisclosure["periods"] = [];
  for (const value of raw.periods) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (!calendarDate(row.start) || !calendarDate(row.end) || row.end < row.start) return null;
    periods.push({ start: row.start, end: row.end });
  }
  return { schemaVersion: 1, packageDigest: raw.packageDigest, packageRevision: Number(raw.packageRevision),
    selectedCount: Number(raw.selectedCount), coverageStatus: raw.coverageStatus as DrivePackageDisclosure["coverageStatus"],
    periods, limitations: raw.limitations as string[],
    ...(raw.confidenceBasis === "provider_search" ? { confidenceBasis: "provider_search" as const } : {}) };
}

export function packageCoverageLabel(coverage: DrivePackageDisclosure["coverageStatus"]): string {
  return coverage === "partial" ? "Incomplete package" : coverage === "unknown" ? "Unable to verify" : "Package contents";
}
