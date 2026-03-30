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
        summary: expect.objectContaining({
          domain_intent: "food",
          item_count: 1,
        }),
      })
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
});
