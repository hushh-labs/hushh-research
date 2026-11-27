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
import { applyConnectionLink, applySnapshot } from "@/lib/kai/plaid-vault/projection";
import { activePortfolioChatView, readPortfolioContext, rememberPortfolioCard } from "@/lib/kai/portfolio-chat-context";
import { CacheService } from "@/lib/services/cache-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { firstPlatypusSnapshot, FIRST_PLATYPUS, NOW } from "../lib/plaid-vault/fixtures";

const PARAMS = { userId: "owner", vaultOwnerToken: "vot", vaultKey: "vk" };
const BEFORE = { portfolio: { holdings: [{ symbol: "OLD", name: "Old Shares", quantity: 1, market_value: 1 }] } };
const AFTER = { portfolio: { holdings: [{ symbol: "NEW", name: "New Shares", quantity: 1, market_value: 2 }] } };

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

  it("rejects portfolio facts if a write invalidates the read before the answer", async () => {
    const release = deferredRead();
    const pending = readPortfolioContext({ ...PARAMS, threadId: "race" }, { section: "holdings", source: "active" }, () => true);
    bumpPkmInvalidationEpoch("owner");
    release(BEFORE);
    await expect(pending).resolves.toEqual({ status: "unavailable", reason: "portfolio_changed" });
  });

  it("reads and ranks fresh holdings in an existing thread without an open card", async () => {
    const domainData = {
      portfolio: {
        account_info: { currency: "CAD", statement_period_end: "2026-10-31" },
        holdings: [
          { symbol: "SMALL", name: "Small holding", market_value: 25 },
          { symbol: "BIG", name: "Largest holding", market_value: 100 },
          { symbol: "NOQUOTE", name: "Unpriced holding" },
        ],
      },
    };
    const cached = KaiFinancialResourceService.primeFromFinancialDomain({
      userId: PARAMS.userId,
      financialDomain: BEFORE,
    });
    expect(cached?.activePortfolio?.holdings?.[0]?.name).toBe("Old Shares");
    mocks.prepareDomainWriteContext
      .mockResolvedValueOnce({ domainData, baseFullBlob: {} })
      .mockResolvedValueOnce({ domainData, baseFullBlob: {} });
    const cardRead = await KaiFinancialResourceService.readForAnswer(PARAMS, () => true);
    const card = activePortfolioChatView(cardRead!.resource);
    const answer = await readPortfolioContext({ ...PARAMS, threadId: "restored-thread" },
      { section: "holdings", source: "active" }, () => true);
    expect(answer).toMatchObject({
      status: "ok", as_of: "2026-10-31", currency: "CAD",
      holdings: { total_count: 3, positions: card?.positions.map(({ facts }) => facts) },
    });
    expect(card?.positions.map(({ facts }) => facts.market_value)).toEqual([100, 25, null]);
  });

  it("reads current facts but refuses a changed card or another vault session", async () => {
    const session = { ...PARAMS, threadId: "card" };
    mocks.prepareDomainWriteContext.mockResolvedValueOnce({ domainData: BEFORE, baseFullBlob: {} });
    const result = await KaiFinancialResourceService.readForAnswer(PARAMS, () => true);
    expect(result?.resource.activePortfolio).toBeTruthy();
    await rememberPortfolioCard(session.threadId, result!.resource);

    const cardRequest = { section: "holdings", source: "last_card" } as const;
    mocks.prepareDomainWriteContext.mockResolvedValueOnce({ domainData: BEFORE, baseFullBlob: {} });
    await expect(readPortfolioContext(session, cardRequest, () => true)).resolves.toMatchObject({
      status: "ok", selection: "last_card", holdings: { positions: [{ name: "Old Shares", market_value: 1 }], total_count: 1 },
    });
    mocks.prepareDomainWriteContext.mockResolvedValueOnce({ domainData: AFTER, baseFullBlob: {} });
    await expect(readPortfolioContext(session, cardRequest, () => true)).resolves.toEqual({
      status: "unavailable", reason: "card_unavailable",
    });
    mocks.prepareDomainWriteContext.mockResolvedValueOnce({ domainData: AFTER, baseFullBlob: {} });
    await expect(readPortfolioContext(session, { ...cardRequest, source: "active" }, () => true)).resolves.toMatchObject({
      status: "ok", selection: "active", holdings: { positions: [{ name: "New Shares", market_value: 2 }], total_count: 1 },
    });
    advanceVaultSessionEpoch();
    await expect(readPortfolioContext(session, cardRequest, () => true)).resolves.toEqual({
      status: "unavailable", reason: "card_unavailable",
    });
    expect(mocks.prepareDomainWriteContext).toHaveBeenCalledTimes(4);
    expect(mocks.secureWrite).not.toHaveBeenCalled();
  });

  it("uses the selected 52-row statement for its card and follow-up when Plaid is also linked", async () => {
    const connection = applyConnectionLink(null, {
      item_id: "sample", access_token: "fixture-only", institution: FIRST_PLATYPUS, products: ["investments"],
    }, NOW);
    const linked = applySnapshot(connection, "sample", firstPlatypusSnapshot("sample", "sample"), NOW);
    const statement = {
      id: "selected",
      canonical_v2: {
        account_info: { currency: "USD" },
        holdings: Array.from({ length: 52 }, (_, index) => ({
          symbol: `HOLD${index + 1}`,
          name: `Test holding ${index + 1}`,
          identifier_type: "ticker",
          quantity: 1,
          market_value: 52 - index,
        })),
      },
    };
    const domain = (activeSnapshotId: string) => ({
      ...linked,
      sources: {
        active_source: "statement",
        statement: { active_snapshot_id: activeSnapshotId, snapshots: [statement] },
      },
    });
    const load = (activeSnapshotId: string) => mocks.prepareDomainWriteContext.mockResolvedValueOnce({
      domainData: domain(activeSnapshotId), baseFullBlob: {},
    });
    const request = { source: "active", section: "holdings" } as const;
    const session = { ...PARAMS, threadId: "finance" };
    load("selected");
    const read = await KaiFinancialResourceService.readForAnswer(PARAMS, () => true);
    expect(read?.resource.plaidPortfolio?.holdings?.length).toBeGreaterThan(0);
    expect(read?.resource.activeSource).toBe("statement");
    expect(activePortfolioChatView(read!.resource)?.positions).toHaveLength(52);

    load("selected");
    const legacy = await readPortfolioContext(session, request, () => true);
    const legacyHoldings = "holdings" in legacy ? legacy.holdings : undefined;
    expect(legacyHoldings?.positions).toHaveLength(40);
    expect(legacyHoldings).not.toHaveProperty("investment_rows");

    load("selected");
    const expanded = await readPortfolioContext(session, { ...request, detail: "expanded" }, () => true);
    expect(expanded).toMatchObject({
      status: "ok", source: "statement",
      holdings: { investment_rows: 52, total_count: 52, matched_count: 52, unique_tickers: 52 },
    });
    const expandedPositions = "holdings" in expanded ? expanded.holdings?.positions : undefined;
    expect(expandedPositions).toHaveLength(52);
    expect(expandedPositions?.at(-1)?.ticker).toBe("HOLD52");

    load("selected");
    await expect(readPortfolioContext(session, { ...request, ticker: "HOLD52", detail: "expanded" }, () => true)).resolves.toMatchObject({
      status: "ok", source: "statement", holdings: { total_count: 52, matched_count: 1,
        positions: [{ ticker: "HOLD52", market_value: 1 }] },
    });
    load("deleted");
    await expect(readPortfolioContext(session, request, () => true)).resolves.toEqual({
      status: "unavailable", reason: "source_unavailable",
    });
    expect(KaiFinancialResourceService.activeSavedSource(PARAMS.userId, domain("deleted"))).toBeNull();
  });

  it("uses saved currency and treats missing prices and positions as unknown", async () => {
    const session = { ...PARAMS, threadId: "currency" };
    const portfolio = { holdings: [{ symbol: "ABC", name: "Unpriced holding" }] };
    const inCad = { portfolio: { ...portfolio, account_info: { currency: "CAD" } } };
    const unlabeled = { portfolio: { holdings: [{ ...portfolio.holdings[0], market_value: 11 }] } };
    const load = (domainData: Record<string, unknown>) =>
      mocks.prepareDomainWriteContext.mockResolvedValueOnce({ domainData, baseFullBlob: {} });

    load(inCad);
    const holdings = { section: "holdings", source: "active" } as const;
    await expect(readPortfolioContext(session, holdings, () => true)).resolves.toMatchObject({
      status: "ok", currency: "CAD",
      holdings: { positions: [{ currency: "CAD", market_value: null }] },
    });
    load(inCad);
    await expect(readPortfolioContext(session, { ...holdings, section: "performance" }, () => true))
      .resolves.toEqual({ status: "unavailable", reason: "section_unavailable" });
    load(unlabeled);
    await expect(readPortfolioContext(session, holdings, () => true)).resolves.toMatchObject({
      status: "ok", currency: null,
      holdings: { positions: [{ currency: null, market_value: 11 }] },
    });
  });

  it("uses the same saved allocation mix as the Finance chart", async () => {
    const domainData = {
      portfolio: {
        account_info: { currency: "USD" },
        holdings: [{ symbol: "ABC", name: "Example holding", market_value: 100 }],
        analytics_v2: { allocation_mix: [{ bucket: "equity", value: 60 }, { bucket: "fixed_income", value: 40 }] },
      },
    };
    mocks.prepareDomainWriteContext.mockResolvedValueOnce({ domainData, baseFullBlob: {} });
    await expect(readPortfolioContext({ ...PARAMS, threadId: "allocation" }, {
      section: "allocation", source: "active",
    }, () => true)).resolves.toMatchObject({
      status: "ok", allocation: [{ bucket: "Equities", percent: 60 }, { bucket: "Fixed Income", percent: 40 }],
    });
  });
});
