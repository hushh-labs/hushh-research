/**
 * lib/connect/connect-ranking.ts
 *
 * Score-based ranking and reason label system for Connect candidates.
 * Scores are additive — a candidate can receive multiple score boosts
 * from different sources.
 */

import type {
  ConnectCandidate,
  ConnectCandidateReason,
  ConnectCandidateSource,
} from "./types";

// ─── Score Constants ──────────────────────────────────────────────────────────

export const CONNECT_SCORES = {
  ACTIVE_CONNECTION: 100,
  PENDING_CONNECTION: 80,
  CONTACT_MATCH: 60,
  CONNECT_REQUESTED: 55,
  SHORTLISTED: 40,
  VERIFIED_RIA: 30,
  QUERY_NAME_MATCH: 25,
  QUERY_HEADLINE_MATCH: 15,
  VIEWED: 10,
  VISIBLE_PROFILE: 5,
  PASSED: -50,         // suppressed but not excluded
  PRIVATE: -200,       // excluded from discovery (should never rank)
} as const;

// ─── Reason Codes ─────────────────────────────────────────────────────────────

export const REASON_LABELS = {
  active_connection: "Connected",
  pending_connection: "Pending request",
  previous_connection: "Previously connected",
  contact_match: "In your contacts",
  connect_requested: "Connect requested",
  shortlisted: "Shortlisted",
  ria_verified: "RIA verified",
  query_match_name: "Matches your search",
  query_match_headline: "Matches your search",
  visible_profile: "Visible profile",
  passed: "Passed",
  kai_test: "Test profile",
} as const;

// ─── Score Computation ────────────────────────────────────────────────────────

type QueryBoostOptions = {
  query?: string | null;
  displayName?: string | null;
  headline?: string | null;
  summary?: string | null;
  firmName?: string | null;
};

/**
 * Compute the score boost from a search query against candidate text fields.
 * Returns 0 if no query, or sum of matched boosts.
 */
export function computeQueryScore(options: QueryBoostOptions): {
  score: number;
  reasons: ConnectCandidateReason[];
} {
  const q = String(options.query || "").trim().toLowerCase();
  if (!q) return { score: 0, reasons: [] };

  const reasons: ConnectCandidateReason[] = [];
  let score = 0;

  const nameMatch =
    String(options.displayName || "").toLowerCase().includes(q) ||
    String(options.firmName || "").toLowerCase().includes(q);

  if (nameMatch) {
    score += CONNECT_SCORES.QUERY_NAME_MATCH;
    reasons.push({
      code: "query_match_name",
      label: REASON_LABELS.query_match_name,
      weight: CONNECT_SCORES.QUERY_NAME_MATCH,
      source: "profile_visibility",
    });
  }

  const headlineMatch =
    !nameMatch &&
    (String(options.headline || "").toLowerCase().includes(q) ||
      String(options.summary || "").toLowerCase().includes(q));

  if (headlineMatch) {
    score += CONNECT_SCORES.QUERY_HEADLINE_MATCH;
    reasons.push({
      code: "query_match_headline",
      label: REASON_LABELS.query_match_headline,
      weight: CONNECT_SCORES.QUERY_HEADLINE_MATCH,
      source: "profile_visibility",
    });
  }

  return { score, reasons };
}

/**
 * Compute score contribution from a candidate's connection status.
 */
export function computeConnectionStatusScore(
  candidate: Pick<ConnectCandidate, "connectionStatus" | "actionStatus">,
): { score: number; reasons: ConnectCandidateReason[] } {
  const reasons: ConnectCandidateReason[] = [];
  let score = 0;

  switch (candidate.connectionStatus) {
    case "connected":
      score += CONNECT_SCORES.ACTIVE_CONNECTION;
      reasons.push({
        code: "active_connection",
        label: REASON_LABELS.active_connection,
        weight: CONNECT_SCORES.ACTIVE_CONNECTION,
        source: "active_connection",
      });
      break;

    case "pending":
      score += CONNECT_SCORES.PENDING_CONNECTION;
      reasons.push({
        code: "pending_connection",
        label: REASON_LABELS.pending_connection,
        weight: CONNECT_SCORES.PENDING_CONNECTION,
        source: "pending_connection",
      });
      break;

    case "previous":
      score += CONNECT_SCORES.PENDING_CONNECTION; // treat similar to pending
      reasons.push({
        code: "previous_connection",
        label: REASON_LABELS.previous_connection,
        weight: CONNECT_SCORES.PENDING_CONNECTION,
        source: "previous_connection",
      });
      break;

    case "connect_requested":
      score += CONNECT_SCORES.CONNECT_REQUESTED;
      reasons.push({
        code: "connect_requested",
        label: REASON_LABELS.connect_requested,
        weight: CONNECT_SCORES.CONNECT_REQUESTED,
        source: "active_connection",
      });
      break;

    case "shortlisted":
      score += CONNECT_SCORES.SHORTLISTED;
      reasons.push({
        code: "shortlisted",
        label: REASON_LABELS.shortlisted,
        weight: CONNECT_SCORES.SHORTLISTED,
        source: "marketplace_investor",
      });
      break;

    case "passed":
      score += CONNECT_SCORES.PASSED;
      reasons.push({
        code: "passed",
        label: REASON_LABELS.passed,
        weight: CONNECT_SCORES.PASSED,
        source: "marketplace_investor",
      });
      break;

    default:
      break;
  }

  return { score, reasons };
}

/**
 * Compute score contribution from source types.
 */
export function computeSourceScore(
  sourceTypes: ConnectCandidateSource[],
  kind: ConnectCandidate["kind"],
  verificationStatus?: string | null,
): { score: number; reasons: ConnectCandidateReason[] } {
  const reasons: ConnectCandidateReason[] = [];
  let score = 0;

  if (sourceTypes.includes("contact_match")) {
    score += CONNECT_SCORES.CONTACT_MATCH;
    reasons.push({
      code: "contact_match",
      label: REASON_LABELS.contact_match,
      weight: CONNECT_SCORES.CONTACT_MATCH,
      source: "contact_match",
    });
  }

  if (
    kind === "ria" &&
    ["active", "verified", "finra_verified"].includes(
      String(verificationStatus || "").toLowerCase(),
    )
  ) {
    score += CONNECT_SCORES.VERIFIED_RIA;
    reasons.push({
      code: "ria_verified",
      label: REASON_LABELS.ria_verified,
      weight: CONNECT_SCORES.VERIFIED_RIA,
      source: "marketplace_ria",
    });
  }

  if (
    sourceTypes.includes("profile_visibility") ||
    sourceTypes.includes("marketplace_ria") ||
    sourceTypes.includes("marketplace_investor") ||
    sourceTypes.includes("contact_match")
  ) {
    score += CONNECT_SCORES.VISIBLE_PROFILE;
    reasons.push({
      code: "visible_profile",
      label: REASON_LABELS.visible_profile,
      weight: CONNECT_SCORES.VISIBLE_PROFILE,
      source: sourceTypes[0] ?? "profile_visibility",
    });
  }

  return { score, reasons };
}

// ─── Final Score Assembly ─────────────────────────────────────────────────────

/**
 * Compute the total score for a candidate given a query.
 * Mutates the candidate's score and reasons in-place.
 */
export function applyScoreToCandidate(
  candidate: ConnectCandidate,
  query?: string | null,
): ConnectCandidate {
  const { score: qScore, reasons: qReasons } = computeQueryScore({
    query,
    displayName: candidate.displayName,
    headline: candidate.headline,
    summary: candidate.summary,
    firmName: candidate.firmName,
  });

  const { score: csScore, reasons: csReasons } = computeConnectionStatusScore(candidate);

  const { score: srcScore, reasons: srcReasons } = computeSourceScore(
    candidate.sourceTypes,
    candidate.kind,
    candidate.verificationStatus,
  );

  const allReasons = [...csReasons, ...srcReasons, ...qReasons];
  const totalScore = csScore + srcScore + qScore;

  return {
    ...candidate,
    score: totalScore,
    reasons: allReasons,
  };
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

/**
 * Sort candidates by score descending. Stable sort (preserves order for equal scores).
 */
export function sortCandidatesByScore(candidates: ConnectCandidate[]): ConnectCandidate[] {
  return [...candidates].sort((a, b) => b.score - a.score);
}

/**
 * Remove or suppress passed candidates from discovery sections.
 * Passed candidates with an active/pending connection override are kept.
 */
export function filterPassedCandidates(
  candidates: ConnectCandidate[],
  includePassedWithConnection = false,
): ConnectCandidate[] {
  return candidates.filter((c) => {
    if (c.connectionStatus !== "passed") return true;
    if (includePassedWithConnection) {
      return c.sourceTypes.some((s) =>
        ["active_connection", "pending_connection"].includes(s),
      );
    }
    return false;
  });
}
