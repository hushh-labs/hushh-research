import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  formatAgentPkmSaveSummary,
  getPkmAutoSaveCards,
  getPkmConfirmationCards,
  loadAgentPkmContext,
  peekAgentPkmContext,
  previewAgentPkmMemory,
  warmAgentPkmContext,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps sharing and uncertain cards in review while exposing only private can-save cards", () => {
    const cards: AgentPkmPreviewCard[] = [
      { card_id: "auto", source_text: "", write_mode: "can_save" },
      {
        card_id: "shared",
        source_text: "",
        write_mode: "can_save",
        sharing_impact: {
          active_recipient_count: 1,
          recipient_labels: ["Advisor"],
          enters_next_export_revision: true,
          summary: "One recipient is affected.",
          affected_grant_ids: ["grant"],
          affected_export_ids: ["export"],
        },
      },
      { card_id: "review", source_text: "", write_mode: "confirm_first" },
    ];

    expect(getPkmAutoSaveCards(cards).map((card) => card.card_id)).toEqual(["auto"]);
    expect(getPkmConfirmationCards(cards).map((card) => card.card_id)).toEqual([
      "shared",
      "review",
    ]);
  });

  it("loads decrypted session PKM when the vault key is available", async () => {
    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my writing preferences",
    });

    expect(context.source).toBe("decrypted_session_pkm");
    expect(context.text).toContain("Source: decrypted locally");
    expect(context.text).toContain("concise summaries");
    expect(context.coverage).toMatchObject({
      totalFactCount: 1,
      matchedFactCount: 1,
      selectedFactCount: 1,
      budgetChars: 12000,
    });
    expect(pkmLoadFullBlobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        vaultKey: "vault_key",
        vaultOwnerToken: "vault_token",
      })
    );
  });

  it("checks duplicates only against an already-unlocked local inventory", async () => {
    expect(
      AgentPkmContextStore.findLocalDuplicate({
        userId: "user_1",
        candidate: "concise summaries",
      })
    ).toBeNull();

    await loadAgentPkmContext({
      userId: "user_1",
      vaultKey: "test-vault-key",
      vaultOwnerToken: "owner-token",
      message: "preferences",
    });

    expect(
      AgentPkmContextStore.findLocalDuplicate({
        userId: "user_1",
        candidate: "concise summaries",
      })
    ).toMatchObject({ kind: "exact", domain: "preferences" });
  });

  it("treats the reported memory-summary wording as a broad PKM request", async () => {
    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "list down a summary of my memory",
    });

    expect(context.source).toBe("decrypted_session_pkm");
    expect(context.mode).toBe("broad");
    expect(context.text).toContain("Preferences: 1 saved fact");
    expect(context.text).not.toContain("concise summaries");
    expect(context.coverage).toMatchObject({ inventoryOnly: true, selectedFactCount: 0 });
  });

  it("warms the Agent working set only in process memory", async () => {
    await warmAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
    });

    expect(pkmLoadFullBlobMock).toHaveBeenCalledTimes(1);
    expect(peekAgentPkmContext({ userId: "user_1", message: "writing preferences" }))
      .not.toBeNull();
  });

  it("serves an expired session working set immediately while one refresh is shared", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00Z"));
    await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "summarize my memory",
    });

    vi.setSystemTime(new Date("2026-07-20T12:06:00Z"));
    expect(
      peekAgentPkmContext({ userId: "user_1", message: "summarize my memory" })?.text,
    ).toContain("Preferences: 1 saved fact");

    let resolveMetadata: ((value: typeof METADATA) => void) | null = null;
    pkmGetMetadataMock.mockReturnValueOnce(
      new Promise<typeof METADATA>((resolve) => {
        resolveMetadata = resolve;
      }),
    );
    const firstRefresh = loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "summarize my memory",
    });
    const secondRefresh = loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my writing",
    });

    expect(pkmGetMetadataMock).toHaveBeenCalledTimes(2);
    resolveMetadata?.(METADATA);
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toHaveLength(2);
    expect(pkmLoadFullBlobMock).toHaveBeenCalledTimes(1);
  });

  it("drops an in-flight context load when the vault session clears", async () => {
    let resolveMetadata: ((value: typeof METADATA) => void) | null = null;
    pkmGetMetadataMock.mockReturnValueOnce(
      new Promise<typeof METADATA>((resolve) => {
        resolveMetadata = resolve;
      })
    );

    const pending = loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
    });
    clearAgentPkmContext("user_1");
    resolveMetadata?.(METADATA);

    await expect(pending).resolves.toMatchObject({ text: "", domains: [] });
    expect(pkmLoadFullBlobMock).not.toHaveBeenCalled();
    expect(peekAgentPkmContext({ userId: "user_1" })).toBeNull();
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

  it("uses only redacted metadata for an interactive first-turn preflight", async () => {
    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my preferences",
      metadataOnly: true,
    });

    expect(context.source).toBe("metadata");
    expect(context.text).toContain("summary metadata only");
    expect(pkmLoadFullBlobMock).not.toHaveBeenCalled();
  });

  it("never projects runtime secrets or quarantined information into an Agent Chat PKM context", async () => {
    pkmLoadFullBlobMock.mockResolvedValue({
      preferences: {
        writing: { default_style: "concise summaries" },
      },
      runtime_secrets: {
        llm: {
          gemini_api_key: "must-not-reach-agent-context",
          credential_mode: "byok",
        },
      },
      __quarantine_v1: {
        saved_but_never_shareable: "must-not-reach-agent-context",
      },
    });

    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "summarize everything in my PKM",
    });

    expect(context.source).toBe("decrypted_session_pkm");
    expect(context.domains).toContain("preferences");
    expect(context.domains).not.toContain("runtime_secrets");
    expect(context.domains).not.toContain("__quarantine_v1");
    expect(context.text).toContain("Preferences: 1 saved fact");
    expect(context.text).not.toContain("runtime_secrets");
    expect(context.text).not.toContain("gemini_api_key");
    expect(context.text).not.toContain("must-not-reach-agent-context");
  });

  it("keeps a bounded local inventory and reports safety omissions", async () => {
    const deeplyNested: Record<string, unknown> = { favorite: "tea" };
    let cursor = deeplyNested;
    for (let index = 0; index < 18; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    pkmLoadFullBlobMock.mockResolvedValue({
      food: {
        drinks: { favorite: "tea" },
        nested: deeplyNested,
      },
    });

    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "What drinks do I like?",
    });

    expect(context.text).toContain("Food > Drinks > Favorite: tea");
    expect(context.coverage?.safetyOmittedNodeCount).toBeGreaterThan(0);
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
      "/api/pkm/memory/proposals",
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

  it("redacts rejected proposal payloads from the user-facing error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        detail: [{ type: "string_too_long", input: "private imported profile must not escape" }],
      }),
    });

    await expect(previewAgentPkmMemory({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      message: "private imported profile must not escape",
      currentDomains: ["identity"],
      ingestionId: "ingestion-1",
      chunkIndex: 2,
    })).rejects.toThrow("Memory preparation failed (string_too_long). Please try again.");

    expect(consoleError).toHaveBeenCalledWith(
      "[PKM_INGEST] proposal_failed",
      expect.objectContaining({
        ingestion_id: "ingestion-1",
        chunk_index: 2,
        status: 422,
        error_code: "string_too_long",
      }),
    );
    consoleError.mockRestore();
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
    const write = pkmSavePreparedDomainMock.mock.calls[0]?.[0] as {
      build: () => Promise<{ summary: Record<string, unknown> }>;
    };
    const plan = await write.build();
    expect(JSON.stringify(plan.summary)).not.toContain(
      "remember that I prefer concise summaries"
    );
    expect(plan.summary).not.toHaveProperty("message_excerpt");
    expect(plan.summary).not.toHaveProperty("card_id");
    expect(peekAgentPkmContext({ userId: "user_1", message: "writing" })).toBeNull();
  });

  it("writes independent domains concurrently while preserving per-domain merge order", async () => {
    const pendingWrites = new Map<string, Array<() => void>>();
    pkmSavePreparedDomainMock.mockImplementation(({ domain }: { domain: string }) =>
      new Promise((resolve) => {
        const resolvers = pendingWrites.get(domain) || [];
        resolvers.push(() => resolve({ success: true, saveState: "saved", message: "Saved", fullBlob: {} }));
        pendingWrites.set(domain, resolvers);
      }),
    );

    const saveTask = addToPKM({
      userId: "user_1",
      cards: [
        {
          card_id: "preference-1",
          source_text: "I prefer concise summaries.",
          write_mode: "can_save",
          target_domain: "preferences",
          candidate_payload: { writing: { default_style: "concise" } },
          structure_decision: { target_domain: "preferences" },
        },
        {
          card_id: "education-1",
          source_text: "I study engineering.",
          write_mode: "can_save",
          target_domain: "education",
          candidate_payload: { field: "engineering" },
          structure_decision: { target_domain: "education" },
        },
        {
          card_id: "preference-2",
          source_text: "I like gaming laptops.",
          write_mode: "can_save",
          target_domain: "preferences",
          candidate_payload: { hardware: { preference: "gaming laptop" } },
          structure_decision: { target_domain: "preferences" },
        },
      ],
      sourceMessage: "Imported profile",
      vaultKey: "vault_key",
      vaultOwnerToken: "owner-token",
      confirmation: {
        confirmedByUser: true,
        surface: "chat",
        source: "agent_chat_review_button",
      },
    });

    expect(pkmSavePreparedDomainMock.mock.calls.map(([params]) => params.domain)).toEqual([
      "preferences",
      "education",
    ]);
    expect(pendingWrites.get("preferences")).toHaveLength(1);

    pendingWrites.get("education")?.[0]?.();
    pendingWrites.get("preferences")?.[0]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pkmSavePreparedDomainMock.mock.calls.map(([params]) => params.domain)).toEqual([
      "preferences",
      "education",
      "preferences",
    ]);
    pendingWrites.get("preferences")?.[1]?.();

    await expect(saveTask).resolves.toMatchObject({
      saved: 3,
      results: [
        { cardId: "preference-1", success: true },
        { cardId: "education-1", success: true },
        { cardId: "preference-2", success: true },
      ],
    });
  });

  it("returns a scoped, private-agent save receipt for a reviewed preference", async () => {
    const result = await addToPKM({
      userId: "user_1",
      cards: [
        {
          card_id: "food-drink-card",
          source_text: "Remember that I prefer tea.",
          write_mode: "can_save",
          target_domain: "food",
          primary_json_path: "drinks.favorite",
          candidate_payload: { drinks: { favorite: "tea" } },
          structure_decision: { target_domain: "food" },
        },
      ],
      sourceMessage: "Remember that I prefer tea.",
      vaultKey: "vault_key",
      vaultOwnerToken: "vault_token",
      source: "agent_chat",
      confirmation: {
        confirmedByUser: true,
        surface: "chat",
        source: "agent_chat_review_button",
      },
    });

    expect(result.results[0]).toMatchObject({
      domain: "food",
      scope: "drinks.favorite",
      sharingPosture: "Private to your private agent. Consent is required before external sharing.",
      success: true,
    });
    expect(formatAgentPkmSaveSummary(result)).toBe(
      "Saved in Food > Drinks > Favorite. Private to your private agent. Consent is required before external sharing."
    );
  });

  it("lists each saved PKM location once in the receipt", () => {
    expect(
      formatAgentPkmSaveSummary({
        attempted: 3,
        saved: 3,
        failed: 0,
        domains: ["food"],
        results: [
          {
            cardId: "one",
            domain: "food",
            scope: "preferences",
            success: true,
            sharingPosture: "Private to your private agent.",
          },
          {
            cardId: "two",
            domain: "food",
            scope: "preferences",
            success: true,
            sharingPosture: "Private to your private agent.",
          },
          {
            cardId: "three",
            domain: "food",
            scope: "preferences",
            success: true,
            sharingPosture: "Private to your private agent.",
          },
        ],
      })
    ).toBe("Saved in Food > Preferences. Private to your private agent.");
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
