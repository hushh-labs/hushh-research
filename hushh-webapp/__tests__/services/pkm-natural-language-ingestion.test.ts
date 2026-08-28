import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  previewAgentPkmMemory: mocks.preview,
  addToPKM: mocks.save,
}));

import { ingestNaturalLanguagePkm } from "@/lib/pkm/pkm-natural-language-ingestion";

describe("ingestNaturalLanguagePkm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the shared proposal cards for independently encrypted PKM writes", async () => {
    const cards = [{ card_id: "education", source_text: "I study engineering." }];
    mocks.preview.mockResolvedValueOnce({ cards });
    mocks.save.mockResolvedValueOnce({ attempted: 1, saved: 1, failed: 0, domains: ["education"], results: [] });

    const result = await ingestNaturalLanguagePkm({
      userId: "user_1",
      message: "  I study engineering.  ",
      currentDomains: ["identity"],
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      source: "kyc_identity_onboarding",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "kyc_identity_onboarding",
      },
    });

    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      message: "I study engineering.",
      currentDomains: ["identity"],
      vaultOwnerToken: "owner-token",
      chunkIndex: 1,
    }));
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      cards: [expect.objectContaining({ source_text: "I study engineering." })],
      sourceMessage: "I study engineering.",
      source: "kyc_identity_onboarding",
    }));
    expect(result.save.saved).toBe(1);
  });

  it("recursively narrows a model-truncated proposal before any card is saved", async () => {
    mocks.preview.mockResolvedValueOnce({
      cards: [],
      preview_summary: { split_recommended: true, total_segments_detected: 9 },
    });
    mocks.preview.mockResolvedValueOnce({ cards: [{ card_id: "one", source_text: "First detail." }] });
    mocks.preview.mockResolvedValueOnce({ cards: [{ card_id: "two", source_text: "Second detail." }] });
    mocks.save.mockResolvedValueOnce({ attempted: 2, saved: 2, failed: 0, domains: ["identity"], results: [] });

    const result = await ingestNaturalLanguagePkm({
      userId: "user_1",
      message: `${"A durable personal detail. ".repeat(8)}${"Another durable personal detail. ".repeat(8)}`,
      currentDomains: ["identity"],
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      source: "kyc_identity_onboarding",
      confirmation: { confirmedByUser: true, surface: "web", source: "kyc_identity_onboarding" },
    });

    expect(mocks.preview).toHaveBeenCalledTimes(3);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      cards: [
        expect.objectContaining({ source_text: "First detail." }),
        expect.objectContaining({ source_text: "Second detail." }),
      ],
    }));
    expect(result.save.saved).toBe(2);
  });

  it("chunks an oversized import below the proposal API limit", async () => {
    const largeImport = `${"Personal detail with useful context. ".repeat(400)}`;
    mocks.preview.mockImplementation(async ({ message }: { message: string }) => ({
      cards: [{ card_id: "fact", source_text: message.slice(0, 40) }],
    }));
    mocks.save.mockResolvedValueOnce({ attempted: 2, saved: 2, failed: 0, domains: ["identity"], results: [] });

    const result = await ingestNaturalLanguagePkm({
      userId: "user_1",
      message: largeImport,
      currentDomains: ["identity"],
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      source: "kyc_identity_onboarding",
      confirmation: { confirmedByUser: true, surface: "web", source: "kyc_identity_onboarding" },
    });

    expect(mocks.preview.mock.calls.map(([params]) => params.message.length)).toEqual(
      expect.arrayContaining([expect.any(Number)])
    );
    expect(mocks.preview.mock.calls.every(([params]) => params.message.length <= 10_000)).toBe(true);
    expect(result.chunkCount).toBeGreaterThan(1);
  });

  it("preserves every numbered section in a long assistant-authored profile import", async () => {
    const sectionIds = Array.from({ length: 14 }, (_, index) => `FACT-${index + 1}`);
    const profileImport = sectionIds
      .map((id, index) => `${index + 1}. Profile section\n- ${id}: synthetic detail ${index + 1}`)
      .join("\n\n");
    mocks.preview.mockImplementation(async ({ message }: { message: string }) => ({
      cards: [{ card_id: "section", source_text: message }],
    }));
    mocks.save.mockResolvedValueOnce({
      attempted: 3,
      saved: 3,
      failed: 0,
      domains: ["identity", "professional"],
      results: [],
    });

    await ingestNaturalLanguagePkm({
      userId: "user_1",
      message: profileImport,
      currentDomains: [],
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      source: "agent_chat_memory_capture",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "agent_chat_memory_capture",
      },
    });

    const submittedText = mocks.preview.mock.calls
      .map(([params]) => params.message)
      .join("\n");
    for (const id of sectionIds) expect(submittedText).toContain(id);
    expect(mocks.preview).toHaveBeenCalledTimes(3);
  });
});
