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
import type {
  ReceiptMemoryArtifact,
  ShoppingReceiptsMemoryPayload,
} from "@/lib/services/gmail-receipt-memory-service";

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
      source_agent: receiptsPath ? "gmail_receipt_memory_v1" : previous?.source_agent ?? path.source_agent,
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
  const nextDomainData = {
    ...params.currentDomainData,
    ...candidatePayload,
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

  const readableSummary = candidatePayload.receipts_memory.readable_summary;
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
    message_excerpt: `Imported Gmail receipt memory ${params.artifact.artifact_id}`.slice(0, 160),
    source: "gmail_receipt_memory_v1",
  };

  return {
    domainData: nextDomainData,
    summary,
    manifest,
    structureDecision,
  };
}
