import type { DomainSummary } from "@/lib/services/personal-knowledge-model-service";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";

export type ReadablePkmMetadata = {
  readable_summary: string;
  readable_highlights: string[];
  readable_updated_at: string;
  readable_source_label: string;
  readable_event_summary: string;
};

export type NaturalDomainPresentation = {
  title: string;
  summary: string;
  highlights: string[];
  sections: string[];
  sourceLabel: string | null;
  updatedAt: string | null;
};

export type NaturalAccessEntry = {
  id: string;
  requesterLabel: string;
  requesterImageUrl?: string | null;
  readableAccessLabel: string;
  coverageKind: "broad" | "limited";
  status: string;
  expiresAt: string | null;
};

function normalizeToken(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, "");
}

function humanizePath(value: string | null | undefined, separator = " > "): string {
  const parts = String(value || "")
    .split(".")
    .map((part) =>
      part
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (match) => match.toUpperCase())
        .trim()
    )
    .filter(Boolean);
  return parts.join(separator);
}

function clampText(value: string | null | undefined, maxLength = 96): string | null {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    items.push(trimmed);
  }
  return items;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] || "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function normalizeSectionPath(path: string): string {
  const normalized = normalizeToken(path);
  if (!normalized) return "";
  return normalized.replace(/^entities\./, "");
}

function deriveSections(params: {
  domainKey: string;
  manifest?: DomainManifest | null;
  structureDecision?: Record<string, unknown> | null;
  primaryJsonPath?: string | null;
  targetEntityScope?: string | null;
  availableScopes?: string[];
}): string[] {
  const preferredPaths = uniqueStrings([
    ...toStringArray(params.manifest?.top_level_scope_paths),
    ...toStringArray(params.structureDecision?.top_level_scope_paths),
  ]);
  const fallbackPaths: string[] = [];

  const primaryPath = normalizeSectionPath(params.primaryJsonPath || params.targetEntityScope || "");
  if (primaryPath) {
    fallbackPaths.push(primaryPath.split(".")[0] || primaryPath);
  }

  for (const scope of params.availableScopes || []) {
    const prefix = `attr.${normalizeToken(params.domainKey)}.`;
    if (!scope.startsWith(prefix)) continue;
    const remainder = scope.slice(prefix.length).replace(/\.\*$/, "");
    if (!remainder || remainder === "*") continue;
    const section = normalizeSectionPath(remainder).split(".")[0];
    if (section) fallbackPaths.push(section);
  }

  return uniqueStrings(
    [...preferredPaths, ...fallbackPaths].map((path) => humanizePath(path, " "))
  ).slice(0, 6);
}

function toReadableHighlights(value: unknown): string[] {
  return uniqueStrings(toStringArray(value).map((item) => clampText(item, 120))).slice(0, 5);
}

function toReadableSourceLabel(value: unknown): string | null {
  const normalized = clampText(typeof value === "string" ? value : "", 48);
  return normalized || null;
}

function deriveFallbackSummary(domain: DomainSummary, sections: string[]): string {
  const messageExcerpt = clampText(
    typeof domain.summary?.message_excerpt === "string" ? domain.summary.message_excerpt : "",
    120
  );

  if (messageExcerpt && sections.length > 0) {
    return `Kai saved a ${domain.displayName.toLowerCase()} update from one of your notes, focused on ${formatList(
      sections.slice(0, 2)
    ).toLowerCase()}.`;
  }
  if (sections.length === 1) {
    const firstSection = sections[0] || "saved";
    return `Kai keeps a readable view of your ${domain.displayName.toLowerCase()} ${firstSection.toLowerCase()} details.`;
  }
  if (sections.length > 1) {
    return `Kai keeps a readable view of your ${domain.displayName.toLowerCase()} details across ${formatList(
      sections.slice(0, 3)
    ).toLowerCase()}.`;
  }
  if (domain.attributeCount > 0) {
    return `Kai has ${domain.attributeCount} saved ${domain.displayName.toLowerCase()} detail${
      domain.attributeCount === 1 ? "" : "s"
    } ready for you to review.`;
  }
  return `Kai has a saved ${domain.displayName.toLowerCase()} profile ready for you to review.`;
}

function deriveFallbackHighlights(domain: DomainSummary, sections: string[]): string[] {
  const highlights: Array<string | null> = [
    domain.attributeCount > 0
      ? `${domain.attributeCount} saved detail${domain.attributeCount === 1 ? "" : "s"}`
      : null,
    sections.length > 0 ? `Organized into ${formatList(sections.slice(0, 3))}` : null,
    typeof domain.summary?.externalizable_path_count === "number"
      ? `${domain.summary.externalizable_path_count} consent-ready branches`
      : typeof domain.summary?.externalizable_path_count === "string"
        ? `${domain.summary.externalizable_path_count} consent-ready branches`
        : null,
    clampText(
      typeof domain.summary?.message_excerpt === "string"
        ? `Latest note: ${domain.summary.message_excerpt}`
        : "",
      120
    ),
  ];
  return uniqueStrings(highlights).slice(0, 5);
}

function deriveMergeHighlight(mergeMode: string | null | undefined): string | null {
  const normalized = normalizeToken(mergeMode);
  if (!normalized) return null;
  if (normalized.includes("update") || normalized.includes("merge")) {
    return "Merged into an existing memory";
  }
  if (normalized.includes("create")) {
    return "Saved as a new memory";
  }
  return null;
}

export function buildReadablePkmMetadata(params: {
  domainKey: string;
  domainDisplayName?: string | null;
  sourceText?: string | null;
  mergeMode?: string | null;
  intentClass?: string | null;
  manifest?: DomainManifest | null;
  structureDecision?: Record<string, unknown> | null;
  primaryJsonPath?: string | null;
  targetEntityScope?: string | null;
  createdAt?: string | null;
}): ReadablePkmMetadata {
  const domainDisplayName =
    clampText(params.domainDisplayName, 48) ||
    humanizePath(normalizeToken(params.domainKey).replace(/\./g, " "), " ");
  const sections = deriveSections({
    domainKey: params.domainKey,
    manifest: params.manifest,
    structureDecision: params.structureDecision,
    primaryJsonPath: params.primaryJsonPath,
    targetEntityScope: params.targetEntityScope,
  });
  const capturedAt = params.createdAt || new Date().toISOString();
  const messageExcerpt = clampText(params.sourceText, 120);
  const intentLabel = humanizePath(params.intentClass || "", " ");
  const sectionSentence =
    sections.length > 0
      ? `focused on ${formatList(sections.slice(0, 2)).toLowerCase()}`
      : `for your ${domainDisplayName.toLowerCase()} profile`;
  const readableSummary = `Kai saved a ${domainDisplayName.toLowerCase()} update ${sectionSentence}.`;

  const readableHighlights = uniqueStrings([
    sections.length > 0 ? `Updated sections: ${formatList(sections.slice(0, 3))}` : null,
    deriveMergeHighlight(params.mergeMode),
    intentLabel ? `Intent: ${intentLabel}` : null,
    messageExcerpt ? `Captured from: ${messageExcerpt}` : null,
  ]).slice(0, 5);

  const readableEventSummary =
    sections.length > 0
      ? `Updated ${domainDisplayName} across ${formatList(sections.slice(0, 2))}.`
      : `Updated ${domainDisplayName}.`;

  return {
    readable_summary: readableSummary,
    readable_highlights: readableHighlights,
    readable_updated_at: capturedAt,
    readable_source_label: "PKM Agent Lab",
    readable_event_summary: readableEventSummary,
  };
}

export function buildNaturalDomainPresentation(params: {
  domain: DomainSummary;
  manifest?: DomainManifest | null;
}): NaturalDomainPresentation {
  const sections = deriveSections({
    domainKey: params.domain.key,
    manifest: params.manifest,
    availableScopes: params.domain.availableScopes,
  });

  const readableSummary = clampText(params.domain.readableSummary, 240);
  const readableSourceLabel = toReadableSourceLabel(params.domain.readableSourceLabel);
  const readableHighlights = toReadableHighlights(params.domain.readableHighlights);

  return {
    title: params.domain.displayName,
    summary: readableSummary || deriveFallbackSummary(params.domain, sections),
    highlights:
      readableHighlights.length > 0
        ? readableHighlights
        : deriveFallbackHighlights(params.domain, sections),
    sections,
    sourceLabel: readableSourceLabel,
    updatedAt: params.domain.readableUpdatedAt || params.domain.lastUpdated,
  };
}

function scopeTouchesDomain(scope: string | null | undefined, domainKey: string): boolean {
  const normalizedScope = String(scope || "").trim();
  const normalizedDomain = normalizeToken(domainKey);
  if (!normalizedScope || !normalizedDomain) return false;
  if (normalizedScope === "pkm.read" || normalizedScope === "vault.owner") return true;
  return (
    normalizedScope === `attr.${normalizedDomain}.*` ||
    normalizedScope.startsWith(`attr.${normalizedDomain}.`)
  );
}

function describeScopeForDomain(
  scope: string | null | undefined,
  domain: DomainSummary
): { label: string; coverageKind: "broad" | "limited" } | null {
  const normalizedScope = String(scope || "").trim();
  const normalizedDomain = normalizeToken(domain.key);
  if (!scopeTouchesDomain(normalizedScope, normalizedDomain)) return null;

  if (normalizedScope === "pkm.read") {
    return {
      label: "Can access all of your saved data.",
      coverageKind: "broad",
    };
  }
  if (normalizedScope === "vault.owner") {
    return {
      label: "Can manage your full vault and everything inside it.",
      coverageKind: "broad",
    };
  }

  const prefix = `attr.${normalizedDomain}.`;
  const remainder = normalizedScope.startsWith(prefix)
    ? normalizedScope.slice(prefix.length)
    : normalizedScope === `attr.${normalizedDomain}.*`
      ? "*"
      : "";

  if (!remainder || remainder === "*") {
    return {
      label: `Can access all ${domain.displayName} data.`,
      coverageKind: "broad",
    };
  }

  const withoutWildcard = remainder.replace(/\.\*$/, "");
  return {
    label: `Can access ${domain.displayName} > ${humanizePath(withoutWildcard)}.`,
    coverageKind: remainder.endsWith(".*") ? "limited" : "limited",
  };
}

export function buildNaturalAccessEntries(params: {
  domain: DomainSummary;
  activeGrants: ConsentCenterEntry[];
}): NaturalAccessEntry[] {
  const entries: NaturalAccessEntry[] = [];
  for (const grant of params.activeGrants) {
    const description = describeScopeForDomain(grant.scope, params.domain);
    if (!description) continue;
    entries.push({
      id: grant.id,
      requesterLabel: String(grant.counterpart_label || "Connected app"),
      requesterImageUrl: grant.counterpart_image_url,
      readableAccessLabel: description.label,
      coverageKind: description.coverageKind,
      status: String(grant.status || "active"),
      expiresAt:
        typeof grant.expires_at === "string"
          ? grant.expires_at
          : typeof grant.expires_at === "number"
            ? new Date(grant.expires_at).toISOString()
            : null,
    });
  }
  return entries;
}
