import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.apiFetch } }));

import { PublicProfileDiscoveryService, type DiscoveryStartInput } from "@/lib/services/public-profile-discovery-service";

describe("PublicProfileDiscoveryService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the actionable verified-phone requirement from the API", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: { code: "verified_phone_required" } }),
    });

    const input: DiscoveryStartInput = {
      consent: true,
      consentVersion: "public_profile_discovery_v2",
      externalPhoneConsent: false,
    };
    await expect(PublicProfileDiscoveryService.start("firebase-token", input)).rejects.toThrow(
      "Verify your phone number before starting public-profile discovery.",
    );
  });
});
