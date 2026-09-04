import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  setActiveSource: vi.fn(),
  peekCachedFullBlob: vi.fn(),
  peekCachedEncryptedBlob: vi.fn(),
  loadDomainData: vi.fn(),
  storeMergedDomainWithPreparedBlob: vi.fn(),
  cacheSync: vi.fn(),
  warm: vi.fn(),
  trackGrowth: vi.fn(),
}));

vi.mock("@/lib/kai/brokerage/plaid-portfolio-service", () => ({
  PlaidPortfolioService: {
    getStatus: mocks.getStatus,
    setActiveSource: mocks.setActiveSource,
    refresh: vi.fn(),
    cancelRefreshRun: vi.fn(),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    peekCachedFullBlob: mocks.peekCachedFullBlob,
    peekCachedEncryptedBlob: mocks.peekCachedEncryptedBlob,
    loadDomainData: mocks.loadDomainData,
    storeMergedDomainWithPreparedBlob: mocks.storeMergedDomainWithPreparedBlob,
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onPlaidSourceProjected: mocks.cacheSync,
  },
}));

vi.mock("@/lib/services/unlock-warm-orchestrator", () => ({
  UnlockWarmOrchestrator: { run: mocks.warm },
}));

vi.mock("@/lib/observability/growth", () => ({
  trackGrowthFunnelStepCompleted: mocks.trackGrowth,
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    getState: () => ({ tasks: [] }),
    startTask: vi.fn(),
    updateTask: vi.fn(),
    cancelTask: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
  },
}));

import { usePortfolioSources } from "@/lib/kai/brokerage/use-portfolio-sources";

const statementPortfolio = {
  holdings: [
    {
      symbol: "STATEMENT",
      name: "Statement holding",
      quantity: 1,
      market_value: 100,
    },
  ],
};

const plaidPortfolio = {
  holdings: [
    {
      symbol: "PLAID",
      name: "Brokerage holding",
      quantity: 2,
      market_value: 200,
    },
  ],
};

function makeFinancial(snapshotCount = 1) {
  const snapshots = [
    {
      id: "statement-july",
      imported_at: "2026-07-17T00:00:00.000Z",
      canonical_v2: statementPortfolio,
    },
  ];
  if (snapshotCount > 1) {
    snapshots.push({
      id: "statement-june",
      imported_at: "2026-06-17T00:00:00.000Z",
      canonical_v2: statementPortfolio,
    });
  }
  return {
    portfolio: statementPortfolio,
    sources: {
      active_source: "statement",
      statement: {
        active_snapshot_id: "statement-july",
        snapshots,
      },
    },
  };
}

function makePlaidStatus() {
  return {
    configured: false,
    user_id: "reviewer-user",
    source_preference: "statement" as const,
    items: [{ item_id: "plaid-item" }],
    aggregate: {
      item_count: 1,
      account_count: 1,
      holdings_count: 1,
      institution_names: ["Demo Brokerage"],
      sync_status: "completed",
      last_synced_at: "2026-07-17T12:00:00.000Z",
      portfolio_data: plaidPortfolio,
    },
  };
}

async function renderReadyHook() {
  const hook = renderHook(() =>
    usePortfolioSources({
      userId: "reviewer-user",
      vaultOwnerToken: "vault-owner-token",
      vaultKey: "vault-key",
      initialStatementPortfolio: statementPortfolio,
    }),
  );

  await waitFor(() => {
    expect(hook.result.current.isLoading).toBe(false);
    expect(hook.result.current.availableSources).toEqual(["statement", "plaid"]);
  });
  return hook;
}

describe("usePortfolioSources source selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStatus.mockResolvedValue(makePlaidStatus());
    mocks.setActiveSource.mockResolvedValue({
      user_id: "reviewer-user",
      active_source: "plaid",
    });
    mocks.peekCachedFullBlob.mockImplementation(() => ({
      blob: { financial: makeFinancial() },
      dataVersion: 7,
    }));
    mocks.peekCachedEncryptedBlob.mockReturnValue({ dataVersion: 7 });
    mocks.loadDomainData.mockResolvedValue(makeFinancial());
    mocks.storeMergedDomainWithPreparedBlob.mockImplementation(
      async ({ domainData }: { domainData: Record<string, unknown> }) => ({
        success: true,
        fullBlob: { financial: domainData },
      }),
    );
    mocks.warm.mockResolvedValue(undefined);
  });

  it("keeps the confirmed source selected until both durable writes settle", async () => {
    let resolveBackendWrite: (() => void) | undefined;
    mocks.setActiveSource.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveBackendWrite = resolve;
        }),
    );
    const { result } = await renderReadyHook();

    let changePromise!: Promise<void>;
    act(() => {
      changePromise = result.current.changeActiveSource("plaid");
    });

    await waitFor(() => expect(result.current.isChangingSource).toBe(true));
    expect(result.current.activeSource).toBe("statement");

    await act(async () => {
      resolveBackendWrite?.();
      await changePromise;
    });

    expect(result.current.isChangingSource).toBe(false);
    expect(result.current.activeSource).toBe("plaid");
    expect(mocks.storeMergedDomainWithPreparedBlob).toHaveBeenCalledTimes(1);
  });

  it("retains the last confirmed source when the server preference write fails", async () => {
    mocks.setActiveSource.mockRejectedValueOnce(new Error("network unavailable"));
    const { result } = await renderReadyHook();

    await act(async () => {
      await expect(result.current.changeActiveSource("plaid")).rejects.toThrow(
        "network unavailable",
      );
    });

    expect(result.current.activeSource).toBe("statement");
    expect(result.current.isChangingSource).toBe(false);
    expect(mocks.storeMergedDomainWithPreparedBlob).not.toHaveBeenCalled();
  });

  it("compensates the server preference when the encrypted write is not accepted", async () => {
    mocks.storeMergedDomainWithPreparedBlob.mockResolvedValueOnce({
      success: false,
      conflict: true,
      fullBlob: { financial: makeFinancial() },
    });
    const { result } = await renderReadyHook();

    await act(async () => {
      await expect(result.current.changeActiveSource("plaid")).rejects.toThrow(
        "changed elsewhere",
      );
    });

    expect(result.current.activeSource).toBe("statement");
    expect(mocks.setActiveSource).toHaveBeenCalledTimes(2);
    expect(mocks.setActiveSource).toHaveBeenLastCalledWith({
      userId: "reviewer-user",
      activeSource: "statement",
      vaultOwnerToken: "vault-owner-token",
    });
  });

  it("rejects unavailable sources before issuing any durable write", async () => {
    mocks.getStatus.mockResolvedValueOnce({
      ...makePlaidStatus(),
      aggregate: {
        ...makePlaidStatus().aggregate,
        portfolio_data: null,
        holdings_count: 0,
      },
    });
    const hook = renderHook(() =>
      usePortfolioSources({
        userId: "reviewer-user",
        vaultOwnerToken: "vault-owner-token",
        vaultKey: "vault-key",
        initialStatementPortfolio: statementPortfolio,
      }),
    );

    await waitFor(() => {
      expect(hook.result.current.availableSources).toEqual(["statement"]);
    });

    await act(async () => {
      await expect(hook.result.current.changeActiveSource("plaid")).rejects.toThrow(
        "not ready yet",
      );
    });

    expect(mocks.setActiveSource).not.toHaveBeenCalled();
  });

  it("keeps saved-statement deletion available when the derived preference is unavailable", async () => {
    const financial = makeFinancial(2);
    mocks.peekCachedFullBlob.mockReturnValue({
      blob: { financial },
      dataVersion: 7,
    });
    mocks.loadDomainData.mockResolvedValue(financial);
    mocks.setActiveSource.mockRejectedValueOnce(new Error("service unavailable"));
    const { result } = await renderReadyHook();

    await act(async () => {
      await expect(
        result.current.deleteStatementSnapshot("statement-july"),
      ).resolves.toBeUndefined();
    });

    expect(mocks.storeMergedDomainWithPreparedBlob).toHaveBeenCalledTimes(1);
  });
});
