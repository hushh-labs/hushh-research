// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  domainData: {} as Record<string, unknown>,
  revision: 0,
  updatedAt: "2026-07-30T00:00:00.000Z",
  loadDomainDataWithBlob: vi.fn(),
  loadDomainSnapshot: vi.fn(),
  storeMergedDomainWithPreparedBlob: vi.fn(),
}));

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    invalidateResourcePrefix: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-upgrade-orchestrator", () => ({
  PkmUpgradeOrchestrator: {
    ensureRunning: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-upgrade-service", () => ({
  PkmUpgradeService: {
    getStatus: vi.fn(),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: vi.fn().mockResolvedValue({
      upgradableDomains: [],
    }),
    getDomainManifest: vi.fn().mockResolvedValue(null),
    peekCachedDomainBlob: vi.fn(() =>
      persistence.revision > 0
        ? {
            dataVersion: persistence.revision,
            updatedAt: persistence.updatedAt,
          }
        : null,
    ),
    loadDomainSnapshot: (...args: unknown[]) =>
      persistence.loadDomainSnapshot(...args),
    loadDomainDataWithBlob: (...args: unknown[]) =>
      persistence.loadDomainDataWithBlob(...args),
    storeMergedDomainWithPreparedBlob: (...args: unknown[]) =>
      persistence.storeMergedDomainWithPreparedBlob(...args),
  },
}));

import {
  addSavedLocation,
  loadSavedLocations,
  saveRequestedLocationWorkflowPlace,
} from "@/lib/one-location/saved-locations";
import { CacheService } from "@/lib/services/cache-service";

const CONTEXT = {
  userId: "settings-owner",
  vaultKey: "vault-key",
  vaultOwnerToken: "vault-owner-token",
};

describe("saved-place onboarding to Settings persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
    persistence.domainData = {};
    persistence.revision = 0;
    persistence.updatedAt = "2026-07-30T00:00:00.000Z";

    persistence.loadDomainSnapshot.mockImplementation(async () => ({
      data: persistence.domainData,
      snapshot:
        persistence.revision > 0
          ? {
              contentRevision: persistence.revision,
              manifestRevision: null,
              manifest: null,
              etag: `location-${persistence.revision}`,
              encryptedBlob: {
                dataVersion: persistence.revision,
                updatedAt: persistence.updatedAt,
              },
            }
          : null,
    }));
    persistence.loadDomainDataWithBlob.mockImplementation(async () => ({
      data: persistence.domainData,
      blob:
        persistence.revision > 0
          ? {
              dataVersion: persistence.revision,
              updatedAt: persistence.updatedAt,
            }
          : null,
    }));
    persistence.storeMergedDomainWithPreparedBlob.mockImplementation(
      async (params: {
        domain: string;
        domainData: Record<string, unknown>;
      }) => {
        persistence.revision += 1;
        persistence.domainData = params.domainData;
        return {
          success: true,
          conflict: false,
          message: "Stored",
          dataVersion: persistence.revision,
          updatedAt: persistence.updatedAt,
          fullBlob: {
            [params.domain]: persistence.domainData,
          },
        };
      },
    );
  });

  it("carries the requested workflow through the real coordinator without replacing Home, Work or unrelated records",async()=>{
    const original = {saved_places:{schema_version:2,locations:[
      {id:"home",category:"home",label:"Home",latitude:0,longitude:0,savedAt:"2026-09-01T00:00:00Z"},
      {id:"work",category:"work",label:"Work",latitude:1,longitude:1,savedAt:"2026-09-01T00:00:00Z"},
    ]},unrelated:{fixture:["keep",{nested:true}]}};
    persistence.domainData=structuredClone(original);
    persistence.revision=1;
    const authority={authorizationMode:"owner_requested_workflow" as const,surface:"voice" as const,source:"location_onboarding_command" as const,
      workflowAuthority:{command_id:"command",command_step:0,operation_id:"a".repeat(64),workflow_id:"workflow.setup.location" as const,run_id:"run_fixture"}};
    const finalize={schemaVersion:"one.location_pkm_finalize_authorization.v1" as const,authorizationId:"auth_fixture",token:"fixture-token",runId:"run_fixture",runRevision:1,
      leaseId:"lease_fixture",directiveId:"directive_fixture",draftRef:"draft_fixture",draftDigest:"b".repeat(64),expectedCommitId:"00000000-0000-5000-8000-000000000001",expiresAt:"2026-09-13T12:00:00Z"};
    const beforeEffect=vi.fn(async()=>{});
    const params={context:CONTEXT,authorization:authority,finalize,beforeEffect,
      draft:{category:"other" as const,label:"Current location",latitude:2,longitude:2,address:null,accuracyM:5,capturedAt:"2026-09-13T00:00:00Z",sourcePlatform:"web" as const}};
    const result=await saveRequestedLocationWorkflowPlace(params);
    expect(result.success).toBe(true);
    const call=persistence.storeMergedDomainWithPreparedBlob.mock.calls.at(-1)![0];
    expect(call.locationFinalizeAuthorization).toEqual(finalize);
    expect(call.beforeEffect).toBe(beforeEffect);
    expect(call.mutationPlan.confirmation_receipt).toMatchObject({authorization_mode:"owner_requested_workflow",workflow_authority:authority.workflowAuthority});
    expect(call.mutationPlan.confirmation_receipt.confirmed_by_user).not.toBe(true);
    expect(persistence.domainData.unrelated).toEqual(original.unrelated);
    const saved=(persistence.domainData.saved_places as any).locations;
    expect(saved.slice(0,2)).toEqual(original.saved_places.locations);
    expect(saved[2]).toMatchObject({id:"location_setup_run_fixture",category:"other",label:"Current location",address:null});
    const firstPlan=call.mutationPlan.plan_id;
    await saveRequestedLocationWorkflowPlace(params);
    expect((persistence.domainData.saved_places as any).locations).toHaveLength(3);
    expect(persistence.storeMergedDomainWithPreparedBlob.mock.calls.at(-1)![0].mutationPlan.plan_id).toBe(firstPlan);
    const invalid = {id:"unknown",future_version:99};
    (persistence.domainData.saved_places as any).locations.push(invalid);
    const calls=persistence.storeMergedDomainWithPreparedBlob.mock.calls.length;
    const refused=await saveRequestedLocationWorkflowPlace(params);
    expect(refused.success).toBe(false);
    expect(persistence.storeMergedDomainWithPreparedBlob).toHaveBeenCalledTimes(calls);
    expect((persistence.domainData.saved_places as any).locations.at(-1)).toEqual(invalid);
  });

  it("round-trips an edited onboarding place through the real PKM coordinator and Settings reader", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "work",
        label: "",
        latitude: 12.9716,
        longitude: 77.5946,
        address: "Hushh Office, Bengaluru, Karnataka, India",
      },
    });

    CacheService.getInstance().clear();
    const settingsLocations = await loadSavedLocations(CONTEXT);

    expect(settingsLocations).toEqual([
      expect.objectContaining({
        id: "work",
        category: "work",
        label: "Work",
        latitude: 12.9716,
        longitude: 77.5946,
        address: "Hushh Office, Bengaluru, Karnataka, India",
      }),
    ]);
    expect(
      persistence.storeMergedDomainWithPreparedBlob,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "location",
        domainData: expect.objectContaining({
          // v2 adds addressBase + addressDetails so an edit rebuilds the
          // composed line from its parts. v1 entries stay readable.
          saved_places: expect.objectContaining({
            schema_version: 2,
          }),
        }),
      }),
    );
    expect(persistence.loadDomainDataWithBlob).toHaveBeenCalledWith({
      userId: CONTEXT.userId,
      domain: "location",
      vaultKey: CONTEXT.vaultKey,
      vaultOwnerToken: CONTEXT.vaultOwnerToken,
      segmentIds: undefined,
    });
  });

  it("keeps one encrypted record when another category targets the same place", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "home",
        latitude: 12.9763,
        longitude: 77.5929,
        address: "Kasturba Road, Bengaluru",
      },
    });

    await expect(
      addSavedLocation({
        context: CONTEXT,
        input: {
          category: "work",
          latitude: 12.9764,
          longitude: 77.593,
          address: "Kasturba Road, Bengaluru",
        },
      }),
    ).rejects.toMatchObject({
      code: "duplicate_saved_location",
      existingCategory: "home",
    });

    CacheService.getInstance().clear();
    expect(await loadSavedLocations(CONTEXT)).toEqual([
      expect.objectContaining({ category: "home" }),
    ]);
  });
});
