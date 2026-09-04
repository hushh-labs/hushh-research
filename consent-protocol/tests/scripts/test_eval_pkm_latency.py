"""Latency-benchmark coverage for the PKM structure-agent evaluator.

Every case here drives the evaluator through a duck-typed fake preview service.
No test in this file may reach a real model.
"""

import pytest

from scripts import eval_pkm_structure_agent as eval_script


def _case(case_id: str = "latency-001") -> eval_script.PromptCase:
    return eval_script.PromptCase(
        case_id=case_id,
        message="I prefer Thai food.",
        expected_save_class="durable",
        expected_intent_class="preference",
        expected_mutation_intent="create",
        expected_domains=("food",),
        expect_confirmation=False,
        category="preference",
    )


def _preview(*, performance: dict | None = None) -> dict:
    preview = {
        "intent_frame": {
            "save_class": "durable",
            "intent_class": "preference",
            "mutation_intent": "create",
            "requires_confirmation": False,
        },
        "structure_decision": {
            "action": "create_domain",
            "target_domain": "food",
            "json_paths": [],
            "top_level_scope_paths": [],
            "externalizable_paths": [],
        },
        "write_mode": "can_save",
        "validation_hints": [],
        "used_fallback": False,
    }
    if performance is not None:
        preview["performance"] = performance
    return preview


class FakePreviewService:
    """The duck-typed seam the structure-agent evaluator already accepts."""

    def __init__(self, performances: list[dict | None]):
        self._performances = list(performances)
        self.calls = 0

    async def generate_structure_preview(self, **kwargs):
        assert kwargs["capture_execution_trace"] is True
        index = min(self.calls, len(self._performances) - 1)
        self.calls += 1
        return _preview(performance=self._performances[index])


async def _evaluate(service, *, rep: int = 0) -> eval_script.EvaluationResult:
    return await eval_script._evaluate_case(
        service=service,
        case=_case(),
        state={"domains": [], "memories": []},
        user_id="synthetic-user",
        model_override="test-model",
        strict_small_model=True,
        per_prompt_timeout_seconds=1.0,
        domain_registry_override=[],
        rep=rep,
    )


def _result(
    *,
    latency_ms: float,
    rep: int = 0,
    stage_latencies_ms: dict[str, float] | None = None,
    stage_totals_ms: dict[str, float] | None = None,
) -> eval_script.EvaluationResult:
    return eval_script.EvaluationResult(
        case_id=f"case-{latency_ms}-{rep}",
        message="I prefer Thai food.",
        category="preference",
        expected_save_class="durable",
        expected_intent_class="preference",
        expected_mutation_intent="create",
        expected_domains=["food"],
        expect_confirmation=False,
        latency_ms=latency_ms,
        actual_save_class="durable",
        actual_intent_class="preference",
        actual_mutation_intent="create",
        actual_domain="food",
        actual_write_mode="can_save",
        requires_confirmation=False,
        validation_hints=[],
        drift_flags={},
        used_fallback=False,
        timed_out=False,
        finance_contamination=False,
        unresolved_domain=False,
        inner_timeout_count=0,
        inner_budget_exhausted_count=0,
        inner_failure_count=0,
        save_class_ok=True,
        intent_ok=True,
        mutation_ok=True,
        domain_ok=True,
        confirmation_ok=True,
        schema_ok=True,
        stage_latencies_ms=stage_latencies_ms or {},
        stage_totals_ms=stage_totals_ms or {},
        rep=rep,
    )


def test_pct_interpolates_between_neighbouring_samples():
    assert eval_script.pct([10.0, 20.0, 30.0, 40.0], 0.50) == 25.0
    # position = (5 - 1) * 0.95 = 3.8, so the answer sits 80% of the way from 4 to 5.
    assert eval_script.pct([1.0, 2.0, 3.0, 4.0, 5.0], 0.95) == pytest.approx(4.8)
    assert eval_script.pct([5.0, 1.0, 4.0, 2.0, 3.0], 0.95) == pytest.approx(4.8)


def test_pct_handles_empty_single_and_boundary_input():
    assert eval_script.pct([], 0.95) == 0.0
    assert eval_script.pct([42.5], 0.99) == 42.5
    assert eval_script.pct([10.0, 20.0, 30.0], 0.0) == 10.0
    assert eval_script.pct([10.0, 20.0, 30.0], 1.0) == 30.0


def test_pct_reports_a_higher_tail_than_the_retired_naive_index():
    samples = [float(value) for value in range(1, 21)]
    naive_index = min(len(samples) - 1, max(0, int(len(samples) * 0.95) - 1))

    assert samples[naive_index] == 19.0
    assert eval_script.pct(samples, 0.95) == pytest.approx(19.05)


@pytest.mark.asyncio
async def test_evaluate_case_keeps_per_agent_and_per_stage_latency():
    service = FakePreviewService(
        [
            {
                "total_latency_ms": 900.0,
                "stage_latencies_ms": {
                    "memory_segmentation": 120.5,
                    "preview_cards_total": 640.25,
                },
                "agent_execution": [
                    {"agent_id": "memory_intent_agent", "status": "ok", "latency_ms": 210.5},
                    {"agent_id": "structure_agent", "status": "ok", "latency_ms": 430.0},
                ],
            }
        ]
    )

    result = await _evaluate(service)

    assert result.stage_latencies_ms == {
        "memory_intent_agent": 210.5,
        "structure_agent": 430.0,
    }
    assert result.stage_totals_ms == {
        "memory_segmentation": 120.5,
        "preview_cards_total": 640.25,
    }


@pytest.mark.asyncio
async def test_evaluate_case_accumulates_an_agent_that_ran_more_than_once():
    service = FakePreviewService(
        [
            {
                "agent_execution": [
                    {"agent_id": "structure_agent", "status": "ok", "latency_ms": 100.0},
                    {"agent_id": "structure_agent", "status": "ok", "latency_ms": 55.5},
                    {"agent_id": "", "status": "ok", "latency_ms": 999.0},
                    {"agent_id": "structure_agent", "status": "ok", "latency_ms": "bad"},
                    "not-a-dict",
                ]
            }
        ]
    )

    result = await _evaluate(service)

    assert result.stage_latencies_ms == {"structure_agent": 155.5}


@pytest.mark.asyncio
async def test_evaluate_case_defaults_to_empty_latency_maps_without_a_trace():
    result = await _evaluate(FakePreviewService([None]))

    assert result.stage_latencies_ms == {}
    assert result.stage_totals_ms == {}
    assert result.latency_ms >= 0.0


def test_summary_reports_p50_p95_p99_and_a_slowest_first_stage_rollup():
    results = [
        _result(
            latency_ms=float(value),
            stage_latencies_ms={"memory_intent_agent": 10.0, "structure_agent": float(value)},
            stage_totals_ms={"memory_segmentation": 5.0},
        )
        for value in range(100, 1100, 100)
    ]

    summary = eval_script._summarize_results(results)

    assert summary["prompt_count"] == 10
    assert summary["min_latency_ms"] == 100.0
    assert summary["max_latency_ms"] == 1000.0
    assert summary["p50_latency_ms"] == 550.0
    assert summary["p95_latency_ms"] == 955.0
    assert summary["p99_latency_ms"] == 991.0
    assert summary["average_latency_ms"] == 550.0

    stage_summary = summary["stage_latency_summary"]
    # The slow agent has to be the first stage the founder reads.
    assert list(stage_summary) == ["structure_agent", "memory_intent_agent"]
    assert stage_summary["structure_agent"] == {
        "count": 10,
        "avg": 550.0,
        "p50": 550.0,
        "p95": 955.0,
        "p99": 991.0,
    }
    assert stage_summary["memory_intent_agent"]["p95"] == 10.0
    assert summary["stage_total_latency_summary"]["memory_segmentation"]["count"] == 10


def test_summary_splits_the_cold_first_rep_from_the_warm_repetitions():
    results = [
        _result(latency_ms=5000.0, rep=0),
        _result(latency_ms=5200.0, rep=0),
        _result(latency_ms=400.0, rep=1),
        _result(latency_ms=600.0, rep=1),
        _result(latency_ms=500.0, rep=2),
    ]

    summary = eval_script._summarize_results(results)

    assert summary["latency_cold"]["count"] == 2
    assert summary["latency_cold"]["p50_ms"] == 5100.0
    assert summary["latency_warm"]["count"] == 3
    assert summary["latency_warm"]["p50_ms"] == 500.0
    assert summary["latency_warm"]["max_ms"] == 600.0
    # The overall block still covers every repetition.
    assert summary["prompt_count"] == 5


def test_empty_summary_still_exposes_the_latency_keys():
    # The keys stay present so downstream readers never KeyError, but they carry
    # None rather than 0.0: an unmeasured percentile is absent, not instant.
    summary = eval_script._summarize_results([])

    for key in ("p50_latency_ms", "p95_latency_ms", "p99_latency_ms"):
        assert key in summary
        assert summary[key] is None
    assert summary["latency_cold"]["count"] == 0
    assert summary["latency_cold"]["p95_ms"] is None
    assert summary["stage_latency_summary"] == {}


def test_latency_gate_is_off_until_a_ceiling_is_supplied():
    thresholds = dict(eval_script.DEFAULT_GATE_THRESHOLDS)
    thresholds["max_p95_latency_ms"] = None
    summary = eval_script._summarize_results([_result(latency_ms=90_000.0)])

    failures = eval_script._gate_failures_for_summary(
        label="synthetic:candidate_minimal",
        summary=summary,
        thresholds=thresholds,
    )

    assert failures == []


def test_unmeasured_latency_is_a_gate_failure_not_a_pass():
    # An empty latency block reports None, not 0.0. If the gate coerced that to
    # zero it would clear every ceiling, so a run that timed nothing would
    # publish a satisfied latency gate -- the most flattering reading of no data.
    summary = eval_script._summarize_results([])
    assert summary["p95_latency_ms"] is None

    failures = eval_script._gate_failures_for_summary(
        label="synthetic:candidate_minimal",
        summary=summary,
        thresholds={**eval_script.DEFAULT_GATE_THRESHOLDS, "max_p95_latency_ms": 2000.0},
    )
    assert any("p95_latency_ms not measured" in failure for failure in failures)


def test_latency_gate_fails_only_when_p95_exceeds_the_ceiling():
    results = [_result(latency_ms=latency) for latency in (400.0, 800.0, 1200.0, 1600.0)]
    summary = eval_script._summarize_results(results)
    thresholds = dict(eval_script.DEFAULT_GATE_THRESHOLDS)

    thresholds["max_p95_latency_ms"] = 2000.0
    assert (
        eval_script._gate_failures_for_summary(
            label="synthetic:candidate_minimal",
            summary=summary,
            thresholds=thresholds,
        )
        == []
    )

    thresholds["max_p95_latency_ms"] = 1000.0
    assert eval_script._gate_failures_for_summary(
        label="synthetic:candidate_minimal",
        summary=summary,
        thresholds=thresholds,
    ) == ["synthetic:candidate_minimal:p95_latency_ms 1540.00 > 1000.00"]


def test_quality_gate_reports_the_latency_breach_alongside_the_existing_gates():
    gate = eval_script._build_quality_gate(
        synthetic_reports=[
            {
                "mode": "candidate_minimal",
                "summary": {
                    "schema_ok_rate": 1.0,
                    "domain_ok_rate": 1.0,
                    "mutation_ok_rate": 1.0,
                    "intent_ok_rate": 1.0,
                    "fallback_rate": 0.0,
                    "durable_domain_coverage_rate": 1.0,
                    "p95_latency_ms": 4200.0,
                },
            }
        ],
        shadow_reports=[],
        thresholds={**eval_script.DEFAULT_GATE_THRESHOLDS, "max_p95_latency_ms": 3000.0},
    )

    assert gate["status"] == "fail"
    assert gate["failures"] == ["synthetic:candidate_minimal:p95_latency_ms 4200.00 > 3000.00"]


def test_parse_args_defaults_keep_one_rep_and_an_ungated_latency(monkeypatch):
    monkeypatch.setattr("sys.argv", ["eval_pkm_structure_agent.py"])

    args = eval_script.parse_args()

    assert args.reps == 1
    assert args.max_p95_latency_ms is None
    assert eval_script._gate_thresholds(args)["max_p95_latency_ms"] is None


def test_parse_args_accepts_a_latency_ceiling_and_repetitions(monkeypatch):
    monkeypatch.setattr(
        "sys.argv",
        ["eval_pkm_structure_agent.py", "--reps", "3", "--max-p95-latency-ms", "2500"],
    )

    args = eval_script.parse_args()

    assert args.reps == 3
    assert eval_script._gate_thresholds(args)["max_p95_latency_ms"] == 2500.0


@pytest.mark.asyncio
async def test_reps_replays_the_chain_and_tags_every_repetition():
    service = FakePreviewService(
        [{"agent_execution": [{"agent_id": "structure_agent", "latency_ms": 12.0}]}]
    )
    personas = [
        {
            "persona_id": "persona_01",
            "name": "Avery",
            "prompts": [_case("latency-001"), _case("latency-002")],
        }
    ]

    report = await eval_script._run_synthetic_mode(
        service=service,
        personas=personas,
        mode_name="candidate_minimal",
        model_override="test-model",
        strict_small_model=True,
        chain_state=True,
        per_prompt_timeout_seconds=1.0,
        reps=3,
    )

    assert service.calls == 6
    # 2 prompts x 3 reps. The two counts are deliberately distinct: conflating
    # them makes a --reps run look like it covered 3x the corpus it actually did.
    assert report["evaluated_run_count"] == 6
    assert report["synthetic_prompt_count"] == 2
    assert report["reps"] == 3
    persona_report = report["personas"][0]
    assert persona_report["rep_count"] == 3
    assert [record["rep"] for record in persona_report["results"]] == [0, 0, 1, 1, 2, 2]
    # A repetition restarts from a blank chain, so the two prompts land in the
    # state once, not once per repetition. Accumulating would leave 6 memories
    # and turn later creates into no_ops, corrupting the accuracy rates.
    assert persona_report["final_domains"] == ["food"]
    assert persona_report["active_memory_count"] == 2
    assert report["summary"]["latency_cold"]["count"] == 2
    assert report["summary"]["latency_warm"]["count"] == 4
    assert report["summary"]["stage_latency_summary"]["structure_agent"]["count"] == 6


@pytest.mark.asyncio
async def test_single_rep_run_marks_every_result_cold():
    service = FakePreviewService([None])
    personas = [{"persona_id": "persona_01", "name": "Avery", "prompts": [_case()]}]

    report = await eval_script._run_synthetic_mode(
        service=service,
        personas=personas,
        mode_name="candidate_minimal",
        model_override="test-model",
        strict_small_model=True,
        chain_state=True,
        per_prompt_timeout_seconds=1.0,
    )

    assert service.calls == 1
    assert report["summary"]["latency_cold"]["count"] == 1
    assert report["summary"]["latency_warm"]["count"] == 0
