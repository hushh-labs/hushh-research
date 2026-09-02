import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  previewAgentPkmMemory: mocks.preview,
  addToPKM: mocks.save,
  getPkmAutoSaveCards: (cards: Array<{ write_mode?: string; sharing_impact?: { active_recipient_count?: number } }>) =>
    cards.filter(
      (card) =>
        card.write_mode === "can_save" &&
        (card.sharing_impact?.active_recipient_count || 0) === 0,
    ),
}));

import {
  ingestNaturalLanguagePkm,
  prepareNaturalLanguagePkm,
} from "@/lib/pkm/pkm-natural-language-ingestion";

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

  it("fails closed for a KYC import with no durable proposal cards", async () => {
    mocks.preview.mockResolvedValueOnce({ cards: [] });
    mocks.save.mockResolvedValueOnce({ attempted: 0, saved: 0, failed: 0, domains: [], results: [] });

    const result = await ingestNaturalLanguagePkm({
      userId: "user_1",
      message: "Thanks for helping with this form.",
      currentDomains: ["identity"],
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      source: "kyc_identity_onboarding",
      confirmation: { confirmedByUser: true, surface: "web", source: "kyc_identity_onboarding" },
      writePolicy: "auto_save_only",
    });

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ cards: [] }));
    expect(result.save).toMatchObject({ attempted: 0, saved: 0, failed: 0 });
  });

  it("does not let KYC save review-only proposal cards", async () => {
    const cards = [
      { card_id: "review", source_text: "I might travel soon.", write_mode: "confirm_first" },
      { card_id: "eligible", source_text: "I avoid dairy.", write_mode: "can_save" },
    ];
    mocks.preview.mockResolvedValueOnce({ cards });
    mocks.save.mockResolvedValueOnce({ attempted: 1, saved: 1, failed: 0, domains: ["health"], results: [] });

    await ingestNaturalLanguagePkm({
      userId: "user_1",
      message: "I might travel soon. I avoid dairy.",
      currentDomains: ["identity"],
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      source: "kyc_identity_onboarding",
      confirmation: { confirmedByUser: true, surface: "web", source: "kyc_identity_onboarding" },
      writePolicy: "auto_save_only",
    });

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      cards: [expect.objectContaining({ source_text: "I avoid dairy." })],
    }));
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

  it("fails closed when a source block has unaccounted facts", async () => {
    mocks.preview.mockResolvedValueOnce({
      cards: [{ card_id: "one", source_text: "One represented fact." }],
      preview_summary: { total_segments_detected: 2 },
    });

    await expect(
      prepareNaturalLanguagePkm({
        userId: "user_1",
        message: "One represented fact. One missing fact.",
        currentDomains: [],
        vaultOwnerToken: "owner-token",
        source: "agent_chat_profile_import",
      }),
    ).rejects.toThrow("was not fully accounted for");
  });

  it("returns an explicit disposition for every processed source block", async () => {
    mocks.preview.mockResolvedValueOnce({
      cards: [{ card_id: "one", source_text: "Stable fact.", write_mode: "can_save" }],
      preview_summary: { total_segments_detected: 1 },
      used_fallback: false,
    });

    const prepared = await prepareNaturalLanguagePkm({
      userId: "user_1",
      message: "Stable fact.",
      currentDomains: [],
      vaultOwnerToken: "owner-token",
      source: "agent_chat_profile_import",
    });

    expect(prepared.sourceCoverage).toEqual([
      {
        sourceBlockId: "source_block_001",
        disposition: "proposed",
        detectedFactCount: 1,
        accountedFactCount: 1,
      },
    ]);
  });
});

describe("prepareNaturalLanguagePkm large-paste behavior", () => {
  beforeEach(() => {
    mocks.preview.mockReset();
    mocks.save.mockReset();
  });

  it("keeps the blocks that prepared when one block fails, and reports the failure", async () => {
    // Seven numbered sections pack into two chunks (six per chunk).
    const sections = Array.from({ length: 7 }, (_, i) => `${i + 1}. Section ${i + 1}\nFact number ${i + 1} about me.`);
    mocks.preview
      .mockResolvedValueOnce({ cards: [{ card_id: "a", source_text: "Fact number 1 about me.", write_mode: "can_save" }], preview_summary: { total_segments_detected: 1 } })
      .mockRejectedValueOnce(new Error("Memory preparation failed (http_503). Please try again."));
    const result = await prepareNaturalLanguagePkm({
      userId: "user_1",
      message: sections.join("\n\n"),
      currentDomains: [],
      vaultOwnerToken: "owner-token",
      source: "agent_chat_profile_import",
    });
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(result.cards).toHaveLength(1);
    expect(result.sourceCoverage.map((block) => block.disposition)).toEqual(["proposed", "failed"]);
  });

  it("fails only when every block failed", async () => {
    mocks.preview.mockRejectedValueOnce(new Error("Memory preparation failed (http_503). Please try again."));
    await expect(
      prepareNaturalLanguagePkm({
        userId: "user_1",
        message: "I run at dawn.",
        currentDomains: [],
        vaultOwnerToken: "owner-token",
        source: "agent_chat_profile_import",
      }),
    ).rejects.toThrow("failed for every section");
  });

  it("drops exact duplicates, forces confirmation on near matches, and counts excluded secrets", async () => {
    mocks.preview.mockResolvedValueOnce({
      cards: [
        { card_id: "dup", source_text: "I type at about 85 WPM.", write_mode: "can_save" },
        { card_id: "near", source_text: "I prefer early breakfasts most days.", write_mode: "can_save" },
        { card_id: "fresh", source_text: "I run at dawn.", write_mode: "can_save" },
        { card_id: "secret", source_text: "Card on file 4111 1111 1111 1111", write_mode: "do_not_save", validation_hints: ["sensitive_card_number_rejected"] },
      ],
      preview_summary: { total_segments_detected: 4 },
    });
    const result = await prepareNaturalLanguagePkm({
      userId: "user_1",
      message: "I type at about 85 WPM. I prefer early breakfasts most days. I run at dawn. Card on file 4111 1111 1111 1111",
      currentDomains: ["preferences"],
      currentManifests: [{ domain: "preferences" }],
      vaultOwnerToken: "owner-token",
      source: "agent_chat_profile_import",
      findDuplicate: (candidate) =>
        candidate.includes("85 WPM")
          ? { kind: "exact", domain: "professional", path: ["typing_speed"] }
          : candidate.includes("breakfast")
            ? { kind: "possible", domain: "food", path: ["breakfast"] }
            : null,
    });
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ currentManifests: [{ domain: "preferences" }] }));
    const ids = result.cards.map((card) => card.card_id.split("_").at(-1));
    expect(ids).toEqual(["near", "fresh", "secret"]);
    const near = result.cards.find((card) => card.card_id.endsWith("near"));
    expect(near?.write_mode).toBe("confirm_first");
    expect(near?.validation_hints).toContain("possible_duplicate");
    expect(result.sourceCoverage[0]).toMatchObject({ duplicateCount: 1, excludedSecretCount: 1 });
  });
});
