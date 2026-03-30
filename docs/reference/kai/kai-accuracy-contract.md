# Kai Accuracy Contract (v6.0)


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document defines production behavior for Kai analysis/import surfaces.

## Non-Negotiables
- Real data only for portfolio decisions and recommendations.
- No mock fallback on decision-critical paths.
- Fail closed when required realtime dependencies are missing on deterministic decision-critical paths.
- Every dashboard KPI must map to explicit provenance.

## Realtime Provider Matrix
- Quotes/market snapshot: `Finnhub` -> `PMP/FMP` -> `yfinance` -> Yahoo quote fallback.
- News sentiment: `Finnhub` -> `PMP/FMP` -> NewsAPI -> Google News RSS.
- SEC fundamentals: SEC EDGAR `companyfacts` and filings.
- Renaissance policy context: Supabase `renaissance_*` tables.

## Fail-Closed Policy
- Deterministic optimize/dependency-critical paths return `REALTIME_DATA_UNAVAILABLE` when required sources fail.
- Analyze stream may complete in explicit degraded mode for partial failures, but must emit:
  - `analysis_degraded=true`
  - `degraded_agents=[...]`
  - non-empty `short_recommendation`
- No speculative recommendation should be emitted without explicit degraded markers.
- Client should render actionable retry messaging and avoid overstating confidence.

## Portfolio Parser Quality Gates
- `placeholder_symbol_count == 0`
- `account_header_row_count == 0`
- `zero_qty_zero_price_nonzero_value_count == 0`
- `aggregated_holdings_count > 0` for benchmark corpus docs
- No retained row with empty `symbol` and unknown `name`
- Benchmark default scope is statement-candidate PDFs; guide/how-to PDFs are optional (`--include-non-statements`).

## Stream Contract Signals
`/api/kai/portfolio/import/stream` includes:
- `holdings_raw_count`
- `holdings_validated_count`
- `holdings_aggregated_count`
- `holdings_dropped_reasons`
- per-holding `confidence` and `provenance`

`/api/kai/analyze/stream` terminal decision includes:
- `short_recommendation`
- `analysis_degraded`
- `degraded_agents`
- `stream_id`
- `llm_calls_count`
- `provider_calls_count`
- `retry_counts`
- `analysis_mode`

## Dashboard Rendering Contract
- Render only validated holdings from `portfolio_data_v2.holdings`.
- Surface parser confidence and statement provenance in UI.
- Never display static/mock financial claims in production mode.

## Benchmark and Compliance Commands
```bash
# Full v6 suite (benchmark + ADK/A2A checks + contract tests)
python consent-protocol/scripts/run_kai_accuracy_suite.py

# Fast local sanity run (limits benchmark corpus to first N docs)
python consent-protocol/scripts/run_kai_accuracy_suite.py --benchmark-limit 1 --no-fail-benchmark

# Portfolio parser corpus benchmark (offline QA)
python consent-protocol/scripts/eval_portfolio_stream_quality.py

# SEC payload extraction and normalization (offline)
python scripts/dump_sec_payloads.py
python scripts/extract_sec_features.py

# ADK + Google A2A static compliance checks
python consent-protocol/scripts/verify_adk_a2a_compliance.py
```
