import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  CURRENT_PKM_CONTRACT_VERSION,
  CURRENT_READABLE_SUMMARY_VERSION,
  CURRENT_READABLE_PROJECTION_VERSION,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import type { DomainSummary } from "@/lib/services/personal-knowledge-model-service";

export type PkmDomainCapability =
  | "manifest_normalization"
  | "readable_summary"
  | "scope_registry"
  | "consumer_projection"
  | "semantic_counts"
  | "externalizable_paths"
  | "entity_maps"
  | "encrypted_payload_structure";

export type PkmDomainCompatibility = {
  pkmContractVersion: string;
  readableProjectionVersion: string;
  capabilities: PkmDomainCapability[];
  blockedReasons: string[];
};

export type PkmDomainUpgradeResult = {
  domainData: Record<string, unknown>;
  notes: string[];
  newDomainContractVersion: number;
  pkmContractVersion: string;
  readableProjectionVersion: string;
  capabilitiesApplied: PkmDomainCapability[];
  compatibility: PkmDomainCompatibility;
};

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value) as T;
    } catch {
      // Fall through.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueCapabilities(values: PkmDomainCapability[]): PkmDomainCapability[] {
  return Array.from(new Set(values));
}

function countEntityMaps(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countEntityMaps(item), 0);
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const [key, child] of Object.entries(record)) {
    if (key === "entities" && child && typeof child === "object" && !Array.isArray(child)) {
      count += Object.keys(child as Record<string, unknown>).length;
      continue;
    }
    count += countEntityMaps(child);
  }
  return count;
}

export function inferPkmDomainCompatibility(params: {
  domainData: Record<string, unknown>;
  manifest?: DomainManifest | null;
}): PkmDomainCompatibility {
  const capabilities: PkmDomainCapability[] = ["encrypted_payload_structure"];
  const manifest = params.manifest || null;
  const summary = manifest?.summary_projection || {};
  const blockedReasons: string[] = [];

  if (manifest?.paths?.length || manifest?.top_level_scope_paths?.length) {
    capabilities.push("manifest_normalization");
  } else if (manifest) {
    blockedReasons.push("manifest_has_no_paths");
  } else {
    blockedReasons.push("missing_manifest");
  }
  if (manifest?.scope_registry?.length) {
    capabilities.push("scope_registry");
  }
  if (manifest?.externalizable_paths?.length) {
    capabilities.push("externalizable_paths");
  }
  if (summary.readable_summary || summary.readable_highlights) {
    capabilities.push("readable_summary");
  }
  if (summary.consumer_visible === true || manifest?.scope_registry?.some((entry) => {
    const projection = entry.summary_projection || {};
    return projection.consumer_visible === true && projection.internal_only !== true;
  })) {
    capabilities.push("consumer_projection");
  }
  if (Number(summary.consumer_item_count || 0) > 0 || countEntityMaps(params.domainData) > 0) {
    capabilities.push("semantic_counts", "entity_maps");
  }

  return {
    pkmContractVersion: CURRENT_PKM_CONTRACT_VERSION,
    readableProjectionVersion: CURRENT_READABLE_PROJECTION_VERSION,
    capabilities: uniqueCapabilities(capabilities),
    blockedReasons,
  };
}

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function summarizeSections(manifest?: DomainManifest | null): string[] {
  const source = Array.isArray(manifest?.top_level_scope_paths) ? manifest?.top_level_scope_paths : [];
  return source
    .map((item) => titleize(String(item || "")))
    .filter(Boolean)
    .slice(0, 4);
}

export function runDomainUpgrade(params: {
  domain: string;
  domainData: Record<string, unknown>;
  currentVersion: number;
  manifest?: DomainManifest | null;
}): PkmDomainUpgradeResult {
  const targetVersion = currentDomainContractVersion(params.domain);
  const compatibility = inferPkmDomainCompatibility({
    domainData: params.domainData,
    manifest: params.manifest || null,
  });
  if ((params.currentVersion || 0) <= 0) {
    return {
      domainData: cloneRecord(params.domainData),
      notes: [
        `Rebuilt ${titleize(params.domain)} into the current Personal Knowledge Model contract from legacy or unversioned data.`,
      ],
      newDomainContractVersion: targetVersion,
      pkmContractVersion: CURRENT_PKM_CONTRACT_VERSION,
      readableProjectionVersion: CURRENT_READABLE_PROJECTION_VERSION,
      capabilitiesApplied: compatibility.capabilities,
      compatibility,
    };
  }
  let nextDomainData = cloneRecord(params.domainData);
  let nextVersion = Math.max(0, params.currentVersion || 0);
  const notes: string[] = [];

  while (nextVersion < targetVersion) {
    nextVersion += 1;
    notes.push(`Refreshed ${titleize(params.domain)} with the generic dynamic PKM capability pipeline.`);
  }

  return {
    domainData: nextDomainData,
    notes,
    newDomainContractVersion: targetVersion,
    pkmContractVersion: CURRENT_PKM_CONTRACT_VERSION,
    readableProjectionVersion: CURRENT_READABLE_PROJECTION_VERSION,
    capabilitiesApplied: compatibility.capabilities,
    compatibility,
  };
}

export function buildReadableUpgradeSummary(params: {
  domain: string;
  domainSummary?: DomainSummary | null;
  manifest?: DomainManifest | null;
  upgradedAt?: string;
  notes?: string[];
}): {
  readable_summary: string;
  readable_highlights: string[];
  readable_updated_at: string;
  readable_source_label: string;
  readable_event_summary: string;
  readable_summary_version: number;
  readable_projection_version: string;
  pkm_contract_version: string;
  upgraded_at: string;
} {
  const domainLabel =
    params.domainSummary?.displayName || titleize(String(params.domain || "Profile"));
  const sections = summarizeSections(params.manifest);
  const attributeCount = Number(params.domainSummary?.attributeCount || 0);
  const upgradedAt = params.upgradedAt || new Date().toISOString();
  const highlights = [
    sections.length > 0 ? `${sections.join(", ")}` : null,
    attributeCount > 0
      ? `${attributeCount} saved detail${attributeCount === 1 ? "" : "s"}`
      : null,
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);

  return {
    readable_summary: `Your ${domainLabel.toLowerCase()} memory is organized and ready to review.`,
    readable_highlights: highlights.slice(0, 5),
    readable_updated_at: upgradedAt,
    readable_source_label: "Saved memory",
    readable_event_summary: `Updated ${domainLabel} memory.`,
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    readable_projection_version: CURRENT_READABLE_PROJECTION_VERSION,
    pkm_contract_version: CURRENT_PKM_CONTRACT_VERSION,
    upgraded_at: upgradedAt,
  };
}
