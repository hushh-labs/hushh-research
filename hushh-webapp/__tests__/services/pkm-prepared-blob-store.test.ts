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
});
