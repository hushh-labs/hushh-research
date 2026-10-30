import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/kai/plaid-vault/vault-sync", () => ({ loadFinancialForVault: mocks.load }));
import { readSavedFinance } from "@/lib/finance-sharing/saved-source";
import { assertAdvisorSourceIntegrity } from "@/lib/finance-sharing/advisor-source-integrity";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { applyConnectionLink, applySnapshot } from "@/lib/kai/plaid-vault/projection";
import { firstPlatypusSnapshot, FIRST_PLATYPUS, NOW } from "./plaid-vault/fixtures";

const source = { kind: "statement" as const, snapshotId: "selected" };
const context: FinanceShareContext = { userId: "owner", vaultKey: "key", vaultOwnerToken: "token", getIdToken: async () => "id", isCurrent: () => true };
const holding = { symbol: "AAPL", name: "Apple", quantity: 1, price: 100, market_value: 100 };
const financial = (portfolio: Record<string, unknown>) => ({ sources: { statement: { active_snapshot_id: "selected", snapshots: [{ id: "selected", canonical_v2: portfolio }] } } });
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("crypto", webcrypto); });

describe("advisor source integrity", () => {
  it("allows the exact selected USD statement when its entries survive normalization", async () => {
    mocks.load.mockResolvedValue(financial({ currency: "USD", holdings: [holding], total_value: 100 }));
    const saved = await readSavedFinance(context, source, true);
    expect(saved.portfolio.holdings).toHaveLength(1);
  });
  it("checks the V7 source before normalization and rejects foreign currency", async () => {
    const v7 = { pkm_contract_version: "7.0.0", financial_core_v7: { active_source: "statement", accounts: { account: { account_id: "account", currency: "USD" } },
      securities: { sec: { symbol: "AAPL", name: "Apple" } }, positions: { one: { security_id: "sec", account_id: "account", quantity: 1, price: 100, market_value: 100 } },
      account_summary: { ending_value: 100, currency: "USD" }, total_value: 100 } };
    const active = { kind: "statement" as const, snapshotId: null };
    mocks.load.mockResolvedValue(v7);
    expect((await readSavedFinance(context, active, true)).portfolio.holdings).toHaveLength(1);
    mocks.load.mockResolvedValue({ ...v7, financial_core_v7: { ...v7.financial_core_v7, account_summary: { ending_value: 100, currency: "EUR" } } });
    await expect(readSavedFinance(context, active, true)).rejects.toThrow();
    mocks.load.mockResolvedValue({ ...v7, financial_core_v7: { ...v7.financial_core_v7, accounts: { account: { account_id: "account", currency: "EUR" } } } });
    await expect(readSavedFinance(context, active, true)).rejects.toThrow();
    mocks.load.mockResolvedValue({ ...v7, financial_core_v7: { ...v7.financial_core_v7, securities: { sec: { symbol: "AAPL", currency: "EUR" } }, positions: { one: { ...v7.financial_core_v7.positions.one, currency: "USD" } } } });
    await expect(readSavedFinance(context, active, true)).rejects.toThrow();
  });
  it("reads an untagged V7 position as USD but never hides another account's foreign currency", () => {
    const v7 = (other: Record<string, unknown>) => ({ financial_core_v7: { account_summary: { currency: "USD" }, accounts: { a: other, b: {} },
      securities: { sec: { symbol: "AAPL" } },
      positions: { one: { security_id: "sec", account_id: "b", quantity: 1, price: 100, market_value: 100 } } } });
    const portfolio = { holdings: [holding] } as PortfolioData;
    const active = { kind: "statement", snapshotId: null, representation: "current-v7" } as const;
    expect(() => assertAdvisorSourceIntegrity(v7({ currency: "USD" }), active, portfolio)).not.toThrow();
    expect(() => assertAdvisorSourceIntegrity(v7({ currency: "EUR" }), active, portfolio)).toThrow();
  });
  it("validates the V7 fallback rather than stale linked records", () => {
    const v7 = { connections_v1: { item: { item_id: "item" } },
      holdings_v1: { one: { item_id: "item", account_id: "account", security_id: "@@@", quantity: 1, institution_value: 100, iso_currency_code: "USD" } },
      accounts_v1: { account: { account_id: "account", item_id: "item", balances: { iso_currency_code: "USD" } } },
      securities_v1: {}, financial_core_v7: { accounts: { account: { currency: "USD" } },
        securities: { "@@@": { symbol: "AAPL", currency: "EUR" } },
        positions: { one: { security_id: "@@@", account_id: "account", quantity: 1, price: 100, market_value: 100, currency: "USD" } } } };
    const portfolio = { holdings: [{ ...holding, item_id: "item", account_id: "account", security_id: "@@@" }] } as PortfolioData;
    expect(() => assertAdvisorSourceIntegrity(v7, { kind: "plaid", snapshotId: null, representation: "current-v7" }, portfolio)).toThrow();
  });
  it("verifies the selected linked positions and rejects foreign currency", async () => {
    const linked = applyConnectionLink(null, { item_id: "sample", access_token: "fixture-only", institution: FIRST_PLATYPUS, products: ["investments"] }, NOW);
    const saved = applySnapshot(linked, "sample", firstPlatypusSnapshot("sample", "sample"), NOW);
    mocks.load.mockResolvedValue(saved);
    const result = await readSavedFinance(context, { kind: "plaid", snapshotId: null }, true);
    expect(result.portfolio.holdings?.length).toBeGreaterThan(0);
    const foreign = structuredClone(saved);
    const first = Object.values(foreign.holdings_v1 ?? {})[0]!;
    first.iso_currency_code = "EUR";
    mocks.load.mockResolvedValue(foreign);
    await expect(readSavedFinance(context, { kind: "plaid", snapshotId: null }, true)).rejects.toThrow();
    const conflicting = structuredClone(saved);
    const security = Object.values(conflicting.securities_v1 ?? {})[0]!;
    Object.assign(security, { currency: "EUR" });
    mocks.load.mockResolvedValue(conflicting);
    await expect(readSavedFinance(context, { kind: "plaid", snapshotId: null }, true)).rejects.toThrow();
  });
  it.each([
    { currency: "EUR", holdings: [holding], total_value: 100 },
    { currency: "USD", holdings: [{ ...holding, symbol: "", name: "Cash" }], total_value: 100 },
    { currency: "USD", holdings: [{ ...holding, market_value: undefined }], total_value: 100 },
    { currency: "USD", holdings: [{ ...holding, iso_currency_code: "USD", currency: "EUR" }], total_value: 100 },
  ])("refuses foreign, omitted, or missing source information before preview", async portfolio => {
    mocks.load.mockResolvedValue(financial(portfolio));
    await expect(readSavedFinance(context, source, true)).rejects.toThrow();
  });
  it("reads a statement with no currency tag as USD", async () => {
    mocks.load.mockResolvedValue(financial({ holdings: [holding], total_value: 100 }));
    expect((await readSavedFinance(context, source, true)).portfolio.holdings).toHaveLength(1);
  });
});
