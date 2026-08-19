import { describe, expect, it, vi } from "vitest";

const { previewAgentPkmMemory, addToPKM, isReservedPkmCard } = vi.hoisted(() => ({
  previewAgentPkmMemory: vi.fn(),
  addToPKM: vi.fn(),
  isReservedPkmCard: vi.fn((card: { reserved?: boolean }) => card.reserved === true),
}));

vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  previewAgentPkmMemory,
  addToPKM,
  isReservedPkmCard,
}));

import { saveKycIdentityNarrativeInBackground } from "@/lib/services/kyc-identity-memory-ingestion-service";

describe("saveKycIdentityNarrativeInBackground", () => {
  it("stores eligible private facts from the Continue action without retaining the source text", async () => {
    const eligible = {
      card_id: "identity-1",
      write_mode: "can_save",
      sharing_impact: { active_recipient_count: 0 },
    };
    previewAgentPkmMemory.mockResolvedValueOnce({
      cards: [
        eligible,
        { card_id: "shared-1", write_mode: "confirm_first", sharing_impact: { active_recipient_count: 1 } },
        { card_id: "reserved-1", reserved: true, write_mode: "can_save" },
      ],
    });
    addToPKM.mockResolvedValueOnce({ attempted: 1, saved: 1, failed: 0, domains: ["identity"] });

    await expect(
      saveKycIdentityNarrativeInBackground({
        userId: "user_1",
        narrative: "I am Avery and work in software.",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toMatchObject({ saved: 1 });

    expect(previewAgentPkmMemory).toHaveBeenCalledWith({
      userId: "user_1",
      message: "I am Avery and work in software.",
      currentDomains: ["identity"],
      vaultOwnerToken: "owner-token",
    });
    expect(addToPKM).toHaveBeenCalledWith(
      expect.objectContaining({
        cards: [eligible],
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "kyc_identity_continue",
        },
      }),
    );
  });

  it("does not call the model for an empty narrative", async () => {
    await expect(
      saveKycIdentityNarrativeInBackground({
        userId: "user_1",
        narrative: "   ",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toBeNull();

    expect(previewAgentPkmMemory).not.toHaveBeenCalled();
  });
});
