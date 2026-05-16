import { beforeEach, describe, expect, it, vi } from "vitest";

const loadDomainDataWithBlobMock = vi.fn();

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadDomainDataWithBlob: (...args: unknown[]) => loadDomainDataWithBlobMock(...args),
    peekCachedDomainBlob: vi.fn(() => null),
  },
}));

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    invalidateResourcePrefix: vi.fn(async () => undefined),
  },
}));

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";

describe("PkmDomainResourceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
  });

  it("does not hydrate a PKM read when the vault identity changes mid-request", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;

    loadDomainDataWithBlobMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    const first = PkmDomainResourceService.refresh({
      userId: "user-1",
      domain: "financial",
      vaultKey: "vault-key-a",
      vaultOwnerToken: "vault-token-a",
    });
    const second = PkmDomainResourceService.refresh({
      userId: "user-1",
      domain: "financial",
      vaultKey: "vault-key-b",
      vaultOwnerToken: "vault-token-b",
    });

    resolveSecond({
      data: { source: "second" },
      blob: { ciphertext: "c2", iv: "i2", tag: "t2", dataVersion: 2 },
    });
    await expect(second).resolves.toMatchObject({
      data: { source: "second" },
      key: { contentRevision: 2 },
    });

    resolveFirst({
      data: { source: "first" },
      blob: { ciphertext: "c1", iv: "i1", tag: "t1", dataVersion: 1 },
    });
    await expect(first).resolves.toBeNull();

    expect(loadDomainDataWithBlobMock).toHaveBeenCalledTimes(2);
    expect(
      CacheService.getInstance().peek(
        CACHE_KEYS.PKM_DOMAIN_RESOURCE("user-1", "financial", "all")
      )?.data
    ).toMatchObject({
      data: { source: "second" },
      key: { contentRevision: 2 },
    });
  });
});
