import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  CURRENT_PKM_CONTRACT_VERSION,
  CURRENT_READABLE_SUMMARY_VERSION,
  CURRENT_READABLE_PROJECTION_VERSION,
  PKM_QUARANTINE_SEGMENT_ID,
  RESERVED_BRANCH_MIGRATION_DOMAINS,
  comparePkmSemanticVersions,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import {
  relocateAgentEntriesFromReservedBranches,
  type ReservedMigrationReport,
} from "@/lib/personal-knowledge-model/reserved-branch-migration";
import type { DomainSummary } from "@/lib/services/personal-knowledge-model-service";

// Cross-runtime reserved segment contract. Information placed here remains
// encrypted but must never appear in scope discovery or consent exports.
export { PKM_QUARANTINE_SEGMENT_ID };

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
  losslessValidation: PkmLosslessValidation;
  /** Every original occurrence that changed place, from the stored data to `domainData`. */
  lineage: PkmOccurrenceLineage[];
  /** Present when the reserved-branch relocation ran for this domain (`RESERVED_BRANCH_MIGRATION_DOMAINS`). */
  reservedMigration?: ReservedMigrationReport;
};

export type PkmLosslessValidation = {
  preserved: boolean;
  beforeLeafCount: number;
  afterLeafCount: number;
  issueCodes: string[];
  receipt: PreservationReceiptV1;
};

export type PkmOccurrenceClassification =
  | "preserved"
  | "moved"
  | "equal_value_deduplicated"
  | "quarantined";

export type PkmOccurrenceLineage = {
  sourcePointer: string;
  targetPointer: string;
  classification: PkmOccurrenceClassification;
};

export type PreservationReceiptV1 = {
  schemaVersion: "pkm_preservation_receipt.v1";
  totalSourceOccurrences: number;
  preserved: number;
  moved: number;
  equalValueDeduplicated: number;
  quarantined: number;
  rejected: number;
  complete: boolean;
};

export class PkmFutureVersionError extends Error {
  constructor() {
    super("This saved information was created by a newer app version. Update the app before changing it.");
    this.name = "PkmFutureVersionError";
  }
}

export class PkmLosslessUpgradeError extends Error {
  validation: PkmLosslessValidation;

  constructor(validation: PkmLosslessValidation) {
    super("PKM upgrade stopped because lossless preservation could not be proven.");
    this.name = "PkmLosslessUpgradeError";
    this.validation = validation;
  }
}

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

type JsonOccurrence = { pointer: string; value: unknown; type: string };

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function enumerateOccurrences(value: unknown, pointer = ""): JsonOccurrence[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ pointer, value, type: "array" }];
    return value.flatMap((item, index) => enumerateOccurrences(item, `${pointer}/${index}`));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [{ pointer, value, type: "object" }];
    return entries.flatMap(([key, child]) =>
      enumerateOccurrences(child, `${pointer}/${escapeJsonPointer(key)}`)
    );
  }
  return [{ pointer, value, type: jsonValueType(value) }];
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (jsonValueType(left) !== jsonValueType(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightRecord = right as Record<string, unknown>;
    return (
      leftEntries.length === Object.keys(rightRecord).length &&
      leftEntries.every(([key, value]) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        jsonValuesEqual(value, rightRecord[key])
      )
    );
  }
  return Object.is(left, right);
}

function buildPreservationProof(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  lineage: PkmOccurrenceLineage[] = []
): { receipt: PreservationReceiptV1; issueCodes: string[]; afterCount: number } {
  const issueCodes = new Set<string>();
  const sourceOccurrences = enumerateOccurrences(before);
  const targetOccurrences = new Map(
    enumerateOccurrences(after).map((occurrence) => [occurrence.pointer, occurrence])
  );
  const explicitLineage = new Map(lineage.map((entry) => [entry.sourcePointer, entry]));
  const counts = {
    preserved: 0,
    moved: 0,
    equalValueDeduplicated: 0,
    quarantined: 0,
    rejected: 0,
  };

  for (const source of sourceOccurrences) {
    const declared = explicitLineage.get(source.pointer);
    const classification = declared?.classification || "preserved";
    const targetPointer = declared?.targetPointer ?? source.pointer;
    const target = targetOccurrences.get(targetPointer);
    if (!target) {
      issueCodes.add("source_occurrence_unmapped");
      issueCodes.add("field_dropped");
      counts.rejected += 1;
      continue;
    }
    if (source.type !== target.type) {
      issueCodes.add("source_occurrence_type_changed");
      issueCodes.add("leaf_changed");
      counts.rejected += 1;
      continue;
    }
    if (!jsonValuesEqual(source.value, target.value)) {
      issueCodes.add("source_occurrence_value_changed");
      issueCodes.add("leaf_changed");
      counts.rejected += 1;
      continue;
    }
    if (classification === "preserved" && source.pointer !== targetPointer) {
      issueCodes.add("preserved_occurrence_moved_without_lineage");
      counts.rejected += 1;
      continue;
    }
    if (classification === "moved" && source.pointer === targetPointer) {
      issueCodes.add("moved_occurrence_has_same_pointer");
      counts.rejected += 1;
      continue;
    }
    if (classification === "preserved") counts.preserved += 1;
    else if (classification === "moved") counts.moved += 1;
    else if (classification === "equal_value_deduplicated") counts.equalValueDeduplicated += 1;
    else counts.quarantined += 1;
  }

  const totalSourceOccurrences = sourceOccurrences.length;
  const classified =
    counts.preserved +
    counts.moved +
    counts.equalValueDeduplicated +
    counts.quarantined;
  const complete = counts.rejected === 0 && classified === totalSourceOccurrences;
  if (!complete) issueCodes.add("preservation_receipt_incomplete");
  return {
    receipt: {
      schemaVersion: "pkm_preservation_receipt.v1",
      totalSourceOccurrences,
      ...counts,
      complete,
    },
    issueCodes: [...issueCodes].sort(),
    afterCount: enumerateOccurrences(after).length,
  };
}

export function validateLosslessDomainUpgrade(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  lineage: PkmOccurrenceLineage[] = []
): PkmLosslessValidation {
  const proof = buildPreservationProof(before, after, lineage);
  return {
    preserved: proof.receipt.complete,
    beforeLeafCount: proof.receipt.totalSourceOccurrences,
    afterLeafCount: proof.afterCount,
    issueCodes: proof.issueCodes,
    receipt: proof.receipt,
  };
}

type PkmDomainUpgradeStepResult = {
  domainData: Record<string, unknown>;
  /** Every occurrence the step put somewhere else; unlisted ones must stay put. */
  lineage: PkmOccurrenceLineage[];
};

type PkmDomainUpgradeStep = {
  toVersion: number;
  transform: (params: { domain: string; domainData: Record<string, unknown> }) => PkmDomainUpgradeStepResult;
};

const cloneStep = ({ domainData }: { domainData: Record<string, unknown> }): PkmDomainUpgradeStepResult => ({
  domainData: cloneRecord(domainData),
  lineage: [],
});

const RESERVED_BRANCH_MIGRATION_DOMAIN_SET: ReadonlySet<string> = new Set(RESERVED_BRANCH_MIGRATION_DOMAINS);

const LOSSLESS_DOMAIN_UPGRADE_STEPS: Record<number, PkmDomainUpgradeStep> = {
  1: { toVersion: 1, transform: cloneStep },
  2: { toVersion: 2, transform: cloneStep },
  3: { toVersion: 3, transform: cloneStep },
  4: { toVersion: 4, transform: cloneStep },
};

/**
 * Carry each original occurrence through every step's lineage, so the final
 * receipt is proved against the data as it was before the whole upgrade.
 */
function composeLineage(
  original: Record<string, unknown>,
  stepLineages: PkmOccurrenceLineage[][],
): PkmOccurrenceLineage[] {
  const composed: PkmOccurrenceLineage[] = [];
  const steps = stepLineages.map((lineage) => new Map(lineage.map((entry) => [entry.sourcePointer, entry])));
  for (const occurrence of enumerateOccurrences(original)) {
    let current = occurrence.pointer;
    let classification: PkmOccurrenceClassification = "preserved";
    for (const lineage of steps) {
      const declared = lineage.get(current);
      if (!declared) continue;
      current = declared.targetPointer;
      if (declared.classification !== "preserved") classification = declared.classification;
    }
    if (current !== occurrence.pointer || classification !== "preserved") {
      composed.push({ sourcePointer: occurrence.pointer, targetPointer: current, classification });
    }
  }
  return composed;
}

function assertSupportedStoredVersions(params: {
  currentVersion: number;
  targetVersion: number;
  manifest?: DomainManifest | null;
}): void {
  const manifest = params.manifest || null;
  const hasFutureVersion =
    params.currentVersion > params.targetVersion ||
    Number(manifest?.readable_summary_version || 0) > CURRENT_READABLE_SUMMARY_VERSION ||
    comparePkmSemanticVersions(
      String(manifest?.pkm_contract_version || "0.0.0"),
      CURRENT_PKM_CONTRACT_VERSION
    ) > 0 ||
    comparePkmSemanticVersions(
      String(manifest?.readable_projection_version || "0.0.0"),
      CURRENT_READABLE_PROJECTION_VERSION
    ) > 0;
  if (hasFutureVersion) {
    throw new PkmFutureVersionError();
  }
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

const FRIENDLY_EXPLICIT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  domain_registry_prepopulate: "Finance setup",
  financial_profile_sync: "Finance setup",
  kai_onboarding_completion: "Finance setup",
  kai_nav_tour_state: "Finance setup",
  kai_profile_preference_confirm: "Finance setup",
  kai_profile_setup_sync: "Finance setup",
};

export function extractKnownPkmSourceLabel(domainData: Record<string, unknown>): string | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: domainData, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 2_000) {
    const current = pending.shift();
    if (!current || current.depth > 12) continue;
    visited += 1;
    if (Array.isArray(current.value)) {
      current.value.forEach((value) => pending.push({ value, depth: current.depth + 1 }));
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      if (key === "source" && typeof value === "string") {
        const label = FRIENDLY_EXPLICIT_SOURCE_LABELS[value.trim().toLowerCase()];
        if (label) return label;
      }
      pending.push({ value, depth: current.depth + 1 });
    }
  }
  return null;
}

export function runDomainUpgrade(params: {
  domain: string;
  domainData: Record<string, unknown>;
  currentVersion: number;
  manifest?: DomainManifest | null;
}): PkmDomainUpgradeResult {
  const domain = String(params.domain || "").trim().toLowerCase();
  const targetVersion = currentDomainContractVersion(domain);
  const fromVersion = Math.max(0, params.currentVersion || 0);
  assertSupportedStoredVersions({
    currentVersion: fromVersion,
    targetVersion,
    manifest: params.manifest,
  });
  const compatibility = inferPkmDomainCompatibility({
    domainData: params.domainData,
    manifest: params.manifest || null,
  });
  // Unversioned or legacy information bootstraps through every step.
  const notes: string[] = fromVersion <= 0
    ? [`Rebuilt ${titleize(domain)} into the current Personal Knowledge Model contract from legacy or unversioned information.`]
    : [];
  let nextDomainData = cloneRecord(params.domainData);
  let nextVersion = fromVersion;
  const stepLineages: PkmOccurrenceLineage[][] = [];
  let reservedMigration: ReservedMigrationReport | undefined;

  while (nextVersion < targetVersion) {
    const toVersion = nextVersion + 1;
    const step = LOSSLESS_DOMAIN_UPGRADE_STEPS[toVersion];
    if (!step || step.toVersion !== toVersion) {
      throw new Error(`Missing PKM domain upgrade transform for version ${toVersion}.`);
    }
    const candidate = step.transform({ domain, domainData: nextDomainData });
    const stepValidation = validateLosslessDomainUpgrade(nextDomainData, candidate.domainData, candidate.lineage);
    if (!stepValidation.preserved) {
      throw new PkmLosslessUpgradeError(stepValidation);
    }
    nextDomainData = candidate.domainData;
    nextVersion = toVersion;
    stepLineages.push(candidate.lineage);
    if (fromVersion > 0) {
      notes.push(`Refreshed ${titleize(domain)} with the generic dynamic PKM capability pipeline.`);
    }
  }

  // The reserved-branch relocation is not a version step: it runs on every
  // upgrade of a domain that holds a reserved branch, and is idempotent, so a
  // domain already relocated passes through unchanged. Its completion is the
  // manifest marker the orchestrator stamps (RESERVED_BRANCH_MIGRATION_MARKER).
  if (RESERVED_BRANCH_MIGRATION_DOMAIN_SET.has(domain)) {
    const relocated = relocateAgentEntriesFromReservedBranches({ domain, domainData: nextDomainData });
    const relocationValidation = validateLosslessDomainUpgrade(
      nextDomainData,
      relocated.domainData,
      relocated.lineage,
    );
    if (!relocationValidation.preserved) {
      throw new PkmLosslessUpgradeError(relocationValidation);
    }
    nextDomainData = relocated.domainData;
    stepLineages.push(relocated.lineage);
    reservedMigration = relocated.report;
    if (relocated.lineage.length > 0) {
      notes.push(
        `Moved ${relocated.report.moved} agent-written ${titleize(domain)} entries out of app-owned branches; ` +
          `${relocated.report.quarantined} ambiguous entries were preserved privately.`
      );
    }
  }

  const lineage = composeLineage(params.domainData, stepLineages);
  const losslessValidation = validateLosslessDomainUpgrade(params.domainData, nextDomainData, lineage);
  if (!losslessValidation.preserved) {
    throw new PkmLosslessUpgradeError(losslessValidation);
  }

  return {
    domainData: nextDomainData,
    notes,
    newDomainContractVersion: targetVersion,
    pkmContractVersion: CURRENT_PKM_CONTRACT_VERSION,
    readableProjectionVersion: CURRENT_READABLE_PROJECTION_VERSION,
    capabilitiesApplied: compatibility.capabilities,
    compatibility,
    losslessValidation,
    lineage,
    ...(reservedMigration ? { reservedMigration } : {}),
  };
}

export function buildReadableUpgradeSummary(params: {
  domain: string;
  domainData?: Record<string, unknown> | null;
  domainSummary?: DomainSummary | null;
  manifest?: DomainManifest | null;
  upgradedAt?: string;
  notes?: string[];
}): {
  readable_summary: string;
  readable_highlights: string[];
  readable_updated_at: string;
  readable_source_label: string | null;
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
  const sourceLabel = params.domainData
    ? extractKnownPkmSourceLabel(params.domainData)
    : null;
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
    readable_source_label: sourceLabel,
    readable_event_summary: `Updated ${domainLabel} memory.`,
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    readable_projection_version: CURRENT_READABLE_PROJECTION_VERSION,
    pkm_contract_version: CURRENT_PKM_CONTRACT_VERSION,
    upgraded_at: upgradedAt,
  };
}
