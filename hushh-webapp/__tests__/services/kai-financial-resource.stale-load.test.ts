import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareDomainWriteContext: vi.fn(),
  secureWrite: vi.fn(),
  secureInvalidate: vi.fn(),
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { prepareDomainWriteContext: mocks.prepareDomainWriteContext },
}));
vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: vi.fn(async () => null),
    write: mocks.secureWrite,
    invalidateResource: mocks.secureInvalidate,
  },
}));
vi.mock("@/lib/cache/request-audit-log", () => ({ logRequestAudit: vi.fn() }));

import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { KaiFinancialResourceService } from "@/lib/kai/kai-financial-resource";
import { CacheService } from "@/lib/services/cache-service";

const PARAMS = { userId: "owner", vaultOwnerToken: "vot", vaultKey: "vk" };
const BEFORE = { portfolio: { holdings: [{ symbol: "OLD", quantity: 1, market_value: 1 }] } };
const AFTER = { portfolio: { holdings: [{ symbol: "NEW", quantity: 1, market_value: 1 }] } };

function deferredRead() {
  let release!: (financial: Record<string, unknown>) => void;
  mocks.prepareDomainWriteContext.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = (financial) => resolve({ domainData: financial, baseFullBlob: {} });
      }),
  );
  return (financial: Record<string, unknown>) => release(financial);
}

describe("a Kai finance read that races a write", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
    vi.clearAllMocks();
  });

  it("does not cache a result read before a write that landed meanwhile", async () => {
    const release = deferredRead();
    const pending = KaiFinancialResourceService.refresh(PARAMS);

    // A write lands (CacheSyncService bumps the epoch synchronously).
    bumpPkmInvalidationEpoch("owner");
    release(BEFORE);
    const resource = await pending;

    expect(resource?.financialDomain).toEqual(BEFORE);
    expect(KaiFinancialResourceService.peek("owner")).toBeNull();
    expect(mocks.secureWrite).not.toHaveBeenCalled();
  });

  it("caches normally when nothing was written during the read", async () => {
    mocks.prepareDomainWriteContext.mockResolvedValueOnce({ domainData: AFTER, baseFullBlob: {} });
    await KaiFinancialResourceService.refresh(PARAMS);

    expect(KaiFinancialResourceService.peek("owner")?.data?.financialDomain).toEqual(AFTER);
    expect(mocks.secureWrite).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh read after an invalidation instead of joining the old one", async () => {
    const release = deferredRead();
    const stale = KaiFinancialResourceService.refresh(PARAMS);
    KaiFinancialResourceService.invalidate("owner");
    mocks.prepareDomainWriteContext.mockResolvedValueOnce({ domainData: AFTER, baseFullBlob: {} });

    const fresh = await KaiFinancialResourceService.refresh(PARAMS);
    release(BEFORE);
    await stale;

    expect(fresh?.financialDomain).toEqual(AFTER);
    expect(mocks.prepareDomainWriteContext).toHaveBeenCalledTimes(2);
    // The old read finished last, but the cache keeps the fresh result.
    expect(KaiFinancialResourceService.peek("owner")?.data?.financialDomain).toEqual(AFTER);
  });
});
