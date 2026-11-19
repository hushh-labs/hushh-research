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
});
