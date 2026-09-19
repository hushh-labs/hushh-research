import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  },
}));

const pkmGetMetadataMock = vi.fn();
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: (...args: unknown[]) => pkmGetMetadataMock(...args),
  },
}));

const pkmGetStaleFirstMock = vi.fn();
const pkmGetManyStaleFirstMock = vi.fn();
const pkmHydrateFromSecureCacheMock = vi.fn();
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: (...args: unknown[]) => pkmGetStaleFirstMock(...args),
    getManyStaleFirst: (...args: unknown[]) => pkmGetManyStaleFirstMock(...args),
    hydrateFromSecureCache: (...args: unknown[]) => pkmHydrateFromSecureCacheMock(...args),
  },
}));

const pkmSavePreparedDomainMock = vi.fn();
const pkmSaveMergedDomainMock = vi.fn();
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    savePreparedDomain: (...args: unknown[]) => pkmSavePreparedDomainMock(...args),
    saveMergedDomain: (...args: unknown[]) => pkmSaveMergedDomainMock(...args),
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
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { createAgentPkmCaptureGuard, isAgentPkmProcessingReady } from "@/lib/agent/agent-pkm-capture-runtime";

it("keeps a confirmed old-generation receipt without invalidating the replacement owner context", async () => {
  publishValidatedAuthSessionOwner("owner-a");
  const guard = createAgentPkmCaptureGuard({
    userId: "owner-a", signal: new AbortController().signal, isEnabled: () => true,
  });
  const invalidate = vi.spyOn(AgentPkmContextStore, "invalidateUser");
  pkmSavePreparedDomainMock.mockImplementationOnce(async () => {
    publishValidatedAuthSessionOwner("owner-b");
    publishValidatedAuthSessionOwner("owner-a");
    advanceVaultSessionEpoch();
    return { success: true, saveState: "saved", fullBlob: {} };
  });
  try {
    const result = await addToPKM({
      userId: "owner-a", sourceMessage: "Synthetic preference", vaultKey: "test-key",
      vaultOwnerToken: "test-token", beforeEffect: guard.assertCurrent, mayPublish: guard.isCurrent,
      confirmation: { confirmedByUser: true, surface: "chat", source: "test" },
      cards: [{ card_id: "test", write_mode: "can_save", target_domain: "preferences",
        candidate_payload: { format: "brief" }, structure_decision: { target_domain: "preferences" } }],
    });
    expect(result.saved).toBe(1);
    expect(guard.isCurrent()).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  } finally {
    invalidate.mockRestore();
    publishValidatedAuthSessionOwner(null);
  }
});

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

let pkmBlob: Record<string, unknown>;

describe("agent PKM memory helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAgentPkmContext();
    pkmGetMetadataMock.mockResolvedValue(METADATA);
    pkmBlob = {
      preferences: {
        writing: {
          default_style: "concise summaries",
        },
      },
    };
    pkmGetStaleFirstMock.mockResolvedValue({
      data: {
        identity_profile: {
          full_name: "Akshat Kumar",
          declared_age: "23",
        },
      },
    });
    pkmHydrateFromSecureCacheMock.mockResolvedValue(null);
    pkmGetManyStaleFirstMock.mockImplementation(async ({ domains }: { domains: string[] }) => ({
      snapshots: Object.fromEntries(
        domains
          .filter((domain) => pkmBlob[domain])
          .map((domain) => [domain, { data: pkmBlob[domain] }]),
      ),
      failedDomains: [],
    }));
    pkmSavePreparedDomainMock.mockResolvedValue({
      success: true,
      saveState: "saved",
      message: "Saved",
      fullBlob: {},
    });
    pkmSaveMergedDomainMock.mockResolvedValue({
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
      { card_id: "incomplete", source_text: "", write_mode: "can_save", preparation_requires_review: true },
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

  it("rechecks token expiry without requiring a React render", () => {
    vi.useFakeTimers();
    const state = { authLoading: false, sessionVerificationRequired: false, isVaultUnlocked: true,
      vaultOwnerToken: "test-token", tokenExpiresAt: Date.now() + 100 };
    expect(isAgentPkmProcessingReady(state, "test-token")).toBe(true);
    expect(isAgentPkmProcessingReady({ ...state, vaultOwnerToken: "replacement" }, "test-token")).toBe(false);
    vi.advanceTimersByTime(100);
    expect(isAgentPkmProcessingReady(state, "test-token")).toBe(false);
    expect(isAgentPkmProcessingReady({ ...state, tokenExpiresAt: null }, "test-token")).toBe(false);
  });

  it.each(["owner", "product"])("rejects a direct %s automatic write with incomplete coverage but retains explicit manual review", async (mode) => {
    const card: AgentPkmPreviewCard = {
      card_id: "incomplete", source_text: "I prefer tea.", write_mode: "can_save",
      preparation_requires_review: true, target_domain: "preferences",
      candidate_payload: { drink: "tea" }, structure_decision: { target_domain: "preferences" },
    };
    const params = { userId: "user_1", cards: [card], sourceMessage: "I prefer tea. I prefer warm rooms.",
      vaultKey: "test-key", vaultOwnerToken: "test-token", source: "test" };
    const automatic = await addToPKM({ ...params, confirmation: mode === "owner" ? {
      authorizationMode: "owner_auto_save_policy", surface: "chat", source: "test",
      autoSavePolicyVersion: 1, autoSavePolicyEnabledAt: "2026-09-18T00:00:00Z",
    } : {
      authorizationMode: "product_default_auto_save_policy", surface: "chat",
      source: "agent_chat_product_default_auto_save", autoSavePolicyVersion: 1,
      productDefaultEffectiveAt: "2026-09-18T00:00:00Z",
    } });
    expect(automatic).toMatchObject({ saved: 0, failed: 1 });
    expect(pkmSavePreparedDomainMock).not.toHaveBeenCalled();
    expect(pkmSaveMergedDomainMock).not.toHaveBeenCalled();
    const reviewed = await addToPKM({ ...params, confirmation: {
      confirmedByUser: true, surface: "web", source: "test",
    } });
    expect(reviewed).toMatchObject({ saved: 1, failed: 0 });
    expect(pkmSavePreparedDomainMock).toHaveBeenCalledTimes(1);
    expect(card.write_mode).toBe("can_save");
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
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        vaultKey: "vault_key",
        vaultOwnerToken: "vault_token",
      })
    );
  });

  it("uses encrypted device snapshots before detached chat revalidation", async () => {
    pkmHydrateFromSecureCacheMock.mockImplementation(async ({ domain }) =>
      domain === "preferences"
        ? { data: pkmBlob.preferences }
        : null,
    );

    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my writing preferences",
    });

    expect(context.text).toContain("concise summaries");
    expect(pkmHydrateFromSecureCacheMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", domain: "preferences", vaultKey: "vault_key" }),
    );
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ forceRefresh: true, backgroundRefresh: false }),
    );
  });

  it("loads only the identity profile segment for a targeted KYC lookup", async () => {
    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "Find my legal name and age for this KYC request",
    });

    expect(pkmGetStaleFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        domain: "identity",
        segmentIds: ["identity_profile"],
        backgroundRefresh: false,
      }),
    );
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
    expect(context.text).toContain("Akshat Kumar");
  });

  it("serves a warm targeted KYC lookup without another encrypted-segment request", async () => {
    const params = {
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "Find my legal name and age for this KYC request",
    };

    await loadAgentPkmContext(params);
    await loadAgentPkmContext(params);

    expect(pkmGetStaleFirstMock).toHaveBeenCalledTimes(1);
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
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

  it("warms only PKM metadata until a chat request selects encrypted segments", async () => {
    await warmAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
    });

    expect(pkmGetMetadataMock).toHaveBeenCalledTimes(1);
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
    expect(peekAgentPkmContext({ userId: "user_1", message: "writing preferences" }))
      .toBeNull();
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
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledTimes(1);
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
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
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
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
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
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
  });

  it("never projects runtime secrets or quarantined information into an Agent Chat PKM context", async () => {
    pkmBlob = {
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
    };

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
    pkmBlob = {
      food: {
        drinks: { favorite: "tea" },
        nested: deeplyNested,
      },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [
        ...METADATA.domains,
        { ...METADATA.domains[0], key: "food", displayName: "Food" },
      ],
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

  it("batches simple KYC fields for one domain into one encrypted write", async () => {
    const result = await addToPKM({
      userId: "user_1",
      cards: [
        {
          card_id: "kyc-name",
          source_text: "My name is Akshat Kumar.",
          write_mode: "can_save",
          merge_mode: "extend_entity",
          target_domain: "identity",
          primary_json_path: "identity_profile.full_name",
          candidate_payload: { identity_profile: { full_name: "Akshat Kumar" } },
          structure_decision: { target_domain: "identity" },
        },
        {
          card_id: "kyc-institution",
          source_text: "I study at IIT Bombay.",
          write_mode: "can_save",
          merge_mode: "extend_entity",
          target_domain: "identity",
          primary_json_path: "identity_profile.education.institution",
          candidate_payload: {
            identity_profile: { education: { institution: "IIT Bombay" } },
          },
          structure_decision: { target_domain: "identity" },
        },
      ],
      sourceMessage: "KYC profile",
      vaultKey: "vault_key",
      vaultOwnerToken: "owner-token",
      source: "kyc_identity_onboarding",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "kyc_identity_onboarding",
      },
      batchSimpleDomainExtensions: true,
    });

    expect(pkmSavePreparedDomainMock).not.toHaveBeenCalled();
    expect(pkmSaveMergedDomainMock).toHaveBeenCalledTimes(1);
    const write = pkmSaveMergedDomainMock.mock.calls[0]?.[0] as {
      domain: string;
      build: () => { domainData: Record<string, unknown> };
    };
    expect(write.domain).toBe("identity");
    expect(write.build().domainData).toEqual({
      identity_profile: {
        full_name: "Akshat Kumar",
        education: { institution: "IIT Bombay" },
      },
    });
    expect(result).toMatchObject({
      saved: 2,
      failed: 0,
      results: [
        { cardId: "kyc-name", success: true },
        { cardId: "kyc-institution", success: true },
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
