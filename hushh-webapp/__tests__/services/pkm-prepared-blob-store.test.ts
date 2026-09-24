import { beforeEach, describe, expect, it, vi } from "vitest";

const encryptDataMock = vi.fn();
const transport = vi.hoisted(() => ({ native: false, nativeStore: vi.fn() }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => transport.native,
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("@/lib/capacitor", () => ({
  HushhPersonalKnowledgeModel: { storeDomainData: transport.nativeStore },
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
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

describe("PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    transport.native = false;
    transport.nativeStore.mockReset();
    encryptDataMock.mockResolvedValue({
      ciphertext: "ciphertext-1",
      iv: "iv-1",
      tag: "tag-1",
    });
  });

  it.each(["prepared", "merged"] as const)("retains reviewed semantic metadata in the %s writer", async (writer) => {
    const previous = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional", domainData: { role: "synthetic", sibling: "retained" },
    }).manifest;
    previous.paths.find(path => path.json_path === "sibling")!.consent_label = "Reviewed sibling";
    const reviewed = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional", domainData: { role: "updated" },
    }).manifest;
    reviewed.paths[0]!.consent_label = "Reviewed role";
    reviewed.paths[0]!.sensitivity_label = "confidential";
    // The older merged entrypoint accepts an optional complete manifest rather
    // than a partial reviewed preview. Without one, retain previous metadata.
    previous.paths.find(path => path.json_path === "role")!.consent_label = "Reviewed role";
    previous.paths.find(path => path.json_path === "role")!.sensitivity_label = "restricted";
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(previous);
    const store = vi.spyOn(PersonalKnowledgeModelService, "storeDomainData").mockResolvedValue({ success: true });
    const save = writer === "prepared"
      ? PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob.bind(PersonalKnowledgeModelService)
      : PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob.bind(PersonalKnowledgeModelService);
    await save({
      userId: "synthetic-owner", vaultKey: "synthetic-key", domain: "professional",
      baseFullBlob: { professional: { role: "old", sibling: "retained" } },
      domainData: { role: "updated", sibling: "retained" }, summary: {},
      mergeDecision: { merge_mode: "replace_domain", target_domain: "professional" },
      manifest: writer === "prepared" ? reviewed : undefined,
      structureDecision: { target_domain: "professional", sensitivity_labels: { role: "restricted", removed: "restricted" } },
      cacheFullBlob: false,
    });
    const saved = store.mock.calls[0]![0];
    expect(saved.manifest?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ json_path: "role", consent_label: "Reviewed role", sensitivity_label: "restricted" }),
      expect.objectContaining({ json_path: "sibling", consent_label: "Reviewed sibling" }),
    ]));
    expect(saved.manifest?.paths.some(path => path.json_path === "removed")).toBe(false);
    expect(saved.structureDecision?.sensitivity_labels).toMatchObject({ role: "restricted" });
    expect(saved.domainData).toEqual({ role: "updated", sibling: "retained" });
  });

  it.each(["prepared", "merged"] as const)("does not build an unused conflicting fallback in the %s writer", async (writer) => {
    const domainData = { preferences: { entities: { synthetic: { summary: "synthetic" } } } };
    const supplied = buildPersonalKnowledgeModelStructureArtifacts({ domain: "professional", domainData });
    const previous = { ...supplied.manifest, paths: [{
      json_path: "preferences.entities.synthetic.summary", path_type: "leaf" as const,
      exposure_eligibility: false, consent_label: "Old custom concrete label",
    }] };
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(previous);
    const store = vi.spyOn(PersonalKnowledgeModelService, "storeDomainData").mockResolvedValue({ success: true });
    const save = writer === "prepared"
      ? PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob.bind(PersonalKnowledgeModelService)
      : PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob.bind(PersonalKnowledgeModelService);
    await save({
      userId: "synthetic-owner", vaultKey: "synthetic-key", domain: "professional",
      domainData, baseFullBlob: {}, summary: {}, manifest: supplied.manifest,
      structureDecision: supplied.structureDecision, cacheFullBlob: false,
    });
    expect(store.mock.calls[0]![0].manifest).toBe(supplied.manifest);
  });

  it.each([false, true])("blocks final dispatch if the session changes during encryption (native=%s)", async (native) => {
    transport.native = native;
    let canceled = false;
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    const api = vi.spyOn(ApiService, "apiFetch");
    encryptDataMock.mockImplementation(async () => {
      canceled = true;
      return { ciphertext: "ciphertext", iv: "iv", tag: "tag", algorithm: "aes-256-gcm" };
    });
    await expect(PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob({
      userId: "owner-fixture", vaultKey: "vault-key-fixture", vaultOwnerToken: "owner-token-fixture",
      domain: "food", domainData: { preference: "tea" }, baseFullBlob: {}, summary: {},
      beforeEffect: async () => { if (canceled) throw new DOMException("Canceled", "AbortError"); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(api).not.toHaveBeenCalled();
    expect(transport.nativeStore).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves a confirmed receipt without republishing after session change (native=%s)", async (native) => {
    transport.native = native;
    let current = true;
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    const cache = vi.spyOn(CacheSyncService, "onPkmDomainStored").mockImplementation(() => {});
    const fullBlobCache = vi.spyOn(PersonalKnowledgeModelService, "cacheDecryptedBlob").mockImplementation(() => {});
    if (native) transport.nativeStore.mockImplementation(async () => {
      current = false;
      return { success: true, dataVersion: 2 };
    });
    else vi.spyOn(ApiService, "apiFetch").mockImplementation(async (_path, options) => {
      await options?.beforeDispatch?.();
      current = false;
      return new Response(JSON.stringify({ success: true, data_version: 2 }));
    });
    const result = await PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob({
      userId: "owner-fixture", vaultKey: "vault-key-fixture", vaultOwnerToken: "owner-token-fixture",
      domain: "food", domainData: { preference: "tea" }, baseFullBlob: {}, summary: {},
      beforeEffect: async () => { if (!current) throw new DOMException("Canceled", "AbortError"); },
      mayPublish: () => current,
    });
    expect(result.success).toBe(true);
    expect(result.dataVersion).toBe(2);
    expect(cache).not.toHaveBeenCalled();
    expect(fullBlobCache).not.toHaveBeenCalled();
  });

  it("checks native effect authority synchronously after an async guard yields", async () => {
    transport.native = true;
    let current = true;
    await expect(PersonalKnowledgeModelService.storeDomainData({
      userId: "owner-fixture", domain: "food", summary: {},
      encryptedBlob: { ciphertext: "ciphertext", iv: "iv", tag: "tag", algorithm: "aes-256-gcm" },
      vaultOwnerToken: "owner-token-fixture",
      beforeEffect: async () => { queueMicrotask(() => { current = false; }); },
      mayPublish: () => current,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.nativeStore).not.toHaveBeenCalled();
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
        schemaVersion: "pkm_upgrade_claim.v1",
        claimId: "00000000-0000-4000-8000-000000000001",
        commitId: "00000000-0000-4000-8000-000000000002",
        ownerUserId: "user-1",
        runId: "rehearsal_user-1",
        domain: "financial",
        sourceContentRevision: 4,
        sourceManifestRevision: 2,
        targetDomainContractVersion: 3,
        targetReadableSummaryVersion: 1,
        targetPkmContractVersion: "6.0.0",
        targetReadableProjectionVersion: "6.0.0",
        expiresAt: "2026-07-15T12:05:00Z",
        mode: "real",
      },
      preservationReceipt: {
        schemaVersion: "pkm_preservation_receipt.v1",
        totalSourceOccurrences: 1,
        preserved: 1,
        moved: 0,
        equalValueDeduplicated: 0,
        quarantined: 0,
        rejected: 0,
        complete: true,
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
      upgrade_claim: {
        schema_version: "pkm_upgrade_claim.v1",
        claim_id: "00000000-0000-4000-8000-000000000001",
        commit_id: "00000000-0000-4000-8000-000000000002",
        owner_user_id: "user-1",
        run_id: "rehearsal_user-1",
        domain: "financial",
        source_content_revision: 4,
        source_manifest_revision: 2,
        target_domain_contract_version: 3,
        target_readable_summary_version: 1,
        target_pkm_contract_version: "6.0.0",
        target_readable_projection_version: "6.0.0",
        expires_at: "2026-07-15T12:05:00Z",
        mode: "real",
      },
      preservation_receipt: {
        total_source_occurrences: 1,
        preserved: 1,
        rejected: 0,
        complete: true,
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

describe("PersonalKnowledgeModelService runtime secrets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    encryptDataMock.mockResolvedValue({
      ciphertext: "ciphertext-1",
      iv: "iv-1",
      tag: "tag-1",
    });
  });

  it.each([
    ["store", "loadDomainData"], ["remove", "loadDomainData"],
    ["store", "getDomainManifest"], ["remove", "getDomainManifest"],
  ] as const)("does not %s settings after failed %s", async (operation, failedRead) => {
    vi.spyOn(PersonalKnowledgeModelService, "loadDomainData").mockResolvedValue({
      llm: { other_provider_key: "synthetic-preserved-sibling" },
    });
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    const failure = new Error("Synthetic read unavailable");
    vi.spyOn(PersonalKnowledgeModelService, failedRead).mockRejectedValue(failure);
    const store = vi.spyOn(PersonalKnowledgeModelService, "storeDomainData")
      .mockResolvedValue({ success: true });
    const params = {
      userId: "user-1", vaultKey: "vault-key-1", vaultOwnerToken: "vault-owner-token",
      credentialRef: "pkm:runtime_secrets.llm.gemini_api_key",
      secret: "synthetic-new-value",
      confirmation: { confirmedByUser: true as const, surface: "web" as const, source: "runtime_secret_test" },
    };
    await expect(operation === "store"
      ? PersonalKnowledgeModelService.storeRuntimeSecret(params)
      : PersonalKnowledgeModelService.removeRuntimeSecret(params)).rejects.toBe(failure);
    expect(store).not.toHaveBeenCalled();
  });

  it.each(["loadDomainData", "getDomainManifest"] as const)(
    "stops conflict recovery when %s fails without a replacement write",
    async (failedRead) => {
      const failure = new TypeError("Failed to fetch");
      const load = vi.spyOn(PersonalKnowledgeModelService, "loadDomainData")
        .mockResolvedValue({ llm: { other_provider_key: "synthetic-preserved-sibling" } });
      const manifest = vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest")
        .mockResolvedValue(null);
      if (failedRead === "loadDomainData") {
        load.mockResolvedValueOnce({ llm: { other_provider_key: "synthetic-preserved-sibling" } })
          .mockRejectedValueOnce(failure);
      } else {
        manifest.mockResolvedValueOnce(null).mockRejectedValueOnce(failure);
      }
      const store = vi.spyOn(PersonalKnowledgeModelService, "storeDomainData")
        .mockResolvedValueOnce({ success: false, conflict: true })
        .mockResolvedValue({ success: true });
      await expect(PersonalKnowledgeModelService.storeRuntimeSecret({
        userId: "user-1", vaultKey: "vault-key-1", vaultOwnerToken: "vault-owner-token",
        credentialRef: "pkm:runtime_secrets.llm.gemini_api_key", secret: "synthetic-value",
        confirmation: { confirmedByUser: true, surface: "web", source: "runtime_secret_test" },
      })).rejects.toBe(failure);
      expect(store).toHaveBeenCalledTimes(1);
    },
  );

  it("allows a first settings write after authoritative absence", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadDomainData").mockResolvedValue(null);
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    const store = vi.spyOn(PersonalKnowledgeModelService, "storeDomainData")
      .mockResolvedValue({ success: true });
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      userId: "user-1", vaultKey: "vault-key-1", vaultOwnerToken: "vault-owner-token",
      credentialRef: "pkm:runtime_secrets.llm.gemini_api_key", secret: "synthetic-value",
      confirmation: { confirmedByUser: true, surface: "web", source: "runtime_secret_test" },
    });
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("stores a Gemini runtime key in the encrypted runtime_secrets domain without metadata leakage", async () => {
    const rawKey = "gemini-user-key-123";
    vi.spyOn(PersonalKnowledgeModelService, "loadDomainData").mockResolvedValue({
      llm: { other_provider_key: "keep-me", credential_mode: "hushh_managed_vertex" },
    });
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    const storeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "storeDomainData")
      .mockResolvedValue({ success: true });

    await PersonalKnowledgeModelService.storeRuntimeSecret({
      userId: "user-1",
      vaultKey: "vault-key-1",
      vaultOwnerToken: "vault-owner-token",
      confirmation: { confirmedByUser: true, surface: "web", source: "runtime_secret_test" },
      credentialRef: "pkm:runtime_secrets.llm.gemini_api_key",
      secret: ` ${rawKey} `,
    });

    expect(encryptDataMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plaintext: JSON.stringify({
          llm: {
            other_provider_key: "keep-me",
            credential_mode: "hushh_managed_vertex",
            gemini_api_key: rawKey,
          },
        }),
      }),
    );
    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        domain: "runtime_secrets",
        domainData: {
          llm: {
            other_provider_key: "keep-me",
            credential_mode: "hushh_managed_vertex",
            gemini_api_key: rawKey,
          },
        },
        summary: expect.objectContaining({
          consumer_visible: false,
          internal_only: true,
          configured_runtime_providers: ["gemini"],
          has_gemini_api_key: true,
          credential_mode: "hushh_managed_vertex",
        }),
      }),
    );

    const storedPayload = storeSpy.mock.calls[0]?.[0];
    expect(stringify(storedPayload?.summary)).not.toContain(rawKey);
    expect(stringify(storedPayload?.manifest)).not.toContain(rawKey);
    expect(stringify(storedPayload?.structureDecision)).not.toContain(rawKey);
    expect(storedPayload?.manifest?.externalizable_paths).toEqual([]);
    expect(storedPayload?.manifest?.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json_path: "llm.gemini_api_key",
          exposure_eligibility: false,
          sensitivity_label: "restricted",
        }),
        expect.objectContaining({
          json_path: "llm.credential_mode",
          exposure_eligibility: false,
          sensitivity_label: "restricted",
        }),
      ]),
    );
  });

  it("removes the Gemini runtime key while preserving sibling runtime secrets", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadDomainData").mockResolvedValue({
      llm: {
        gemini_api_key: "remove-me",
        other_provider_key: "keep-me",
      },
    });
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    const storeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "storeDomainData")
      .mockResolvedValue({ success: true });

    await PersonalKnowledgeModelService.removeRuntimeSecret({
      userId: "user-1",
      vaultKey: "vault-key-1",
      vaultOwnerToken: "vault-owner-token",
      confirmation: { confirmedByUser: true, surface: "web", source: "runtime_secret_test" },
      credentialRef: "pkm:runtime_secrets.llm.gemini_api_key",
    });

    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "runtime_secrets",
        domainData: {
          llm: {
            other_provider_key: "keep-me",
          },
        },
        summary: expect.objectContaining({
          has_gemini_api_key: false,
          configured_runtime_providers: [],
          credential_mode: "byok",
        }),
      }),
    );
  });

  it("returns null when a runtime secret path is missing", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "loadDomainData").mockResolvedValue({
      llm: {},
    });

    await expect(
      PersonalKnowledgeModelService.loadRuntimeSecret({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: "pkm:runtime_secrets.llm.gemini_api_key",
      }),
    ).resolves.toBeNull();
  });

  it("rejects invalid runtime credential refs before storage", async () => {
    const storeSpy = vi.spyOn(PersonalKnowledgeModelService, "storeDomainData");

    await expect(
      PersonalKnowledgeModelService.storeRuntimeSecret({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: "pkm:runtime_secrets",
        secret: "gemini-user-key-123",
      }),
    ).rejects.toThrow("Invalid PKM credential reference.");
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("rejects empty runtime secrets before encryption", async () => {
    const storeSpy = vi.spyOn(PersonalKnowledgeModelService, "storeDomainData");

    await expect(
      PersonalKnowledgeModelService.storeRuntimeSecret({
        userId: "user-1",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "vault-owner-token",
        credentialRef: "pkm:runtime_secrets.llm.gemini_api_key",
        secret: "   ",
      }),
    ).rejects.toThrow("Runtime secret is required.");
    expect(encryptDataMock).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("stores non-Gemini runtime keys without exposing raw key material in metadata", async () => {
    const rawKey = "openai-user-key-123";
    vi.spyOn(PersonalKnowledgeModelService, "loadDomainData").mockResolvedValue({
      llm: { gemini_api_key: "keep-gemini" },
    });
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    const storeSpy = vi
      .spyOn(PersonalKnowledgeModelService, "storeDomainData")
      .mockResolvedValue({ success: true });

    await PersonalKnowledgeModelService.storeRuntimeSecret({
      userId: "user-1",
      vaultKey: "vault-key-1",
      vaultOwnerToken: "vault-owner-token",
      confirmation: { confirmedByUser: true, surface: "web", source: "runtime_secret_test" },
      credentialRef: "pkm:runtime_secrets.llm.openai_api_key",
      secret: rawKey,
    });

    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "runtime_secrets",
        domainData: {
          llm: {
            gemini_api_key: "keep-gemini",
            openai_api_key: rawKey,
          },
        },
        summary: expect.objectContaining({
          configured_runtime_providers: ["gemini", "openai"],
          configured_provider_count: 2,
          has_gemini_api_key: true,
          has_openai_api_key: true,
          has_claude_api_key: false,
          has_grok_api_key: false,
        }),
      }),
    );

    const storedPayload = storeSpy.mock.calls[0]?.[0];
    expect(stringify(storedPayload?.summary)).not.toContain(rawKey);
    expect(stringify(storedPayload?.manifest)).not.toContain(rawKey);
    expect(stringify(storedPayload?.structureDecision)).not.toContain(rawKey);
    expect(storedPayload?.manifest?.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json_path: "llm.claude_api_key",
          exposure_eligibility: false,
          sensitivity_label: "restricted",
        }),
        expect.objectContaining({
          json_path: "llm.grok_api_key",
          exposure_eligibility: false,
          sensitivity_label: "restricted",
        }),
        expect.objectContaining({
          json_path: "llm.openai_api_key",
          exposure_eligibility: false,
          sensitivity_label: "restricted",
        }),
      ]),
    );
  });
});
