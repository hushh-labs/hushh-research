import type {
  KaiCircleCandidate,
  KaiCircleSection,
  KaiCircleSectionKey,
} from "@/lib/one-location/types";

export const KAI_CIRCLE_SECTION_META: Record<
  KaiCircleSectionKey,
  Pick<KaiCircleSection, "title" | "description">
> = {
  needs_action: {
    title: "Needs your approval",
    description: "Requests and people waiting on a decision.",
  },
  trusted_circle: {
    title: "Trusted Circle",
    description: "People with active sharing, history, or referrals.",
  },
  professional_network: {
    title: "Professional Network",
    description: "RIA, investor, advisor, and marketplace signals.",
  },
  connect_matches: {
    title: "Connect Matches",
    description: "People discovered from Connect and contact matching.",
  },
  location_ready: {
    title: "Location-ready KAI members",
    description: "Verified KAI members ready for encrypted sharing.",
  },
  needs_setup: {
    title: "Needs setup",
    description: "People who need to open One Location once.",
  },
};

export const KAI_CIRCLE_SECTION_EMPTY_COPY: Record<
  KaiCircleSectionKey,
  { title: string; description: string }
> = {
  needs_action: {
    title: "No approvals waiting",
    description: "New location requests and pending decisions will appear here.",
  },
  trusted_circle: {
    title: "No trusted matches yet",
    description: "Active shares, repeat approvals, and referrals will lift people here.",
  },
  professional_network: {
    title: "No professional signals yet",
    description: "RIA, investor, advisor, and marketplace matches will appear here.",
  },
  connect_matches: {
    title: "No Connect matches yet",
    description: "Contact and Connect matches will appear here after sync.",
  },
  location_ready: {
    title: "No ready KAI members yet",
    description: "Verified KAI members with location keys will appear here.",
  },
  needs_setup: {
    title: "No setup blockers",
    description: "Everyone in this section is ready enough for the current flow.",
  },
};

export const KAI_CIRCLE_SECTION_ORDER: KaiCircleSectionKey[] = [
  "needs_action",
  "trusted_circle",
  "professional_network",
  "connect_matches",
  "location_ready",
  "needs_setup",
];

export function kaiCircleSectionKey(candidate: KaiCircleCandidate): KaiCircleSectionKey {
  switch (candidate.recommendationCategory) {
    case "needs_action":
      return "needs_action";
    case "trusted_circle":
      return "trusted_circle";
  }

  if (candidate.connectStatus === "pending") return "needs_action";
  if (candidate.connectStatus === "connected") return "trusted_circle";
  if (candidate.isShareReady) return "location_ready";
  if (
    candidate.sourceTypes.includes("one_location_recipient") ||
    candidate.readiness === "target_setup_needed" ||
    candidate.readiness === "viewer_setup_needed"
  ) {
    return "needs_setup";
  }

  const isProfessional =
    candidate.recommendationCategory === "professional_network" ||
    candidate.recommendationTier === "kai_network" ||
    ["ria", "investor", "public_profile"].includes(String(candidate.connectKind || "")) ||
    candidate.sourceTypes.some((source) =>
      ["marketplace_ria", "marketplace_investor", "public_sec", "active_connection"].includes(source),
    );
  if (isProfessional) return "professional_network";

  if (candidate.sourceTypes.includes("contact_match")) return "connect_matches";
  return "needs_setup";
}

export function buildKaiCircleSections(candidates: KaiCircleCandidate[]): KaiCircleSection[] {
  const grouped = new Map<KaiCircleSectionKey, KaiCircleCandidate[]>();
  KAI_CIRCLE_SECTION_ORDER.forEach((key) => grouped.set(key, []));

  for (const candidate of candidates) {
    grouped.get(kaiCircleSectionKey(candidate))?.push(candidate);
  }

  return KAI_CIRCLE_SECTION_ORDER.map((key) => ({
    key,
    title: KAI_CIRCLE_SECTION_META[key].title,
    description: KAI_CIRCLE_SECTION_META[key].description,
    candidates: grouped.get(key) ?? [],
  }));
}
