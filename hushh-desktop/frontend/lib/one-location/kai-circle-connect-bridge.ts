import { isDiscoverable } from "@/lib/connect/connect-visibility";
import type { ConnectCandidate } from "@/lib/connect/types";
import type {
  KaiCircleCandidate,
  OneLocationRecipient,
  OneLocationState,
  OneLocationViewerCapabilities,
} from "@/lib/one-location/types";

const LOCATION_KEY_AGREEMENT_ALGORITHM = ["ECDH-P256", "AES256-GCM"].join("-");

function candidateIdForUser(userId: string): string {
  return `user:${userId}`;
}

function hasShareKey(value: {
  keyId?: string | null;
  publicKeyJwk?: JsonWebKey | null;
  canReceiveLocation?: boolean;
}): boolean {
  return Boolean(value.canReceiveLocation && value.keyId && value.publicKeyJwk);
}

function isOneLocationRecipientCandidate(candidate: KaiCircleCandidate): boolean {
  return candidate.sourceTypes.includes("one_location_recipient");
}

function uniq(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
  );
}

function connectReasonLabels(connect: ConnectCandidate): Array<{ code: string; label: string; weight?: number }> {
  const labels = connect.reasons
    .filter((reason) => reason.code && reason.label)
    .slice(0, 3)
    .map((reason) => ({
      code: reason.code,
      label: reason.label,
      weight: reason.weight,
    }));

  if (connect.sourceTypes.includes("contact_match")) {
    labels.unshift({ code: "connect_contact_match", label: "Matched from Connect contacts", weight: 30 });
  }
  if (connect.connectionStatus === "connected") {
    labels.unshift({ code: "connect_active_connection", label: "Active Connect relationship", weight: 40 });
  }
  return labels;
}

function recommendationTierFromConnect(connect: ConnectCandidate): string {
  if (connect.connectionStatus === "connected") return "trusted_circle";
  if (connect.sourceTypes.includes("contact_match")) return "contacts";
  if (connect.kind === "ria" || connect.kind === "investor" || connect.kind === "public_profile") {
    return "kai_network";
  }
  return "available";
}

function recommendationCategoryFromConnect(connect: ConnectCandidate): string {
  if (connect.connectionStatus === "connected") return "trusted_circle";
  if (connect.kind === "ria" || connect.kind === "investor" || connect.kind === "public_profile") {
    return "professional_network";
  }
  if (connect.sourceTypes.includes("contact_match")) return "connect_matches";
  return "location_ready";
}

function isConnectLocationVisible(connect: ConnectCandidate): boolean {
  if (connect.exposureEnabled === false) return false;
  if (String(connect.visibilityPosture || "").trim().toLowerCase() === "private") {
    return false;
  }
  return isDiscoverable(connect);
}

function fromRecipient(recipient: OneLocationRecipient): KaiCircleCandidate {
  const isShareReady = hasShareKey(recipient);
  const recommendationTier =
    recipient.recommendationTier ?? (isShareReady ? "available" : "setup_needed");
  const recommendationCategory =
    recipient.recommendationCategory ?? (isShareReady ? "location_ready" : "needs_setup");
  return {
    candidateId: candidateIdForUser(recipient.userId),
    userId: recipient.userId,
    displayName: recipient.displayName,
    maskedPhone: recipient.maskedPhone,
    phoneVerified: recipient.phoneVerified,
    keyId: recipient.keyId,
    publicKeyJwk: recipient.publicKeyJwk,
    keyAlgorithm: recipient.keyAlgorithm,
    keyRegisteredAt: recipient.keyRegisteredAt,
    canReceiveLocation: recipient.canReceiveLocation,
    isShareReady,
    readiness: isShareReady ? "location_ready" : "target_setup_needed",
    sourceTypes: ["one_location_recipient"],
    isDiscoverable: true,
    recommendationScore: recipient.recommendationScore,
    recommendationRank: recipient.recommendationRank,
    recommendationTier,
    recommendationCategory,
    recommendationCategoryLabel: recipient.recommendationCategoryLabel,
    recommendationReasons: recipient.recommendationReasons,
    recommendationSummary: recipient.recommendationSummary,
    trustLevel: recipient.trustLevel,
    relationshipType: recipient.relationshipType,
    profileHeadline: recipient.profileHeadline,
    verificationBadge: recipient.verificationBadge,
    lastInteractionAt: recipient.lastInteractionAt,
  };
}

function fromConnect(connect: ConnectCandidate, viewerCapabilities?: OneLocationViewerCapabilities): KaiCircleCandidate {
  const userId = String(connect.userId || "").trim() || null;
  const isPublicProfileOnly = !userId;
  const sourceTypes = uniq(connect.sourceTypes);
  const score = Math.max(0, connect.score || 0);
  const reasons = connectReasonLabels(connect);
  const tier = recommendationTierFromConnect(connect);
  const category = recommendationCategoryFromConnect(connect);
  const viewerNeedsSetup = viewerCapabilities?.hasLocationRecipientKey === false;

  return {
    candidateId: userId ? candidateIdForUser(userId) : connect.candidateId,
    userId,
    displayName: connect.displayName,
    maskedPhone: null,
    phoneVerified: Boolean(userId),
    keyId: null,
    publicKeyJwk: null,
    keyAlgorithm: LOCATION_KEY_AGREEMENT_ALGORITHM,
    canReceiveLocation: false,
    isShareReady: false,
    readiness: isPublicProfileOnly
      ? "invite_only"
      : viewerNeedsSetup
        ? "viewer_setup_needed"
        : "target_setup_needed",
    connectCandidateId: connect.candidateId,
    connectKind: connect.kind,
    connectStatus: connect.connectionStatus,
    sourceTypes,
    profileHref: connect.profileHref,
    connectionHref: connect.connectionHref,
    isPublicProfileOnly,
    isDiscoverable: connect.isDiscoverable,
    recommendationScore: score,
    recommendationTier: tier,
    recommendationCategory: category,
    recommendationCategoryLabel:
      category === "trusted_circle"
        ? "Trusted Circle"
        : category === "professional_network"
          ? "Professional Network"
          : sourceTypes.includes("contact_match")
            ? "Connect Match"
            : "Connect",
    recommendationReasons: reasons,
    recommendationSummary:
      connect.summary ||
      connect.headline ||
      (sourceTypes.includes("contact_match")
        ? "Discovered through your Connect contact matches."
        : "Discovered from Connect."),
    trustLevel:
      connect.connectionStatus === "connected"
        ? "high"
        : category === "professional_network"
          ? "medium"
          : "new",
    relationshipType: connect.firmName || connect.locationLabel || null,
    profileHeadline: connect.headline,
    verificationBadge: connect.verificationBadge,
    lastInteractionAt: connect.lastInteractionAt,
  };
}

function mergeCandidate(existing: KaiCircleCandidate, incoming: KaiCircleCandidate): KaiCircleCandidate {
  const isShareReady = existing.isShareReady || incoming.isShareReady;
  const existingIsOneLocationRecipient = isOneLocationRecipientCandidate(existing);
  const sourceTypes = uniq([...existing.sourceTypes, ...incoming.sourceTypes]);
  const score = Math.max(existing.recommendationScore ?? 0, incoming.recommendationScore ?? 0);
  const reasons = [
    ...(existing.recommendationReasons ?? []),
    ...(incoming.recommendationReasons ?? []).filter(
      (reason) => !(existing.recommendationReasons ?? []).some((item) => item.code === reason.code),
    ),
  ].slice(0, 4);

  const preferIncomingName =
    incoming.displayName && incoming.displayName.length > existing.displayName.length;

  return {
    ...existing,
    displayName: preferIncomingName ? incoming.displayName : existing.displayName,
    connectCandidateId: existing.connectCandidateId ?? incoming.connectCandidateId,
    connectKind: existing.connectKind ?? incoming.connectKind,
    connectStatus: existing.connectStatus ?? incoming.connectStatus,
    sourceTypes,
    profileHref: existing.profileHref ?? incoming.profileHref,
    connectionHref: existing.connectionHref ?? incoming.connectionHref,
    isPublicProfileOnly: existing.isPublicProfileOnly && incoming.isPublicProfileOnly,
    isDiscoverable: existing.isDiscoverable || incoming.isDiscoverable,
    isShareReady,
    readiness: isShareReady ? "location_ready" : incoming.readiness || existing.readiness,
    recommendationScore: score,
    recommendationTier: existing.recommendationTier ?? incoming.recommendationTier,
    recommendationCategory: existing.recommendationCategory ?? incoming.recommendationCategory,
    recommendationCategoryLabel:
      existingIsOneLocationRecipient
        ? existing.recommendationCategoryLabel
        : existing.recommendationCategoryLabel ?? incoming.recommendationCategoryLabel,
    recommendationReasons: reasons,
    recommendationSummary: existing.recommendationSummary ?? incoming.recommendationSummary,
    trustLevel: existing.trustLevel ?? incoming.trustLevel,
    relationshipType: existing.relationshipType ?? incoming.relationshipType,
    profileHeadline: existing.profileHeadline ?? incoming.profileHeadline,
    verificationBadge: existing.verificationBadge ?? incoming.verificationBadge,
    lastInteractionAt: existing.lastInteractionAt ?? incoming.lastInteractionAt,
  };
}

export function buildKaiCircleCandidates(params: {
  connectCandidates?: ConnectCandidate[];
  state?: Pick<OneLocationState, "recipients" | "viewerCapabilities"> | null;
}): KaiCircleCandidate[] {
  const map = new Map<string, KaiCircleCandidate>();
  const viewerCapabilities = params.state?.viewerCapabilities;
  const hiddenConnectUserIds = new Set(
    (params.connectCandidates ?? [])
      .filter((connect) => !isConnectLocationVisible(connect))
      .map((connect) => String(connect.userId || "").trim())
      .filter(Boolean),
  );

  for (const recipient of params.state?.recipients ?? []) {
    if (hiddenConnectUserIds.has(recipient.userId)) continue;
    map.set(candidateIdForUser(recipient.userId), fromRecipient(recipient));
  }

  for (const connect of params.connectCandidates ?? []) {
    if (!isConnectLocationVisible(connect)) continue;
    const candidate = fromConnect(connect, viewerCapabilities);
    const existing = map.get(candidate.candidateId);
    if (!existing) continue;
    map.set(candidate.candidateId, mergeCandidate(existing, candidate));
  }

  return Array.from(map.values())
    .filter((candidate) => candidate.isDiscoverable)
    .sort((a, b) => {
      if (a.isShareReady !== b.isShareReady) return a.isShareReady ? -1 : 1;
      const aScore = a.recommendationScore ?? 0;
      const bScore = b.recommendationScore ?? 0;
      if (aScore !== bScore) return bScore - aScore;
      return a.displayName.localeCompare(b.displayName);
    })
    .map((candidate, index) => ({
      ...candidate,
      recommendationRank: candidate.recommendationRank ?? index + 1,
    }));
}
