"use client";

import {
  buildNaturalAccessEntries,
  buildNaturalDomainPresentation,
  type NaturalAccessEntry,
  type NaturalDomainPresentation,
} from "@/lib/personal-knowledge-model/natural-language";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  CURRENT_READABLE_SUMMARY_VERSION,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import type {
  DomainSummary,
  PersonalKnowledgeModelMetadata,
  PkmUpgradeDomainState,
} from "@/lib/services/personal-knowledge-model-service";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

export type PkmDomainStatus = "complete" | "partial" | "missing" | "stale";
export type PkmDensity = "relaxed" | "compact" | "dense";

export type PkmDomainAccessPresentation = NaturalAccessEntry & {
  scope: string;
  counterpartType: ConsentCenterEntry["counterpart_type"];
  domainKey: string;
  domainTitle: string;
};

export type PkmDomainPresentation = {
  key: string;
  title: string;
  summary: string;
  highlights: string[];
  sections: string[];
  sourceLabels: string[];
  updatedAt: string | null;
  detailCount: number;
  status: PkmDomainStatus;
  statusLabel: string;
  accessEntries: PkmDomainAccessPresentation[];
  accessSummary: string;
  accessCount: number;
  attentionFlags: string[];
  permissionCount: number;
  enabledPermissionCount: number;
};

export type PkmDomainPermissionPresentation = {
  key: string;
  scopeHandle: string | null;
  topLevelScopePath: string;
  label: string;
  description: string;
  exposureEnabled: boolean;
  sensitivityTier: string;
  activeReaderCount: number;
  requesterLabels: string[];
  counterpartSummary: string;
  includesBroadAccess: boolean;
  disabledReason?: string;
};

export type PkmDomainUpgradePresentation = {
  status: "current" | "updating" | "missing_manifest";
  label: string;
  description: string;
  canManagePermissions: boolean;
};

export type PkmAccessConnectionPresentation = {
  id: string;
  requesterLabel: string;
  requesterImageUrl?: string | null;
  counterpartType: ConsentCenterEntry["counterpart_type"];
  domains: string[];
  grants: PkmDomainAccessPresentation[];
  broadAccessCount: number;
  accessCount: number;
};

export type PkmProfileSummaryPresentation = {
  metadataResolved: boolean;
  sharingResolved: boolean;
  totalDomains: number;
  totalAttributes: number;
  totalSourceCount: number;
  activeGrantCount: number;
  sharedDomainCount: number;
  staleDomainCount: number;
  missingDomainCount: number;
  density: PkmDensity;
  lastUpdated: string | null;
  recentDomainTitles: string[];
  attentionItems: string[];
};

const INTERNAL_ONLY_TOP_LEVEL_SCOPE_PATHS = new Set([
  "domain_intent",
  "schema_version",
  "updated_at",
]);

function normalizeToken(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, "");
}

function humanizePath(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .split(".")
    .map((segment) =>
      segment
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (match) => match.toUpperCase())
        .trim()
    )
    .filter(Boolean)
    .join(" ");
}

function daysSince(value: string | null | undefined): number | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const timestamp = new Date(text).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
}

function inferSourceLabels(
  domain: DomainSummary,
  presentation: NaturalDomainPresentation
): string[] {
  const labels = new Set<string>();
  if (presentation.sourceLabel) {
    labels.add(presentation.sourceLabel);
  }

  const key = normalizeToken(domain.key);
  if (key.includes("receipt") || key.includes("gmail") || key.includes("merchant")) {
    labels.add("Gmail receipts");
  }
  if (
    key.includes("portfolio") ||
    key.includes("financial") ||
    key.includes("brokerage") ||
    key.includes("holding") ||
    key.includes("investment")
  ) {
    labels.add("Portfolio imports");
  }
  if (key.includes("preference") || key.includes("risk") || key.includes("profile")) {
    labels.add("Manual preferences");
  }
  if (key.includes("identity") || key.includes("contact")) {
    labels.add("Account profile");
  }
  if (labels.size === 0) {
    if (key.includes("ria") || key.includes("advisor")) {
      labels.add("Advisor package");
    } else {
      labels.add("Saved memory");
    }
  }
  return Array.from(labels).slice(0, 3);
}

function toStatus(
  domain: DomainSummary,
  presentation: NaturalDomainPresentation
): { status: PkmDomainStatus; statusLabel: string } {
  const ageDays = daysSince(presentation.updatedAt);
  if (domain.attributeCount <= 0) {
    return { status: "missing", statusLabel: "Missing" };
  }
  if (ageDays !== null && ageDays >= 30) {
    return { status: "stale", statusLabel: "Stale" };
  }
  if (domain.attributeCount < 4 || presentation.sections.length < 2) {
    return { status: "partial", statusLabel: "Partial" };
  }
  return { status: "complete", statusLabel: "Complete" };
}

function summarizeAccess(entries: PkmDomainAccessPresentation[]): string {
  if (!entries.length) return "No active access";
  const counts = {
    apps: entries.filter((entry) => entry.counterpartType === "developer").length,
    advisors: entries.filter((entry) => entry.counterpartType === "ria").length,
    people: entries.filter((entry) => entry.counterpartType === "investor").length,
  };
  const phrases: string[] = [];
  if (counts.apps > 0) phrases.push(`${counts.apps} app${counts.apps === 1 ? "" : "s"}`);
  if (counts.advisors > 0) {
    phrases.push(`${counts.advisors} advisor${counts.advisors === 1 ? "" : "s"}`);
  }
  if (counts.people > 0) phrases.push(`${counts.people} person${counts.people === 1 ? "" : "s"}`);
  if (phrases.length === 0) return `${entries.length} active connection${entries.length === 1 ? "" : "s"}`;
  if (phrases.length === 1) return `${phrases[0]} can read this`;
  return `${phrases.slice(0, -1).join(" + ")} + ${phrases.at(-1)} have access`;
}

function isConsumerHighlightUseful(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (/\bsaved details?\b/.test(normalized)) return false;
  if (normalized.startsWith("organized into ")) return false;
  if (/\bconsent-ready\b/.test(normalized)) return false;
  if (/\bbranches?\b/.test(normalized)) return false;
  return true;
}

export function buildPkmDomainPresentation(params: {
  domain: DomainSummary;
  activeGrants: ConsentCenterEntry[];
  manifest?: DomainManifest | null;
  upgradeState?: PkmUpgradeDomainState | null;
}): PkmDomainPresentation {
  const presentation = buildNaturalDomainPresentation({
    domain: params.domain,
    manifest: params.manifest || null,
  });

  const accessEntries = buildNaturalAccessEntries({
    domain: params.domain,
    activeGrants: params.activeGrants,
  }).map((entry): PkmDomainAccessPresentation => {
    const grant = params.activeGrants.find((candidate) => candidate.id === entry.id);
    return {
      ...entry,
      scope: String(grant?.scope || ""),
      counterpartType: grant?.counterpart_type || "developer",
      domainKey: params.domain.key,
      domainTitle: params.domain.displayName,
    };
  });

  const sourceLabels = inferSourceLabels(params.domain, presentation);
  const { status, statusLabel } = toStatus(params.domain, presentation);
  const attentionFlags: string[] = [];
  if (status === "missing") attentionFlags.push("Needs data");
  if (status === "stale") attentionFlags.push("Refresh recommended");
  if (accessEntries.length > 0) attentionFlags.push("Shared");
  const permissions = buildPkmDomainPermissionPresentation({
    domain: params.domain,
    manifest: params.manifest || null,
    activeGrants: params.activeGrants,
    upgradeState: params.upgradeState || null,
  });
  if (permissions.length > 0) {
    attentionFlags.push(
      `${permissions.filter((permission) => permission.exposureEnabled).length} shareable section${
        permissions.filter((permission) => permission.exposureEnabled).length === 1 ? "" : "s"
      }`
    );
  }

  return {
    key: params.domain.key,
    title: presentation.title,
    summary: presentation.summary,
    highlights: presentation.highlights.filter(isConsumerHighlightUseful).slice(0, 4),
    sections: presentation.sections,
    sourceLabels,
    updatedAt: presentation.updatedAt,
    detailCount: params.domain.attributeCount,
    status,
    statusLabel,
    accessEntries,
    accessSummary: summarizeAccess(accessEntries),
    accessCount: accessEntries.length,
    attentionFlags,
    permissionCount: permissions.length,
    enabledPermissionCount: permissions.filter((permission) => permission.exposureEnabled).length,
  };
}

export function buildPkmAccessConnections(
  domains: PkmDomainPresentation[]
): PkmAccessConnectionPresentation[] {
  const grouped = new Map<string, PkmAccessConnectionPresentation>();
  for (const domain of domains) {
    for (const grant of domain.accessEntries) {
      const key = `${grant.counterpartType}:${grant.requesterLabel}`;
      const current = grouped.get(key);
      if (current) {
        current.grants.push(grant);
        if (!current.domains.includes(domain.title)) current.domains.push(domain.title);
        current.accessCount += 1;
        if (grant.coverageKind === "broad") current.broadAccessCount += 1;
        continue;
      }
      grouped.set(key, {
        id: key,
        requesterLabel: grant.requesterLabel,
        requesterImageUrl: grant.requesterImageUrl,
        counterpartType: grant.counterpartType,
        domains: [domain.title],
        grants: [grant],
        broadAccessCount: grant.coverageKind === "broad" ? 1 : 0,
        accessCount: 1,
      });
    }
  }

  return Array.from(grouped.values()).sort((left, right) => {
    if (right.accessCount !== left.accessCount) return right.accessCount - left.accessCount;
    return left.requesterLabel.localeCompare(right.requesterLabel);
  });
}

function resolveDensity(params: {
  metadata: PersonalKnowledgeModelMetadata | null;
  activeGrantCount: number;
}): PkmDensity {
  const totalDomains = params.metadata?.domains.length ?? 0;
  const totalAttributes = params.metadata?.totalAttributes ?? 0;
  if (totalDomains >= 8 || totalAttributes >= 60 || params.activeGrantCount >= 12) {
    return "dense";
  }
  if (totalDomains >= 4 || totalAttributes >= 24 || params.activeGrantCount >= 6) {
    return "compact";
  }
  return "relaxed";
}

export function buildPkmProfileSummaryPresentation(params: {
  metadata: PersonalKnowledgeModelMetadata | null;
  domains: PkmDomainPresentation[];
  activeGrants: ConsentCenterEntry[];
  pendingRequestCount?: number;
  metadataResolved?: boolean;
  sharingResolved?: boolean;
}): PkmProfileSummaryPresentation {
  const staleDomainCount = params.domains.filter((domain) => domain.status === "stale").length;
  const missingDomainCount = params.domains.filter((domain) => domain.status === "missing").length;
  const sharedDomainCount = params.domains.filter((domain) => domain.accessCount > 0).length;
  const totalSourceCount = new Set(
    params.domains.flatMap((domain) => domain.sourceLabels.map((label) => label.trim())).filter(Boolean)
  ).size;
  const attentionItems: string[] = [];
  if (missingDomainCount > 0) {
    attentionItems.push(`${missingDomainCount} domain${missingDomainCount === 1 ? "" : "s"} still need data.`);
  }
  if (staleDomainCount > 0) {
    attentionItems.push(`${staleDomainCount} domain${staleDomainCount === 1 ? "" : "s"} should be refreshed.`);
  }
  if ((params.pendingRequestCount || 0) > 0) {
    const pending = params.pendingRequestCount || 0;
    attentionItems.push(`${pending} access request${pending === 1 ? "" : "s"} waiting for review.`);
  }
  if (attentionItems.length === 0 && params.domains.length > 0) {
    attentionItems.push("Your saved data is readable and ready to manage.");
  }

  return {
    metadataResolved: params.metadataResolved ?? params.metadata !== null,
    sharingResolved: params.sharingResolved ?? true,
    totalDomains: params.metadata?.domains.length ?? 0,
    totalAttributes: params.metadata?.totalAttributes ?? 0,
    totalSourceCount,
    activeGrantCount: params.activeGrants.length,
    sharedDomainCount,
    staleDomainCount,
    missingDomainCount,
    density: resolveDensity({
      metadata: params.metadata,
      activeGrantCount: params.activeGrants.length,
    }),
    lastUpdated: params.metadata?.lastUpdated ?? null,
    recentDomainTitles: [...params.domains]
      .sort((left, right) => {
        const leftTimestamp = new Date(left.updatedAt || 0).getTime();
        const rightTimestamp = new Date(right.updatedAt || 0).getTime();
        return rightTimestamp - leftTimestamp;
      })
      .slice(0, 4)
      .map((domain) => domain.title),
    attentionItems,
  };
}

function extractTopLevelScopePath(
  entry: NonNullable<DomainManifest["scope_registry"]>[number]
): string {
  const projection =
    entry.summary_projection && typeof entry.summary_projection === "object"
      ? entry.summary_projection
      : {};
  const fromProjection = String(projection.top_level_scope_path || "").trim();
  if (fromProjection) return fromProjection;
  const fallback = normalizeToken(entry.scope_label).replace(/\s+/g, "_");
  return fallback;
}

function isConsumerVisibleScopeEntry(
  entry: NonNullable<DomainManifest["scope_registry"]>[number]
): boolean {
  const projection =
    entry.summary_projection && typeof entry.summary_projection === "object"
      ? entry.summary_projection
      : {};
  const topLevelScopePath = extractTopLevelScopePath(entry);
  if (projection.internal_only === true) return false;
  if (projection.consumer_visible === false) return false;
  return !INTERNAL_ONLY_TOP_LEVEL_SCOPE_PATHS.has(normalizeToken(topLevelScopePath));
}

function isConsumerVisibleTopLevelScopePath(path: string | null | undefined): boolean {
  const normalized = normalizeToken(path);
  return Boolean(normalized) && !INTERNAL_ONLY_TOP_LEVEL_SCOPE_PATHS.has(normalized);
}

function scopeTouchesPermission(
  scope: string | null | undefined,
  domainKey: string,
  topLevelScopePath: string
): boolean {
  const normalizedScope = String(scope || "").trim();
  const normalizedDomain = normalizeToken(domainKey);
  const normalizedTopLevel = normalizeToken(topLevelScopePath);
  if (!normalizedScope || !normalizedDomain || !normalizedTopLevel) return false;
  if (normalizedScope === "pkm.read" || normalizedScope === "vault.owner") return true;
  if (normalizedScope === `attr.${normalizedDomain}.*`) return true;
  const prefix = `attr.${normalizedDomain}.${normalizedTopLevel}`;
  return normalizedScope === `${prefix}.*` || normalizedScope.startsWith(`${prefix}.`);
}

function summarizePermissionReaders(grants: ConsentCenterEntry[]): {
  activeReaderCount: number;
  requesterLabels: string[];
  counterpartSummary: string;
  includesBroadAccess: boolean;
} {
  const apps = new Set<string>();
  const advisors = new Set<string>();
  const people = new Set<string>();
  const labels = new Set<string>();
  let includesBroadAccess = false;

  for (const grant of grants) {
    const label = String(grant.counterpart_label || "").trim();
    if (label) labels.add(label);
    if (grant.scope === "pkm.read" || grant.scope === "vault.owner" || /\.?\*$/.test(String(grant.scope || ""))) {
      includesBroadAccess = true;
    }
    if (grant.counterpart_type === "developer") apps.add(label || "App");
    else if (grant.counterpart_type === "ria") advisors.add(label || "Advisor");
    else if (grant.counterpart_type === "investor") people.add(label || "Person");
  }

  const parts: string[] = [];
  if (apps.size > 0) parts.push(`${apps.size} app${apps.size === 1 ? "" : "s"}`);
  if (advisors.size > 0) parts.push(`${advisors.size} advisor${advisors.size === 1 ? "" : "s"}`);
  if (people.size > 0) parts.push(`${people.size} person${people.size === 1 ? "" : "s"}`);

  let counterpartSummary = "No one currently has access";
  if (parts.length === 1) counterpartSummary = `${parts[0]} currently has access`;
  else if (parts.length > 1) counterpartSummary = `${parts.slice(0, -1).join(" + ")} + ${parts.at(-1)} currently have access`;
  if (includesBroadAccess && grants.length > 0) {
    counterpartSummary = parts.length > 0 ? `${counterpartSummary} via broad or direct access` : "Included in broad access";
  }

  return {
    activeReaderCount: grants.length,
    requesterLabels: Array.from(labels).slice(0, 3),
    counterpartSummary,
    includesBroadAccess,
  };
}

export function buildPkmDomainUpgradePresentation(params: {
  domain: DomainSummary;
  manifest?: DomainManifest | null;
  upgradeState?: PkmUpgradeDomainState | null;
}): PkmDomainUpgradePresentation {
  const targetDomainVersion = currentDomainContractVersion(params.domain.key);
  const manifestDomainVersion = Number(params.manifest?.domain_contract_version || 0);
  const manifestReadableVersion = Number(params.manifest?.readable_summary_version || 0);
  const needsUpgrade =
    Boolean(params.upgradeState?.needsUpgrade) ||
    manifestDomainVersion > 0 && manifestDomainVersion < targetDomainVersion ||
    manifestReadableVersion > 0 && manifestReadableVersion < CURRENT_READABLE_SUMMARY_VERSION;

  if (!params.manifest) {
    return {
      status: "missing_manifest",
      label: "Updating structure",
      description:
        "This domain is still being prepared for section-level sharing controls. You can review the data now and manage detailed sharing once the manifest is ready.",
      canManagePermissions: false,
    };
  }

  if (needsUpgrade) {
    return {
      status: "updating",
      label: "Updating structure",
      description:
        "This domain is readable now. Sharing controls use the latest available manifest while the domain finishes upgrading in the background.",
      canManagePermissions: true,
    };
  }

  return {
    status: "current",
    label: "Current",
    description: "This domain is on the current structure and ready for viewing and sharing controls.",
    canManagePermissions: true,
  };
}

export function buildPkmDomainPermissionPresentation(params: {
  domain: DomainSummary;
  manifest?: DomainManifest | null;
  activeGrants: ConsentCenterEntry[];
  upgradeState?: PkmUpgradeDomainState | null;
}): PkmDomainPermissionPresentation[] {
  const upgrade = buildPkmDomainUpgradePresentation(params);
  const registry = Array.isArray(params.manifest?.scope_registry)
    ? params.manifest?.scope_registry || []
    : [];

  const permissionEntries =
    registry.length > 0
      ? registry
          .filter((entry) => isConsumerVisibleScopeEntry(entry))
          .map((entry) => ({
          scopeHandle: entry.scope_handle || null,
          scopeLabel: entry.scope_label || humanizePath(extractTopLevelScopePath(entry)),
          topLevelScopePath: extractTopLevelScopePath(entry),
          exposureEnabled: entry.exposure_enabled !== false,
          sensitivityTier: entry.sensitivity_tier || "confidential",
          preferenceRank:
            typeof entry.summary_projection?.manifest_version === "number"
              ? 2
              : entry.summary_projection?.storage_mode === "manifest"
                ? 1
                : 0,
        }))
      : (params.manifest?.top_level_scope_paths || [])
          .filter((path) => isConsumerVisibleTopLevelScopePath(path))
          .map((path) => ({
          scopeHandle: null,
          scopeLabel: humanizePath(path),
          topLevelScopePath: path,
          exposureEnabled: true,
          sensitivityTier: "confidential",
          preferenceRank: 0,
        }));

  const dedupedPermissionEntries = new Map<
    string,
    (typeof permissionEntries)[number]
  >();

  for (const entry of permissionEntries) {
    const normalizedTopLevelScopePath = normalizeToken(entry.topLevelScopePath);
    if (!normalizedTopLevelScopePath) {
      continue;
    }
    const existing = dedupedPermissionEntries.get(normalizedTopLevelScopePath);
    if (!existing || entry.preferenceRank > existing.preferenceRank) {
      dedupedPermissionEntries.set(normalizedTopLevelScopePath, entry);
    }
  }

  return Array.from(dedupedPermissionEntries.values())
    .map((entry) => {
      const matchingGrants = params.activeGrants.filter((grant) =>
        scopeTouchesPermission(grant.scope, params.domain.key, entry.topLevelScopePath)
      );
      const readerSummary = summarizePermissionReaders(matchingGrants);
      const disabledReason = upgrade.canManagePermissions
        ? undefined
        : "Section-level sharing will appear once this domain manifest is ready.";
      return {
        key: `${params.domain.key}:${entry.topLevelScopePath}`,
        scopeHandle: entry.scopeHandle,
        topLevelScopePath: entry.topLevelScopePath,
        label: entry.scopeLabel,
        description: `Controls whether approved apps or advisors can request the ${entry.scopeLabel.toLowerCase()} section of your ${params.domain.displayName.toLowerCase()} data.`,
        exposureEnabled: entry.exposureEnabled,
        sensitivityTier: entry.sensitivityTier,
        activeReaderCount: readerSummary.activeReaderCount,
        requesterLabels: readerSummary.requesterLabels,
        counterpartSummary: entry.exposureEnabled
          ? readerSummary.activeReaderCount > 0
            ? readerSummary.counterpartSummary
            : "Ready to share when you approve access"
          : readerSummary.activeReaderCount > 0
            ? readerSummary.counterpartSummary
            : "Hidden from new sharing",
        includesBroadAccess: readerSummary.includesBroadAccess,
        disabledReason,
      };
    });
}
