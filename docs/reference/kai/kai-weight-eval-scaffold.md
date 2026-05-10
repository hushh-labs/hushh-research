# Kai Weight Eval Scaffold (Offline-Only)

This document captures the first safe scaffold for Kai learning without mutating live runtime behavior.

## What is implemented

1. Shared eval contracts for promotion governance:
- `EvalRun`
- `EvalCase`
- `EvalKPIBundle`
- `EvalGateResult`
- `PromotionDecision`
- `RollbackRecord`

File:
- `consent-protocol/hushh_mcp/services/eval_contracts.py`

2. Kai weight evaluator service (offline-only candidate runs):
- builds candidate eval runs from expected vs observed outcomes
- loads canonical decision receipts from PKM `decision_projection` events
- compares later outcomes offline (`run_weight_eval_from_pkm`)
- supports provider-driven auto outcome derivation (`run_weight_eval_with_outcome_provider`)
- evaluates promotion gates (`accuracy`, `safety_regression`, `latency`)
- computes deterministic debate attribution (weighted contributions + Renaissance shift)
- persists candidate/promotion audit artifacts using existing PKM mutation-event rails
- exposes read-only artifact retrieval via `fetch_recent_weight_eval_artifacts`
- does **not** write or mutate live `AGENT_WEIGHTS`

File:
- `consent-protocol/hushh_mcp/services/kai_weight_eval_service.py`

2a. PKM artifact retrieval support:
- reads only Kai weight-eval projection types from `pkm_events`:
  - `kai_weight_eval_v1`
  - `kai_weight_eval_promotion_v1`

File:
- `consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py`

2b. Read-only observability route:
- `GET /api/kai/weight-eval/artifacts`
- requires VAULT_OWNER auth and user-id match
- returns runs, promotions, and artifact count for a user

Files:
- `consent-protocol/api/routes/kai/weight_eval.py`
- `consent-protocol/api/routes/kai/__init__.py`

3. Focused tests for behavior contract:
- candidate runs remain `status="candidate"`
- safety regression blocks promotion
- attribution contract includes normalized contribution percentages
- provider-driven end-to-end path derives outcomes from receipts before evaluation

File:
- `consent-protocol/tests/services/test_kai_weight_eval_service.py`

4. Local regression runner:
- reproducible script entrypoint for local/offline weight-eval execution from PKM receipts

File:
- `consent-protocol/scripts/local_kai_weight_eval_regression.py`

## Safety boundaries enforced

- Offline-only: no live path mutation.
- Candidate-only: promotion is a separate governed decision.
- Explicit gates: no implicit/automatic activation.
- Attribution is deterministic and auditable.
- Audit persistence uses existing `decision_projection` event rails with `projection_type` tags:
  - `kai_weight_eval_v1`
  - `kai_weight_eval_promotion_v1`

## Why this is the right first step

- Aligns with fail-closed governance and "evaluate before promote."
- Creates a shared contract surface that can be reused by PKM lab and Kai evaluation.
- Adds explainability primitives (attribution) without changing the production decision path.

## Next steps (small PR sequence)

1. Integrate with `PKMAgentLabService` phase runner so PKM + Kai share one eval control plane.
2. Add time-window price outcome adapters for scheduled offline re-evaluation runs.
3. Wire production market-data-backed provider implementation (beyond the test provider).
4. Add operator-facing dashboards/alerts for gate drift and artifact freshness.
