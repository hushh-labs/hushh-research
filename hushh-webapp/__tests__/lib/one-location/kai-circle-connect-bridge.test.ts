import { describe, expect, it } from "vitest";

import { buildKaiCircleCandidates } from "@/lib/one-location/kai-circle-connect-bridge";
import { buildKaiCircleSections, kaiCircleSectionKey } from "@/lib/one-location/kai-circle-sections";
import { resolveKaiCircleCtas } from "@/lib/one-location/kai-circle-ctas";
import type { ConnectCandidate } from "@/lib/connect/types";
import type { OneLocationRecipient } from "@/lib/one-location/types";

const TEST_LOCATION_KEY_ALGORITHM = "test-location-key-agreement";

function connectCandidate(overrides: Partial<ConnectCandidate> = {}): ConnectCandidate {
  return {
    candidateId: "user:user_b",
    kind: "ria",
    sourceTypes: ["marketplace_ria"],
    userId: "user_b",
    publicProfileId: null,
    sourceType: "marketplace_ria",
    displayName: "Advisor B",
    headline: "Advisor",
    summary: null,
    avatarUrl: null,
    firmName: null,
    locationLabel: null,
    visibilityPosture: "default_available",
    exposureEnabled: true,
    isDiscoverable: true,
    verificationStatus: "active",
    verificationBadge: "RIA Verified",
    connectionStatus: "available",
    actionStatus: null,
    score: 60,
    reasons: [],
    primaryCta: "connect",
    secondaryCtas: [],
    profileHref: "/marketplace?riaId=ria_b",
    connectionHref: null,
    ...overrides,
  };
}

function recipient(overrides: Partial<OneLocationRecipient> = {}): OneLocationRecipient {
  return {
    userId: "user_b",
    displayName: "Advisor B",
    phoneVerified: true,
    keyId: "key_b",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    keyAlgorithm: TEST_LOCATION_KEY_ALGORITHM,
    canReceiveLocation: true,
    recommendationCategory: "location_ready",
    recommendationTier: "available",
    recommendationScore: 40,
    ...overrides,
  };
}

describe("KAI Circle Connect bridge", () => {
  it("merges Connect candidates with One Location recipient readiness by userId", () => {
    const [candidate] = buildKaiCircleCandidates({
      connectCandidates: [connectCandidate({ sourceTypes: ["marketplace_ria", "contact_match"] })],
      state: {
        recipients: [recipient()],
        viewerCapabilities: { hasLocationRecipientKey: true },
      },
    });

    expect(candidate.userId).toBe("user_b");
    expect(candidate.isShareReady).toBe(true);
    expect(candidate.keyId).toBe("key_b");
    expect(candidate.sourceTypes).toEqual(
      expect.arrayContaining(["one_location_recipient", "marketplace_ria", "contact_match"]),
    );
    expect(resolveKaiCircleCtas({ candidate, mode: "share" })[0]).toMatchObject({
      id: "share_location",
      enabled: true,
    });
  });

  it("excludes public profiles without One Location recipient identity", () => {
    const candidates = buildKaiCircleCandidates({
      connectCandidates: [
        connectCandidate({
          candidateId: "public:public_sec:123",
          kind: "public_profile",
          userId: null,
          publicProfileId: "123",
          sourceTypes: ["public_sec"],
          profileHref: "/marketplace?investorId=123",
        }),
      ],
      state: { recipients: [], viewerCapabilities: { hasLocationRecipientKey: true } },
    });

    expect(candidates).toEqual([]);
  });

  it("excludes Connect-only professional profiles from the location sharing list", () => {
    const candidates = buildKaiCircleCandidates({
      connectCandidates: [connectCandidate({ userId: "user_c", candidateId: "user:user_c" })],
      state: { recipients: [], viewerCapabilities: { hasLocationRecipientKey: true } },
    });

    expect(candidates).toEqual([]);
  });

  it("defensively filters private or exposure-disabled Connect candidates", () => {
    const candidates = buildKaiCircleCandidates({
      connectCandidates: [
        connectCandidate({
          candidateId: "user:private",
          userId: "private",
          exposureEnabled: false,
        }),
        connectCandidate({
          candidateId: "user:hidden",
          userId: "hidden",
          visibilityPosture: "private",
        }),
      ],
      state: { recipients: [] },
    });

    expect(candidates).toEqual([]);
  });

  it("hides ready One Location recipients when Connect marks that user private", () => {
    const candidates = buildKaiCircleCandidates({
      connectCandidates: [
        connectCandidate({
          exposureEnabled: false,
          visibilityPosture: "private",
          isDiscoverable: false,
        }),
      ],
      state: {
        recipients: [recipient()],
        viewerCapabilities: { hasLocationRecipientKey: true },
      },
    });

    expect(candidates).toEqual([]);
  });

  it("keeps keyless One Location app users in Needs Setup even with professional Connect metadata", () => {
    const [candidate] = buildKaiCircleCandidates({
      connectCandidates: [connectCandidate({ userId: "user_c", candidateId: "user:user_c" })],
      state: {
        recipients: [
          recipient({
            userId: "user_c",
            keyId: null,
            publicKeyJwk: null,
            canReceiveLocation: false,
            recommendationCategory: "needs_setup",
            recommendationTier: "setup_needed",
          }),
        ],
      },
    });

    expect(candidate.isShareReady).toBe(false);
    expect(kaiCircleSectionKey(candidate)).toBe("needs_setup");
    const sections = buildKaiCircleSections([candidate]);
    expect(sections.find((section) => section.key === "professional_network")?.candidates).toHaveLength(0);
    expect(sections.find((section) => section.key === "needs_setup")?.candidates).toHaveLength(1);
  });

  it("resolves request CTA when viewer setup can be bootstrapped first", () => {
    const [candidate] = buildKaiCircleCandidates({
      connectCandidates: [connectCandidate()],
      state: {
        recipients: [recipient()],
        viewerCapabilities: { hasLocationRecipientKey: false, canRequestLocation: true },
      },
    });

    expect(resolveKaiCircleCtas({
      candidate,
      mode: "request",
      viewerCapabilities: { hasLocationRecipientKey: false, canRequestLocation: true },
    })[0]).toMatchObject({
      id: "request_location",
      enabled: true,
    });
  });
});
