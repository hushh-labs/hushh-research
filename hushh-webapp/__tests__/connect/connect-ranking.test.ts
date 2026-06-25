import { describe, expect, it } from "vitest";
import {
  computeQueryScore,
  computeConnectionStatusScore,
  computeSourceScore,
  applyScoreToCandidate,
  sortCandidatesByScore,
  filterPassedCandidates,
  CONNECT_SCORES,
} from "@/lib/connect/connect-ranking";
import type { ConnectCandidate } from "@/lib/connect/types";

describe("Connect Ranking Module", () => {
  describe("computeQueryScore", () => {
    it("should return 0 score and empty reasons if query is empty", () => {
      const result = computeQueryScore({ query: "" });
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it("should boost if query matches name or firmName", () => {
      const result = computeQueryScore({
        query: "john",
        displayName: "John Doe",
        firmName: "Capital Ltd",
      });
      expect(result.score).toBe(CONNECT_SCORES.QUERY_NAME_MATCH);
      expect(result.reasons[0]?.code).toBe("query_match_name");
    });

    it("should boost if query matches headline or summary and not name", () => {
      const result = computeQueryScore({
        query: "expert",
        displayName: "John Doe",
        headline: "Expert RIA advisor",
        summary: "Providing wealth growth",
      });
      expect(result.score).toBe(CONNECT_SCORES.QUERY_HEADLINE_MATCH);
      expect(result.reasons[0]?.code).toBe("query_match_headline");
    });
  });

  describe("computeConnectionStatusScore", () => {
    it("should award correct scores based on connection status", () => {
      expect(computeConnectionStatusScore({ connectionStatus: "connected" }).score).toBe(
        CONNECT_SCORES.ACTIVE_CONNECTION,
      );
      expect(computeConnectionStatusScore({ connectionStatus: "pending" }).score).toBe(
        CONNECT_SCORES.PENDING_CONNECTION,
      );
      expect(computeConnectionStatusScore({ connectionStatus: "previous" }).score).toBe(
        CONNECT_SCORES.PENDING_CONNECTION,
      );
      expect(computeConnectionStatusScore({ connectionStatus: "connect_requested" }).score).toBe(
        CONNECT_SCORES.CONNECT_REQUESTED,
      );
      expect(computeConnectionStatusScore({ connectionStatus: "shortlisted" }).score).toBe(
        CONNECT_SCORES.SHORTLISTED,
      );
      expect(computeConnectionStatusScore({ connectionStatus: "passed" }).score).toBe(
        CONNECT_SCORES.PASSED,
      );
    });
  });

  describe("computeSourceScore", () => {
    it("should add contact match boost", () => {
      const result = computeSourceScore(["contact_match"], "hushh_user");
      expect(result.score).toBe(CONNECT_SCORES.CONTACT_MATCH + CONNECT_SCORES.VISIBLE_PROFILE);
    });

    it("should add verified RIA boost", () => {
      const result = computeSourceScore(["marketplace_ria"], "ria", "active");
      expect(result.score).toBe(CONNECT_SCORES.VERIFIED_RIA + CONNECT_SCORES.VISIBLE_PROFILE);
    });
  });

  describe("applyScoreToCandidate", () => {
    it("should correctly compile score and reasons", () => {
      const candidate: ConnectCandidate = {
        candidateId: "user:123",
        kind: "ria",
        sourceTypes: ["marketplace_ria"],
        userId: "123",
        displayName: "Alice Smith",
        headline: "Wealth builder",
        verificationStatus: "active",
        connectionStatus: "connected",
        isDiscoverable: true,
        score: 0,
        reasons: [],
        primaryCta: "view_connection",
        secondaryCtas: [],
      };

      const result = applyScoreToCandidate(candidate, "Alice");
      expect(result.score).toBe(
        CONNECT_SCORES.ACTIVE_CONNECTION +
          CONNECT_SCORES.VISIBLE_PROFILE +
          CONNECT_SCORES.VERIFIED_RIA +
          CONNECT_SCORES.QUERY_NAME_MATCH,
      );
      expect(result.reasons).toHaveLength(4);
    });
  });

  describe("sortCandidatesByScore", () => {
    it("should sort candidates descending by score", () => {
      const c1 = { score: 10 } as ConnectCandidate;
      const c2 = { score: 50 } as ConnectCandidate;
      const c3 = { score: 30 } as ConnectCandidate;
      const sorted = sortCandidatesByScore([c1, c2, c3]);
      expect(sorted.map((c) => c.score)).toEqual([50, 30, 10]);
    });
  });

  describe("filterPassedCandidates", () => {
    it("should remove passed candidates", () => {
      const c1 = { connectionStatus: "available" } as ConnectCandidate;
      const c2 = { connectionStatus: "passed", sourceTypes: ["marketplace_investor"] } as ConnectCandidate;
      const result = filterPassedCandidates([c1, c2]);
      expect(result).toHaveLength(1);
    });

    it("should keep passed candidate if it has active/pending connection and inclusion is requested", () => {
      const c1 = { connectionStatus: "passed", sourceTypes: ["active_connection"] } as ConnectCandidate;
      const c2 = { connectionStatus: "passed", sourceTypes: ["marketplace_investor"] } as ConnectCandidate;
      const result = filterPassedCandidates([c1, c2], true);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(c1);
    });
  });
});
