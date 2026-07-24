import { beforeEach, describe, expect, it, vi } from "vitest";

const secureReadMock = vi.fn();
const secureWriteMock = vi.fn();
const loadDomainDataWithBlobMock = vi.fn();
const peekCachedDomainBlobMock = vi.fn();

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: (...args: unknown[]) => secureReadMock(...args),
    write: (...args: unknown[]) => secureWriteMock(...args),
    invalidateResourcePrefix: vi.fn(),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadDomainDataWithBlob: (...args: unknown[]) => loadDomainDataWithBlobMock(...args),
    peekCachedDomainBlob: (...args: unknown[]) => peekCachedDomainBlobMock(...args),
  },
}));

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { CacheService } from "@/lib/services/cache-service";

describe("PkmDomainResourceService consent-gated cache hydration", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
    vi.clearAllMocks();
    peekCachedDomainBlobMock.mockReturnValue(null);
  });

  it("does not hydrate secure PKM cache without a vault owner scope token", async () => {
    const result = await PkmDomainResourceService.hydrateFromSecureCache({
      userId: "user-1",
      domain: "financial",
      vaultKey: "vault-key",
    });

    expect(result).toBeNull();
    expect(secureReadMock).not.toHaveBeenCalled();
  });

  it("does not refresh and hydrate PKM cache without a vault owner scope token", async () => {
    const result = await PkmDomainResourceService.getStaleFirst({
      userId: "user-1",
      domain: "financial",
      vaultKey: "vault-key",
      backgroundRefresh: false,
    });

    expect(result).toBeNull();
    expect(secureReadMock).not.toHaveBeenCalled();
    expect(loadDomainDataWithBlobMock).not.toHaveBeenCalled();
    expect(secureWriteMock).not.toHaveBeenCalled();
  });
});
