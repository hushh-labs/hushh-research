import { describe, expect, it } from "vitest";
import {
  normalizeRiaToCandidate,
  normalizeInvestorToCandidate,
  normalizeContactMatchToCandidate,
  normalizeConsentEntryToCandidate,
  mergeCandidates,
} from "@/lib/connect/candidates";
import type { MarketplaceRia, MarketplaceInvestor } from "@/lib/services/ria-service";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import type { ConnectCandidate } from "@/lib/connect/types";

describe("Connect Candidates Normalization & Merge Module", () => {
  describe("normalizeRiaToCandidate", () => {
    it("should correctly normalize a MarketplaceRia profile", () => {
      const mockRia: MarketplaceRia = {
        id: "ria-1",
        user_id: "user-ria-1",
        display_name: "Alice Advisor",
        headline: "Wealth builder",
        strategy_summary: "Conservative growth strategy",
        verification_status: "active",
        is_test_profile: false,
        firms: [{ firm_id: "firm-1", legal_name: "Alpha Wealth" }],
      };

      const candidate = normalizeRiaToCandidate(mockRia, { currentPersona: "investor" });
      expect(candidate.candidateId).toBe("user:user-ria-1");
      expect(candidate.displayName).toBe("Alice Advisor");
      expect(candidate.headline).toBe("Wealth builder");
      expect(candidate.firmName).toBe("Alpha Wealth");
      expect(candidate.kind).toBe("ria");
      expect(candidate.connectionStatus).toBe("available");
      expect(candidate.primaryCta).toBe("connect");
    });
  });

  describe("normalizeInvestorToCandidate", () => {
    it("should correctly normalize a MarketplaceInvestor profile", () => {
      const mockInvestor: MarketplaceInvestor = {
        id: "inv-1",
        source_type: "hushh_user",
        user_id: "user-inv-1",
        display_name: "Bob Capitalist",
        headline: "Growth investor",
        location_hint: "New York",
        strategy_summary: "Venture scale tech investments",
        connectable: true,
      };

      const candidate = normalizeInvestorToCandidate(mockInvestor, { currentPersona: "ria" });
      expect(candidate.candidateId).toBe("user:user-inv-1");
      expect(candidate.displayName).toBe("Bob Capitalist");
      expect(candidate.headline).toBe("Growth investor");
      expect(candidate.kind).toBe("investor");
      expect(candidate.connectionStatus).toBe("available");
      expect(candidate.primaryCta).toBe("connect");
    });

    it("should handle public sec profiles correctly", () => {
      const mockInvestor: MarketplaceInvestor = {
        id: "sec-1",
        source_type: "public_sec",
        public_profile_id: "12345",
        display_name: "SEC Corp Filing Profile",
        location_hint: "Washington DC",
        connectable: false,
      };

      const candidate = normalizeInvestorToCandidate(mockInvestor, { currentPersona: "ria" });
      expect(candidate.candidateId).toBe("public:public_sec:12345");
      expect(candidate.kind).toBe("public_profile");
      expect(candidate.primaryCta).toBe("none");
    });
  });

  describe("normalizeContactMatchToCandidate", () => {
    it("should create new candidate if no existing matches", () => {
      const match = {
        user_id: "user-match-1",
        kind: "ria",
        display_name: "Charlie Contact",
        phone_last4: "5678",
        headline: "Tax planning advisor",
      };

      const candidate = normalizeContactMatchToCandidate(match, { existingCandidates: [] });
      expect(candidate).not.toBeNull();
      expect(candidate!.candidateId).toBe("user:user-match-1");
      expect(candidate!.sourceTypes).toContain("contact_match");
      expect(candidate!.displayName).toBe("Charlie Contact");
      expect(candidate!.headline).toBe("Tax planning advisor");
    });

    it("should augment existing candidate", () => {
      const existing: ConnectCandidate = {
        candidateId: "user:user-match-1",
        kind: "ria",
        sourceTypes: ["marketplace_ria"],
        userId: "user-match-1",
        displayName: "Charlie",
        isDiscoverable: true,
        connectionStatus: "available",
        score: 10,
        reasons: [],
        primaryCta: "connect",
        secondaryCtas: [],
      };

      const match = {
        user_id: "user-match-1",
        kind: "ria",
        display_name: "Charlie Contact",
        phone_last4: "5678",
        headline: "Tax planning advisor",
      };

      const candidate = normalizeContactMatchToCandidate(match, { existingCandidates: [existing] });
      expect(candidate).not.toBeNull();
      expect(candidate!.candidateId).toBe("user:user-match-1");
      expect(candidate!.sourceTypes).toContain("contact_match");
      expect(candidate!.sourceTypes).toContain("marketplace_ria");
      expect(candidate!.displayName).toBe("Charlie");
    });

    it("preserves marketplace visibility from contact-match profiles", () => {
      const match = {
        user_id: "user-hidden",
        kind: "investor",
        display_name: "Hidden Contact",
        phone_last4: "5678",
        headline: "Private investor",
        profile: {
          id: "hushh_user:user-hidden",
          source_type: "hushh_user",
          user_id: "user-hidden",
          display_name: "Hidden Contact",
          visibility_posture: "private",
          exposure_enabled: true,
        },
      };

      const candidate = normalizeContactMatchToCandidate(match, { existingCandidates: [] });

      expect(candidate).not.toBeNull();
      expect(candidate!.visibilityPosture).toBe("private");
      expect(candidate!.exposureEnabled).toBe(true);
      expect(candidate!.isDiscoverable).toBe(false);
    });
  });

  describe("normalizeConsentEntryToCandidate", () => {
    it("should correctly convert ConsentCenterEntry for active connection", () => {
      const entry: ConsentCenterEntry = {
        request_id: "req-1",
        counterpart_id: "counter-1",
        counterpart_type: "ria",
        counterpart_label: "Dave Director",
        counterpart_secondary_label: "Fiduciary advisor",
        relationship_status: "active",
      };

      const candidate = normalizeConsentEntryToCandidate(entry, { surface: "active" });
      expect(candidate).not.toBeNull();
      expect(candidate!.candidateId).toBe("user:counter-1");
      expect(candidate!.connectionStatus).toBe("connected");
      expect(candidate!.primaryCta).toBe("view_connection");
    });
  });

  describe("mergeCandidates", () => {
    it("should merge unique sources and pick higher score", () => {
      const c1: ConnectCandidate = {
        candidateId: "user:123",
        kind: "ria",
        sourceTypes: ["marketplace_ria"],
        userId: "123",
        displayName: "John",
        isDiscoverable: true,
        connectionStatus: "connected",
        score: 10,
        reasons: [{ code: "ria_verified", label: "RIA Verified", weight: 10, source: "marketplace_ria" }],
        primaryCta: "connect",
        secondaryCtas: [],
      };

      const c2: ConnectCandidate = {
        candidateId: "user:123",
        kind: "ria",
        sourceTypes: ["contact_match"],
        userId: "123",
        displayName: "John Doe",
        isDiscoverable: true,
        connectionStatus: "pending",
        score: 50,
        reasons: [{ code: "contact_match", label: "In Contacts", weight: 50, source: "contact_match" }],
        primaryCta: "review_request",
        secondaryCtas: [],
      };

      const merged = mergeCandidates([c1, c2]);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.displayName).toBe("John Doe"); // longer display name
      expect(merged[0]?.sourceTypes).toContain("marketplace_ria");
      expect(merged[0]?.sourceTypes).toContain("contact_match");
      expect(merged[0]?.connectionStatus).toBe("connected"); // connected has priority over pending in priority map
      expect(merged[0]?.score).toBe(50);
      expect(merged[0]?.reasons).toHaveLength(2);
    });

    it("preserves hidden marketplace visibility when merging with another source", () => {
      const visibleContact: ConnectCandidate = {
        candidateId: "user:123",
        kind: "investor",
        sourceTypes: ["contact_match"],
        userId: "123",
        displayName: "John Contact",
        visibilityPosture: "default_available",
        exposureEnabled: true,
        isDiscoverable: true,
        connectionStatus: "available",
        score: 50,
        reasons: [{ code: "contact_match", label: "In Contacts", weight: 50, source: "contact_match" }],
        primaryCta: "open_profile",
        secondaryCtas: [],
      };
      const hiddenMarketplace: ConnectCandidate = {
        candidateId: "user:123",
        kind: "investor",
        sourceTypes: ["marketplace_investor"],
        userId: "123",
        displayName: "John Hidden",
        visibilityPosture: "private",
        exposureEnabled: false,
        isDiscoverable: false,
        connectionStatus: "available",
        score: 20,
        reasons: [],
        primaryCta: "open_profile",
        secondaryCtas: [],
      };

      const [merged] = mergeCandidates([visibleContact, hiddenMarketplace]);

      expect(merged.visibilityPosture).toBe("private");
      expect(merged.exposureEnabled).toBe(false);
      expect(merged.isDiscoverable).toBe(false);
    });
  });
});
