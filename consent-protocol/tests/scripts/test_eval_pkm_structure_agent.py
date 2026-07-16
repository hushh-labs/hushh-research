import asyncio
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.services import pkm_agent_lab_service as pkm_agent_lab_module
from scripts import eval_pkm_structure_agent as eval_script

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[2]


def test_persona_chain_keeps_hundred_case_crud_surface():
    prompts = eval_script._build_persona_chain(eval_script.PERSONA_SEEDS[0])

    assert len(prompts) == 100
    categories = {prompt.category for prompt in prompts}
    assert {"correction", "deletion", "ambiguous", "finance"}.issubset(categories)


def test_evaluator_timeout_outlives_runtime_preview_budget(monkeypatch):
    monkeypatch.setattr("sys.argv", ["eval_pkm_structure_agent.py"])

    args = eval_script.parse_args()

    assert args.per_prompt_timeout_seconds == eval_script.DEFAULT_PER_PROMPT_TIMEOUT_SECONDS
    assert args.per_prompt_timeout_seconds > pkm_agent_lab_module._PREVIEW_TOTAL_BUDGET_SECONDS


def test_release_chain_is_small_but_covers_all_storage_decisions_and_domains():
    personas, chain_state = eval_script.build_phase_personas(
        phase="release_chain_24", max_prompts_per_persona=120
    )
    prompts = personas[0]["prompts"]

    assert chain_state is True
    assert len(prompts) == 24
    assert {prompt.expected_mutation_intent for prompt in prompts} == {
        "create",
        "extend",
        "correct",
        "delete",
        "no_op",
    }
    assert {prompt.expected_save_class for prompt in prompts} == {
        "durable",
        "ephemeral",
        "ambiguous",
    }
    expected_domains = {domain for prompt in prompts for domain in prompt.expected_domains}
    assert {
        "financial",
        "food",
        "health",
        "location",
        "professional",
        "shopping",
        "social",
        "travel",
    }.issubset(expected_domains)


def test_release_fail_fast_only_stops_zero_tolerance_failures():
    healthy = SimpleNamespace(
        timed_out=False,
        schema_ok=True,
        inner_timeout_count=0,
        inner_budget_exhausted_count=0,
        inner_failure_count=0,
        finance_contamination=False,
        unresolved_domain=False,
    )
    assert eval_script._decisive_release_failure(healthy) == ""

    unhealthy = SimpleNamespace(**vars(healthy))
    unhealthy.inner_timeout_count = 1
    assert eval_script._decisive_release_failure(unhealthy) == "inner_timeout"


def test_quality_gate_flags_fallback_fragmentation_and_mutation_drift():
    gate = eval_script._build_quality_gate(
        synthetic_reports=[
            {
                "mode": "candidate_minimal",
                "summary": {
                    "schema_ok_rate": 1.0,
                    "domain_ok_rate": 0.96,
                    "mutation_ok_rate": 0.80,
                    "intent_ok_rate": 0.93,
                    "fallback_rate": 0.25,
                    "fragmentation_score": 0.50,
                    "finance_contamination_count": 1,
                    "unresolved_domain_count": 1,
                    "inner_timeout_count": 1,
                    "inner_budget_exhausted_count": 1,
                    "inner_failure_count": 1,
                },
            }
        ],
        shadow_reports=[],
        thresholds={
            "schema_ok_rate": 1.0,
            "domain_ok_rate": 0.95,
            "mutation_ok_rate": 0.90,
            "intent_ok_rate": 0.90,
            "fallback_rate": 0.10,
            "fragmentation_score_min": 0.80,
            "fragmentation_score_max": 1.20,
        },
    )

    assert gate["status"] == "fail"
    failures = "\n".join(gate["failures"])
    assert "mutation" in failures
    assert "fallback" in failures
    assert "fragmentation" in failures
    assert "finance_contamination" in failures
    assert "unresolved_domain" in failures
    assert "inner_timeout" in failures
    assert "inner_budget_exhausted" in failures
    assert "inner_agent_failure" in failures


def test_fragmentation_ignores_non_durable_alternative_domains():
    results = [
        SimpleNamespace(
            expected_save_class="durable",
            expected_domains=["food"],
            actual_save_class="durable",
            actual_domain="food",
            actual_write_mode="can_save",
        ),
        SimpleNamespace(
            expected_save_class="ambiguous",
            expected_domains=["professional", "travel", "shopping", "food"],
            actual_save_class="ambiguous",
            actual_domain="ria",
            actual_write_mode="do_not_save",
        ),
        SimpleNamespace(
            expected_save_class="ephemeral",
            expected_domains=["financial"],
            actual_save_class="ephemeral",
            actual_domain="professional",
            actual_write_mode="do_not_save",
        ),
    ]

    assert eval_script._durable_domain_fragmentation_score(results) == 1.0


@pytest.mark.asyncio
async def test_evaluator_fails_closed_on_hidden_inner_agent_timeout():
    class TraceService:
        async def generate_structure_preview(self, **kwargs):
            assert kwargs["capture_execution_trace"] is True
            return {
                "intent_frame": {
                    "save_class": "durable",
                    "intent_class": "preference",
                    "mutation_intent": "create",
                    "requires_confirmation": False,
                },
                "structure_decision": {"target_domain": "food"},
                "write_mode": "confirm_first",
                "validation_hints": [],
                "used_fallback": True,
                "performance": {
                    "agent_execution": [{"agent_id": "memory_intent_agent", "status": "timeout"}]
                },
            }

    case = eval_script.PromptCase(
        case_id="trace-timeout",
        message="I prefer Thai food.",
        expected_save_class="durable",
        expected_intent_class="preference",
        expected_mutation_intent="create",
        expected_domains=("food",),
        expect_confirmation=True,
        category="preference",
    )
    result = await eval_script._evaluate_case(
        service=TraceService(),
        case=case,
        state={"domains": [], "memories": []},
        user_id="synthetic-user",
        model_override="test-model",
        strict_small_model=True,
        per_prompt_timeout_seconds=1.0,
        domain_registry_override=[],
    )
    summary = eval_script._summarize_results([result])
    failures = eval_script._gate_failures_for_summary(
        label="synthetic:candidate_minimal",
        summary=summary,
        thresholds={
            "schema_ok_rate": 0.0,
            "domain_ok_rate": 0.0,
            "mutation_ok_rate": 0.0,
            "intent_ok_rate": 0.0,
            "fallback_rate": 1.0,
            "fragmentation_score_min": 0.0,
            "fragmentation_score_max": 2.0,
        },
    )

    assert result.timed_out is False
    assert summary["inner_timeout_count"] == 1
    assert failures == ["synthetic:candidate_minimal:inner_timeout 1"]


@pytest.mark.asyncio
async def test_synthetic_only_main_never_initializes_pkm_service(monkeypatch, tmp_path):
    args = SimpleNamespace(
        env_file=None,
        json_out=str(tmp_path / "report.json"),
        phase="fresh_chain_60",
        max_prompts_per_persona=1,
        skip_shadow=True,
        shadow_users="",
        model="",
        per_prompt_timeout_seconds=1.0,
        enforce_gates=False,
    )
    monkeypatch.setattr(eval_script, "parse_args", lambda: args)
    monkeypatch.setattr(eval_script, "get_pkm_agent_lab_service", lambda: object())
    monkeypatch.setattr(
        eval_script,
        "PersonalKnowledgeModelService",
        lambda: pytest.fail("synthetic-only evaluation must not initialize PKM storage"),
    )
    monkeypatch.setattr(
        eval_script,
        "build_phase_personas",
        lambda **_: ([{"user_id": "synthetic", "prompts": []}], {}),
    )
    monkeypatch.setattr(eval_script, "_mode_matrix", lambda _: [("test", "", False)])
    monkeypatch.setattr(eval_script, "resolve_shadow_users", lambda _: [])
    monkeypatch.setattr(eval_script, "_gate_thresholds", lambda _: {})
    monkeypatch.setattr(
        eval_script,
        "_run_synthetic_mode",
        lambda **_: asyncio.sleep(0, result={"mode": "test", "summary": {}}),
    )
    monkeypatch.setattr(
        eval_script,
        "_build_quality_gate",
        lambda **_: {"status": "pass", "failures": [], "thresholds": {}},
    )
    monkeypatch.setattr(eval_script, "_manual_kpi_summary", lambda **_: {})

    assert await eval_script.main() == 0


def test_synthetic_evaluator_import_needs_no_core_vault_or_signing_key():
    environment = os.environ.copy()
    environment.pop("APP_SIGNING_KEY", None)
    environment.pop("VAULT_DATA_KEY", None)
    environment["PYTHONPATH"] = str(CONSENT_PROTOCOL_ROOT)

    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            "import asyncio; "
            "from hushh_mcp.services.pkm_agent_lab_service import get_pkm_agent_lab_service; "
            "service = get_pkm_agent_lab_service(); "
            "assert service.structure_manifest.name; "
            "service._client = object(); "
            "preview = asyncio.run(service.generate_structure_preview("
            "user_id='synthetic', message='I prefer Thai food.', current_domains=[])); "
            "assert preview['structure_decision']['target_domain'] == 'food'",
        ],
        cwd=CONSENT_PROTOCOL_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
