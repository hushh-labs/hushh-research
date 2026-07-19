import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBaselineStaleFirst: vi.fn(),
  getPersonalizedStaleFirst: vi.fn(),
  resolveTrackedSymbols: vi.fn(),
  getStaleFirst: vi.fn(),
  preloadTickerUniverse: vi.fn(),
  getKaiActivePickSource: vi.fn(),
  trackWarmupCompleted: vi.fn(),
}));

vi.mock("@/lib/kai/kai-market-home-resource", () => ({
  KaiMarketHomeResourceService: {
    getBaselineStaleFirst: mocks.getBaselineStaleFirst,
    getPersonalizedStaleFirst: mocks.getPersonalizedStaleFirst,
    resolveTrackedSymbols: mocks.resolveTrackedSymbols,
  },
}));

vi.mock("@/lib/kai/kai-financial-resource", () => ({
  KaiFinancialResourceService: {
    getStaleFirst: mocks.getStaleFirst,
  },
}));

vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  preloadTickerUniverse: mocks.preloadTickerUniverse,
}));

vi.mock("@/lib/kai/pick-source-selection", () => ({
  getKaiActivePickSource: mocks.getKaiActivePickSource,
}));

vi.mock("@/lib/observability/client", () => ({
  trackWarmupCompleted: mocks.trackWarmupCompleted,
}));

import { warmFinanceWorkspace } from "@/lib/kai/finance-workspace-warmup";

describe("warmFinanceWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBaselineStaleFirst.mockResolvedValue(null);
    mocks.getPersonalizedStaleFirst.mockResolvedValue(null);
    mocks.resolveTrackedSymbols.mockReturnValue([]);
    mocks.getStaleFirst.mockResolvedValue(null);
    mocks.preloadTickerUniverse.mockResolvedValue([]);
    mocks.getKaiActivePickSource.mockReturnValue("default");
  });

  it("warms only safe market and analysis resources before the vault is available", async () => {
    await warmFinanceWorkspace({
      userId: "user-1",
      activeTab: "market",
    });

    expect(mocks.getBaselineStaleFirst).toHaveBeenCalledWith({
      userId: "user-1",
      daysBack: 7,
      backgroundRefresh: true,
    });
    expect(mocks.preloadTickerUniverse).toHaveBeenCalledTimes(1);
    expect(mocks.getStaleFirst).not.toHaveBeenCalled();
    expect(mocks.getPersonalizedStaleFirst).not.toHaveBeenCalled();
  });

  it("uses the existing financial resource to warm a symbol-scoped market snapshot", async () => {
    mocks.getStaleFirst.mockResolvedValue({ holdings: ["msft", "NVDA", "MSFT"] });

    await warmFinanceWorkspace({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner-token",
      activeTab: "portfolio",
    });

    expect(mocks.getStaleFirst).toHaveBeenCalledWith({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner-token",
      backgroundRefresh: true,
    });
    expect(mocks.getPersonalizedStaleFirst).toHaveBeenCalledWith({
      userId: "user-1",
      vaultOwnerToken: "vault-owner-token",
      pickSource: "default",
      symbols: ["MSFT", "NVDA"],
      daysBack: 7,
      backgroundRefresh: true,
    });
    expect(mocks.trackWarmupCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: "kai_home",
        warmPriority: "finance_workspace:portfolio",
      }),
    );
  });

  it("does not issue a personalized request without cached or resolved symbols", async () => {
    await warmFinanceWorkspace({
      userId: "user-1",
      vaultOwnerToken: "vault-owner-token",
      activeTab: "analysis",
    });

    expect(mocks.getStaleFirst).not.toHaveBeenCalled();
    expect(mocks.getPersonalizedStaleFirst).not.toHaveBeenCalled();
  });

  it("warms a cache-derived personalized market snapshot without unlocking portfolio data", async () => {
    mocks.resolveTrackedSymbols.mockReturnValue(["aapl"]);

    await warmFinanceWorkspace({
      userId: "user-1",
      vaultOwnerToken: "vault-owner-token",
      activeTab: "analysis",
    });

    expect(mocks.getStaleFirst).not.toHaveBeenCalled();
    expect(mocks.getPersonalizedStaleFirst).toHaveBeenCalledWith({
      userId: "user-1",
      vaultOwnerToken: "vault-owner-token",
      pickSource: "default",
      symbols: ["AAPL"],
      daysBack: 7,
      backgroundRefresh: true,
    });
  });
});
