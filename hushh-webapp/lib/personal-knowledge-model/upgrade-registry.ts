import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  CURRENT_READABLE_SUMMARY_VERSION,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import type { DomainSummary } from "@/lib/services/personal-knowledge-model-service";

export type PkmDomainUpgradeResult = {
  domainData: Record<string, unknown>;
  notes: string[];
  newDomainContractVersion: number;
};

type PkmDomainUpgradeStep = {
  fromVersion: number;
  toVersion: number;
  apply: (domainData: Record<string, unknown>) => Record<string, unknown>;
  note: string;
};

const DOMAIN_UPGRADE_REGISTRY: Record<string, PkmDomainUpgradeStep[]> = {
  financial: [
    {
      fromVersion: 1,
      toVersion: 2,
      apply: (domainData) => ({ ...domainData }),
      note: "Refreshed the Financial contract metadata for resumable PKM upgrades.",
    },
  ],
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
}): PkmDomainUpgradeResult {
  const targetVersion = currentDomainContractVersion(params.domain);
  let nextDomainData = cloneRecord(params.domainData);
  let nextVersion = Math.max(0, params.currentVersion || 0);
  const notes: string[] = [];
  const steps = DOMAIN_UPGRADE_REGISTRY[String(params.domain || "").trim().toLowerCase()] || [];

  while (nextVersion < targetVersion) {
    const matchingStep = steps.find((step) => step.fromVersion === nextVersion);
    if (matchingStep) {
      nextDomainData = matchingStep.apply(nextDomainData);
      nextVersion = matchingStep.toVersion;
      notes.push(matchingStep.note);
      continue;
    }
    nextVersion += 1;
    notes.push(`Refreshed ${titleize(params.domain)} to contract v${nextVersion}.`);
  }

  return {
    domainData: nextDomainData,
    notes,
    newDomainContractVersion: targetVersion,
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
  upgraded_at: string;
} {
  const domainLabel =
    params.domainSummary?.displayName || titleize(String(params.domain || "Profile"));
  const sections = summarizeSections(params.manifest);
  const attributeCount = Number(params.domainSummary?.attributeCount || 0);
  const upgradedAt = params.upgradedAt || new Date().toISOString();
  const highlights = [
    sections.length > 0 ? `Updated sections: ${sections.join(", ")}` : null,
    attributeCount > 0
      ? `${attributeCount} saved detail${attributeCount === 1 ? "" : "s"} kept intact`
      : null,
    params.notes && params.notes.length > 0 ? params.notes[0] : null,
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);

  return {
    readable_summary: `Kai refreshed your ${domainLabel.toLowerCase()} data so it stays organized and ready to review.`,
    readable_highlights: highlights.slice(0, 5),
    readable_updated_at: upgradedAt,
    readable_source_label: "PKM Upgrade",
    readable_event_summary: `Refreshed ${domainLabel} for the latest private model.`,
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    upgraded_at: upgradedAt,
  };
}
