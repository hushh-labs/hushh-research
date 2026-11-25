import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  getDomainManifest: vi.fn(),
  getDomainSnapshot: vi.fn(),
  decryptDomainSnapshot: vi.fn(),
  storeMergedDomainWithPreparedBlob: vi.fn(),
  storePreparedDomainWithPreparedBlob: vi.fn(),
  prepareDomainWriteContext: vi.fn(),
  ensureRefreshRunning: vi.fn(),
  refreshVaultConnections: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: (...args: unknown[]) => mocks.getMetadata(...args),
    getDomainManifest: (...args: unknown[]) => mocks.getDomainManifest(...args),
    getDomainSnapshot: (...args: unknown[]) => mocks.getDomainSnapshot(...args),
    decryptDomainSnapshot: (...args: unknown[]) => mocks.decryptDomainSnapshot(...args),
    storeMergedDomainWithPreparedBlob: (...args: unknown[]) =>
      mocks.storeMergedDomainWithPreparedBlob(...args),
    storePreparedDomainWithPreparedBlob: (...args: unknown[]) =>
      mocks.storePreparedDomainWithPreparedBlob(...args),
  },
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    prepareDomainWriteContext: (...args: unknown[]) =>
      mocks.prepareDomainWriteContext(...args),
  },
}));

vi.mock("@/lib/services/consent-export-refresh-orchestrator", () => ({
  ConsentExportRefreshOrchestrator: {
    ensureRunning: (...args: unknown[]) => mocks.ensureRefreshRunning(...args),
  },
}));

vi.mock("@/lib/kai/plaid-vault/vault-sync", () => ({
  hasVaultConnections: (financial: Record<string, unknown> | null | undefined) =>
    Boolean(financial?.connections_v1 && Object.keys(financial.connections_v1 as object).length > 0),
  refreshVaultConnections: (...args: unknown[]) => mocks.refreshVaultConnections(...args),
}));

import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  ensureFreshPlaidProjectionForScope,
  PlaidExportRefreshError,
} from "@/lib/consent/financial-plaid-export-refresh";
import { summarizePlaidVaultProjection } from "@/lib/kai/plaid-vault/projection-summary";

const BASE_PARAMS = {
  userId: "owner-1",
  domain: "food",
  vaultKey: "vault-key-1",
  vaultOwnerToken: "vault-owner-token-1",
  confirmation: {
    confirmedByUser: true as const,
    surface: "web" as const,
    source: "plaid_live_test",
  },
};

function stubReadyContext() {
  mocks.getMetadata.mockResolvedValue({ upgradableDomains: [] });
  mocks.getDomainManifest.mockResolvedValue(null);
  mocks.prepareDomainWriteContext.mockResolvedValue({
    baseFullBlob: { food: {} },
    domainData: {},
    expectedDataVersion: 1,
    encryptedDomain: null,
    manifest: null,
    snapshot: null,
    etag: "etag-1",
  });
}

describe("live Plaid refresh and continuous export propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRefreshRunning.mockResolvedValue(undefined);
  });

  it("triggers ConsentExportRefreshOrchestrator after a non-idempotent saveMergedDomain write", async () => {
    stubReadyContext();
    mocks.storeMergedDomainWithPreparedBlob.mockResolvedValueOnce({
      success: true,
      dataVersion: 2,
      fullBlob: { food: { updated: true } },
    });

    const res = await PkmWriteCoordinator.saveMergedDomain({
      ...BASE_PARAMS,
      build: () => ({
        domainData: { favorite: "ramen" },
        summary: { item_count: 1 },
      }),
    });

    expect(res.success).toBe(true);
    expect(mocks.ensureRefreshRunning).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRefreshRunning).toHaveBeenCalledWith({
      userId: "owner-1",
      vaultKey: "vault-key-1",
      vaultOwnerToken: "vault-owner-token-1",
      initiatedBy: "pkm_write:food",
    });
  });

  it("skips ConsentExportRefreshOrchestrator when merged write is unchanged or mayPublish returns false", async () => {
    stubReadyContext();

    const unchangedRes = await PkmWriteCoordinator.saveMergedDomain({
      ...BASE_PARAMS,
      build: () => ({
        unchanged: true,
        domainData: {},
        summary: {},
      }),
    });
    expect(unchangedRes.idempotentReplay).toBe(true);
    expect(mocks.ensureRefreshRunning).not.toHaveBeenCalled();

    mocks.storeMergedDomainWithPreparedBlob.mockResolvedValueOnce({
      success: true,
      dataVersion: 2,
      fullBlob: { food: {} },
    });
    const fencedRes = await PkmWriteCoordinator.saveMergedDomain({
      ...BASE_PARAMS,
      mayPublish: () => false,
      build: () => ({
        domainData: { updated: true },
        summary: {},
      }),
    });
    expect(fencedRes.success).toBe(true);
    expect(mocks.ensureRefreshRunning).not.toHaveBeenCalled();
  });

  it("triggers ConsentExportRefreshOrchestrator on savePreparedDomain only when not an idempotent replay", async () => {
    stubReadyContext();

    mocks.storePreparedDomainWithPreparedBlob.mockResolvedValueOnce({
      success: true,
      idempotentReplay: true,
      dataVersion: 1,
      fullBlob: {},
    });
    await PkmWriteCoordinator.savePreparedDomain({
      ...BASE_PARAMS,
      build: () => ({
        domainData: { a: 1 },
        summary: {},
      }),
    });
    expect(mocks.ensureRefreshRunning).not.toHaveBeenCalled();

    mocks.storePreparedDomainWithPreparedBlob.mockResolvedValueOnce({
      success: true,
      idempotentReplay: false,
      dataVersion: 2,
      fullBlob: {},
    });
    await PkmWriteCoordinator.savePreparedDomain({
      ...BASE_PARAMS,
      build: () => ({
        domainData: { a: 2 },
        summary: {},
      }),
    });
    expect(mocks.ensureRefreshRunning).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRefreshRunning).toHaveBeenCalledWith({
      userId: "owner-1",
      vaultKey: "vault-key-1",
      vaultOwnerToken: "vault-owner-token-1",
      initiatedBy: "pkm_write:food",
    });
  });

  it("refreshes live Plaid connections for attr.financial.* and pkm.read, skips unrelated scopes, and fails closed on relink", async () => {
    await ensureFreshPlaidProjectionForScope({
      userId: "owner-1",
      scope: "attr.food.*",
      vaultKey: "vault-key-1",
      vaultOwnerToken: "owner-token-1",
    });
    expect(mocks.getDomainSnapshot).not.toHaveBeenCalled();

    const financialData = {
      connections_v1: {
        item_live: { item_id: "item_live", institution_name: "First Platypus Bank", status: "active" },
      },
    };
    mocks.getDomainSnapshot.mockResolvedValue({ domain: "financial", dataVersion: 1 });
    mocks.decryptDomainSnapshot.mockResolvedValue(financialData);
    mocks.refreshVaultConnections.mockResolvedValue({
      refreshed: 1,
      needsRelink: [],
      failed: 0,
      saved: true,
    });

    await ensureFreshPlaidProjectionForScope({
      userId: "owner-1",
      scope: "attr.financial.portfolio.*",
      vaultKey: "vault-key-1",
      vaultOwnerToken: "owner-token-1",
    });
    await ensureFreshPlaidProjectionForScope({
      userId: "owner-1",
      scope: "pkm.read",
      vaultKey: "vault-key-1",
      vaultOwnerToken: "owner-token-1",
    });
    expect(mocks.refreshVaultConnections).toHaveBeenCalledTimes(2);

    mocks.refreshVaultConnections.mockResolvedValueOnce({
      refreshed: 0,
      needsRelink: ["item_live"],
      failed: 0,
      saved: false,
    });
    await expect(
      ensureFreshPlaidProjectionForScope({
        userId: "owner-1",
        scope: "attr.financial.portfolio.*",
        vaultKey: "vault-key-1",
        vaultOwnerToken: "owner-token-1",
      }),
    ).rejects.toThrow(PlaidExportRefreshError);
  });

  it("summarizes live Plaid amounts and projected Financial Summary + Investment Portfolio scopes while skipping duplicates", () => {
    const summary = summarizePlaidVaultProjection({
      accounts_v1: {
        "item_1:chk": {
          account_id: "chk",
          item_id: "item_1",
          type: "depository",
          balances: { current: 50000, available: 50000, limit: null, iso_currency_code: "USD" },
          duplicate_of: null,
        },
        "item_1:inv": {
          account_id: "inv",
          item_id: "item_1",
          type: "investment",
          balances: { current: 65000, available: null, limit: null, iso_currency_code: "USD" },
          duplicate_of: null,
        },
        "item_1:dup": {
          account_id: "dup",
          item_id: "item_1",
          type: "depository",
          balances: { current: 999999, available: 999999, limit: null, iso_currency_code: "USD" },
          duplicate_of: "item_1:chk",
        },
      },
      holdings_v1: {
        "inv:sec_aapl": {
          item_id: "item_1",
          account_id: "inv",
          security_id: "sec_aapl",
          quantity: 100,
          institution_price: 250,
          institution_price_as_of: null,
          institution_value: 25000,
          cost_basis: 18000,
          iso_currency_code: "USD",
        },
      },
      securities_v1: {
        sec_aapl: {
          security_id: "sec_aapl",
          ticker: "AAPL",
          name: "Apple Inc.",
          type: "equity",
          subtype: "common stock",
          cusip: "037833100",
          is_cash_equivalent: false,
          close_price: 250,
          sector: "Technology",
          industry: "Consumer Electronics",
        },
      },
      derived_v1: {
        schema: "plaid-derived-v1",
        net_worth: { value: 115000 },
        liquid_cash: { value: 50000 },
        investable_assets: { value: 65000 },
      },
      summary: {
        schema: "plaid-summary-v1",
        net_worth_band: "$100k-$250k",
      },
    });

    expect(summary.hasData).toBe(true);
    expect(summary.byItemId.item_1).toEqual({
      accountCount: 2,
      netAmount: 115000,
      formattedNetAmount: "$115,000",
      summaryLabel: "2 accounts · $115,000",
    });
    expect(summary.totalsLine).toBe("Net worth $115,000 · Liquid cash $50,000 · Investable $65,000");
    expect(summary.projectedScopesLine).toBe(
      "Shareable scopes: Financial Summary ($100k-$250k) · Investment Portfolio ($25,000)",
    );
  });
});
