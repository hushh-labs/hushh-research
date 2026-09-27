import { beforeEach, describe, expect, it, vi } from "vitest";

const { memory, mocks } = vi.hoisted(() => ({
  memory: new Map<string, unknown>(),
  mocks: {
  saveMergedDomain: vi.fn(),
  cachePortfolio: vi.fn(),
  },
}));

vi.mock("@/lib/services/device-resource-cache-service", () => ({
  DeviceResourceCacheService: {
    write: async ({ userId, resourceKey, value }: Record<string, unknown>) => {
      memory.set(`${userId}:${resourceKey}`, value);
    },
    read: async ({ userId, resourceKey }: Record<string, unknown>) =>
      memory.get(`${userId}:${resourceKey}`) ?? null,
    invalidateResource: async (userId: string, resourceKey: string) => {
      memory.delete(`${userId}:${resourceKey}`);
    },
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: (...args: unknown[]) => mocks.saveMergedDomain(...args),
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onPortfolioUpserted: (...args: unknown[]) => mocks.cachePortfolio(...args),
  },
}));

vi.mock("@/lib/kai/brokerage/financial-sources", () => ({
  buildStatementSource: (
    _current: Record<string, unknown>,
    snapshots: unknown[],
    activeSnapshotId: string,
  ) => ({ active_snapshot_id: activeSnapshotId, snapshots }),
  buildFinancialDomainSummary: () => ({ holdings_count: 1 }),
}));

import { FinanceSetupDraftService } from "@/lib/services/finance-setup-draft-service";

describe("FinanceSetupDraftService", () => {
  beforeEach(() => {
    memory.clear();
    vi.clearAllMocks();
    mocks.saveMergedDomain.mockResolvedValue({ success: true });
  });

  it("stages reviewed portfolio information until the master vault action", async () => {
    await FinanceSetupDraftService.stage({
      userId: "user-1",
      portfolio: {
        account_info: { brokerage: "Sample Brokerage" },
        holdings: [{ symbol: "HUSHH", quantity: 1, price: 10, market_value: 10 }],
      },
    });

    await expect(FinanceSetupDraftService.load("user-1")).resolves.toMatchObject({
      version: 1,
      portfolio: {
        account_info: { brokerage: "Sample Brokerage" },
      },
    });
    expect(mocks.cachePortfolio).not.toHaveBeenCalled();
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("writes the staged review once vault authority exists, then erases the origin", async () => {
    await FinanceSetupDraftService.stage({
      userId: "user-1",
      portfolio: {
        account_info: { brokerage: "Sample Brokerage" },
        holdings: [{ symbol: "HUSHH", quantity: 1, price: 10, market_value: 10 }],
      },
    });

    await expect(
      FinanceSetupDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toBe(true);

    expect(mocks.saveMergedDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        domain: "financial",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    );
    await expect(FinanceSetupDraftService.load("user-1")).resolves.toBeNull();
    expect(mocks.cachePortfolio).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ holdings: expect.any(Array) }),
    );
  });

  it("retains the staged review when encrypted persistence fails", async () => {
    await FinanceSetupDraftService.stage({
      userId: "user-1",
      portfolio: { holdings: [{ symbol: "HUSHH", market_value: 10 }] },
    });
    mocks.saveMergedDomain.mockResolvedValue({ success: false, message: "write failed" });

    await expect(
      FinanceSetupDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).rejects.toThrow("write failed");

    await expect(FinanceSetupDraftService.hasPending("user-1")).resolves.toBe(true);
  });

  // A brokerage statement committed twice (a retried Finish, or the setup draft
  // and the review both saving it) was stored as two snapshots, because each
  // commit prepended a fresh timestamp id.
  it("keeps one snapshot when the same statement is committed twice", async () => {
    const schwab = {
      account_info: {
        brokerage: "Charles Schwab",
        account_number: "XXXX-1234",
        statement_period_start: "2026-08-01",
        statement_period_end: "2026-08-31",
      },
      holdings: [{ symbol: "AAPL", quantity: 10, price: 200, market_value: 2000 }],
    };
    const commit = async (
      portfolio: Record<string, unknown>,
      current: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      await FinanceSetupDraftService.stage({ userId: "user-1", portfolio });
      await FinanceSetupDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      });
      const { build } = mocks.saveMergedDomain.mock.calls.at(-1)![0] as {
        build: (context: { currentDomainData: Record<string, unknown> }) => {
          domainData: Record<string, unknown>;
        };
      };
      return build({ currentDomainData: current }).domainData;
    };
    const statementIds = (domain: Record<string, unknown>) =>
      ((domain.documents as { statements: Array<{ id: string }> }).statements).map(
        (statement) => statement.id,
      );

    const first = await commit(schwab, {});
    const second = await commit(schwab, first);
    expect(statementIds(second)).toHaveLength(1);
    expect(statementIds(second)).toEqual(statementIds(first));

    // Negative control: the next month's statement is a new snapshot.
    const september = await commit(
      {
        ...schwab,
        account_info: {
          ...schwab.account_info,
          statement_period_start: "2026-09-01",
          statement_period_end: "2026-09-30",
        },
      },
      second,
    );
    expect(statementIds(september)).toHaveLength(2);
  });
});
