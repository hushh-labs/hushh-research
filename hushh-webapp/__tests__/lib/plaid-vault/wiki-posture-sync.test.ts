import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ownerContentIsPrivate: vi.fn(async () => false),
  ownerPodRequest: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  refreshHotDigest: vi.fn(async () => undefined),
  createPage: vi.fn(async () => ({ revision: 1 })),
  editPage: vi.fn(async () => ({ revision: 2 })),
  readPage: vi.fn(async () => null as { revision: number } | null),
  registerSource: vi.fn(async () => ({})),
}));

vi.mock("@/lib/services/private-agent-specialist-chat", () => ({
  ownerContentIsPrivate: mocks.ownerContentIsPrivate,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    ownerPodRequest: mocks.ownerPodRequest,
  },
}));
vi.mock("@/lib/files/wiki/active-shared-wiki", () => ({
  peekActiveSharedWiki: () => null,
  ensureActiveSharedWiki: () => ({
    registerSource: mocks.registerSource,
    readPage: mocks.readPage,
    createPage: mocks.createPage,
    editPage: mocks.editPage,
  }),
}));
vi.mock("@/lib/files/wiki/writer", () => ({
  SharedWikiKnowledgeWriter: class {
    refreshHotDigest = mocks.refreshHotDigest;
  },
}));

import {
  buildPlaidWikiPostureSummary,
  syncPlaidPostureToPersonalWiki,
} from "@/lib/kai/plaid-vault/wiki-posture-sync";

const SYNTHETIC_FINANCIAL = {
  connections_v1: {
    item_1: {
      item_id: "item_1",
      institution_name: "First Platypus Bank",
      status: "connected",
      last_synced_at: "2026-11-19T12:00:00Z",
      last_refreshed_at: "2026-11-19T12:00:00Z",
    },
  },
  accounts_v1: {
    acct_checking: {
      account_id: "acct_checking",
      item_id: "item_1",
      name: "Plaid Checking",
      mask: "0000",
      type: "depository",
      subtype: "checking",
      balances: { current: 110, available: 100, iso_currency_code: "USD" },
    },
    acct_loan: {
      account_id: "acct_loan",
      item_id: "item_1",
      name: "Plaid Student Loan",
      mask: "7777",
      type: "loan",
      subtype: "student",
      balances: { current: 65262, iso_currency_code: "USD" },
    },
  },
};

describe("syncPlaidPostureToPersonalWiki", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("compiles multi-account posture markdown without secrets", () => {
    const summary = buildPlaidWikiPostureSummary(SYNTHETIC_FINANCIAL);
    expect(summary).not.toBeNull();
    expect(summary!.markdown).toContain("# Connected Financial Accounts");
    expect(summary!.markdown).toContain("First Platypus Bank — Plaid Checking (••••0000) [checking]");
    expect(summary!.markdown).toContain("Plaid Student Loan (••••7777) [student]");
    expect(summary!.claims.length).toBeGreaterThanOrEqual(2);
  });

  it("writes through files/wiki/migrate on Private Pod runtime", async () => {
    mocks.ownerContentIsPrivate.mockResolvedValueOnce(true);
    const ok = await syncPlaidPostureToPersonalWiki({
      userId: "owner_pod",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      financial: SYNTHETIC_FINANCIAL,
    });
    expect(ok).toBe(true);
    expect(mocks.ownerPodRequest).toHaveBeenCalledWith(
      "files/wiki/migrate",
      expect.objectContaining({ method: "POST" }),
      false,
    );
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  it("writes cited page and refreshes hot.md on Shared Wiki runtime", async () => {
    mocks.ownerContentIsPrivate.mockResolvedValueOnce(false);
    const ok = await syncPlaidPostureToPersonalWiki({
      userId: "owner_shared",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      financial: SYNTHETIC_FINANCIAL,
    });
    expect(ok).toBe(true);
    expect(mocks.registerSource).toHaveBeenCalledOnce();
    expect(mocks.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connected Financial Accounts",
        folder: "financial",
      }),
    );
    expect(mocks.refreshHotDigest).toHaveBeenCalledOnce();
  });

  it("falls back to client-encrypted Shared Wiki and compiles 5 mirror pages when pod returns 503 FILES_NOT_ENABLED", async () => {
    mocks.ownerContentIsPrivate.mockResolvedValueOnce(true);
    mocks.ownerPodRequest.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { error_code: "FILES_NOT_ENABLED" } }), { status: 503 }),
    );
    const enriched = {
      ...SYNTHETIC_FINANCIAL,
      summary: { schema: "plaid-summary-v1", net_worth_band: "$0-$10k", liquid_cash_band: "$0-$10k", investable_assets_band: "$0-$10k", cash_flow_trend: "flat", income_stability: "unknown", institution_count: 1, account_count: 2 },
      accounts: { schema: "plaid-accounts-v1", cash_in_bank: 100, total_depository_balance: 110, account_count: 1, items: [{ institution_name: "First Platypus Bank", account_name: "Plaid Checking", account_type: "Checking", current_balance: 110, available_balance: 100 }] },
      liabilities: { schema: "plaid-liabilities-v1", total_owed: 65262, credit_card_owed: 0, loan_owed: 65262, account_count: 1, items: [{ institution_name: "First Platypus Bank", account_name: "Plaid Student Loan", category: "Loan", account_type: "Student loan", balance_owed: 65262 }] },
      cashflow: { schema: "plaid-cashflow-v1", current_month: "2026-11", current_monthly_income: 5000, current_monthly_spend: 1200, current_monthly_net: 3800, cash_flow_trend: "positive", recurring_bills: [{ label: "Streaming", cadence: "monthly", typical_amount: 15.49, last_date: "2026-11-01" }] },
    };
    const ok = await syncPlaidPostureToPersonalWiki({
      userId: "owner_pod",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      financial: enriched,
    });
    expect(ok).toBe(true);
    const titles = mocks.createPage.mock.calls.map((call) => call[0]?.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Connected Financial Accounts",
        "Financial Summary",
        "Bank Accounts",
        "Credit & Loans",
        "Cash Flow & Recurring Bills",
      ]),
    );
    expect(mocks.refreshHotDigest).toHaveBeenCalledOnce();
  });
});
