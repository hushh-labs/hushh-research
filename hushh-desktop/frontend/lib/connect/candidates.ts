/**
 * lib/connect/candidates.ts
 *
 * Normalizers and deduplication logic for Connect candidates.
 * Converts raw API types → ConnectCandidate, merges duplicates by candidateId.
 *
 * No direct fetch — all data is passed in from the service layer.
 */

import type {
  MarketplaceRia,
  MarketplaceInvestor,
  MarketplaceContactMatch,
  MarketplaceInvestorActionRecord,
  RiaClientAccess,
} from "@/lib/services/ria-service";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import {
  marketplaceInvestorCardId,
  marketplaceInvestorUserId,
  isMarketplaceInvestorConnectable,
  isMarketplaceInvestorShortlistable,
  isPublicSecMarketplaceInvestor,
  marketplaceInvestorSourceLabel,
  marketplaceInvestorCurationLabel,
} from "@/lib/marketplace/investor-discovery";
import { buildMarketplaceConnectionsRoute } from "@/lib/navigation/routes";
import type {
  ConnectCandidate,
  ConnectCandidateSource,
  ConnectPrimaryCta,
  ConnectStatus,
} from "./types";
import { buildCandidateId, mergeSourceTypes } from "./connect-visibility";
import { applyScoreToCandidate } from "./connect-ranking";

// ─── CTA Resolution ───────────────────────────────────────────────────────────

function resolvePrimaryCta(opts: {
  connectionStatus: ConnectStatus;
  isDiscoverable: boolean;
  canConnect: boolean;
  isTestProfile?: boolean;
  hasProfileHref: boolean;
}): ConnectPrimaryCta {
  const { connectionStatus, isDiscoverable, canConnect, isTestProfile, hasProfileHref } = opts;

  if (connectionStatus === "connected") return "view_connection";
  if (connectionStatus === "pending") return "review_request";
  if (connectionStatus === "connect_requested") return "open_profile";
  if (connectionStatus === "not_connectable" || connectionStatus === "private") {
    return hasProfileHref ? "open_profile" : "none";
  }
  if (isTestProfile) return "open_profile";
  if (canConnect && isDiscoverable) return "connect";
  if (hasProfileHref) return "open_profile";
  return "none";
}

function resolveSecondaryCtas(
  primaryCta: ConnectPrimaryCta,
  opts: {
    canShortlist: boolean;
    connectionStatus: ConnectStatus;
    hasProfileHref: boolean;
  },
): ConnectPrimaryCta[] {
  const secondary: ConnectPrimaryCta[] = [];
  if (primaryCta !== "open_profile" && opts.hasProfileHref) secondary.push("open_profile");
  if (primaryCta !== "shortlist" && opts.canShortlist) secondary.push("shortlist");
  return secondary.slice(0, 2);
}

// ─── Connection Status Helpers ────────────────────────────────────────────────

function consentEntryToStatus(entry: ConsentCenterEntry): ConnectStatus {
  const status = String(entry.relationship_status || entry.status || "").toLowerCase();
  if (["active", "approved", "granted"].includes(status)) return "connected";
  if (["request_pending", "pending"].includes(status)) return "pending";
  if (["revoked", "cancelled", "denied"].includes(status)) return "previous";
  return "available";
}

function riaRelationshipToStatus(access: RiaClientAccess): ConnectStatus {
  const status = String(access.relationship_status || access.status || "").toLowerCase();
  if (["active", "approved"].includes(status)) return "connected";
  if (["request_pending", "pending"].includes(status)) return "pending";
  if (["revoked", "cancelled", "denied"].includes(status)) return "previous";
  return "available";
}

function investorActionToStatus(
  actionStatus: string | null | undefined,
): ConnectCandidate["actionStatus"] {
  switch (String(actionStatus || "").toLowerCase()) {
    case "viewed": return "viewed";
    case "passed": return "passed";
    case "shortlisted": return "shortlisted";
    case "connect_requested": return "connect_requested";
    default: return null;
  }
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

export function normalizeRiaToCandidate(
  ria: MarketplaceRia,
  opts: {
    consentEntries?: ConsentCenterEntry[];
    query?: string | null;
    currentPersona?: string;
  } = {},
): ConnectCandidate {
  const { consentEntries = [], query, currentPersona = "investor" } = opts;

  const candidateId = buildCandidateId({ userId: ria.user_id });
  const existingConsent = consentEntries.find((e) => e.counterpart_id === ria.user_id);
  const connectionStatus: ConnectStatus = existingConsent
    ? consentEntryToStatus(existingConsent)
    : "available";

  const firmName = Array.isArray(ria.firms) && ria.firms.length > 0
    ? ria.firms[0]?.legal_name ?? null
    : null;

  const verificationStatus = ria.verification_status;
  const isConnectable =
    currentPersona === "investor" &&
    ["active", "verified", "finra_verified"].includes(String(verificationStatus).toLowerCase()) &&
    connectionStatus === "available";

  const isDiscoverableFlag = true; // RIA search API already filters; treat as discoverable
  const profileHref = `/marketplace?riaId=${encodeURIComponent(ria.id)}`;
  const connectionHref = existingConsent
    ? buildMarketplaceConnectionsRoute({ tab: "active" })
    : null;

  const primaryCta = resolvePrimaryCta({
    connectionStatus,
    isDiscoverable: isDiscoverableFlag,
    canConnect: isConnectable,
    isTestProfile: ria.is_test_profile,
    hasProfileHref: true,
  });

  const candidate: ConnectCandidate = {
    candidateId,
    kind: "ria",
    sourceTypes: ["marketplace_ria"],
    userId: ria.user_id,
    publicProfileId: null,
    sourceType: "marketplace_ria",
    _rawRiaProfile: ria,
    displayName: ria.display_name,
    headline: ria.headline ?? null,
    summary: ria.strategy_summary ?? null,
    avatarUrl: null,
    firmName,
    locationLabel: null,
    visibilityPosture: ria.visibility_posture ?? "default_available",
    exposureEnabled: ria.exposure_enabled ?? null,
    isDiscoverable: isDiscoverableFlag,
    verificationStatus,
    verificationBadge: verificationStatus === "active" ? "RIA Verified" : null,
    connectionStatus,
    actionStatus: null,
    score: 0,
    reasons: [],
    primaryCta,
    secondaryCtas: resolveSecondaryCtas(primaryCta, {
      canShortlist: false,
      connectionStatus,
      hasProfileHref: true,
    }),
    profileHref,
    connectionHref,
    isTestProfile: ria.is_test_profile,
  };

  return applyScoreToCandidate(candidate, query);
}

export function normalizeInvestorToCandidate(
  investor: MarketplaceInvestor,
  opts: {
    riaRelationships?: RiaClientAccess[];
    investorActions?: MarketplaceInvestorActionRecord[];
    query?: string | null;
    currentPersona?: string;
    shortlistedIds?: string[];
    passedIds?: string[];
  } = {},
): ConnectCandidate {
  const {
    riaRelationships = [],
    investorActions = [],
    query,
    currentPersona = "ria",
    shortlistedIds = [],
    passedIds = [],
  } = opts;

  const investorId = marketplaceInvestorCardId(investor);
  const userId = marketplaceInvestorUserId(investor);
  const isPublicSec = isPublicSecMarketplaceInvestor(investor);

  const candidateId = buildCandidateId({
    userId,
    publicProfileId: investor.public_profile_id,
    sourceType: investor.source_type ?? "investor",
    fallbackLabel: investor.display_name,
  });

  const relationship = userId
    ? riaRelationships.find((r) => r.investor_user_id === userId)
    : null;

  const actionRecord = investorActions.find((a) => {
    const key = String(a.target_key || "").trim();
    return key === investorId || key === userId;
  });

  let connectionStatus: ConnectStatus = "available";
  if (relationship) {
    connectionStatus = riaRelationshipToStatus(relationship);
  } else if (shortlistedIds.includes(investorId)) {
    connectionStatus = "shortlisted";
  } else if (passedIds.includes(investorId)) {
    connectionStatus = "passed";
  }

  const actionStatus = investorActionToStatus(actionRecord?.status);

  const isConnectable =
    currentPersona === "ria" &&
    isMarketplaceInvestorConnectable(investor) &&
    connectionStatus === "available";
  const isShortlistable = isMarketplaceInvestorShortlistable(investor);
  const isDiscoverableFlag = !isPublicSec || Boolean(investor.public_profile_id);

  const curationLabel = marketplaceInvestorCurationLabel(investor);
  const sourceLabel = marketplaceInvestorSourceLabel(investor);
  const locationLabel = [curationLabel, sourceLabel, investor.location_hint]
    .filter(Boolean)
    .join(" · ") || null;

  const sourceTypes: ConnectCandidateSource[] = isPublicSec
    ? ["public_sec"]
    : ["marketplace_investor"];

  const profileHref = userId && !isPublicSec
    ? `/marketplace?investorId=${encodeURIComponent(investorId)}`
    : null;

  const connectionHref = relationship
    ? buildMarketplaceConnectionsRoute({ tab: "active" })
    : null;

  const primaryCta = resolvePrimaryCta({
    connectionStatus,
    isDiscoverable: isDiscoverableFlag,
    canConnect: isConnectable,
    isTestProfile: investor.is_test_profile,
    hasProfileHref: Boolean(profileHref),
  });

  const candidate: ConnectCandidate = {
    candidateId,
    kind: isPublicSec ? "public_profile" : "investor",
    sourceTypes,
    userId,
    publicProfileId: investor.public_profile_id ?? null,
    sourceType: investor.source_type ?? null,
    _rawInvestorProfile: investor,
    displayName: investor.display_name,
    headline: investor.headline ?? null,
    summary: investor.strategy_summary ?? investor.location_hint ?? null,
    avatarUrl: null,
    firmName: null,
    locationLabel,
    visibilityPosture: investor.visibility_posture ?? "default_available",
    exposureEnabled: investor.exposure_enabled ?? null,
    isDiscoverable: isDiscoverableFlag,
    verificationStatus: null,
    verificationBadge: null,
    connectionStatus,
    actionStatus,
    score: 0,
    reasons: [],
    primaryCta,
    secondaryCtas: resolveSecondaryCtas(primaryCta, {
      canShortlist: isShortlistable && connectionStatus === "available",
      connectionStatus,
      hasProfileHref: Boolean(profileHref),
    }),
    profileHref,
    connectionHref,
    isTestProfile: investor.is_test_profile,
  };

  return applyScoreToCandidate(candidate, query);
}

export function normalizeContactMatchToCandidate(
  match: MarketplaceContactMatch,
  opts: {
    existingCandidates?: ConnectCandidate[];
    query?: string | null;
  } = {},
): ConnectCandidate | null {
  const { query } = opts;

  const userId = match.user_id;
  const candidateId = buildCandidateId({ userId });

  // If an existing candidate with the same userId exists, we augment it instead of creating new
  const existing = opts.existingCandidates?.find((c) => c.candidateId === candidateId);
  if (existing) {
    // Return augmented version — merge will handle this via mergeByUserId
    return {
      ...existing,
      sourceTypes: mergeSourceTypes(existing.sourceTypes, ["contact_match"]),
    };
  }

  const isRia = match.kind === "ria";
  const profile = match.profile as
    | { visibility_posture?: string | null; exposure_enabled?: boolean | null }
    | null
    | undefined;
  const visibilityPosture = profile?.visibility_posture ?? "default_available";
  const exposureEnabled = profile?.exposure_enabled ?? null;
  const profileIsPrivate = String(visibilityPosture).trim().toLowerCase() === "private";
  const profileHref = isRia
    ? `/marketplace?riaId=${encodeURIComponent(userId)}`
    : `/marketplace?investorId=${encodeURIComponent(userId)}`;

  const candidate: ConnectCandidate = {
    candidateId,
    kind: isRia ? "ria" : "investor",
    sourceTypes: ["contact_match"],
    userId,
    publicProfileId: null,
    sourceType: match.kind,
    displayName: match.display_name,
    headline: match.headline ?? null,
    summary: null,
    avatarUrl: null,
    firmName: null,
    locationLabel: null,
    visibilityPosture,
    exposureEnabled,
    isDiscoverable: exposureEnabled !== false && !profileIsPrivate,
    verificationStatus: null,
    verificationBadge: null,
    connectionStatus: "available",
    actionStatus: null,
    score: 0,
    reasons: [],
    primaryCta: "open_profile",
    secondaryCtas: [],
    profileHref,
    connectionHref: null,
  };

  return applyScoreToCandidate(candidate, query);
}

export function normalizeConsentEntryToCandidate(
  entry: ConsentCenterEntry,
  opts: {
    surface: "active" | "pending" | "previous";
    query?: string | null;
    currentPersona?: string;
  },
): ConnectCandidate | null {
  const counterpartId = entry.counterpart_id;
  if (!counterpartId) return null;

  const { surface, query } = opts;

  const candidateId = buildCandidateId({ userId: counterpartId });
  const sourceMap: Record<string, ConnectCandidateSource> = {
    active: "active_connection",
    pending: "pending_connection",
    previous: "previous_connection",
  };
  const source: ConnectCandidateSource = sourceMap[surface] ?? "active_connection";

  const statusMap: Record<string, ConnectStatus> = {
    active: "connected",
    pending: "pending",
    previous: "previous",
  };
  const connectionStatus: ConnectStatus = statusMap[surface] ?? "connected";

  const connectionHref = buildMarketplaceConnectionsRoute({
    tab: surface === "active" ? "active" : surface === "pending" ? "pending" : "previous",
    selected: counterpartId,
  });

  const primaryCta: ConnectPrimaryCta =
    connectionStatus === "connected"
      ? "view_connection"
      : connectionStatus === "pending"
      ? "review_request"
      : "open_profile";

  const candidate: ConnectCandidate = {
    candidateId,
    kind: entry.counterpart_type === "ria" ? "ria" : "hushh_user",
    sourceTypes: [source],
    userId: counterpartId,
    publicProfileId: null,
    sourceType: entry.counterpart_type,
    _rawConsentEntry: entry,
    displayName: entry.counterpart_label || counterpartId,
    headline: entry.counterpart_secondary_label ?? null,
    summary: null,
    avatarUrl: entry.counterpart_image_url ?? null,
    firmName: null,
    locationLabel: null,
    visibilityPosture: null,
    exposureEnabled: null,
    isDiscoverable: true, // connections always visible in connections section
    verificationStatus: null,
    verificationBadge: null,
    connectionStatus,
    actionStatus: null,
    score: 0,
    reasons: [],
    primaryCta,
    secondaryCtas: [],
    profileHref: entry.request_url ?? null,
    connectionHref,
  };

  return applyScoreToCandidate(candidate, query);
}

// ─── Merge / Deduplication ────────────────────────────────────────────────────

/**
 * Merge a list of raw candidates by candidateId.
 * When two candidates share the same ID, the one with higher score wins for
 * most fields, but sourceTypes are merged.
 */
export function mergeCandidates(candidates: ConnectCandidate[]): ConnectCandidate[] {
  const map = new Map<string, ConnectCandidate>();

  for (const candidate of candidates) {
    const existing = map.get(candidate.candidateId);
    if (!existing) {
      map.set(candidate.candidateId, candidate);
      continue;
    }

    // Merge sources
    const mergedSources = mergeSourceTypes(existing.sourceTypes, candidate.sourceTypes);

    // Pick higher connection status (connected > pending > previous > available)
    const statusPriority: ConnectStatus[] = [
      "connected", "pending", "previous", "shortlisted",
      "connect_requested", "available", "passed", "not_connectable", "private",
    ];
    const existingPriority = statusPriority.indexOf(existing.connectionStatus);
    const incomingPriority = statusPriority.indexOf(candidate.connectionStatus);
    const connectionStatus =
      existingPriority <= incomingPriority
        ? existing.connectionStatus
        : candidate.connectionStatus;

    // Pick better score, recombine reasons
    const mergedReasons = [
      ...existing.reasons,
      ...candidate.reasons.filter(
        (r) => !existing.reasons.some((er) => er.code === r.code),
      ),
    ];
    const score = Math.max(existing.score, candidate.score);

    const merged: ConnectCandidate = {
      ...existing,
      sourceTypes: mergedSources,
      visibilityPosture:
        existing.visibilityPosture === "private" || candidate.visibilityPosture === "private"
          ? "private"
          : existing.visibilityPosture ?? candidate.visibilityPosture,
      exposureEnabled:
        existing.exposureEnabled === false || candidate.exposureEnabled === false
          ? false
          : existing.exposureEnabled ?? candidate.exposureEnabled,
      isDiscoverable: existing.isDiscoverable && candidate.isDiscoverable,
      connectionStatus,
      score,
      reasons: mergedReasons,
      // Prefer higher-detail display name
      displayName: existing.displayName.length >= candidate.displayName.length
        ? existing.displayName
        : candidate.displayName,
      headline: existing.headline ?? candidate.headline,
      summary: existing.summary ?? candidate.summary,
      avatarUrl: existing.avatarUrl ?? candidate.avatarUrl,
    };

    map.set(candidate.candidateId, merged);
  }

  return Array.from(map.values());
}
