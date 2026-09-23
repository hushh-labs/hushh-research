import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyConnectionLink, applySnapshot } from "@/lib/kai/plaid-vault/projection";

import { FIRST_PLATYPUS, NOW, firstPlatypusSnapshot } from "../lib/plaid-vault/fixtures";

const mocks = vi.hoisted(() => ({
  peekCachedFullBlob: vi.fn(),
  peekCachedEncryptedBlob: vi.fn(),
  loadDomainData: vi.fn(),
  storeMergedDomainWithPreparedBlob: vi.fn(),
  saveMergedDomain: vi.fn(),
  cacheSync: vi.fn(),
  warm: vi.fn(),
  trackGrowth: vi.fn(),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    peekCachedFullBlob: mocks.peekCachedFullBlob,
    peekCachedEncryptedBlob: mocks.peekCachedEncryptedBlob,
    loadDomainData: mocks.loadDomainData,
    storeMergedDomainWithPreparedBlob: mocks.storeMergedDomainWithPreparedBlob,
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: mocks.saveMergedDomain },
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

function makeFinancial(options: { snapshotCount?: number; withVault?: boolean } = {}) {
  const snapshots = [
    {
      id: "statement-july",
      imported_at: "2026-07-17T00:00:00.000Z",
      canonical_v2: statementPortfolio,
    },
  ];
  if ((options.snapshotCount ?? 1) > 1) {
    snapshots.push({
      id: "statement-june",
      imported_at: "2026-06-17T00:00:00.000Z",
      canonical_v2: statementPortfolio,
    });
  }
  const base: Record<string, unknown> = {
    portfolio: statementPortfolio,
    sources: {
      active_source: "statement",
      statement: {
        active_snapshot_id: "statement-july",
        snapshots,
      },
    },
  };
  if (options.withVault === false) return base;
  // A bank sealed in the vault makes Plaid an available source.
  const linked = applyConnectionLink(
    base,
    {
      item_id: "item_fp",
      access_token: "access-sandbox-item-fp",
      institution: FIRST_PLATYPUS,
      products: ["investments"],
    },
    NOW,
  );
  return applySnapshot(linked, "item_fp", firstPlatypusSnapshot("item_fp", "fp"), NOW);
}

/** Runs the coordinator's build against the given memory, like the real one. */
function saveRunsBuild(current: Record<string, unknown>) {
  mocks.saveMergedDomain.mockImplementation(
    async (params: {
      build: (context: { currentDomainData: Record<string, unknown> }) => {
        domainData: Record<string, unknown>;
      };
    }) => {
      const plan = params.build({ currentDomainData: current });
      return { success: true, fullBlob: { financial: plan.domainData } };
    },
  );
}

function useFinancial(financial: Record<string, unknown>) {
  mocks.peekCachedFullBlob.mockReturnValue({ blob: { financial }, dataVersion: 7 });
  mocks.loadDomainData.mockResolvedValue(financial);
  saveRunsBuild(financial);
}

async function renderReadyHook(expectedSources = ["statement", "plaid"]) {
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
    expect(hook.result.current.availableSources).toEqual(expectedSources);
  });
  return hook;
}

describe("usePortfolioSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.peekCachedEncryptedBlob.mockReturnValue({ dataVersion: 7 });
    mocks.warm.mockResolvedValue(undefined);
    useFinancial(makeFinancial());
  });

  it("only reads on load: no memory write, so no refused save on unlock", async () => {
    await renderReadyHook();

    // The retired server copy used to be re-saved here without a change plan
    // and the server answered 428 on every unlock.
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
    expect(mocks.storeMergedDomainWithPreparedBlob).not.toHaveBeenCalled();
  });

  it("reports sealed connections from memory, marked as vault custody", async () => {
    const { result } = await renderReadyHook();

    expect(result.current.plaidStatus?.custody).toBe("vault");
    expect(result.current.plaidStatus?.aggregate?.item_count).toBe(1);
  });

  it("keeps the confirmed source selected until the owner-confirmed save settles", async () => {
    let releaseSave: (() => void) | undefined;
    const financial = makeFinancial();
    mocks.saveMergedDomain.mockImplementationOnce(
      (params: { build: (c: { currentDomainData: Record<string, unknown> }) => { domainData: Record<string, unknown> } }) =>
        new Promise((resolve) => {
          releaseSave = () => {
            const plan = params.build({ currentDomainData: financial });
            resolve({ success: true, fullBlob: { financial: plan.domainData } });
          };
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
      releaseSave?.();
      await changePromise;
    });

    expect(result.current.isChangingSource).toBe(false);
    expect(result.current.activeSource).toBe("plaid");
    const call = mocks.saveMergedDomain.mock.calls[0]![0];
    expect(call.confirmation).toMatchObject({
      confirmedByUser: true,
      source: "portfolio_source_change",
    });
  });

  it("keeps the last confirmed source when the save is not accepted", async () => {
    mocks.saveMergedDomain.mockResolvedValueOnce({
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
    expect(result.current.isChangingSource).toBe(false);
  });

  it("rejects unavailable sources before issuing any write", async () => {
    useFinancial(makeFinancial({ withVault: false }));
    const hook = await renderReadyHook(["statement"]);

    await act(async () => {
      await expect(hook.result.current.changeActiveSource("plaid")).rejects.toThrow(
        "not ready yet",
      );
    });

    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("deletes a saved statement through one owner-confirmed save that replaces the domain", async () => {
    useFinancial(makeFinancial({ snapshotCount: 2 }));
    const { result } = await renderReadyHook();

    await act(async () => {
      await expect(
        result.current.deleteStatementSnapshot("statement-july"),
      ).resolves.toBeUndefined();
    });

    expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1);
    const call = mocks.saveMergedDomain.mock.calls[0]![0];
    expect(call.confirmation).toMatchObject({
      confirmedByUser: true,
      source: "portfolio_statement_delete",
    });
    const plan = call.build({ currentDomainData: makeFinancial({ snapshotCount: 2 }) });
    expect(plan.mergeDecision).toMatchObject({ merge_mode: "replace_domain" });
    expect(mocks.storeMergedDomainWithPreparedBlob).not.toHaveBeenCalled();
  });
});
