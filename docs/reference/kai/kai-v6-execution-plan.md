# Kai V6 Execution Plan (Accuracy-First, Real-Data-Only)


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Objective
Deliver a production-grade Kai experience where dashboard, analysis, and optimization are strictly based on validated realtime + filing-backed evidence, with no speculative fallback in decision-critical flows.

## Principles
- Real data only for recommendations and portfolio actions.
- Fail closed for missing decision-critical signals.
- Deterministic preprocessing before LLM synthesis.
- Every KPI rendered in UI must have provenance and freshness metadata.
- UX stays responsive via staged streaming, progressive rendering, and caching.

## Scope
- Backend: portfolio parsing, realtime fetchers, agent orchestration, optimize engine.
- Frontend: import stream surface, dashboard contracts, richer charting, explainability.
- Data ops: brokerage corpus benchmarking, SEC payload normalization, regression suites.
- Compliance: ADK/A2A parity and route-level contract verification.

## Phase 1: Baseline and Benchmarking
1. Expand parser benchmark to full `data/brokerage_statements/*`.
2. Run `consent-protocol/scripts/eval_portfolio_stream_quality.py` on full corpus.
3. Produce baseline metrics:
   - placeholder rows
   - invalid numeric tuples
   - post-validation holdings count
   - aggregate confidence
4. Create pass/fail report artifact in CI and keep latest report in build artifacts.

## Phase 2: Data Provider Reliability and Provenance
1. Keep provider priority:
   - Market/quotes: `Finnhub -> PMP/FMP -> yfinance -> Yahoo`
   - News: `Finnhub -> PMP/FMP -> NewsAPI -> Google RSS`
2. Attach provider metadata on every realtime payload:
   - `source`, `fetched_at`, `ttl_seconds`, `is_stale`
3. Enforce hard-fail in analysis/optimize when required realtime dependency fails.
4. Add provider outage simulation tests and expected error code checks.

## Phase 3: Portfolio Parsing Quality Hardening
1. Keep strict parser stages:
   - normalize rows
   - filter non-holdings
   - validate numeric consistency
   - aggregate by symbol
   - quality report
2. Reject false positives:
   - synthetic placeholders (`HOLDING_*`)
   - account header/profile rows
   - unknown identity + invalid tuples
3. Emit stream quality counters and dropped-reason summary.
4. Preserve per-holding confidence + provenance through API and frontend state.

## Phase 4: SEC Feature Enrichment
1. Extract top-10 SEC payloads and refresh periodically.
2. Normalize to compact features via `scripts/extract_sec_features.py`.
3. Feed derived features to analysis context:
   - trend stability
   - cash-flow quality
   - leverage profile
   - R&D intensity
4. Keep runtime separate from offline heavy extraction jobs.

## Phase 5: Agent and Decision Robustness
1. Standardize agent input packet:
   - SEC fundamentals
   - realtime quote snapshot
   - realtime sentiment set
   - Renaissance screening context
   - user risk profile
2. Require evidence references in debate outputs.
3. Add schema-level checks so unsupported claims fail validation before UI render.
4. Keep dissenting viewpoints with confidence weighting and source traceability.

## Phase 6: Optimize Engine (Deterministic First, LLM Second)
1. Deterministic front-pass:
   - eligibility
   - policy constraints
   - exposure and concentration checks
   - candidate ranking
2. LLM layer only synthesizes explainability for deterministic outputs.
3. Remove threshold-specific copy from UX.
4. Return structured actions with:
   - expected impact
   - risk delta
   - constraints triggered
   - confidence/provenance tags

## Phase 7: Frontend Dashboard and UX Enrichment
1. Keep one canonical dashboard contract from backend snapshot.
2. Render only validated data-backed sections.
3. Add richer charts with Recharts (through centralized component system):
   - allocation
   - concentration
   - sector exposure
   - realized/unrealized split
   - confidence/completeness score
4. Keep import stream cohesive:
   - stage timeline
   - reasoning summary
   - token transcript
   - holdings preview blocks

## Phase 8: Caching and Performance
1. Keep memory-first deterministic cache coherence.
2. Cache read-through for stable snapshots with strict invalidation on mutations.
3. Warm cache on unlock/sync bridge where safe.
4. Track p50/p95 for:
   - import parsing latency
   - analysis generation
   - optimize generation

## Phase 9: Compliance and Quality Gates
1. Enforce ADK/A2A checks via `verify_adk_a2a_compliance.py`.
2. Keep parser benchmark gates:
   - no placeholders
   - no header rows as holdings
   - no impossible numeric rows
3. Keep hard-fail contract for realtime dependency errors.
4. CI gate commands:
   - backend tests + benchmark
   - frontend typecheck/tests/build
   - route/parity/design-system checks

## Phase 10: Rollout
1. Dev: full corpus + provider fallback tests + UI contract tests.
2. Staging: shadow verification with real statements and compare outputs.
3. Prod canary: gradual rollout with telemetry dashboards.
4. Promotion criteria:
   - benchmark pass rate stable
   - no fail-open recommendation incidents
   - latency within accuracy-first SLA target

## Deliverables
- Stable provider fallback and provenance-backed realtime fetches.
- Parser quality gates + corpus benchmark artifacts.
- Rich, data-bound dashboard + confidence-aware charts.
- Deterministic optimize proposals with explainable outputs.
- ADK/A2A compliance verification integrated into release checks.

## Immediate Next Sprint Tasks
1. Run full brokerage corpus benchmark and publish baseline report.
2. Add runtime telemetry for realtime dependency failures and staleness rates.
3. Wire remaining frontend chart panels to canonical snapshot contract.
4. Complete optimize explainability payload schema and UI rendering.
