import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareDomainWriteContext: vi.fn(),
  getDomainStaleFirst: vi.fn(),
  getPlaidStatus: vi.fn(),
  secureRead: vi.fn(),
  secureWrite: vi.fn(),
  secureInvalidate: vi.fn(),
  saveMergedDomain: vi.fn(),
  onPlaidSourceProjected: vi.fn(),
  warmUnlock: vi.fn(),
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    prepareDomainWriteContext: mocks.prepareDomainWriteContext,
    getStaleFirst: mocks.getDomainStaleFirst,
  },
}));

vi.mock("@/lib/kai/brokerage/plaid-portfolio-service", () => ({
  PlaidPortfolioService: {
    getStatus: mocks.getPlaidStatus,
  },
}));

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: mocks.secureRead,
    write: mocks.secureWrite,
    invalidateResource: mocks.secureInvalidate,
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: mocks.saveMergedDomain,
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onPlaidSourceProjected: mocks.onPlaidSourceProjected,
  },
}));

vi.mock("@/lib/services/unlock-warm-orchestrator", () => ({
  UnlockWarmOrchestrator: {
    run: mocks.warmUnlock,
  },
}));

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

import { KaiFinancialResourceService } from "@/lib/kai/kai-financial-resource";
import { CacheService } from "@/lib/services/cache-service";

const emptyPlaidStatus = {
  configured: true,
  environment: "production",
  user_id: "user-1",
  source_preference: "statement",
  items: [],
  aggregate: {
    item_count: 0,
    account_count: 0,
    holdings_count: 0,
    institution_names: [],
    sync_status: "idle",
    portfolio_data: null,
  },
};

describe("KaiFinancialResourceService missing finance state", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
    vi.clearAllMocks();
    mocks.secureRead.mockResolvedValue(null);
    mocks.secureWrite.mockResolvedValue(undefined);
    mocks.getDomainStaleFirst.mockResolvedValue(null);
    mocks.getPlaidStatus.mockResolvedValue(emptyPlaidStatus);
  });

  afterEach(() => {
    CacheService.getInstance().clear();
  });

  it("treats import setup with no source as an empty state without probing PKM", async () => {
    mocks.prepareDomainWriteContext.mockRejectedValue(new Error("unexpected PKM fetch"));

    const resource = await KaiFinancialResourceService.refresh({
      userId: "user-1",
      vaultOwnerToken: "vault-owner-token",
      vaultKey: "vault-key",
      skipEmptyFinancialProbe: true,
    });

    expect(resource?.hasFinancialData).toBe(false);
    expect(resource?.financialDomain).toBeNull();
    expect(resource?.plaidStatus).toEqual(emptyPlaidStatus);
    expect(mocks.getPlaidStatus).toHaveBeenCalledTimes(1);
    expect(mocks.prepareDomainWriteContext).not.toHaveBeenCalled();
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("keeps non-setup PKM failures loud", async () => {
    mocks.prepareDomainWriteContext.mockRejectedValue(new Error("forbidden"));

    await expect(
      KaiFinancialResourceService.refresh({
        userId: "user-2",
        vaultOwnerToken: "vault-owner-token",
        vaultKey: "vault-key",
      })
    ).rejects.toThrow("forbidden");
  });
});
