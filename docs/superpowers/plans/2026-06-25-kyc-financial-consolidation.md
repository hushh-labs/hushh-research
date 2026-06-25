# KYC Financial Consolidation Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the KYC draft builder consolidate fragmented PKM financial data (merge lots and accounts per security, aggregate totals, de-noise) into a tiered, meaningful disclosure — deterministically and client-side, before tokenization.

**Architecture:** A new pure module `one-kyc-financial-consolidation.ts` collects accounts, merges holdings per security across accounts (reusing the existing `consolidateHoldingsBySymbol`), and computes aggregate header facts (totals, cash, net unrealized gain/loss, allocation, reconciliation flag). `formatPortfolioApprovedValue` in the ZK service consumes it and emits the *same* two-block string contract (`Portfolio summary` + `Holdings`) the renderer already parses — so `buildDraft → renderModel → renderer` and `redact → rewrite → re-fill` are unchanged. The portfolio remains a single opaque token at redaction time, so no real figure ever leaves the browser.

**Tech Stack:** TypeScript, Next.js (client module, `"use client"`), Vitest. Reuses `hushh-webapp/lib/utils/portfolio-normalize.ts`.

## Global Constraints

- **Zero-knowledge:** all numeric consolidation is deterministic and client-side, completed BEFORE `redactDraftForLlm`. The LLM only ever sees `{{F0}}…` placeholders + prose. Never send a real value off-device.
- **Pipeline intact:** do NOT change the signatures of `buildDraft`, `redactDraftForLlm`, `resubstituteDraft`, `validateTokenIntegrity`, `splitDraftTemplate`, `reassembleDraftTemplate`, or any function in `one-kyc-approved-disclosure-renderer.ts`.
- **Backend untouched:** `draft_body` stays NULL; no backend file is modified by this plan.
- **No dropped positions (D2):** every distinct position is disclosed; trimming is only via the existing `compact`/`fullDetail` style flags. Aggregate totals are always complete and exact.
- **Reconciliation tolerance:** `Math.max(1, Math.abs(totalValue) * 0.01)`.
- **Test runner:** `npx vitest run <file>` from `hushh-webapp/`. Typecheck: `npm run typecheck`. Lint: `npx eslint <files> --max-warnings=0`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** `feature/agent-kyc-enhancement` (already checked out).

---

## File Structure

- **Create** `hushh-webapp/lib/services/one-kyc-financial-consolidation.ts` — pure consolidation module (types + `consolidateFinancialPortfolio`).
- **Create** `hushh-webapp/__tests__/services/one-kyc-financial-consolidation.test.ts` — unit tests for the module.
- **Modify** `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` — `formatPortfolioApprovedValue` (currently lines ~449-504) consumes the new module; add a small allocation-string helper.
- **Modify** `hushh-webapp/__tests__/services/one-kyc-client-zk-service.test.ts` — add multi-account + consolidation integration tests.
- **Modify** `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts` — add redaction-completeness + token-integrity assertions for a consolidated portfolio.
- **Modify** `hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts` — add a golden snapshot of `buildApprovedDisclosureHtml` on a consolidated multi-account portfolio.

---

## Task 1: Consolidation module — account collection & dedup

**Files:**
- Create: `hushh-webapp/lib/services/one-kyc-financial-consolidation.ts`
- Test: `hushh-webapp/__tests__/services/one-kyc-financial-consolidation.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `type ConsolidatedAccount = { label: string | null; endingValue: number | null; cashBalance: number | null; generatedAt: string | null }`
  - `type CollectedAccount = { account: ConsolidatedAccount; holdings: Record<string, unknown>[]; key: string }`
  - `function collectAccounts(portfolio: Record<string, unknown>): CollectedAccount[]`
  - `function dedupAccountsByFreshest(collected: CollectedAccount[]): CollectedAccount[]`
  - internal helpers `toNumber(value: unknown): number | null`, `toText(value: unknown): string | null`, `isRecord(value: unknown): value is Record<string, unknown>`, `accountLabel(accountInfo: Record<string, unknown> | null): string | null`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/services/one-kyc-financial-consolidation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  collectAccounts,
  dedupAccountsByFreshest,
} from "@/lib/services/one-kyc-financial-consolidation";

describe("collectAccounts", () => {
  it("treats a single portfolio object as one account", () => {
    const collected = collectAccounts({
      account_info: { brokerage_name: "Fidelity", account_type: "Individual TOD" },
      account_summary: { ending_value: 1000, cash_balance: 50 },
      holdings: [{ symbol: "AAPL", quantity: 10, market_value: 900 }],
    });
    expect(collected).toHaveLength(1);
    expect(collected[0]!.account.label).toBe("Fidelity Individual TOD");
    expect(collected[0]!.account.endingValue).toBe(1000);
    expect(collected[0]!.account.cashBalance).toBe(50);
    expect(collected[0]!.holdings).toHaveLength(1);
  });

  it("expands an accounts[] array into one entry per account", () => {
    const collected = collectAccounts({
      accounts: [
        {
          account_info: { brokerage_name: "Fidelity", account_type: "Individual" },
          account_summary: { ending_value: 1000 },
          holdings: [{ symbol: "AAPL", quantity: 100, market_value: 900 }],
          generated_at: "2026-01-31T00:00:00Z",
        },
        {
          account_info: { brokerage_name: "Schwab", account_type: "IRA" },
          account_summary: { ending_value: 2000 },
          holdings: [{ symbol: "AAPL", quantity: 200, market_value: 1800 }],
          generated_at: "2026-02-15T00:00:00Z",
        },
      ],
    });
    expect(collected).toHaveLength(2);
    expect(collected.map((c) => c.account.label)).toEqual([
      "Fidelity Individual",
      "Schwab IRA",
    ]);
  });
});

describe("dedupAccountsByFreshest", () => {
  it("keeps the freshest copy of a duplicated account by generatedAt", () => {
    const collected = collectAccounts({
      accounts: [
        {
          account_info: { brokerage_name: "Fidelity", account_type: "IRA", account_number: "X1" },
          account_summary: { ending_value: 1000 },
          holdings: [{ symbol: "AAPL", quantity: 100, market_value: 900 }],
          generated_at: "2026-01-31T00:00:00Z",
        },
        {
          account_info: { brokerage_name: "Fidelity", account_type: "IRA", account_number: "X1" },
          account_summary: { ending_value: 1100 },
          holdings: [{ symbol: "AAPL", quantity: 110, market_value: 990 }],
          generated_at: "2026-02-28T00:00:00Z",
        },
      ],
    });
    const deduped = dedupAccountsByFreshest(collected);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.account.endingValue).toBe(1100);
    expect(deduped[0]!.account.generatedAt).toBe("2026-02-28T00:00:00Z");
  });

  it("keeps accounts with no identity key distinct", () => {
    const collected = collectAccounts({
      accounts: [
        { account_summary: { ending_value: 1 }, holdings: [] },
        { account_summary: { ending_value: 2 }, holdings: [] },
      ],
    });
    expect(dedupAccountsByFreshest(collected)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-financial-consolidation.test.ts`
Expected: FAIL — cannot resolve `@/lib/services/one-kyc-financial-consolidation` (module not found).

- [ ] **Step 3: Write the module skeleton with collection & dedup**

Create `hushh-webapp/lib/services/one-kyc-financial-consolidation.ts`:

```ts
"use client";

/**
 * Deterministic, client-side financial consolidation for the KYC approved-disclosure
 * draft. Runs BEFORE tokenization (zero-knowledge): the LLM never sees real numbers.
 * Reuses the tested per-security merge math from portfolio-normalize.
 */

type AnyRecord = Record<string, unknown>;

export type ConsolidatedAccount = {
  label: string | null;
  endingValue: number | null;
  cashBalance: number | null;
  generatedAt: string | null;
};

export type CollectedAccount = {
  account: ConsolidatedAccount;
  holdings: AnyRecord[];
  key: string;
};

export function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const negative = text.startsWith("(") && text.endsWith(")");
    const sanitized = text.replace(/[,$\s]/g, "").replace(/%/g, "").replace(/[()]/g, "");
    const parsed = Number(negative ? `-${sanitized}` : sanitized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text : null;
}

function recordField(record: AnyRecord | null, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return record[key];
    }
  }
  return undefined;
}

export function accountLabel(accountInfo: AnyRecord | null): string | null {
  if (!accountInfo) return null;
  const brokerage = toText(
    recordField(accountInfo, ["brokerage_name", "brokerage", "institution_name"])
  );
  const type = toText(recordField(accountInfo, ["account_type"]));
  if (brokerage && type) return `${brokerage} ${type}`;
  return brokerage || type || toText(recordField(accountInfo, ["account_holder", "holder_name"]));
}

export function collectAccounts(portfolio: AnyRecord): CollectedAccount[] {
  const rawAccounts =
    Array.isArray(portfolio.accounts) && portfolio.accounts.length
      ? portfolio.accounts.filter(isRecord)
      : [portfolio];

  return rawAccounts.map((acct) => {
    const info = isRecord(acct.account_info) ? acct.account_info : null;
    const summary = isRecord(acct.account_summary) ? acct.account_summary : null;
    const holdings = Array.isArray(acct.holdings) ? acct.holdings.filter(isRecord) : [];
    const label = accountLabel(info);
    const endingValue =
      toNumber(acct.total_value) ??
      toNumber(recordField(summary, ["ending_value", "total_value"]));
    const cashBalance =
      toNumber(acct.cash_balance) ?? toNumber(recordField(summary, ["cash_balance"]));
    const generatedAt = toText(
      acct.generated_at ?? acct.updated_at ?? (summary ? summary.generated_at : undefined)
    );
    const accountNumber = toText(recordField(info, ["account_number"]));
    const key = `${label ?? ""}|${accountNumber ?? ""}`;
    return {
      account: { label, endingValue, cashBalance, generatedAt },
      holdings,
      key,
    };
  });
}

export function dedupAccountsByFreshest(collected: CollectedAccount[]): CollectedAccount[] {
  const byKey = new Map<string, CollectedAccount>();
  collected.forEach((item, index) => {
    // An account with no label and no account number has no stable identity:
    // keep it distinct so we never merge two unrelated accounts.
    if (item.key.replace(/\|/g, "") === "") {
      byKey.set(`__unique_${index}`, item);
      return;
    }
    const existing = byKey.get(item.key);
    if (!existing) {
      byKey.set(item.key, item);
      return;
    }
    // ISO-8601 timestamps compare correctly as strings; freshest wins.
    const existingAt = existing.account.generatedAt ?? "";
    const incomingAt = item.account.generatedAt ?? "";
    if (incomingAt > existingAt) byKey.set(item.key, item);
  });
  return Array.from(byKey.values());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-financial-consolidation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-financial-consolidation.ts hushh-webapp/__tests__/services/one-kyc-financial-consolidation.test.ts
git commit -m "$(cat <<'EOF'
feat(03-05): KYC financial consolidation module — account collection + dedup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Consolidation math — merge, aggregates, allocation, reconciliation

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-financial-consolidation.ts`
- Test: `hushh-webapp/__tests__/services/one-kyc-financial-consolidation.test.ts`

**Interfaces:**
- Consumes: `collectAccounts`, `dedupAccountsByFreshest`, `toNumber`, `isRecord` (Task 1); `consolidateHoldingsBySymbol` from `@/lib/utils/portfolio-normalize`.
- Produces:
  - `type AllocationSlice = { bucket: string; pct: number }`
  - `type ConsolidatedPortfolio = { accounts: ConsolidatedAccount[]; holdings: Record<string, unknown>[]; totalValue: number | null; holdingsSum: number; cashBalance: number | null; netUnrealizedGainLoss: number | null; allocation: AllocationSlice[]; reconciliationMismatch: boolean }`
  - `function consolidateFinancialPortfolio(value: unknown): ConsolidatedPortfolio | null`

- [ ] **Step 1: Write the failing tests**

Append to `hushh-webapp/__tests__/services/one-kyc-financial-consolidation.test.ts`:

```ts
import { consolidateFinancialPortfolio } from "@/lib/services/one-kyc-financial-consolidation";

describe("consolidateFinancialPortfolio", () => {
  it("merges multiple lots of the same security into one position", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [
        { symbol: "AAPL", quantity: 100, market_value: 15000, cost_basis: 10000, unrealized_gain_loss: 5000 },
        { symbol: "AAPL", quantity: 50, market_value: 7500, cost_basis: 6000, unrealized_gain_loss: 1500 },
      ],
    });
    expect(result).not.toBeNull();
    const aapl = result!.holdings.find((h) => h.symbol === "AAPL")!;
    expect(Number(aapl.quantity)).toBe(150);
    expect(Number(aapl.market_value)).toBe(22500);
    expect(Number(aapl.unrealized_gain_loss)).toBe(6500);
    expect(result!.netUnrealizedGainLoss).toBe(6500);
  });

  it("merges the same security across accounts and sums per-account statement totals", () => {
    const result = consolidateFinancialPortfolio({
      accounts: [
        {
          account_info: { brokerage_name: "Fidelity", account_type: "Individual" },
          account_summary: { ending_value: 100000, cash_balance: 1000 },
          holdings: [{ symbol: "AAPL", quantity: 100, market_value: 15000 }],
        },
        {
          account_info: { brokerage_name: "Schwab", account_type: "IRA" },
          account_summary: { ending_value: 50000, cash_balance: 500 },
          holdings: [{ symbol: "AAPL", quantity: 200, market_value: 30000 }],
        },
      ],
    });
    expect(result!.accounts).toHaveLength(2);
    expect(result!.totalValue).toBe(150000); // statement-authoritative: 100000 + 50000
    expect(result!.cashBalance).toBe(1500);
    const aapl = result!.holdings.find((h) => h.symbol === "AAPL")!;
    expect(Number(aapl.quantity)).toBe(300);
    expect(Number(aapl.market_value)).toBe(45000);
  });

  it("prefers the statement total over the summed holdings (statement-authoritative)", () => {
    const result = consolidateFinancialPortfolio({
      account_summary: { ending_value: 500000 },
      holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100000 }],
    });
    expect(result!.totalValue).toBe(500000);
    expect(result!.holdingsSum).toBe(100000);
  });

  it("flags a reconciliation mismatch only when totals diverge beyond tolerance", () => {
    const mismatched = consolidateFinancialPortfolio({
      account_summary: { ending_value: 500000 },
      holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100000 }],
    });
    expect(mismatched!.reconciliationMismatch).toBe(true);

    const consistent = consolidateFinancialPortfolio({
      account_summary: { ending_value: 100000 },
      holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100000 }],
    });
    expect(consistent!.reconciliationMismatch).toBe(false);
  });

  it("uses asset_allocation from the data when present", () => {
    const result = consolidateFinancialPortfolio({
      asset_allocation: [
        { bucket: "equity", value: 80, pct: 80 },
        { bucket: "cash_equivalent", value: 20, pct: 20 },
      ],
      holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100 }],
    });
    expect(result!.allocation).toEqual([
      { bucket: "equity", pct: 80 },
      { bucket: "cash_equivalent", pct: 20 },
    ]);
  });

  it("computes allocation from holdings when asset_allocation is absent", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [
        { symbol: "AAPL", quantity: 1, market_value: 800, instrument_kind: "equity" },
        { symbol: "GOVT", quantity: 1, market_value: 200, instrument_kind: "fixed_income" },
      ],
    });
    const buckets = Object.fromEntries(result!.allocation.map((s) => [s.bucket, Math.round(s.pct)]));
    expect(buckets.equity).toBe(80);
    expect(buckets.fixed_income).toBe(20);
  });

  it("never drops a name-only holding (synthesizes a symbol from the name)", () => {
    const result = consolidateFinancialPortfolio({
      holdings: [
        { name: "US TREASURY 2.5% 2030", quantity: 1, market_value: 1000 },
      ],
    });
    expect(result!.holdings).toHaveLength(1);
    expect(Number(result!.holdings[0]!.market_value)).toBe(1000);
  });

  it("returns null for non-portfolio input", () => {
    expect(consolidateFinancialPortfolio("nope")).toBeNull();
    expect(consolidateFinancialPortfolio(123)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-financial-consolidation.test.ts`
Expected: FAIL — `consolidateFinancialPortfolio` is not exported.

- [ ] **Step 3: Implement the consolidation logic**

Add to the top of `hushh-webapp/lib/services/one-kyc-financial-consolidation.ts`, just under the `"use client";` line:

```ts
import { consolidateHoldingsBySymbol } from "@/lib/utils/portfolio-normalize";
```

Then append to the end of the module:

```ts
export type AllocationSlice = { bucket: string; pct: number };

export type ConsolidatedPortfolio = {
  accounts: ConsolidatedAccount[];
  holdings: AnyRecord[];
  totalValue: number | null;
  holdingsSum: number;
  cashBalance: number | null;
  netUnrealizedGainLoss: number | null;
  allocation: AllocationSlice[];
  reconciliationMismatch: boolean;
};

/**
 * Ensure every holding has a usable `symbol` so the per-symbol merge never drops a
 * position (D2: full disclosure). Name-only holdings (e.g. some bonds) get a stable
 * pseudo-symbol derived from the name; the name is preserved for display.
 */
function ensureSymbol(holding: AnyRecord): AnyRecord {
  const symbol = toText(holding.symbol ?? holding.ticker ?? holding.security_symbol);
  if (symbol) return holding;
  const name = toText(
    holding.name ?? holding.security_name ?? holding.instrument_name ?? holding.description
  );
  if (!name) return holding; // no identity at all — merge math will drop it (acceptable)
  return { ...holding, symbol: name.toUpperCase().slice(0, 40), name };
}

function sumNullable(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

function buildAllocation(
  portfolio: AnyRecord,
  holdings: AnyRecord[],
  holdingsSum: number
): AllocationSlice[] {
  const raw = Array.isArray(portfolio.asset_allocation)
    ? portfolio.asset_allocation.filter(isRecord)
    : [];
  if (raw.length) {
    return raw
      .map((slice) => ({
        bucket: toText(slice.bucket) ?? "other",
        pct: toNumber(slice.pct) ?? 0,
      }))
      .filter((slice) => slice.pct > 0);
  }
  if (!holdingsSum) return [];
  const buckets = new Map<string, number>();
  for (const holding of holdings) {
    const bucket =
      toText(holding.instrument_kind) ?? toText(holding.asset_type) ?? "other";
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + (toNumber(holding.market_value) ?? 0));
  }
  return Array.from(buckets.entries())
    .map(([bucket, value]) => ({ bucket, pct: (value / holdingsSum) * 100 }))
    .filter((slice) => slice.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function consolidateFinancialPortfolio(value: unknown): ConsolidatedPortfolio | null {
  const portfolio = Array.isArray(value)
    ? ({ holdings: value } as AnyRecord)
    : isRecord(value)
      ? value
      : null;
  if (!portfolio) return null;

  const collected = dedupAccountsByFreshest(collectAccounts(portfolio));
  const accounts = collected.map((entry) => entry.account);
  const rawHoldings = collected.flatMap((entry) => entry.holdings).map(ensureSymbol);
  const holdings = consolidateHoldingsBySymbol(rawHoldings) as AnyRecord[];

  const holdingsSum = holdings.reduce(
    (sum, holding) => sum + (toNumber(holding.market_value) ?? 0),
    0
  );

  const statementTotal = sumNullable(accounts.map((account) => account.endingValue));
  const portfolioTotal =
    toNumber(portfolio.total_value) ??
    toNumber(
      isRecord(portfolio.account_summary) ? portfolio.account_summary.ending_value : undefined
    );
  const totalValue =
    statementTotal ?? portfolioTotal ?? (holdings.length ? holdingsSum : null);

  const cashBalance =
    sumNullable(accounts.map((account) => account.cashBalance)) ??
    toNumber(portfolio.cash_balance);

  const netUnrealizedGainLoss = sumNullable(
    holdings.map((holding) => toNumber(holding.unrealized_gain_loss))
  );

  const allocation = buildAllocation(portfolio, holdings, holdingsSum);

  const tolerance = Math.max(1, Math.abs(totalValue ?? 0) * 0.01);
  const reconciliationMismatch =
    totalValue !== null &&
    holdings.length > 0 &&
    Math.abs(totalValue - holdingsSum) > tolerance;

  return {
    accounts,
    holdings,
    totalValue,
    holdingsSum,
    cashBalance,
    netUnrealizedGainLoss,
    allocation,
    reconciliationMismatch,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-financial-consolidation.test.ts`
Expected: PASS (all tests from Task 1 and Task 2).

- [ ] **Step 5: Typecheck**

Run: `cd hushh-webapp && npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-financial-consolidation.ts hushh-webapp/__tests__/services/one-kyc-financial-consolidation.test.ts
git commit -m "$(cat <<'EOF'
feat(03-05): consolidateFinancialPortfolio — merge, aggregates, allocation, reconciliation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire consolidation into `formatPortfolioApprovedValue`

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` (replace `formatPortfolioApprovedValue`, currently lines ~449-504)
- Test: `hushh-webapp/__tests__/services/one-kyc-client-zk-service.test.ts`

**Interfaces:**
- Consumes: `consolidateFinancialPortfolio`, `ConsolidatedPortfolio`, `AllocationSlice` (Task 2); existing `formatCurrencyValue`, `formatHoldingLine`, `formatApprovedValue`, `getRecordValue`, `truncate`, `isRecord` (already in the ZK service).
- Produces: an updated `formatPortfolioApprovedValue(value: unknown): string | null` emitting the same two-block `Portfolio summary` / `Holdings` string contract, now consolidated.

- [ ] **Step 1: Write the failing integration tests**

Append a new `describe` block to `hushh-webapp/__tests__/services/one-kyc-client-zk-service.test.ts` (reuse the existing `baseWorkflow`/`workflow` patterns already in that file; the snippet below shows the full self-contained test):

```ts
describe("KYC financial consolidation in buildDraft", () => {
  const consolidationWorkflow: OneKycWorkflow = {
    ...baseWorkflow,
    required_fields: ["portfolio"],
    requested_scope: "attr.financial.portfolio.*",
    subject: "Portfolio information",
    metadata: { account_holder_name: "Kushal Trivedi" },
  };

  it("combines repeated lots of the same security into one Holdings line", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: consolidationWorkflow,
      exportPayload: {
        financial: {
          portfolio: {
            account_summary: { ending_value: 22500 },
            holdings: [
              { symbol: "AAPL", quantity: 100, market_value: 15000, unrealized_gain_loss: 5000 },
              { symbol: "AAPL", quantity: 50, market_value: 7500, unrealized_gain_loss: 1500 },
            ],
          },
        },
      },
    });
    // One merged AAPL line: 150 shares, $22,500 value.
    const aaplLines = draft.body.split("\n").filter((line) => line.includes("AAPL"));
    expect(aaplLines).toHaveLength(1);
    expect(draft.body).toContain("AAPL: 150 shares; $22,500.00 value");
    expect(draft.body).toContain("- Net unrealized gain/loss: $6,500.00");
  });

  it("renders a per-account breakdown when holdings span multiple accounts", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: consolidationWorkflow,
      exportPayload: {
        financial: {
          portfolio: {
            accounts: [
              {
                account_info: { brokerage_name: "Fidelity", account_type: "Individual" },
                account_summary: { ending_value: 100000, cash_balance: 1000 },
                holdings: [{ symbol: "AAPL", quantity: 100, market_value: 15000 }],
              },
              {
                account_info: { brokerage_name: "Schwab", account_type: "IRA" },
                account_summary: { ending_value: 50000, cash_balance: 500 },
                holdings: [{ symbol: "AAPL", quantity: 200, market_value: 30000 }],
              },
            ],
          },
        },
      },
    });
    expect(draft.body).toContain("- Accounts: 2");
    expect(draft.body).toContain("- Total value: $150,000.00");
    expect(draft.body).toContain("- Fidelity Individual: $100,000.00");
    expect(draft.body).toContain("- Schwab IRA: $50,000.00");
    expect(draft.body).toContain("- Cash balance: $1,500.00");
    // AAPL merged across both accounts: 300 shares, $45,000.
    expect(draft.body).toContain("AAPL: 300 shares; $45,000.00 value");
  });

  it("adds a reconciliation note when the statement total diverges from the holdings sum", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: consolidationWorkflow,
      exportPayload: {
        financial: {
          portfolio: {
            account_summary: { ending_value: 500000 },
            holdings: [{ symbol: "AAPL", quantity: 1, market_value: 100000 }],
          },
        },
      },
    });
    expect(draft.body).toContain("Totals as reported on statements");
    expect(draft.body).toContain("$100,000.00");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.test.ts -t "consolidation"`
Expected: FAIL — current output has two AAPL lines / no `- Accounts:` / no reconciliation note.

- [ ] **Step 3: Add the consolidation import and allocation helper**

In `hushh-webapp/lib/services/one-kyc-client-zk-service.ts`, add to the import block near the top (after the existing renderer import around line 17):

```ts
import {
  consolidateFinancialPortfolio,
  type AllocationSlice,
} from "@/lib/services/one-kyc-financial-consolidation";
```

Add this helper directly above the existing `formatPortfolioApprovedValue` function (above line ~449):

```ts
function humanizeAllocationBucket(bucket: string): string {
  return bucket.replaceAll("_", " ");
}

function formatAllocationSummary(allocation: AllocationSlice[]): string | null {
  if (!allocation.length) return null;
  return allocation
    .map((slice) => `${Math.round(slice.pct)}% ${humanizeAllocationBucket(slice.bucket)}`)
    .join(", ");
}
```

- [ ] **Step 4: Replace `formatPortfolioApprovedValue`**

Replace the entire existing `formatPortfolioApprovedValue` function (currently lines ~449-504) with:

```ts
function formatPortfolioApprovedValue(value: unknown): string | null {
  const consolidated = consolidateFinancialPortfolio(value);
  if (!consolidated) return formatApprovedValue(value);

  const portfolio = Array.isArray(value) ? { holdings: value } : isRecord(value) ? value : {};
  const accountInfo = isRecord(portfolio.account_info)
    ? portfolio.account_info
    : isRecord(portfolio.accountInfo)
      ? portfolio.accountInfo
      : {};
  const accountSummary = isRecord(portfolio.account_summary) ? portfolio.account_summary : {};
  const multiAccount = consolidated.accounts.length > 1;

  const summaryLines: string[] = [];

  if (multiAccount) {
    summaryLines.push(`- Accounts: ${consolidated.accounts.length}`);
    const totalValue = formatCurrencyValue(consolidated.totalValue);
    if (totalValue) summaryLines.push(`- Total value: ${totalValue}`);
    for (const account of consolidated.accounts) {
      const label = account.label || "Account";
      const accountValue = formatCurrencyValue(account.endingValue);
      if (accountValue) summaryLines.push(`- ${label}: ${accountValue}`);
    }
    const cashBalance = formatCurrencyValue(consolidated.cashBalance);
    if (cashBalance) summaryLines.push(`- Cash balance: ${cashBalance}`);
  } else {
    // Single-account: preserve the existing rich statement summary verbatim.
    const holderName = truncate(
      getRecordValue(accountInfo, ["holder_name", "account_holder_name"]),
      120
    );
    const beginningValue = formatCurrencyValue(getRecordValue(accountSummary, ["beginning_value"]));
    const totalValue =
      formatCurrencyValue(consolidated.totalValue) ||
      formatCurrencyValue(getRecordValue(portfolio, ["total_value", "market_value"]));
    const cashBalance =
      formatCurrencyValue(consolidated.cashBalance) ||
      formatCurrencyValue(getRecordValue(accountSummary, ["cash_balance"]));
    const changeInValue = formatCurrencyValue(getRecordValue(accountSummary, ["change_in_value"]));
    const netDepositsWithdrawals = formatCurrencyValue(
      getRecordValue(accountSummary, ["net_deposits_withdrawals"])
    );
    const investmentGainLoss = formatCurrencyValue(
      getRecordValue(accountSummary, ["investment_gain_loss", "gain_loss", "change_in_value"])
    );
    const totalFees = formatCurrencyValue(getRecordValue(accountSummary, ["total_fees", "fees"]));
    const totalIncomePeriod = formatCurrencyValue(
      getRecordValue(accountSummary, ["total_income_period"])
    );
    const totalIncomeYtd = formatCurrencyValue(getRecordValue(accountSummary, ["total_income_ytd"]));

    if (holderName) summaryLines.push(`- Account name: ${holderName}`);
    if (beginningValue) summaryLines.push(`- Beginning value: ${beginningValue}`);
    if (totalValue) summaryLines.push(`- Total value: ${totalValue}`);
    if (cashBalance) summaryLines.push(`- Cash balance: ${cashBalance}`);
    if (changeInValue) summaryLines.push(`- Change in value: ${changeInValue}`);
    if (netDepositsWithdrawals) {
      summaryLines.push(`- Net deposits/withdrawals: ${netDepositsWithdrawals}`);
    }
    if (investmentGainLoss) summaryLines.push(`- Investment gain/loss: ${investmentGainLoss}`);
    if (totalFees) summaryLines.push(`- Fees: ${totalFees}`);
    if (totalIncomePeriod) summaryLines.push(`- Income this period: ${totalIncomePeriod}`);
    if (totalIncomeYtd) summaryLines.push(`- Income year to date: ${totalIncomeYtd}`);
  }

  // Shared aggregate lines (both single- and multi-account).
  const netUnrealized = formatCurrencyValue(consolidated.netUnrealizedGainLoss);
  if (netUnrealized) summaryLines.push(`- Net unrealized gain/loss: ${netUnrealized}`);
  const allocationSummary = formatAllocationSummary(consolidated.allocation);
  if (allocationSummary) summaryLines.push(`- Asset allocation: ${allocationSummary}`);

  const holdings = consolidated.holdings;
  if (holdings.length) summaryLines.push(`- Holdings: ${holdings.length}`);

  if (consolidated.reconciliationMismatch) {
    const holdingsTotal = formatCurrencyValue(consolidated.holdingsSum);
    if (holdingsTotal) {
      summaryLines.push(
        `- Totals as reported on statements; itemized holdings total ${holdingsTotal}.`
      );
    }
  }

  const holdingLines = holdings.map(formatHoldingLine).filter(Boolean);
  const sections: string[] = [];
  if (summaryLines.length) sections.push(["Portfolio summary", ...summaryLines].join("\n"));
  if (holdingLines.length) {
    sections.push(["Holdings", ...holdingLines.map((line) => `- ${line}`)].join("\n"));
  }
  if (sections.length) return sections.join("\n\n");
  return formatApprovedValue(portfolio);
}
```

- [ ] **Step 5: Run the new consolidation tests**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.test.ts -t "consolidation"`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full ZK-service test file (regression gate)**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.test.ts`
Expected: PASS — all pre-existing tests still green (the single-account fixture still produces `- Total value: $6,951,964.54`, `- Cash balance: -$2,569,053.37`, `- Holdings: 4`, `- AAPL: 1,879.4037 shares; $441,258.37 value`, etc., now with additive `- Net unrealized gain/loss` / `- Asset allocation` lines).

If any pre-existing assertion fails, do NOT weaken it — inspect the diff: the single-account branch must preserve every original label verbatim. Fix the implementation, not the test.

- [ ] **Step 7: Typecheck + lint**

Run: `cd hushh-webapp && npm run typecheck && npx eslint lib/services/one-kyc-client-zk-service.ts lib/services/one-kyc-financial-consolidation.ts __tests__/services/one-kyc-client-zk-service.test.ts --max-warnings=0`
Expected: exits 0, clean.

- [ ] **Step 8: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-client-zk-service.ts hushh-webapp/__tests__/services/one-kyc-client-zk-service.test.ts
git commit -m "$(cat <<'EOF'
feat(03-05): consolidate financial portfolio in KYC draft (merge, aggregates, multi-account)

formatPortfolioApprovedValue now consumes consolidateFinancialPortfolio:
per-security merge across lots/accounts, statement-authoritative totals,
net unrealized G/L + allocation header lines, per-account breakdown, and a
reconciliation note on mismatch. Single-account output preserved.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: ZK guardrails — redaction completeness, token integrity, golden snapshot

**Files:**
- Modify: `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts`
- Modify: `hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts`

**Interfaces:**
- Consumes: `OneKycClientZkService.buildDraft`, `redactDraftForLlm`, `resubstituteDraft`, `validateTokenIntegrity` (existing); `buildApprovedDisclosureHtml`, the render model from a consolidated `buildDraft` (existing).
- Produces: regression tests only — no new exports.

- [ ] **Step 1: Write the failing ZK redaction test**

Append to `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts`. Note this file mocks the PKM/service deps at module load (see its top), so `buildDraft` can run; import `OneKycClientZkService` and `OneKycWorkflow` at the top alongside the existing imports if not already present:

```ts
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

describe("consolidated portfolio redaction (ZK)", () => {
  const workflow = {
    id: "wf-zk-1",
    required_fields: ["portfolio"],
    requested_scope: "attr.financial.portfolio.*",
    subject: "Portfolio information",
    metadata: { account_holder_name: "Kushal Trivedi" },
  } as unknown as OneKycWorkflow;

  it("redacts every real figure in a multi-account consolidated portfolio", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload: {
        financial: {
          portfolio: {
            accounts: [
              {
                account_info: { brokerage_name: "Fidelity", account_type: "Individual" },
                account_summary: { ending_value: 100000, cash_balance: 1000 },
                holdings: [{ symbol: "AAPL", quantity: 100, market_value: 15000 }],
              },
              {
                account_info: { brokerage_name: "Schwab", account_type: "IRA" },
                account_summary: { ending_value: 50000, cash_balance: 500 },
                holdings: [{ symbol: "AAPL", quantity: 200, market_value: 30000 }],
              },
            ],
          },
        },
      },
    });

    const { tokenizedTemplate, tokenMap } = redactDraftForLlm({
      body: draft.body,
      approvedValues: draft.approvedValues,
    });

    // No real figure escapes: the consolidated values live inside the single
    // portfolio token, so none of them appear verbatim in the tokenized template.
    for (const figure of ["150,000", "100,000", "45,000", "30,000", "15,000"]) {
      expect(tokenizedTemplate).not.toContain(figure);
    }

    // Round-trip is exact and integrity holds.
    expect(validateTokenIntegrity(tokenizedTemplate, tokenizedTemplate, tokenMap)).toBe(true);
    expect(resubstituteDraft(tokenizedTemplate, tokenMap)).toBe(draft.body);
  });
});
```

- [ ] **Step 2: Run it to verify it passes (behavior already correct) or fails (leak)**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.redact.test.ts -t "consolidated portfolio redaction"`
Expected: PASS. (This locks the ZK guarantee for the new consolidated output. If it FAILS with a figure found in the template, that is a real leak — stop and fix `formatPortfolioApprovedValue`/extraction so the portfolio remains a single approved value/token before continuing.)

- [ ] **Step 3: Write the golden snapshot test for consolidated HTML**

Append to `hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts`. The renderer is the actual sent-email HTML; this locks it across the consolidation change. Use a render model shaped like a consolidated multi-account portfolio:

```ts
import { buildApprovedDisclosureHtml } from "@/lib/services/one-kyc-approved-disclosure-renderer";
import { APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID } from "@/lib/services/one-kyc-approved-disclosure-renderer";

it("renders a consolidated multi-account portfolio to stable themed HTML", () => {
  const html = buildApprovedDisclosureHtml({
    contractId: APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID,
    contractVersion: "1.0.0",
    accountHolder: "Kushal Trivedi",
    style: {
      compact: false,
      formal: false,
      bulletList: false,
      structured: false,
      table: false,
      fullDetail: false,
      human: false,
      cleanHeaders: false,
    },
    sections: [
      {
        scope: "attr.financial.portfolio.*",
        title: "Portfolio",
        entries: [
          {
            field: "portfolio",
            label: "portfolio",
            scope: "attr.financial.portfolio.*",
            value:
              "Portfolio summary\n- Accounts: 2\n- Total value: $150,000.00\n- Fidelity Individual: $100,000.00\n- Schwab IRA: $50,000.00\n- Cash balance: $1,500.00\n\nHoldings\n- AAPL: 300 shares; $45,000.00 value",
          },
        ],
        missingFields: [],
      },
    ],
    missingFields: [],
  });
  expect(html).toContain("<table");
  expect(html).toContain("Portfolio summary");
  expect(html).toContain("AAPL");
  expect(html).toMatchSnapshot();
});
```

- [ ] **Step 4: Run the renderer test to create the snapshot**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-approved-disclosure-renderer.test.ts`
Expected: PASS — new snapshot written to `__tests__/services/__snapshots__/one-kyc-approved-disclosure-renderer.test.ts.snap`; all pre-existing renderer tests (incl. the existing golden snapshot) still green.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts hushh-webapp/__tests__/services/__snapshots__/one-kyc-approved-disclosure-renderer.test.ts.snap
git commit -m "$(cat <<'EOF'
test(03-05): ZK redaction completeness + golden snapshot for consolidated portfolio

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full verification gate

**Files:** none (verification + final docs only).

**Interfaces:** none.

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd hushh-webapp && npx vitest run`
Expected: All tests pass, zero failures (the existing baseline was 1657 passed / 6 skipped; this plan adds tests and must not regress any).

- [ ] **Step 2: Typecheck the whole app**

Run: `cd hushh-webapp && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Lint all touched files**

Run:
```bash
cd hushh-webapp && npx eslint \
  lib/services/one-kyc-financial-consolidation.ts \
  lib/services/one-kyc-client-zk-service.ts \
  __tests__/services/one-kyc-financial-consolidation.test.ts \
  __tests__/services/one-kyc-client-zk-service.test.ts \
  __tests__/services/one-kyc-client-zk-service.redact.test.ts \
  __tests__/services/one-kyc-approved-disclosure-renderer.test.ts \
  --max-warnings=0
```
Expected: clean, exits 0.

- [ ] **Step 4: Confirm no backend file changed**

Run: `git diff --name-only main...HEAD -- consent-protocol/`
Expected: empty output (ZK backend untouched; `draft_body` contract preserved).

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

If steps 1-3 required fixups, commit them:
```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(03-05): verification fixups for KYC financial consolidation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
If no fixups were needed, skip this step.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- D1 tiered output → Task 3 summary header (totals, cash, net G/L, allocation) + Holdings block. ✓
- D2 dedup-only, no drop → Task 2 `ensureSymbol` (name-only never dropped) + merge-by-symbol; no trimming added. ✓
- D3 multi-account merge + per-account summary → Task 2 `collectAccounts`/merge across accounts; Task 3 multi-account branch (`- Accounts:`, per-account lines). ✓
- D4 statement-authoritative + freshest + flag-on-mismatch → Task 2 `statementTotal` precedence, `dedupAccountsByFreshest`, `reconciliationMismatch`; Task 3 reconciliation note. ✓
- ZK (deterministic, pre-tokenization; single token; completeness) → Task 4 redaction test. ✓
- Pipeline intact / renderer unchanged → only `formatPortfolioApprovedValue` modified; renderer parses the same string contract; Task 4 golden snapshot. ✓
- Backend untouched → Task 5 Step 4 assertion. ✓
- Reuse `consolidateHoldingsBySymbol` verbatim → Task 2 import. ✓
- Tolerance `max($1, 1%)` → Task 2. ✓
- Tests (multi-lot, multi-account, statement-vs-computed, recon threshold, cash, allocation data-vs-computed, no-drop, single-account backward-compat, ZK round-trip, golden snapshot) → Tasks 2-4. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type consistency:** `ConsolidatedAccount`, `CollectedAccount`, `AllocationSlice`, `ConsolidatedPortfolio`, `consolidateFinancialPortfolio`, `collectAccounts`, `dedupAccountsByFreshest`, `toNumber`, `toText`, `isRecord`, `accountLabel` defined in Tasks 1-2 and used consistently in Task 3. ✓
