import { beforeEach, describe, expect, it, vi } from "vitest";

const encryptDataMock = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("@/lib/capacitor", () => ({
  HushhPersonalKnowledgeModel: {},
  HushhVault: {
    encryptData: (...args: unknown[]) => encryptDataMock(...args),
  },
}));

vi.mock("@/lib/firebase/config", () => ({
  app: {},
  auth: { currentUser: null },
  getRecaptchaVerifier: vi.fn(),
  resetRecaptcha: vi.fn(),
}));

import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { ApiService } from "@/lib/services/api-service";

describe("PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    encryptDataMock.mockResolvedValue({
      ciphertext: "ciphertext-1",
      iv: "iv-1",
      tag: "tag-1",
    });
  });

  it("stores merged domain from prepared blob without loading blob again", async () => {
    const loadSpy = vi
      .spyOn(PersonalKnowledgeModelService, "loadFullBlob")
      .mockResolvedValue({ existing: { foo: "bar" } });
    const storeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "storeDomainData")
      .mockResolvedValue({ success: true });

    const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
      userId: "user-1",
      vaultKey: "vault-key-1",
      domain: "food",
      domainData: { favorite: "sushi" },
      summary: { item_count: 1 },
      baseFullBlob: { existing: { foo: "bar" } },
      vaultOwnerToken: "vault-owner-token",
    });

    expect(result.success).toBe(true);
    expect(result.fullBlob).toEqual({
      existing: { foo: "bar" },
      food: { favorite: "sushi" },
    });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(encryptDataMock).toHaveBeenCalledTimes(2);
    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        domain: "food",
        domainData: { favorite: "sushi" },
        summary: expect.objectContaining({
          domain_intent: "food",
          item_count: 1,
        }),
      }),
    );
  });

  it("can replace an authoritative financial domain without preserving stale portfolio data", async () => {
    const storeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "storeDomainData")
      .mockResolvedValue({ success: true });

    const nextFinancialDomain = {
      schema_version: 3,
      portfolio: {
        holdings: [{ symbol: "NEW", market_value: 200 }],
        total_value: 200,
      },
      documents: {
        statements: [
          {
            id: "stmt_new",
            canonical_v2: {
              holdings: [{ symbol: "NEW", market_value: 200 }],
              total_value: 200,
            },
          },
        ],
      },
      sources: {
        active_source: "statement",
        statement: {
          active_snapshot_id: "stmt_new",
        },
      },
    };

    const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
      userId: "user-1",
      vaultKey: "vault-key-1",
      domain: "financial",
      baseFullBlob: {
        financial: {
          schema_version: 3,
          portfolio: {
            holdings: [{ symbol: "OLD", market_value: 100 }],
            total_value: 100,
            stale_field: "remove-me",
          },
          documents: {
            statements: [
              {
                id: "stmt_old",
                canonical_v2: {
                  holdings: [{ symbol: "OLD", market_value: 100 }],
                  total_value: 100,
                },
              },
            ],
          },
          sources: {
            active_source: "plaid",
            plaid: {
              aggregate: {
                portfolio_data: {
                  holdings: [{ symbol: "PLAID", market_value: 300 }],
                },
              },
            },
          },
        },
      },
      domainData: nextFinancialDomain,
      summary: { item_count: 1 },
      mergeDecision: {
        merge_mode: "replace_domain",
        target_domain: "financial",
      },
      vaultOwnerToken: "vault-owner-token",
    });

    expect(result.fullBlob.financial).toEqual(nextFinancialDomain);
    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "financial",
        domainData: nextFinancialDomain,
        portfolioData: nextFinancialDomain.portfolio,
      }),
    );
  });

  it("validates prepared domain with the same normalized PKM store contract payload", async () => {
    const apiFetchSpy = vi.spyOn(ApiService, "apiFetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, message: "validated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await PersonalKnowledgeModelService.validatePreparedDomainStore({
      userId: "user-1",
      vaultKey: "vault-key-1",
      domain: "financial",
      domainData: { holdings: [{ ticker: "AAPL" }] },
      summary: {},
      manifest: {
        domain: "financial",
        manifest_version: 2,
        domain_contract_version: 3,
        readable_summary_version: 1,
        upgraded_at: null,
        summary_projection: {},
        top_level_scope_paths: ["holdings"],
        externalizable_paths: ["holdings._items.ticker"],
        paths: [
          {
            json_path: "holdings",
            path_type: "array",
            exposure_eligibility: true,
          },
        ],
      },
      baseFullBlob: {},
      expectedDataVersion: 4,
      upgradeContext: {
        runId: "rehearsal_user-1",
        priorDomainContractVersion: 2,
        newDomainContractVersion: 3,
        priorReadableSummaryVersion: 0,
        newReadableSummaryVersion: 1,
        retryCount: 0,
      },
      vaultOwnerToken: "vault-owner-token",
    });

    expect(result.success).toBe(true);
    expect(apiFetchSpy).toHaveBeenCalledTimes(1);
    const [, requestInit] = apiFetchSpy.mock.calls[0] || [];
    const payload = JSON.parse(String((requestInit as RequestInit | undefined)?.body || "{}"));
    expect(payload).toMatchObject({
      user_id: "user-1",
      domain: "financial",
      expected_data_version: 4,
      upgrade_context: {
        run_id: "rehearsal_user-1",
        prior_domain_contract_version: 2,
        new_domain_contract_version: 3,
        prior_readable_summary_version: 0,
        new_readable_summary_version: 1,
        retry_count: 0,
      },
      manifest: expect.objectContaining({
        domain_contract_version: 3,
        readable_summary_version: 1,
      }),
      summary: expect.objectContaining({
        domain_intent: "financial",
        domain_contract_version: 3,
        readable_summary_version: 1,
      }),
    });
    expect(typeof payload.manifest.upgraded_at).toBe("string");
    expect(typeof payload.summary.upgraded_at).toBe("string");
  });

  it("forwards sync checkpoint metadata in the normalized PKM store payload", async () => {
    const apiFetchSpy = vi.spyOn(ApiService, "apiFetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data_version: 12,
          updated_at: "2026-04-01T00:00:00Z",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );

    await PersonalKnowledgeModelService.storeDomainData({
      userId: "user-1",
      domain: "financial",
      encryptedBlob: {
        ciphertext: "cipher",
        iv: "iv",
        tag: "tag",
      },
      summary: {},
      expectedDataVersion: 11,
      syncCheckpoint: {
        schemaVersion: "pkm_sync_checkpoint.v1",
        checkpointKey:
          "pkm_sync_checkpoint.v1|merged_domain|financial|attempt:0|expected:11|current_manifest:2|target_manifest:3|upgrade:none",
        domain: "financial",
        source: "merged_domain",
        attempt: 0,
        expectedDataVersion: 11,
        currentManifestVersion: 2,
        targetManifestVersion: 3,
        upgradedInSession: false,
        conflictRetry: false,
        upgradeRunId: null,
      },
      vaultOwnerToken: "vault-owner-token",
    });

    const [, requestInit] = apiFetchSpy.mock.calls[0] || [];
    const payload = JSON.parse(String((requestInit as RequestInit | undefined)?.body || "{}"));
    expect(payload.sync_checkpoint).toEqual({
      schema_version: "pkm_sync_checkpoint.v1",
      checkpoint_key:
        "pkm_sync_checkpoint.v1|merged_domain|financial|attempt:0|expected:11|current_manifest:2|target_manifest:3|upgrade:none",
      domain: "financial",
      source: "merged_domain",
      attempt: 0,
      expected_data_version: 11,
      current_manifest_version: 2,
      target_manifest_version: 3,
      upgraded_in_session: false,
      conflict_retry: false,
      upgrade_run_id: null,
    });
  });

  it("applies correct_entity as an in-place canonical entity update", async () => {
    const storeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "storeDomainData")
      .mockResolvedValue({
        success: true,
      });

    const result = await PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob({
      userId: "user-1",
      vaultKey: "vault-key-1",
      domain: "travel",
      baseFullBlob: {
        travel: {
          seat_preferences: {
            entities: {
              seat_pref_001: {
                entity_id: "seat_pref_001",
                kind: "preference",
                summary: "Prefers aisle seats.",
                observations: ["Prefers aisle seats."],
                status: "active",
                created_at: "2026-05-01T00:00:00.000Z",
              },
            },
          },
        },
      },
      domainData: {
        seat_preferences: {
          entities: {
            seat_pref_001: {
              entity_id: "seat_pref_001",
              kind: "correction",
              summary: "Actually window seats work better now.",
              observations: ["Actually window seats work better now."],
              status: "active",
            },
          },
        },
      },
      summary: {},
      mergeDecision: {
        merge_mode: "correct_entity",
        target_domain: "travel",
        target_entity_id: "seat_pref_001",
        target_entity_path: "seat_preferences.entities.seat_pref_001",
        match_confidence: 0.91,
        match_reason: "Corrects the active seat preference.",
      },
      vaultOwnerToken: "vault-owner-token",
    });

    const travel = result.fullBlob.travel as {
      seat_preferences: { entities: Record<string, Record<string, unknown>> };
    };
    const entities = travel.seat_preferences.entities;
    expect(Object.keys(entities)).toEqual(["seat_pref_001"]);
    expect(entities.seat_pref_001).toMatchObject({
      entity_id: "seat_pref_001",
      summary: "Actually window seats work better now.",
      observations: ["Actually window seats work better now."],
      status: "active",
      created_at: "2026-05-01T00:00:00.000Z",
    });
    expect(entities.seat_pref_001.supersedes_entity_id).toBeUndefined();
    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "travel",
        domainData: result.fullBlob.travel,
      }),
    );
  });

  it("applies delete_entity by removing the active entity from shareable domain data", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "storeDomainData").mockResolvedValue({
      success: true,
    });

    const result = await PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob({
      userId: "user-1",
      vaultKey: "vault-key-1",
      domain: "travel",
      baseFullBlob: {
        travel: {
          seat_preferences: {
            entities: {
              seat_pref_001: {
                entity_id: "seat_pref_001",
                kind: "preference",
                summary: "Prefers aisle seats.",
                observations: ["Prefers aisle seats."],
                status: "active",
              },
            },
          },
        },
      },
      domainData: {
        seat_preferences: {
          entities: {
            seat_pref_001: {
              entity_id: "seat_pref_001",
              status: "deleted",
            },
          },
        },
      },
      summary: {},
      mergeDecision: {
        merge_mode: "delete_entity",
        target_domain: "travel",
        target_entity_id: "seat_pref_001",
        target_entity_path: "seat_preferences.entities.seat_pref_001",
        match_confidence: 0.91,
        match_reason: "Deletes the active seat preference.",
      },
      vaultOwnerToken: "vault-owner-token",
    });

    expect(result.fullBlob.travel).toEqual({});
  });

  it("extends canonical entities without duplicating existing observations", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "storeDomainData").mockResolvedValue({
      success: true,
    });

    const result = await PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob({
      userId: "user-1",
      vaultKey: "vault-key-1",
      domain: "shopping",
      baseFullBlob: {
        shopping: {
          product_preferences: {
            entities: {
              brand_pref_001: {
                entity_id: "brand_pref_001",
                kind: "preference",
                summary: "Prefers Patagonia for outdoor jackets.",
                observations: ["Prefers Patagonia for outdoor jackets."],
                status: "active",
              },
            },
          },
        },
      },
      domainData: {
        product_preferences: {
          entities: {
            brand_pref_001: {
              entity_id: "brand_pref_001",
              kind: "preference",
              summary: "Still prefers Patagonia for outdoor jackets and trail gear.",
              observations: [
                "Prefers Patagonia for outdoor jackets.",
                "Still prefers Patagonia for outdoor jackets and trail gear.",
              ],
              status: "active",
            },
          },
        },
      },
      summary: {},
      mergeDecision: {
        merge_mode: "extend_entity",
        target_domain: "shopping",
        target_entity_id: "brand_pref_001",
        target_entity_path: "product_preferences.entities.brand_pref_001",
        match_confidence: 0.9,
        match_reason: "Extends the active shopping preference.",
      },
      vaultOwnerToken: "vault-owner-token",
    });

    const entity = (
      result.fullBlob.shopping as {
        product_preferences: { entities: Record<string, Record<string, unknown>> };
      }
    ).product_preferences.entities.brand_pref_001;
    expect(entity.observations).toEqual([
      "Prefers Patagonia for outdoor jackets.",
      "Still prefers Patagonia for outdoor jackets and trail gear.",
    ]);
    expect(entity.summary).toBe("Still prefers Patagonia for outdoor jackets and trail gear.");
  });

  it("keeps no_op previews from mutating canonical PKM data", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "storeDomainData").mockResolvedValue({
      success: true,
    });

    const existingFinancial = {
      goals: {
        entities: {
          goal_001: {
            entity_id: "goal_001",
            summary: "Pay off student loans in three years.",
            status: "active",
          },
        },
      },
    };

    const result = await PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob({
      userId: "user-1",
      vaultKey: "vault-key-1",
      domain: "financial",
      baseFullBlob: {
        financial: existingFinancial,
      },
      domainData: {
        goals: {
          entities: {
            noisy_task: {
              entity_id: "noisy_task",
              summary: "Remind me tomorrow.",
              status: "active",
            },
          },
        },
      },
      summary: {},
      mergeDecision: {
        merge_mode: "no_op",
        target_domain: "financial",
        target_entity_id: "",
        target_entity_path: "",
        match_confidence: 1,
        match_reason: "Not durable PKM data.",
      },
      vaultOwnerToken: "vault-owner-token",
    });

    expect(result.fullBlob.financial).toEqual(existingFinancial);
  });
});
