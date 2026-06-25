# KYC Financial Consolidation Layer — Design

**Date:** 2026-06-25
**Phase:** 03 — KYC Redraft Intelligence (follow-on)
**Branch:** `feature/agent-kyc-enhancement`
**Status:** Approved — ready for implementation plan

## Problem

The KYC agent drafts an approved-disclosure email from decrypted PKM data. For the
financial domain it **lists raw, fragmented entries**: the path
`buildDraft → extractApprovedValues → formatPortfolioApprovedValue → formatHoldingLine`
emits one line per holding with **zero consolidation, aggregation, dedup, or trimming**.
Multiple lots of the same security, holdings spread across accounts, cash scattered
across accounts, and low-signal noise all pass through verbatim. The result is an
exhaustive, fragmented dump rather than a meaningful KYC disclosure.

Consolidation math already exists in the codebase — `consolidateHoldingsBySymbol()` /
`mergeHoldingsBySymbol()` in `hushh-webapp/lib/utils/portfolio-normalize.ts` (and a
backend `_aggregate_holdings_by_symbol`) — but it is invoked only in the Kai portfolio
flows and brokerage sources, **never in the KYC path**. The KYC draft consumes
`portfolio.holdings` raw.

## Goal

A **deterministic, client-side financial-normalization layer** that consolidates,
de-duplicates, aggregates, and de-noises PKM financial data into a *tiered* KYC
disclosure — a complete aggregate header plus a deduped, full-detail holdings table
merged across accounts — running **before tokenization** and emitting the **same
string contract** the renderer already parses, so the existing render → redact →
rewrite → re-fill pipeline is preserved.

## Hard constraints (must not break)

1. **Zero-knowledge.** Real PII/financial values never leave the browser. The LLM
   redraft path tokenizes every value to `{{F0}}…` before anything is sent, so the LLM
   sees only placeholders + prose and **cannot do arithmetic on real numbers**.
   Therefore all numeric consolidation (summing quantities, totaling values, blending
   cost basis, netting unrealized gain/loss) **must be deterministic and client-side,
   before tokenization**. The LLM is only for prose/structure polish.
2. **Pipeline intact.** Keep `buildDraft → render model → buildApprovedDisclosureHtml /
   renderLlmRedraftHtml`, and `redact → rewrite → re-fill`, contract-unchanged.
3. **Backend ZK unchanged.** No real financial values rendered/persisted on the
   backend; `draft_body` stays `NULL`. Consolidation is purely client-side.

## Decisions (converged with stakeholder)

- **D1 — Output shape: tiered.** A summary header with *complete, exact* aggregates
  (total value, cash, net unrealized gain/loss, asset-class allocation %, position and
  account counts) followed by a consolidated/deduped Holdings table.
- **D2 — Trim policy: dedup-only, full disclosure.** Merge lots and accounts per
  security and remove noise (duplicates, internal-only fields, zero/empty entries), but
  **list every distinct position**. No position is ever silently dropped. Further
  shortening happens only when the user explicitly asks, via the existing
  `compact` / `fullDetail` style flags. Aggregate header totals are always complete and
  exact regardless of any trimming.
- **D3 — Multi-account: merge per security + per-account summary line.** One
  consolidated Holdings table merges each security across all accounts (summing
  qty/value/gain-loss). Account structure is preserved in the header as a short
  per-account total-value summary plus an account count. Single-account data (the real
  data today) renders as it does now — backward-safe.
- **D4 — Data trust: statement-authoritative + freshest, flag only on mismatch.**
  For account/portfolio **totals**, trust the statement's own `account_summary`
  (e.g. `ending_value`) over a recomputed sum. Per-security, merge lots and sum. For
  exact-duplicate payloads/accounts, keep the freshest by `generated_at` / `updated_at`.
  Only when a statement total and the summed holdings disagree beyond a tolerance, add a
  small neutral note ("Totals as reported on statements; itemized holdings sum to
  {{Fx}}.").

## Architecture

### Placement

A new module `hushh-webapp/lib/services/one-kyc-financial-consolidation.ts`, invoked
from `formatPortfolioApprovedValue` / `formatFinancialApprovedValue` in
`hushh-webapp/lib/services/one-kyc-client-zk-service.ts`. Everything downstream
(`buildDraft`, `redactDraftForLlm`, the renderer) is untouched in contract.

### Deterministic vs LLM split (ZK-critical)

All numeric work is client-side and deterministic, completed **before**
`redactDraftForLlm`. The portfolio is already tokenized as **one opaque block**
(`approvedValues["portfolio"]` is the entire formatted string, replaced by a single
`{{Fn}}` token), so individual figures are never exposed and the LLM can only
reposition / re-prose the block. This layer changes only *what is inside* that block,
deterministically.

### Components

**(a) Reuse — per-security merge.** `consolidateHoldingsBySymbol()` from
`lib/utils/portfolio-normalize.ts`, used verbatim (no fork). It sums
quantity / market_value / cost_basis / unrealized_gain_loss / estimated_annual_income
across lots and accounts, recomputes blended `price = market_value / quantity`,
`unrealized_gain_loss_pct`, and `est_yield`, and maps cash-equivalents → `CASH`.
Internal-only fields are filtered later by the KYC layer's existing
`shouldDisplayApprovedKey` / `INTERNAL_APPROVED_VALUE_KEYS`, so reuse is clean.

**(b) New — account collector.** Walk the payload(s). The canonical V2 portfolio is
single-account, but `buildDraft` can receive multiple `exportPayloads`. For each
account capture `{ label (from account_info brokerage/type), endingValue
(account_summary.ending_value / total_value), cashBalance, generatedAt }` plus its raw
holdings. Dedup exact-duplicate accounts, keeping the freshest by
`generated_at` / `updated_at` (D4).

**(c) New — aggregate builder.** Produce the header facts:
- **Total value** = sum of per-account *statement* totals (statement-authoritative);
  fall back to summed holdings when absent.
- **Cash** = sum of account cash balances (or `CASH` holdings).
- **Net unrealized gain/loss** = sum across consolidated holdings.
- **Asset allocation %** = from `asset_allocation` if present, else computed from
  holdings by `instrument_kind`.
- **Per-account total-value lines** + account count.
- **Reconciliation note** (D4): only when
  `|statementTotal − holdingsSum| > tolerance`, append a neutral line.

**(d) Enhanced — string emitter.** `formatPortfolioApprovedValue` emits the existing
two-block contract, now fed consolidated data: a `Portfolio summary` block (aggregate
header + per-account lines) and a `Holdings` block (one `formatHoldingLine` per *merged*
security). The renderer's existing `parseDraftHoldingRow` / `blockToRenderBlocks` already
turns the `Holdings` block into the table — **no renderer change needed**.

### Data flow

```
decryptScopedExport → [exportPayloads]
  → collectAccounts()              (new: per-account totals + raw holdings, freshest-wins)
  → consolidateHoldingsBySymbol()  (reused: merge per security across accounts)
  → buildAggregateHeader()         (new: totals, cash, net G/L, allocation,
                                          per-account lines, reconciliation note)
  → formatPortfolioApprovedValue() (enhanced: same two-block string contract)
  → approvedValues["portfolio"] = consolidated string        ← single token
  → buildDraft → renderModel → renderer                      (UNCHANGED)
  → redactDraftForLlm → LLM → re-fill                        (UNCHANGED)
```

## Edge cases & rules

- **Single account (today's real data):** one account → no per-account breakdown noise,
  no reconciliation note unless a mismatch occurs. Output ≈ today, but deduped and
  summarized. Backward-safe.
- **Empty / zero / null holdings:** dropped (noise trim). A zero-value duplicate never
  produces a line.
- **Non-mergeable scalar conflict** (same symbol, different `name`): freshest wins for
  the label; numerics still sum.
- **Cash:** aggregated into the header cash figure *and* shown as the existing
  `Cash: $…` row.
- **Mixed asset types** (bonds / options / crypto / `other`): merged by symbol like
  equities; `asset_type` / `instrument_kind` carried into the table's Type column. No
  per-type sectioning (YAGNI — revisit if needed).
- **Trim (D2):** dedup-only by default; the existing `compact` / `fullDetail` flags
  remain the only further shortening. No position is silently dropped.

## Discretionary calls (flagged, can be flipped)

- **Reconciliation tolerance:** `max($1, 1% of total)`.
- **No per-asset-type sectioning** — equities/bonds/crypto share one consolidated table
  with a Type column.
- **Reuse `consolidateHoldingsBySymbol` verbatim** (no fork); add only the
  account-attribution + header layer around it.

## Testing

- **Unit (vitest), the consolidation module:** multi-lot merge math; multi-account merge
  + per-account totals; statement-authoritative total vs computed; reconciliation-note
  threshold (fires / does not fire); cash aggregation; freshest-wins dedup; allocation
  from data vs computed; zero/empty trimming; single-account backward-compat.
- **Integration:** `buildDraft` with a fragmented multi-lot / multi-account payload →
  assert consolidated `approvedValues`, correct missing-fields, stable `draftHash`.
- **ZK guardrails (extend `one-kyc-client-zk-service.redact.test.ts`):** redaction
  completeness still holds (no real figure escapes the single portfolio token); token
  integrity round-trips; **golden snapshot** of `buildApprovedDisclosureHtml` on a
  consolidated portfolio to lock the sent-email HTML.
- **Backend:** no change — `draft_body` stays NULL; consolidation is purely client-side.
  Existing `consent-protocol/tests/services/test_one_email_kyc_service_llm.py` stays
  green.

## What does not change

`buildDraft` signature; `redactDraftForLlm` / `resubstituteDraft` /
`validateTokenIntegrity`; `splitDraftTemplate` / `reassembleDraftTemplate`; the entire
renderer; the backend proxy; manifest / scopes. This work is additive and contained.

## Canonical references

- `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` — `buildDraft` (~1350),
  `extractApprovedValues` (~742), `formatPortfolioApprovedValue` (~449),
  `formatHoldingLine` (~317), `formatFinancialApprovedValue` (~571),
  `keyLooksFinancialAmount` (~281), `formatCurrencyValue` (~232), redaction primitives
  `redactDraftForLlm` (~1487) / `resubstituteDraft` / `validateTokenIntegrity`.
- `hushh-webapp/lib/utils/portfolio-normalize.ts` — `consolidateHoldingsBySymbol` (187),
  `mergeHoldingsBySymbol` (51), `normalizeHoldings` (141), `normalizeStoredPortfolio`
  (198).
- `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` —
  `parseDraftHoldingRow` (~361), `blockToRenderBlocks` (~398),
  `buildApprovedDisclosureHtml` / `buildApprovedDisclosurePlainText`,
  `ApprovedDisclosureRenderModel` / `RenderSection` / `RenderFact`.
- Data shapes: `consent-protocol/hushh_mcp/kai_import/normalize_v2.py`
  (`build_financial_portfolio_canonical_v2`, `build_financial_analytics_v2`);
  `hushh-webapp/__tests__/services/one-kyc-client-zk-service.test.ts` (portfolio
  fixture, holding record shape).
- Phase context: `.planning/phases/03-kyc-redraft-intelligence/03-CONTEXT.md`.
