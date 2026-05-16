import logging

import pytest

from hushh_mcp.services.kai_weight_eval_service import KaiWeightEvalService

logger = logging.getLogger(__name__)


class _FakePkmService:
    def __init__(self):
        self.recorded = []
        self.artifacts = []

    async def get_recent_decision_records(self, *, user_id: str, limit: int = 100):
        assert user_id == "user_1"
        assert limit >= 3
        return [
            {
                "decision_id": "d1",
                "ticker": "AAPL",
                "decision": "buy",
                "confidence": 0.71,
                "risk_profile": "balanced",
                "dissenting_opinions": ["valuation stretched"],
                "metadata": {
                    "all_sources": ["financial.sec", "financial.news"],
                    "market_context": {"volatility_regime": "medium"},
                },
            }
        ]

    async def record_mutation_event(self, **kwargs):
        self.recorded.append(kwargs)
        projection_type = (
            kwargs.get("metadata", {}).get("projection_type")
            if isinstance(kwargs.get("metadata"), dict)
            else None
        )
        if projection_type in {"kai_weight_eval_v1", "kai_weight_eval_promotion_v1"}:
            self.artifacts.append(
                {
                    "projection_type": projection_type,
                    "created_at": "2026-05-10T00:00:00Z",
                    "payload": kwargs["metadata"],
                }
            )
        return True

    async def get_recent_kai_weight_eval_artifacts(self, *, user_id: str, limit: int = 50):
        assert user_id == "user_1"
        return self.artifacts[:limit]


class _FakeOutcomeProvider:
    async def get_realized_outcomes(self, *, receipts, horizon_days: int):
        assert horizon_days == 7
        assert isinstance(receipts, list)
        assert receipts and receipts[0]["decision_id"] == "d1"
        return [
            {
                "decision_id": "d1",
                "ticker": "AAPL",
                "realized_return": 0.05,
                "observed_confidence": 0.8,
                "eval_latency_ms": 95,
            }
        ]


@pytest.mark.parametrize(
    "realized_return,expected",
    [
        (0.05, "buy"),
        (0.03, "buy"),
        (0.0, "hold"),
        (-0.01, "hold"),
        (-0.03, "reduce"),
        (-0.08, "reduce"),
    ],
)
def test_decision_from_return_thresholds(realized_return, expected):
    assert KaiWeightEvalService._decision_from_return(realized_return) == expected


@pytest.mark.asyncio
async def test_build_candidate_run_is_offline_candidate_only():
    service = KaiWeightEvalService()
    run = await service.build_candidate_run(
        run_id="run_1",
        model_version="gemini-shadow-v1",
        prompt_set_version="fresh_random_120@v1",
        expected_vs_observed=[
            {
                "case_id": "c1",
                "expected_decision": "buy",
                "observed_decision": "buy",
                "observed_confidence": 0.72,
                "latency_ms": 320,
            },
            {
                "case_id": "c2",
                "expected_decision": "hold",
                "observed_decision": "reduce",
                "observed_confidence": 0.61,
                "latency_ms": 510,
            },
        ],
    )

    assert run.status == "candidate"
    assert "offline_only" in run.notes
    assert "no_live_weight_mutation" in run.notes
    assert len(run.cases) == 2
    assert run.kpis.accuracy_delta == 0.5


@pytest.mark.asyncio
async def test_build_candidate_run_empty_input_has_explicit_empty_note(caplog):
    service = KaiWeightEvalService()
    with caplog.at_level("INFO"):
        run = await service.build_candidate_run(
            run_id="run_empty",
            model_version="m",
            prompt_set_version="p",
            expected_vs_observed=[],
        )
    assert run.notes == ["empty_eval_set"]
    assert "kai_weight_eval.build_candidate_run.empty run_id=run_empty" in caplog.text


@pytest.mark.asyncio
async def test_evaluate_promotion_fails_when_safety_regresses():
    service = KaiWeightEvalService()
    run = await service.build_candidate_run(
        run_id="run_2",
        model_version="gemini-shadow-v1",
        prompt_set_version="fresh_chain_60@v1",
        expected_vs_observed=[
            {
                "case_id": "c1",
                "expected_decision": "buy",
                "observed_decision": "buy",
                "observed_confidence": 0.80,
                "latency_ms": 280,
            }
        ],
        metadata={"safety_regression": 0.05},
    )

    decision = service.evaluate_promotion(run=run, approved_by="governor@hushh")
    assert decision.approved is False
    assert decision.reason == "gates_failed"
    assert any(g.gate_name == "safety_regression" and not g.passed for g in run.gate_results)


@pytest.mark.asyncio
async def test_evaluate_promotion_logs_gate_summary(caplog):
    service = KaiWeightEvalService()
    run = await service.build_candidate_run(
        run_id="run_log",
        model_version="m",
        prompt_set_version="p",
        expected_vs_observed=[
            {"expected_decision": "buy", "observed_decision": "buy", "latency_ms": 100}
        ],
    )
    with caplog.at_level("INFO"):
        _ = service.evaluate_promotion(run=run, approved_by="governor@hushh")
    assert "kai_weight_eval.evaluate_promotion run_id=run_log approved=True" in caplog.text


def test_build_debate_attribution_includes_overlay_and_contributions():
    service = KaiWeightEvalService()
    result = service.build_debate_attribution(
        risk_profile="balanced",
        agent_confidences={"fundamental": 0.8, "sentiment": 0.6, "valuation": 0.7},
        renaissance_shift=0.1,
    )

    assert result["risk_profile"] == "balanced"
    assert result["renaissance_shift"] == 0.1
    assert result["attribution_contract_version"] == 1
    total = sum(result["contribution_percent"].values())
    assert abs(total - 1.0) < 1e-9


@pytest.mark.asyncio
async def test_run_weight_eval_from_pkm_persists_candidate_event():
    fake = _FakePkmService()
    service = KaiWeightEvalService(pkm_service=fake)

    run = await service.run_weight_eval_from_pkm(
        user_id="user_1",
        run_id="run_pkm_1",
        model_version="shadow-v1",
        prompt_set_version="fresh_chain_60@v1",
        outcomes=[
            {
                "decision_id": "d1",
                "ticker": "AAPL",
                "realized_return": 0.06,
                "observed_confidence": 0.77,
                "eval_latency_ms": 120,
            }
        ],
    )

    assert run.status == "candidate"
    assert len(run.cases) == 1
    assert fake.recorded
    assert fake.recorded[0]["operation_type"] == "decision_projection"
    assert fake.recorded[0]["metadata"]["projection_type"] == "kai_weight_eval_v1"


@pytest.mark.asyncio
async def test_run_weight_eval_from_pkm_skips_unmatched_outcome_and_logs_warning(caplog):
    fake = _FakePkmService()
    service = KaiWeightEvalService(pkm_service=fake)

    with caplog.at_level("WARNING"):
        run = await service.run_weight_eval_from_pkm(
            user_id="user_1",
            run_id="run_unmatched",
            model_version="shadow-v1",
            prompt_set_version="p-set",
            outcomes=[{"decision_id": "missing", "ticker": "MSFT", "realized_return": 0.02}],
        )

    assert len(run.cases) == 0
    assert "kai_weight_eval.run.from_pkm.unmatched_outcome" in caplog.text


@pytest.mark.asyncio
async def test_persist_promotion_decision_writes_audit_projection():
    fake = _FakePkmService()
    service = KaiWeightEvalService(pkm_service=fake)
    run = await service.build_candidate_run(
        run_id="run_3",
        model_version="m2",
        prompt_set_version="p2",
        expected_vs_observed=[
            {"expected_decision": "buy", "observed_decision": "buy", "latency_ms": 10}
        ],
    )
    decision = service.evaluate_promotion(run=run, approved_by="governor@hushh")
    ok = await service.persist_promotion_decision(
        user_id="user_1",
        decision=decision,
        gate_results=run.gate_results,
    )

    assert ok is True
    assert fake.recorded[-1]["metadata"]["projection_type"] == "kai_weight_eval_promotion_v1"


@pytest.mark.asyncio
async def test_weight_eval_round_trip_load_run_persist_fetch():
    fake = _FakePkmService()
    service = KaiWeightEvalService(pkm_service=fake)
    outcomes = [
        {"decision_id": "d1", "ticker": "AAPL", "realized_return": 0.04, "eval_latency_ms": 140}
    ]

    logger.info(
        "TEST TRACE input user_id=%s run_id=%s outcomes=%s", "user_1", "run_round_trip", outcomes
    )
    run = await service.run_weight_eval_from_pkm(
        user_id="user_1",
        run_id="run_round_trip",
        model_version="shadow-v1",
        prompt_set_version="roundtrip-v1",
        outcomes=outcomes,
    )
    logger.info(
        "TEST TRACE after_run run_id=%s cases=%s accuracy=%.4f latency=%.2f",
        run.run_id,
        len(run.cases),
        run.kpis.accuracy_delta,
        run.kpis.latency_delta_ms,
    )
    decision = service.evaluate_promotion(run=run, approved_by="governor@hushh")
    logger.info(
        "TEST TRACE after_gate run_id=%s approved=%s reason=%s",
        decision.run_id,
        decision.approved,
        decision.reason,
    )
    await service.persist_promotion_decision(
        user_id="user_1",
        decision=decision,
        gate_results=run.gate_results,
    )
    snapshot = await service.fetch_recent_weight_eval_artifacts(user_id="user_1", limit=10)
    logger.info(
        "TEST TRACE output artifact_count=%s runs=%s promotions=%s",
        snapshot["artifact_count"],
        len(snapshot["runs"]),
        len(snapshot["promotions"]),
    )

    assert run.run_id == "run_round_trip"
    assert snapshot["artifact_count"] >= 2
    assert len(snapshot["runs"]) >= 1
    assert len(snapshot["promotions"]) >= 1


@pytest.mark.asyncio
async def test_weight_eval_round_trip_log_trail_is_complete(caplog):
    fake = _FakePkmService()
    service = KaiWeightEvalService(pkm_service=fake)
    outcomes = [
        {"decision_id": "d1", "ticker": "AAPL", "realized_return": 0.04, "eval_latency_ms": 140}
    ]

    with caplog.at_level("INFO"):
        logger.info("TEST TRACE input user_id=%s outcomes=%s", "user_1", outcomes)
        run = await service.run_weight_eval_from_pkm(
            user_id="user_1",
            run_id="run_trace",
            model_version="shadow-v1",
            prompt_set_version="trace-v1",
            outcomes=outcomes,
        )
        logger.info("TEST TRACE after_run run_id=%s cases=%s", run.run_id, len(run.cases))
        decision = service.evaluate_promotion(run=run, approved_by="governor@hushh")
        logger.info(
            "TEST TRACE after_gate approved=%s reason=%s", decision.approved, decision.reason
        )
        await service.persist_promotion_decision(
            user_id="user_1",
            decision=decision,
            gate_results=run.gate_results,
        )
        snapshot = await service.fetch_recent_weight_eval_artifacts(user_id="user_1", limit=10)
        logger.info(
            "TEST TRACE output artifact_count=%s runs=%s promotions=%s",
            snapshot["artifact_count"],
            len(snapshot["runs"]),
            len(snapshot["promotions"]),
        )

    trace = caplog.text
    assert "TEST TRACE input user_id=user_1" in trace
    assert "kai_weight_eval.load_decision_receipts.start user_id=user_1" in trace
    assert "kai_weight_eval.run.from_pkm.done user_id=user_1 run_id=run_trace" in trace
    assert "kai_weight_eval.evaluate_promotion run_id=run_trace" in trace
    assert "kai_weight_eval.persist_promotion_decision user_id=user_1 run_id=run_trace" in trace
    assert "TEST TRACE output artifact_count=" in trace


@pytest.mark.asyncio
async def test_run_weight_eval_with_outcome_provider_derives_outcomes_end_to_end():
    fake = _FakePkmService()
    provider = _FakeOutcomeProvider()
    service = KaiWeightEvalService(pkm_service=fake, outcome_provider=provider)

    logger.info(
        "TEST TRACE provider_input user_id=%s run_id=%s horizon_days=%s limit=%s",
        "user_1",
        "run_provider_1",
        7,
        10,
    )
    run = await service.run_weight_eval_with_outcome_provider(
        user_id="user_1",
        run_id="run_provider_1",
        model_version="shadow-v1",
        prompt_set_version="provider-v1",
        horizon_days=7,
        limit=10,
    )
    logger.info(
        "TEST TRACE provider_output run_id=%s cases=%s accuracy=%.4f",
        run.run_id,
        len(run.cases),
        run.kpis.accuracy_delta,
    )

    assert run.run_id == "run_provider_1"
    assert len(run.cases) == 1
    assert run.cases[0].expected_decision == "buy"
    assert run.cases[0].observed_decision == "buy"


@pytest.mark.asyncio
async def test_run_weight_eval_with_outcome_provider_requires_provider():
    fake = _FakePkmService()
    service = KaiWeightEvalService(pkm_service=fake)
    with pytest.raises(ValueError, match="Outcome provider is required"):
        await service.run_weight_eval_with_outcome_provider(
            user_id="user_1",
            run_id="run_provider_missing",
            model_version="shadow-v1",
            prompt_set_version="provider-v1",
            horizon_days=7,
            limit=10,
        )


@pytest.mark.asyncio
async def test_run_weight_eval_with_outcome_provider_log_trail(caplog):
    fake = _FakePkmService()
    provider = _FakeOutcomeProvider()
    service = KaiWeightEvalService(pkm_service=fake, outcome_provider=provider)

    with caplog.at_level("INFO"):
        logger.info("TEST TRACE provider_input user_id=%s", "user_1")
        run = await service.run_weight_eval_with_outcome_provider(
            user_id="user_1",
            run_id="run_provider_trace",
            model_version="shadow-v1",
            prompt_set_version="provider-v1",
            horizon_days=7,
            limit=10,
        )
        logger.info("TEST TRACE provider_output run_id=%s cases=%s", run.run_id, len(run.cases))

    trace = caplog.text
    assert "TEST TRACE provider_input user_id=user_1" in trace
    assert "kai_weight_eval.run.with_provider user_id=user_1 run_id=run_provider_trace" in trace
    assert "kai_weight_eval.run.from_pkm.done user_id=user_1 run_id=run_provider_trace" in trace
    assert "TEST TRACE provider_output run_id=run_provider_trace cases=1" in trace
