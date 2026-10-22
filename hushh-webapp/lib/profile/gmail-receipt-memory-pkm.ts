"use client";

import {
  buildPersonalKnowledgeModelStructureArtifacts,
  type DomainManifest,
  type PathDescriptor,
  type StructureDecision,
} from "@/lib/personal-knowledge-model/manifest";
import {
  CURRENT_READABLE_SUMMARY_VERSION,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import {
  mergeReceiptsMemoryWithIndex,
  type ReceiptCanonicalIndex,
} from "@/lib/profile/gmail-receipt-memory-index";
import type {
  ReceiptMemoryArtifact,
  ShoppingReceiptsMemoryPayload,
} from "@/lib/services/gmail-receipt-memory-service";
import { assertReceiptMemoryBudget, safeAffinityLabel, type LightweightReceiptMemory } from "@/lib/mail/receipt-lightweight-memory";

/**
 * The registered writer for `shopping.receipts_memory` (reserved-branches
 * registry). Everything the receipt memory save declares about its author must
 * be this id: the backend judges a request without a mutation plan, such as
 * the pre-save validation, by the structure decision's `source_agent`.
 */
export const RECEIPT_MEMORY_SAVE_WRITER = "gmail_receipt_memory_save_button";

function isReceiptMemoryPath(path: string | null | undefined): boolean {
  const normalized = String(path || "").trim();
  return normalized === "receipts_memory" || normalized.startsWith("receipts_memory.");
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildPathDescriptors(params: {
  generatedPaths: PathDescriptor[];
  currentManifest: DomainManifest | null;
  receiptsSourceAgent?: string;
}): PathDescriptor[] {
  const previousPathMap = new Map(
    (params.currentManifest?.paths || []).map((path) => [path.json_path, path])
  );

  return params.generatedPaths.map((path) => {
    const previous = previousPathMap.get(path.json_path);
    const receiptsPath = isReceiptMemoryPath(path.json_path);
    return {
      ...path,
      exposure_eligibility: receiptsPath ? false : previous?.exposure_eligibility ?? path.exposure_eligibility,
      consent_label: previous?.consent_label ?? path.consent_label,
      sensitivity_label:
        previous?.sensitivity_label ?? (receiptsPath ? "confidential" : path.sensitivity_label),
      scope_handle: previous?.scope_handle ?? path.scope_handle,
      source_agent: receiptsPath
        ? params.receiptsSourceAgent ?? "gmail_receipt_memory_v1"
        : previous?.source_agent ?? path.source_agent,
    };
  });
}

export function hasMatchingReceiptMemoryProvenance(
  currentDomainData: Record<string, unknown>,
  artifact: ReceiptMemoryArtifact
): boolean {
  const receiptsMemory = toRecord(currentDomainData.receipts_memory);
  const provenance = toRecord(receiptsMemory.provenance);
  return (
    String(provenance.deterministic_projection_hash || "") === artifact.deterministic_projection_hash &&
    String(provenance.enrichment_hash || "") === String(artifact.enrichment_hash || "")
  );
}

export function buildShoppingReceiptMemoryPreparedDomain(params: {
  currentDomainData: Record<string, unknown>;
  currentManifest: DomainManifest | null;
  artifact: ReceiptMemoryArtifact;
}): {
  domainData: Record<string, unknown>;
  summary: Record<string, unknown>;
  manifest: DomainManifest;
  structureDecision: StructureDecision;
} {
  const candidatePayload = params.artifact.candidate_pkm_payload as ShoppingReceiptsMemoryPayload;
  // Retired artifact compatibility may contain recent highlights and exact
  // dates/amounts. Project only bounded affinity counts, never spread it.
  const previousMemory = toRecord(params.currentDomainData.receipts_memory);
  const previousHighlights = toRecord(previousMemory.observed_facts).recent_highlights;
  if (previousMemory._canonical_index || (previousHighlights !== undefined && (!Array.isArray(previousHighlights) || previousHighlights.length > 0)))
    throw new Error("Move legacy receipts to the encrypted Mail snapshot before updating memory.");
  const affinity = candidatePayload.receipts_memory.observed_facts.merchant_affinity
    .filter(m => safeAffinityLabel(m.merchant_label) && Number.isSafeInteger(m.receipt_count_365d) && m.receipt_count_365d >= 0 && m.receipt_count_365d <= 10000)
    .slice(0, 20).map(m => ({ merchant_label: m.merchant_label, purchase_count: m.receipt_count_365d }));
  const projected: LightweightReceiptMemory = { schema_version: 2,
    readable_summary: { text: "An observed Mail receipt sample informs merchant affinities.", highlights: [],
      updated_at: candidatePayload.receipts_memory.readable_summary.updated_at, source_label: "Mail receipts" },
    observed_facts: { merchant_affinity: affinity, category_affinity: [], purchase_patterns: [] },
    inferred_preferences: { preference_signals: [] }, confidence: null,
    coverage: { canonical_count: 0, partial: true, truncated: false },
    provenance: { source_kind: "mail_receipt_snapshot", updated_at: candidatePayload.receipts_memory.readable_summary.updated_at } };
  assertReceiptMemoryBudget(projected);
  const nextDomainData = {
    ...params.currentDomainData,
    receipts_memory: projected,
  };

  const generated = buildPersonalKnowledgeModelStructureArtifacts({
    domain: "shopping",
    domainData: nextDomainData,
    previousManifest: params.currentManifest,
  });
  const paths = buildPathDescriptors({
    generatedPaths: generated.manifest.paths,
    currentManifest: params.currentManifest,
  });
  const topLevelScopePaths = Array.from(
    new Set(
      [
        ...(params.currentManifest?.top_level_scope_paths || []),
        ...generated.manifest.top_level_scope_paths,
      ].filter(Boolean)
    )
  );
  const externalizablePaths = paths
    .filter((path) => path.exposure_eligibility)
    .map((path) => path.json_path);

  const readableSummary = projected.readable_summary;
  const summaryProjection = {
    ...(params.currentManifest?.summary_projection || {}),
    readable_summary: readableSummary.text,
    readable_highlights: readableSummary.highlights,
    readable_updated_at: readableSummary.updated_at,
    readable_source_label: readableSummary.source_label,
    domain_contract_version: currentDomainContractVersion("shopping"),
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    receipt_memory_artifact_id: params.artifact.artifact_id,
    receipt_memory_projection_hash: params.artifact.deterministic_projection_hash,
    receipt_memory_enrichment_hash: params.artifact.enrichment_hash || null,
    path_count: paths.length,
    externalizable_path_count: externalizablePaths.length,
    top_level_scope_count: topLevelScopePaths.length,
  };

  const structureDecision: StructureDecision = {
    ...generated.structureDecision,
    action: params.currentManifest ? "extend_domain" : generated.structureDecision.action,
    target_domain: "shopping",
    json_paths: paths.map((path) => path.json_path),
    top_level_scope_paths: topLevelScopePaths,
    externalizable_paths: externalizablePaths,
    summary_projection: summaryProjection,
    confidence: 1,
    source_agent: "gmail_receipt_memory_v1",
    contract_version: 1,
  };

  const manifest: DomainManifest = {
    ...generated.manifest,
    domain: "shopping",
    manifest_version: Math.max(
      generated.manifest.manifest_version,
      (params.currentManifest?.manifest_version || 0) + 1
    ),
    domain_contract_version: currentDomainContractVersion("shopping"),
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    structure_decision: structureDecision,
    summary_projection: summaryProjection,
    top_level_scope_paths: topLevelScopePaths,
    externalizable_paths: externalizablePaths,
    path_count: paths.length,
    externalizable_path_count: externalizablePaths.length,
    paths,
  };

  const summary = {
    ...summaryProjection,
    source: "gmail_receipt_memory_v1",
  };

  return {
    domainData: nextDomainData,
    summary,
    manifest,
    structureDecision,
  };
}

/**
 * Prepares the `shopping` domain write for the owner-confirmed receipt memory
 * save (`gmail_receipt_memory_save_button`). It extends the existing
 * `receipts_memory` payload with the canonical transaction index built on this
 * device from the rows Mail > Receipts shows; it never reads the retired server
 * receipt table. Sibling shopping data is preserved, existing summary fields
 * are kept, and every `receipts_memory` path stays non-shareable.
 */
export function buildShoppingReceiptCanonicalIndexPreparedDomain(params: {
  currentDomainData: Record<string, unknown>;
  currentManifest: DomainManifest | null;
  index: ReceiptCanonicalIndex;
  digest: string;
  now: Date;
  lightweightMemory?: LightweightReceiptMemory;
  archiveVerified?: boolean;
}): {
  domainData: Record<string, unknown>;
  summary: Record<string, unknown>;
  manifest: DomainManifest;
  structureDecision: StructureDecision;
} {
  const priorReceiptMemory = toRecord(params.currentDomainData.receipts_memory);
  const priorHighlights = toRecord(priorReceiptMemory.observed_facts).recent_highlights;
  if ((priorReceiptMemory._canonical_index || (priorHighlights !== undefined && (!Array.isArray(priorHighlights) || priorHighlights.length > 0))) && !params.archiveVerified)
    throw new Error("Verify the encrypted Mail snapshot before removing the legacy index.");
  const receiptsMemory = params.lightweightMemory ? { ...params.lightweightMemory } : mergeReceiptsMemoryWithIndex({
    existing: params.currentDomainData.receipts_memory,
    index: params.index,
    digest: params.digest,
    now: params.now,
  });
  assertReceiptMemoryBudget(receiptsMemory);
  const nextDomainData = {
    ...params.currentDomainData,
    receipts_memory: receiptsMemory,
  };

  const generated = buildPersonalKnowledgeModelStructureArtifacts({
    domain: "shopping",
    domainData: nextDomainData,
    previousManifest: params.currentManifest,
  });
  const paths = buildPathDescriptors({
    generatedPaths: generated.manifest.paths,
    currentManifest: params.currentManifest,
    receiptsSourceAgent: RECEIPT_MEMORY_SAVE_WRITER,
  });
  const topLevelScopePaths = Array.from(
    new Set(
      [
        ...(params.currentManifest?.top_level_scope_paths || []),
        ...generated.manifest.top_level_scope_paths,
      ].filter(Boolean)
    )
  );
  const externalizablePaths = paths
    .filter((path) => path.exposure_eligibility)
    .map((path) => path.json_path);

  const readableSummary = toRecord(receiptsMemory.readable_summary);
  const summaryProjection = {
    ...(params.currentManifest?.summary_projection || {}),
    readable_summary: String(readableSummary.text || ""),
    readable_highlights: Array.isArray(readableSummary.highlights)
      ? readableSummary.highlights
      : [],
    readable_updated_at: String(readableSummary.updated_at || ""),
    readable_source_label: String(readableSummary.source_label || "Gmail receipts"),
    domain_contract_version: currentDomainContractVersion("shopping"),
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    receipt_memory_artifact_id: `canonical_index:${params.digest.slice(0, 16)}`,
    receipt_memory_projection_hash: params.digest,
    receipt_memory_enrichment_hash: null,
    path_count: paths.length,
    externalizable_path_count: externalizablePaths.length,
    top_level_scope_count: topLevelScopePaths.length,
  };

  const structureDecision: StructureDecision = {
    ...generated.structureDecision,
    action: params.currentManifest ? "extend_domain" : generated.structureDecision.action,
    target_domain: "shopping",
    json_paths: paths.map((path) => path.json_path),
    top_level_scope_paths: topLevelScopePaths,
    externalizable_paths: externalizablePaths,
    summary_projection: summaryProjection,
    confidence: 1,
    source_agent: RECEIPT_MEMORY_SAVE_WRITER,
    contract_version: 1,
  };

  const manifest: DomainManifest = {
    ...generated.manifest,
    domain: "shopping",
    manifest_version: Math.max(
      generated.manifest.manifest_version,
      (params.currentManifest?.manifest_version || 0) + 1
    ),
    domain_contract_version: currentDomainContractVersion("shopping"),
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    structure_decision: structureDecision,
    summary_projection: summaryProjection,
    top_level_scope_paths: topLevelScopePaths,
    externalizable_paths: externalizablePaths,
    path_count: paths.length,
    externalizable_path_count: externalizablePaths.length,
    paths,
  };

  return {
    domainData: nextDomainData,
    summary: { ...summaryProjection, source: RECEIPT_MEMORY_SAVE_WRITER },
    manifest,
    structureDecision,
  };
}
