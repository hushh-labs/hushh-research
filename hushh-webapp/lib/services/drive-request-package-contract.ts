import { isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";
import { DriveSharingError, record, string, revision, digest, bulkCount, bulkText } from "@/lib/services/drive-sharing-wire";

/** Owner-only assessment of the exact package prepared for this request. */
export type AgentDocumentPackage = {
  status: "preparing" | "ready" | "no_match" | "unavailable" | "stale" | "allowed";
  revision: number;
  digest: string | null;
  selectedCount: number;
  /** Owner-only preview from the sealed membership; older servers omit it. */
  selectedFiles?: Array<{ position: number; name: string; weightageOutOf10?: number; confidenceScore?: number }>;
  selectedFileCount?: number;
  /** Owner-only, provisional matches while the live request is still being checked. */
  provisionalFiles?: Array<{ position: number; name: string; weightageOutOf10: number; confidenceScore: number }>;
  verifiedCount?: number;
  pendingCount?: number;
  evaluatedCount: number;
  candidateCount: number;
  /** A model assessment score, not a calibrated probability. */
  confidenceScore: number | null;
  confidenceBasis: "model_assessment" | "provider_search";
  importanceScore: number | null;
  suggestedPriceCents: number | null;
  priceReason: string;
  summary: string;
  coverageStatus: "complete" | "partial" | "unknown";
  gaps: string[];
  canAllow: boolean;
};

export function parseAgentDocumentPackage(value: unknown): AgentDocumentPackage {
  const item = record(value);
  const discovery = item.confidenceBasis === "provider_search";
  if (typeof item.status !== "string" ||
      !["preparing", "ready", "no_match", "unavailable", "stale", "allowed"].includes(item.status) ||
      typeof item.coverageStatus !== "string" || !["complete", "partial", "unknown"].includes(item.coverageStatus) ||
      (!discovery && item.confidenceBasis !== "model_assessment") || typeof item.canAllow !== "boolean" ||
      !Array.isArray(item.gaps) || item.gaps.length > 24)
    throw new DriveSharingError("invalid_response");
  const packageDigest = item.digest === null ? null : digest(item.digest);
  const selectedCount = bulkCount(item.selectedCount, 10_000);
  const selectedFileCount = item.selectedFileCount === undefined ? undefined : bulkCount(item.selectedFileCount, 10_000);
  const parseFileRows = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 25)
      throw new DriveSharingError("invalid_response");
    const rows = value.map(raw => {
      const file = record(raw);
      if (discovery) return { position: bulkCount(file.position, 10_000), name: bulkText(file.name, 1000) };
      if (typeof file.weightageOutOf10 !== "number" || !Number.isFinite(file.weightageOutOf10) ||
          file.weightageOutOf10 < 1 || file.weightageOutOf10 > 10)
        throw new DriveSharingError("invalid_response");
      return { position: bulkCount(file.position, 10_000), name: bulkText(file.name, 1000),
        weightageOutOf10: file.weightageOutOf10,
        confidenceScore: bulkCount(file.confidenceScore, 100) };
    });
    if (rows.some(row => row.position === 0) ||
        new Set(rows.map(row => row.position)).size !== rows.length)
      throw new DriveSharingError("invalid_response");
    return rows;
  };
  const selectedFiles = item.selectedFiles === undefined ? undefined : parseFileRows(item.selectedFiles);
  if (discovery && [item.provisionalFiles, item.verifiedCount, item.pendingCount].some(value => value !== undefined))
    throw new DriveSharingError("invalid_response");
  // Only the unchanged model-assessment branch can carry scored provisional rows.
  const provisionalFiles = item.provisionalFiles === undefined ? undefined :
    parseFileRows(item.provisionalFiles) as AgentDocumentPackage["provisionalFiles"];
  const verifiedCount = item.verifiedCount === undefined ? undefined : bulkCount(item.verifiedCount, 10_000);
  const pendingCount = item.pendingCount === undefined ? undefined : bulkCount(item.pendingCount, 10_000);
  const evaluatedCount = bulkCount(item.evaluatedCount, 10_000);
  const candidateCount = bulkCount(item.candidateCount, 10_000);
  const confidenceScore = item.confidenceScore === null ? null : bulkCount(item.confidenceScore, 100);
  const importanceScore = item.importanceScore === null ? null : bulkCount(item.importanceScore, 500);
  if (discovery && (confidenceScore !== null || importanceScore !== null || evaluatedCount !== 0 || item.suggestedPriceCents !== 500) ||
      importanceScore === 0 || item.suggestedPriceCents !== null &&
      !isValidDocumentRequestPriceCents(item.suggestedPriceCents) ||
      item.canAllow && (item.status !== "ready" || !packageDigest || selectedCount === 0) ||
      (selectedFiles === undefined) !== (selectedFileCount === undefined) ||
      selectedFileCount !== undefined && (selectedFileCount !== selectedCount ||
        selectedFiles!.length !== Math.min(selectedFileCount, 25)) ||
      [provisionalFiles, verifiedCount, pendingCount].filter(value => value !== undefined).length % 3 !== 0 ||
      verifiedCount !== undefined && (verifiedCount > evaluatedCount ||
        evaluatedCount > candidateCount ||
        provisionalFiles!.length > Math.min(verifiedCount, 25) ||
        pendingCount !== candidateCount - evaluatedCount))
    throw new DriveSharingError("invalid_response");
  return {
    status: item.status as AgentDocumentPackage["status"],
    revision: revision(item.revision), digest: packageDigest, selectedCount,
    ...(selectedFiles === undefined ? {} : { selectedFiles, selectedFileCount }),
    ...(provisionalFiles === undefined ? {} : { provisionalFiles, verifiedCount, pendingCount }),
    evaluatedCount, candidateCount,
    confidenceScore, confidenceBasis: discovery ? "provider_search" : "model_assessment", importanceScore,
    suggestedPriceCents: item.suggestedPriceCents as number | null,
    priceReason: string(item.priceReason), summary: string(item.summary),
    coverageStatus: item.coverageStatus as AgentDocumentPackage["coverageStatus"],
    gaps: item.gaps.map(gap => string(gap)), canAllow: item.canAllow,
  };
}
