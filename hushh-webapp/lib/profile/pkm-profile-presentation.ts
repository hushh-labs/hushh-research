"use client";

import {
  buildNaturalAccessEntries,
  buildNaturalDomainPresentation,
  type NaturalAccessEntry,
  type NaturalDomainPresentation,
} from "@/lib/personal-knowledge-model/natural-language";
import type { DomainSummary, PersonalKnowledgeModelMetadata } from "@/lib/services/personal-knowledge-model-service";
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

function normalizeToken(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, "");
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
    labels.add("Kai memory");
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

export function buildPkmDomainPresentation(params: {
  domain: DomainSummary;
  activeGrants: ConsentCenterEntry[];
}): PkmDomainPresentation {
  const presentation = buildNaturalDomainPresentation({
    domain: params.domain,
    manifest: null,
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

  return {
    key: params.domain.key,
    title: presentation.title,
    summary: presentation.summary,
    highlights: presentation.highlights.slice(0, 4),
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
