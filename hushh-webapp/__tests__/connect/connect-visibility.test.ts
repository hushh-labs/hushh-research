import { describe, expect, it } from "vitest";
import {
  isVisibilityPostureDiscoverable,
  isDiscoverable,
  buildCandidateId,
  mergeSourceTypes,
  hasConnectionSource,
} from "@/lib/connect/connect-visibility";
import type { ConnectCandidate } from "@/lib/connect/types";

describe("Connect Visibility Helper Module", () => {
  describe("isVisibilityPostureDiscoverable", () => {
    it("should return true for default or public postures", () => {
      expect(isVisibilityPostureDiscoverable("public", "hushh_user")).toBe(true);
      expect(isVisibilityPostureDiscoverable("default_available", "hushh_user")).toBe(true);
      expect(isVisibilityPostureDiscoverable("limited", "hushh_user")).toBe(true);
    });

    it("should return false for private posture", () => {
      expect(isVisibilityPostureDiscoverable("private", "hushh_user")).toBe(false);
    });

    it("should fallback to true for RIA/investor if posture is not defined", () => {
      expect(isVisibilityPostureDiscoverable(null, "ria")).toBe(true);
      expect(isVisibilityPostureDiscoverable(undefined, "investor")).toBe(true);
      expect(isVisibilityPostureDiscoverable(null, "public_profile")).toBe(true);
    });

    it("should fallback to false for generic hushh_user if posture is not defined", () => {
      expect(isVisibilityPostureDiscoverable(null, "hushh_user")).toBe(false);
      expect(isVisibilityPostureDiscoverable(undefined, "hushh_user")).toBe(false);
    });
  });

  describe("isDiscoverable", () => {
    const baseCandidate: ConnectCandidate = {
      candidateId: "user:123",
      kind: "ria",
      sourceTypes: ["marketplace_ria"],
      userId: "123",
      displayName: "John Doe",
      isDiscoverable: true,
      connectionStatus: "available",
      score: 0,
      reasons: [],
      primaryCta: "connect",
      secondaryCtas: [],
    };

    it("should always allow test profiles through", () => {
      const candidate: ConnectCandidate = {
        ...baseCandidate,
        isTestProfile: true,
        exposureEnabled: false,
        visibilityPosture: "private",
      };
      expect(isDiscoverable(candidate)).toBe(true);
    });

    it("should exclude candidate if exposureEnabled is false", () => {
      const candidate: ConnectCandidate = {
        ...baseCandidate,
        exposureEnabled: false,
      };
      expect(isDiscoverable(candidate)).toBe(false);
    });

    it("should exclude candidate if posture is private", () => {
      const candidate: ConnectCandidate = {
        ...baseCandidate,
        visibilityPosture: "private",
      };
      expect(isDiscoverable(candidate)).toBe(false);
    });

    it("should allow candidate if connectionStatus overrides discoverability", () => {
      const candidate: ConnectCandidate = {
        ...baseCandidate,
        exposureEnabled: false,
        visibilityPosture: "private",
        connectionStatus: "connected",
      };
      expect(isDiscoverable(candidate)).toBe(true);
    });

    it("should return the candidate discoverable flag as fallback", () => {
      const candidate1: ConnectCandidate = {
        ...baseCandidate,
        isDiscoverable: true,
      };
      const candidate2: ConnectCandidate = {
        ...baseCandidate,
        isDiscoverable: false,
      };
      expect(isDiscoverable(candidate1)).toBe(true);
      expect(isDiscoverable(candidate2)).toBe(false);
    });
  });

  describe("buildCandidateId", () => {
    it("should return user id format if userId is provided", () => {
      expect(buildCandidateId({ userId: "abc" })).toBe("user:abc");
      expect(buildCandidateId({ userId: " abc " })).toBe("user:abc");
    });

    it("should return public profile format if publicProfileId is provided and no userId", () => {
      expect(buildCandidateId({ publicProfileId: 100, sourceType: "sec" })).toBe("public:sec:100");
      expect(buildCandidateId({ publicProfileId: "200", sourceType: "" })).toBe("public:public:200");
    });

    it("should return contact fallback if neither userId nor publicProfileId is provided", () => {
      expect(buildCandidateId({ fallbackLabel: "Alice Smith" })).toBe("contact:alice_smith");
      expect(buildCandidateId({})).toBe("contact:unknown");
    });
  });

  describe("mergeSourceTypes", () => {
    it("should merge unique sources", () => {
      expect(mergeSourceTypes(["marketplace_ria"], ["contact_match"])).toEqual([
        "marketplace_ria",
        "contact_match",
      ]);
      expect(mergeSourceTypes(["marketplace_ria"], ["marketplace_ria", "kai_test"])).toEqual([
        "marketplace_ria",
        "kai_test",
      ]);
    });
  });

  describe("hasConnectionSource", () => {
    it("should return true if active/pending/previous connection source exists", () => {
      expect(hasConnectionSource(["active_connection"])).toBe(true);
      expect(hasConnectionSource(["pending_connection", "contact_match"])).toBe(true);
      expect(hasConnectionSource(["previous_connection"])).toBe(true);
    });

    it("should return false if no connection source exists", () => {
      expect(hasConnectionSource(["marketplace_ria"])).toBe(false);
      expect(hasConnectionSource(["contact_match"])).toBe(false);
    });
  });
});
