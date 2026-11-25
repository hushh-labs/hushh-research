import { describe, expect, it, vi, beforeEach } from "vitest";

const resourceMocks = vi.hoisted(() => ({
  getStaleFirst: vi.fn(),
  refresh: vi.fn(),
  refreshVaultConnections: vi.fn(),
  wikiSync: vi.fn(async () => true),
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: resourceMocks.getStaleFirst,
    refresh: resourceMocks.refresh,
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    isDomainAbsentInCachedMetadata: () => false,
  },
}));

vi.mock("@/lib/kai/plaid-vault/vault-sync", () => ({
  refreshVaultConnections: resourceMocks.refreshVaultConnections,
  vaultConnections: (financial: Record<string, unknown> | null | undefined) =>
    ((financial?.connections_v1 as Record<string, unknown> | undefined) ?? {}),
}));

vi.mock("@/lib/kai/plaid-vault/wiki-posture-sync", () => ({
  syncPlaidPostureToPersonalWikiBestEffort: resourceMocks.wikiSync,
}));

import {
  PLAID_TOOL_DECLARATIONS,
  buildAgentTurnPlaidPosture,
  executePlaidConnectorClientTool,
  normalizePlaidToolRequest,
} from "@/lib/kai/plaid-vault/plaid-chat-client-tools";
import { WIKI_TOOL_DECLARATIONS } from "@/lib/files/wiki/recall-client-tools";
import {
  clientWikiRecallVersion,
  plaidConnectorToolVersion,
  projectPodActionTools,
} from "@/lib/services/pod-chat-receipt-capabilities";

const sampleFinancial = {
  connections_v1: {
    item_1: {
      institution_name: "First Platypus Bank 987654321098",
      status: "active",
      last_refreshed_at: "2026-11-20T09:00:00Z",
    },
    item_2: {
      institution_name: "Tartan Bank",
      status: "active",
      last_refreshed_at: "2026-11-20T09:01:00Z",
    },
  },
  accounts_v1: {
    "item_1:chk": {
      account_id: "chk",
      item_id: "item_1",
      institution_name: "First Platypus Bank",
      name: "Plaid Checking",
      mask: "0000",
      type: "depository",
      subtype: "checking",
      balances: { current: 110, available: 100, limit: null, iso_currency_code: "USD" },
      duplicate_of: null,
    },
    "item_2:ira": {
      account_id: "ira",
      item_id: "item_2",
      institution_name: "Tartan Bank",
      name: "Plaid IRA",
      mask: "3333",
      type: "investment",
      subtype: "ira",
      balances: { current: 320.76, available: null, limit: null, iso_currency_code: "USD" },
      duplicate_of: null,
    },
  },
  accounts: {
    schema: "plaid-accounts-v1",
    cash_in_bank: 110,
    total_depository_balance: 110,
    account_count: 1,
    institution_count: 1,
    as_of: "2026-11-20T09:01:00Z",
    items: [
      {
        institution_name: "First Platypus Bank",
        account_name: "Plaid Checking",
        account_type: "checking",
        current_balance: 110,
        available_balance: 100,
        currency: "USD",
      },
    ],
  },
  liabilities: {
    schema: "plaid-liabilities-v1",
    total_owed: 410,
    credit_card_owed: 410,
    credit_limit_total: 2000,
    credit_utilization_pct: 20.5,
    loan_owed: 0,
    account_count: 1,
    institution_count: 1,
    as_of: "2026-11-20T09:01:00Z",
    items: [
      {
        institution_name: "Tartan Bank",
        account_name: "Plaid Credit Card",
        category: "Credit card",
        account_type: "credit card",
        balance_owed: 410,
        credit_limit: 2000,
        available_credit: 1590,
        utilization_pct: 20.5,
        currency: "USD",
      },
    ],
  },
  portfolio: {
    account_summary: { total_value: 320.76, cash_balance: 0 },
    holdings: [{ symbol: "VTI", name: "Vanguard Total Stock Market", quantity: 1, market_value: 320.76 }],
  },
  cashflow: {
    schema: "plaid-cashflow-v1",
    net_worth: 20.76,
    total_assets: 430.76,
    total_liabilities: 410,
    liquid_cash: 110,
    investable_assets: 320.76,
    debt_to_asset_pct: 95.2,
    cash_flow_trend: "positive",
    income_stability: "stable",
    current_month: "2026-11",
    current_monthly_income: 5000,
    current_monthly_spend: 2200,
    current_monthly_net: 2800,
    recurring_bill_count: 2,
    as_of: "2026-11-20T09:01:00Z",
    recurring_bills: [
      {
        label: "Electric Utility",
        category: "Utilities",
        cadence: "monthly",
        typical_amount: 145,
        last_date: "2026-11-10",
      },
    ],
  },
};

describe("plaid-chat-client-tools", () => {
  beforeEach(() => {
    resourceMocks.getStaleFirst.mockReset();
    resourceMocks.refresh.mockReset();
    resourceMocks.refreshVaultConnections.mockReset();
    resourceMocks.wikiSync.mockClear();
  });

  it("builds a compact headline posture and scrubs raw 9-17 digit strings", () => {
    const posture = buildAgentTurnPlaidPosture(sampleFinancial);
    expect(posture).toContain("Plaid connected: 2 institutions, 2 accounts");
    expect(posture).toContain("First Platypus Bank [redacted-number]");
    expect(posture).not.toContain("987654321098");
  });

  it("reads local decrypted Plaid mirrors without triggering a network refresh", async () => {
    resourceMocks.getStaleFirst.mockResolvedValue({
      key: { userId: "owner_1" },
      data: sampleFinancial,
    });
    const req = normalizePlaidToolRequest("read_plaid_mirror", { mirror: "accounts" });
    const res = await executePlaidConnectorClientTool("read_plaid_mirror", req, {
      userId: "owner_1",
      vaultKey: "vk_1",
      vaultOwnerToken: "vot_1",
      isCurrent: () => true,
    });
    expect(res.status).toBe("ok");
    expect(res.refreshed).toBe(false);
    expect(resourceMocks.refreshVaultConnections).not.toHaveBeenCalled();
    expect(res.mirrors).toHaveProperty("accounts");
    expect(res.mirrors).not.toHaveProperty("liabilities");
  });

  it("executes live Plaid sync in-turn, updates Wiki posture, and returns all 5 mirrors", async () => {
    resourceMocks.getStaleFirst.mockResolvedValue({
      key: { userId: "owner_1" },
      data: sampleFinancial,
    });
    resourceMocks.refreshVaultConnections.mockResolvedValue({
      refreshed: 2,
      needsRelink: [],
      failed: 0,
      saved: true,
    });
    resourceMocks.refresh.mockResolvedValue({
      key: { userId: "owner_1" },
      data: sampleFinancial,
    });

    const res = await executePlaidConnectorClientTool(
      "sync_plaid_connector",
      normalizePlaidToolRequest("sync_plaid_connector", {}),
      {
        userId: "owner_1",
        vaultKey: "vk_1",
        vaultOwnerToken: "vot_1",
        isCurrent: () => true,
      },
    );
    expect(res.status).toBe("ok");
    expect(res.refreshed).toBe(true);
    expect(resourceMocks.refreshVaultConnections).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, userId: "owner_1" }),
    );
    await vi.waitFor(() => expect(resourceMocks.wikiSync).toHaveBeenCalledOnce());
    expect(Object.keys(res.mirrors ?? {})).toEqual(
      expect.arrayContaining(["accounts", "liabilities", "portfolio", "cashflow"]),
    );
  });

  it("returns connect_required when no Plaid institution is linked", async () => {
    resourceMocks.getStaleFirst.mockResolvedValue({
      key: { userId: "owner_1" },
      data: { connections_v1: {} },
    });
    const res = await executePlaidConnectorClientTool("sync_plaid_connector", {}, {
      userId: "owner_1",
      vaultKey: "vk_1",
      vaultOwnerToken: "vot_1",
      isCurrent: () => true,
    });
    expect(res.status).toBe("connect_required");
    expect(res.connected).toBe(false);
  });

  it("negotiates Plaid and client Wiki tools cleanly across legacy vs upgraded pods", () => {
    expect(plaidConnectorToolVersion({ plaidConnectorToolVersion: 1 })).toBe(1);
    expect(plaidConnectorToolVersion({})).toBe(0);
    expect(clientWikiRecallVersion({ clientWikiRecallVersion: 1 })).toBe(1);
    expect(clientWikiRecallVersion({})).toBe(0);

    const rawInit: RequestInit = {
      method: "POST",
      body: JSON.stringify({
        tools: [...PLAID_TOOL_DECLARATIONS, ...WIKI_TOOL_DECLARATIONS],
        forwardedProps: {
          plaidClientReady: true,
          plaidPosture: "Plaid connected",
          wikiClientReady: true,
          wikiHotDigest: "# Hot",
        },
      }),
    };

    const legacy = projectPodActionTools(rawInit, null, {
      plaidVersion: 0,
      clientWikiVersion: 0,
    });
    const legacyParsed = JSON.parse(String(legacy.body));
    expect(legacyParsed.tools).toEqual([]);
    expect(legacyParsed.forwardedProps).toEqual({});

    const upgraded = projectPodActionTools(rawInit, null, {
      plaidVersion: 1,
      clientWikiVersion: 1,
    });
    const upgradedParsed = JSON.parse(String(upgraded.body));
    expect(upgradedParsed.tools).toHaveLength(
      PLAID_TOOL_DECLARATIONS.length + WIKI_TOOL_DECLARATIONS.length,
    );
    expect(upgradedParsed.forwardedProps.plaidPosture).toBe("Plaid connected");
    expect(upgradedParsed.forwardedProps.wikiHotDigest).toBe("# Hot");
  });
});
