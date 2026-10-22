import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  owner: "fixture-owner" as string | null,
  key: "fixture-key" as string | null,
  token: "fixture-token" as string | null,
  expiresAt: 0,
  unlock: vi.fn(),
  issue: vi.fn(),
  baseline: vi.fn(),
  personalized: vi.fn(),
  warm: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.owner ? { uid: mocks.owner } : null }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: mocks.key,
    vaultOwnerToken: mocks.token,
    tokenExpiresAt: mocks.expiresAt,
    getVaultKey: () => mocks.key,
    getVaultOwnerToken: () => mocks.key && Date.now() < mocks.expiresAt ? mocks.token : null,
    unlockVault: mocks.unlock,
  }),
}));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: { getOrIssueVaultOwnerToken: mocks.issue } }));
vi.mock("@/lib/kai/kai-financial-resource", () => ({
  KaiFinancialResourceService: { peek: () => null },
  useKaiFinancialResource: () => ({ data: null }),
}));
vi.mock("@/lib/kai/kai-market-home-resource", () => ({
  KaiMarketHomeResourceService: {
    resolveTrackedSymbols: () => [],
    getBaselineStaleFirst: mocks.baseline,
    getPersonalizedStaleFirst: mocks.personalized,
    refreshPersonalized: mocks.warm,
  },
}));
vi.mock("@/lib/kai/pick-source-selection", () => ({
  getKaiActivePickSource: () => "default", setKaiActivePickSource: vi.fn(),
}));

import { KaiMarketHomeProvider, useKaiMarketHome } from "@/components/kai/shared/kai-market-home-context";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { resetIdleSchedulerForTests } from "@/lib/perf/idle-scheduler";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const payload = { active_pick_source: "default" };
const wrapper = ({ children }: { children: ReactNode }) => <KaiMarketHomeProvider>{children}</KaiMarketHomeProvider>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-14T13:29:59Z"));
  mocks.owner = "fixture-owner";
  mocks.key = "fixture-key";
  mocks.token = "fixture-token";
  mocks.expiresAt = Date.now() + 3_600_000;
  publishValidatedAuthSessionOwner(mocks.owner);
  advanceVaultSessionEpoch();
  mocks.baseline.mockResolvedValue(payload);
  mocks.personalized.mockResolvedValue(payload);
  mocks.warm.mockResolvedValue(payload);
  mocks.unlock.mockImplementation((_key, token, expiresAt) => {
    mocks.token = token;
    mocks.expiresAt = expiresAt;
    advanceVaultSessionEpoch();
    return true;
  });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    setTimeout(() => callback(0), 0);
    return 1;
  });
  const cache = CacheService.getInstance();
  cache.clear();
  cache.set(CACHE_KEYS.KAI_MARKET_HOME_BASELINE(mocks.owner, 7), payload, 300_000);
  cache.set(CACHE_KEYS.KAI_MARKET_HOME(mocks.owner, "default", 7, "default"), payload, 300_000);
});

afterEach(() => {
  cleanup();
  resetIdleSchedulerForTests();
  CacheService.getInstance().clear();
  publishValidatedAuthSessionOwner(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Market owner opening refresh", () => {
  it("revalidates warm personalized information for news while the market is closed", async () => {
    vi.setSystemTime(new Date("2026-07-14T22:00:00Z"));
    mocks.expiresAt = Date.now() + 3_600_000;
    const updated = { ...payload, news: [{ title: "New after-hours headline" }] };
    mocks.personalized.mockImplementation(async (options) => {
      if (!options.forceRefresh) return payload;
      // The production resource service publishes its successful refresh here.
      CacheService.getInstance().set(
        CACHE_KEYS.KAI_MARKET_HOME(mocks.owner!, "default", 7, "default"), updated, 300_000,
      );
      return updated;
    });
    const { result } = renderHook(useKaiMarketHome, { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(600_020); });
    expect(mocks.personalized).toHaveBeenLastCalledWith(expect.objectContaining({
      forceRefresh: true, vaultOwnerToken: "fixture-token", backgroundRefresh: false,
    }));
    expect(result.current.payload).toEqual(updated);
  });

  it("observes a lock immediately even before the provider rerenders", async () => {
    renderHook(useKaiMarketHome, { wrapper });
    mocks.key = null;
    advanceVaultSessionEpoch();
    await act(async () => { await vi.advanceTimersByTimeAsync(1010); });
    expect(mocks.personalized).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("bypasses fresh client snapshots for both resources and reuses a valid token", async () => {
    renderHook(useKaiMarketHome, { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1010); });
    expect(mocks.baseline).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true, backgroundRefresh: false }));
    expect(mocks.personalized).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true, vaultOwnerToken: "fixture-token" }));
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("renews an expiring credential once before requesting fresh personalized information", async () => {
    mocks.expiresAt = Date.now() + 30_000;
    mocks.issue.mockResolvedValue({ token: "renewed-fixture-token", expiresAt: Date.now() + 3_600_000 });
    renderHook(useKaiMarketHome, { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1010); });
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(mocks.personalized).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true, vaultOwnerToken: "renewed-fixture-token" }));
  });

  it.each(["lock", "account change", "rejected unlock"])("does not dispatch personalized work after %s during renewal", async (change) => {
    mocks.expiresAt = Date.now() + 30_000;
    let finish!: (issued: { token: string; expiresAt: number }) => void;
    mocks.issue.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderHook(useKaiMarketHome, { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1010); });
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    if (change === "lock") {
      mocks.key = null;
      advanceVaultSessionEpoch();
    } else if (change === "account change") {
      publishValidatedAuthSessionOwner("other-fixture-owner");
    } else {
      mocks.unlock.mockReturnValue(false);
    }
    await act(async () => { finish({ token: "obsolete-fixture-token", expiresAt: Date.now() + 3_600_000 }); });
    expect(mocks.personalized).not.toHaveBeenCalled();
  });
});
