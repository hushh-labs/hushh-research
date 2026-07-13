import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  },
}));

const pkmGetMetadataMock = vi.fn();
const pkmLoadFullBlobMock = vi.fn();
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: (...args: unknown[]) => pkmGetMetadataMock(...args),
    loadFullBlob: (...args: unknown[]) => pkmLoadFullBlobMock(...args),
  },
}));

const pkmSavePreparedDomainMock = vi.fn();
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    savePreparedDomain: (...args: unknown[]) => pkmSavePreparedDomainMock(...args),
  },
}));

import {
  addToPKM,
  clearAgentPkmContext,
  loadAgentPkmContext,
  peekAgentPkmContext,
  previewAgentPkmMemory,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";

const METADATA = {
  userId: "user_1",
  domains: [
    {
      key: "preferences",
      displayName: "Preferences",
      icon: "",
      color: "",
      attributeCount: 1,
      summary: { readable_summary: "Prefers concise answers." },
      readableSummary: "Prefers concise answers.",
      readableHighlights: ["Concise summaries"],
      availableScopes: [],
      lastUpdated: "2026-07-06T12:00:00Z",
    },
  ],
  totalAttributes: 1,
  modelCompleteness: 1,
  modelVersion: 1,
  storedModelVersion: 1,
  effectiveModelVersion: 1,
  targetModelVersion: 1,
  upgradeStatus: "ready",
  upgradableDomains: [],
  suggestedDomains: [],
  lastUpgradedAt: null,
  lastUpdated: "2026-07-06T12:00:00Z",
};

describe("agent PKM memory helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAgentPkmContext();
    pkmGetMetadataMock.mockResolvedValue(METADATA);
    pkmLoadFullBlobMock.mockResolvedValue({
      preferences: {
        writing: {
          default_style: "concise summaries",
        },
      },
    });
    pkmSavePreparedDomainMock.mockResolvedValue({
      success: true,
      saveState: "saved",
      message: "Saved",
      fullBlob: {},
    });
  });

  it("loads decrypted session PKM when the vault key is available", async () => {
    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my writing preferences",
    });

    expect(context.source).toBe("decrypted_session_pkm");
    expect(context.text).toContain("Source: decrypted client-side");
    expect(context.text).toContain("concise summaries");
    expect(pkmLoadFullBlobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        vaultKey: "vault_key",
        vaultOwnerToken: "vault_token",
      })
    );
  });

  it("falls back to metadata PKM summaries when the vault key is unavailable", async () => {
    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      message: "what do you know about my preferences",
    });

    expect(context.source).toBe("metadata");
    expect(context.text).toContain("PKM compact context");
    expect(context.text).toContain("Preferences");
    expect(pkmLoadFullBlobMock).not.toHaveBeenCalled();
  });

  it("previews PKM memory through the agent-lab structure route", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        agent_id: "agent",
        agent_name: "One",
        model: "test",
        used_fallback: false,
        preview_cards: [
          {
            card_id: "card_1",
            source_text: "",
            write_mode: "confirm_first",
            target_domain: "preferences",
            candidate_payload: { writing: { default_style: "concise" } },
            structure_decision: { target_domain: "preferences" },
          },
        ],
      }),
    });

    const preview = await previewAgentPkmMemory({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      message: "remember that I prefer concise summaries",
      currentDomains: ["preferences"],
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/pkm/agent-lab/structure",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer vault_token",
        }),
      })
    );
    expect(preview.cards[0]).toMatchObject({
      card_id: "card_1",
      source_text: "remember that I prefer concise summaries",
      write_mode: "confirm_first",
    });
  });

  it("saves reviewed PKM cards through the write coordinator and invalidates cached context", async () => {
    await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "writing",
    });
    expect(peekAgentPkmContext({ userId: "user_1", message: "writing" })).not.toBeNull();

    const cards: AgentPkmPreviewCard[] = [
      {
        card_id: "card_1",
        source_text: "remember that I prefer concise summaries",
        write_mode: "can_save",
        target_domain: "preferences",
        candidate_payload: { writing: { default_style: "concise" } },
        structure_decision: { target_domain: "preferences" },
      },
    ];

    const result = await addToPKM({
      userId: "user_1",
      cards,
      sourceMessage: "remember that I prefer concise summaries",
      vaultKey: "vault_key",
      vaultOwnerToken: "vault_token",
      source: "agent_chat",
      confirmation: {
        confirmedByUser: true,
        surface: "chat",
        source: "agent_chat_review_button",
      },
    });

    expect(result.saved).toBe(1);
    expect(pkmSavePreparedDomainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        domain: "preferences",
        vaultKey: "vault_key",
        vaultOwnerToken: "vault_token",
      })
    );
    expect(peekAgentPkmContext({ userId: "user_1", message: "writing" })).toBeNull();
  });

  it("fails closed when owner confirmation evidence is absent", async () => {
    const result = await addToPKM({
      userId: "user_1",
      cards: [
        {
          card_id: "card_1",
          source_text: "remember this",
          write_mode: "can_save",
          target_domain: "preferences",
          candidate_payload: { writing: { default_style: "concise" } },
          structure_decision: { target_domain: "preferences" },
        },
      ],
      sourceMessage: "remember this",
      vaultKey: "vault_key",
      vaultOwnerToken: "vault_token",
    } as unknown as Parameters<typeof addToPKM>[0]);

    expect(result.saved).toBe(0);
    expect(result.failed).toBe(1);
    expect(pkmSavePreparedDomainMock).not.toHaveBeenCalled();
  });
});
