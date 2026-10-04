import asyncio
import logging
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.services import pkm_agent_lab_service as pkm_agent_lab_module
from scripts import eval_pkm_structure_agent as eval_script
from scripts import pkm_eval_integrity as integrity

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


def test_context_transfer_phase_expects_work_context_kept_and_commands_dropped():
    personas, chain_state = eval_script.build_phase_personas(
        phase="context_transfer", max_prompts_per_persona=120
    )
    prompts = personas[0]["prompts"]

    assert chain_state is False
    assert len(prompts) == eval_script.PHASE_PROMPT_LIMIT["context_transfer"]
    categories = {prompt.category for prompt in prompts}
    assert {
        "context_work",
        "context_technical_id",
        "context_people",
        "context_sensitive",
        "context_command",
    }.issubset(categories)
    # Everything the owner stated is durable; only the live command is not.
    for prompt in prompts:
        if prompt.category == "context_command":
            assert (prompt.expected_save_class, prompt.expected_intent_class) == (
                "ephemeral",
                "command",
            )
        else:
            assert prompt.expected_save_class == "durable", prompt.case_id
            assert "general" not in prompt.expected_domains


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


def test_quality_gate_flags_fallback_domain_coverage_and_mutation_drift():
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
                    "durable_domain_coverage_rate": 0.50,
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
            "durable_domain_coverage_rate": 0.95,
        },
    )

    assert gate["status"] == "fail"
    failures = "\n".join(gate["failures"])
    assert "mutation" in failures
    assert "fallback" in failures
    assert "durable_domain_coverage" in failures
    assert "finance_contamination" in failures
    assert "unresolved_domain" in failures
    assert "inner_timeout" in failures
    assert "inner_budget_exhausted" in failures
    assert "inner_agent_failure" in failures


def test_durable_domain_coverage_accepts_allowed_alternatives():
    results = [
        SimpleNamespace(
            expected_save_class="durable",
            expected_domains=["financial", "travel", "professional"],
            actual_save_class="durable",
            actual_domain="professional",
            actual_write_mode="can_save",
        ),
        SimpleNamespace(
            expected_save_class="durable",
            expected_domains=["health", "professional"],
            actual_save_class="durable",
            actual_domain="health",
            actual_write_mode="confirm_first",
        ),
        SimpleNamespace(
            expected_save_class="durable",
            expected_domains=["food"],
            actual_save_class="durable",
            actual_domain="food",
            actual_write_mode="can_save",
        ),
        SimpleNamespace(
            expected_save_class="durable",
            expected_domains=["location"],
            actual_save_class="durable",
            actual_domain="location",
            actual_write_mode="can_save",
        ),
        SimpleNamespace(
            expected_save_class="durable",
            expected_domains=["social", "shopping"],
            actual_save_class="durable",
            actual_domain="social",
            actual_write_mode="can_save",
        ),
        SimpleNamespace(
            expected_save_class="ambiguous",
            expected_domains=["financial", "travel", "professional", "health"],
            actual_save_class="ambiguous",
            actual_domain="ria",
            actual_write_mode="do_not_save",
        ),
    ]

    # The durable cases expose eight allowed domains but validly choose only
    # five. The retired unique-domain ratio would falsely report 5/8 = 0.625.
    assert eval_script._durable_domain_coverage_rate(results) == 1.0


def test_durable_domain_coverage_rejects_invalid_or_unsaved_durable_results():
    results = [
        SimpleNamespace(
            expected_save_class="durable",
            expected_domains=["food", "travel"],
            actual_save_class="durable",
            actual_domain="professional",
            actual_write_mode="can_save",
        ),
        SimpleNamespace(
            expected_save_class="durable",
            expected_domains=["health"],
            actual_save_class="durable",
            actual_domain="health",
            actual_write_mode="do_not_save",
        ),
    ]
    summary = {
        "schema_ok_rate": 1.0,
        "domain_ok_rate": 1.0,
        "mutation_ok_rate": 1.0,
        "intent_ok_rate": 1.0,
        "fallback_rate": 0.0,
        "durable_domain_coverage_rate": eval_script._durable_domain_coverage_rate(results),
        "finance_contamination_count": 0,
        "unresolved_domain_count": 0,
        "timeout_count": 0,
        "inner_timeout_count": 0,
        "inner_budget_exhausted_count": 0,
        "inner_failure_count": 0,
    }
    failures = eval_script._gate_failures_for_summary(
        label="synthetic:candidate_minimal",
        summary=summary,
        thresholds=eval_script.DEFAULT_GATE_THRESHOLDS,
    )

    assert summary["durable_domain_coverage_rate"] == 0.0
    assert failures == ["synthetic:candidate_minimal:durable_domain_coverage 0.0000 < 0.9500"]


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
            "durable_domain_coverage_rate": 0.0,
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

    completed = subprocess.run(  # noqa: S603 - test invokes the current interpreter with a fixed script
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
            "assert preview['write_mode'] == 'do_not_save'; "
            "assert preview['validation_hints']",
        ],
        cwd=CONSENT_PROTOCOL_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr


@pytest.mark.parametrize(
    "error",
    [
        TimeoutError("private details"),
        PermissionError("private details"),
        ConnectionError("private details"),
    ],
)
async def test_outer_failures_keep_timeout_and_transport_distinct(error):
    class FailedService:
        async def generate_structure_preview(self, **kwargs):
            raise error

    case = eval_script.PromptCase(
        case_id="outer-error",
        message="I prefer Thai food.",
        expected_save_class="durable",
        expected_intent_class="preference",
        expected_mutation_intent="create",
        expected_domains=("food",),
        expect_confirmation=True,
        category="preference",
    )
    state = {"domains": [], "memories": []}
    result = await eval_script._evaluate_case(
        service=FailedService(),
        case=case,
        state=state,
        user_id="synthetic-user",
        model_override="test-model",
        strict_small_model=True,
        per_prompt_timeout_seconds=1.0,
        domain_registry_override=[],
    )
    timeout = isinstance(error, TimeoutError)
    assert result.timed_out is timeout
    assert result.failure_class == type(error).__name__
    assert result.actual_write_mode == ("timeout" if timeout else "error")
    assert eval_script._decisive_release_failure(result) == (
        "outer_timeout" if timeout else "outer_error"
    )
    assert not result.schema_ok
    assert "private details" not in repr(result)
    assert state == {"domains": [], "memories": []}


async def test_fail_fast_saves_partial_report_and_fails_gate(monkeypatch, tmp_path):
    import json

    class FailedService:
        async def generate_structure_preview(self, **kwargs):
            raise PermissionError("must not enter report")

    report_path = tmp_path / "partial.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "eval_pkm_structure_agent.py",
            "--env-file",
            "",
            "--skip-shadow",
            "--phase",
            "release_chain_24",
            "--fail-fast",
            "--enforce-gates",
            "--json-out",
            str(report_path),
        ],
    )
    monkeypatch.setattr(eval_script, "get_pkm_agent_lab_service", FailedService)
    assert await eval_script.main() == 1
    report = json.loads(report_path.read_text())
    assert report["shadow_users"] == []
    run = report["synthetic_reports"][0]
    assert run["evaluated_run_count"] == 1
    assert run["unattempted_run_count"] == 23
    assert run["aborted_reason"].endswith(":outer_error")
    assert run["personas"][0]["results"][0]["failure_class"] == "PermissionError"
    assert report["quality_gate"]["status"] == "fail"
    assert "must not enter report" not in report_path.read_text()


# --------------------------------------------------------------------------
# Honest harness: controls, unsure, variance, ledger, document coverage
# --------------------------------------------------------------------------


class _AnswersExactly:
    """A perfect agent: every case answered with its expected labels."""

    def __init__(self, cases):
        self._by_message = {case.message: case for case in cases}

    async def generate_structure_preview(self, **kwargs):
        return eval_script._planted_result(self._by_message[kwargs["message"]])


async def _release_run(**overrides):
    personas, chain_state = eval_script.build_phase_personas(
        phase="release_chain_24", max_prompts_per_persona=24
    )
    return await eval_script._run_synthetic_mode(
        service=_AnswersExactly(personas[0]["prompts"]),
        personas=personas,
        mode_name="candidate_production",
        model_override="test-model",
        strict_small_model=False,
        chain_state=chain_state,
        per_prompt_timeout_seconds=1.0,
        reps=3,
        control_seed=20261002,
        **overrides,
    )


async def test_planted_controls_void_a_scorer_that_stops_reading_the_domain(monkeypatch):
    clean = await _release_run()
    assert clean["void"] is False
    assert clean["personas"][0]["controls"]["negative_caught"] == 12
    assert clean["rep_statistics"]["domain_ok_rate"]["mean"] == 1.0

    # The retired rule: any confirm_first card graded domain-correct. The
    # production path files every durable write as confirm_first, so this
    # scorer read 1.0 by construction. The planted control must void it.
    real_score = eval_script._score_case

    def lenient(case, answer):
        result = real_score(case, answer)
        if answer.result.get("write_mode") == "confirm_first":
            result.domain_ok = not result.finance_contamination
        return result

    monkeypatch.setattr(eval_script, "_score_case", lenient)
    lenient_run = await _release_run()
    assert lenient_run["void"] is True
    assert any("wrong_domain_confirm_first" in r for r in lenient_run["void_reasons"])
    # A void run publishes no accuracy at all.
    assert lenient_run["summary"]["domain_ok_rate"] is None
    assert lenient_run["rep_statistics"] == {}
    gate = eval_script._build_quality_gate(
        synthetic_reports=[lenient_run],
        shadow_reports=[],
        thresholds={**eval_script.DEFAULT_GATE_THRESHOLDS, "max_rate_spread": 0.1},
    )
    assert gate["status"] == "fail"
    assert any(":void:" in failure for failure in gate["failures"])


_FAILED_STAGE = (
    "pkm.agent_contract_failed agent=%s model=%s error_type=%s provider_status=%s error_code=%s"
)


class _RefusedOnce(_AnswersExactly):
    """A perfect agent whose provider refuses one stage call, as quota exhaustion does."""

    async def generate_structure_preview(self, **kwargs):
        if not getattr(self, "_refused", False):
            self._refused = True
            logging.getLogger(pkm_agent_lab_module.__name__).warning(
                _FAILED_STAGE, "agent_memory_merge", "m", "ClientError", 429, "quota_exhausted"
            )
        return await super().generate_structure_preview(**kwargs)


async def test_a_provider_refusal_voids_the_run_and_a_bad_request_does_not():
    # The counter reads the service's own failure line; it must still exist.
    source = Path(pkm_agent_lab_module.__file__).read_text(encoding="utf-8")
    assert '"pkm.agent_contract_failed agent=%s model=%s error_type=%s "' in source
    assert '"provider_status=%s error_code=%s"' in source

    service_logger = logging.getLogger(pkm_agent_lab_module.__name__)
    with integrity.count_provider_refusals() as refusals:
        service_logger.warning(_FAILED_STAGE, "a", "m", "ClientError", 429, "quota_exhausted")
        service_logger.warning(_FAILED_STAGE, "a", "m", "ServerError", 503, "unavailable")
        # A malformed request is the subject's failure, not the provider's.
        service_logger.warning(_FAILED_STAGE, "a", "m", "ClientError", 400, "bad_request")
    assert refusals.count == 2
    assert integrity.provider_void_reasons(0) == []

    personas, chain_state = eval_script.build_phase_personas(
        phase="release_chain_24", max_prompts_per_persona=24
    )
    refused = await eval_script._run_synthetic_mode(
        service=_RefusedOnce(personas[0]["prompts"]),
        personas=personas,
        mode_name="candidate_production",
        model_override="test-model",
        strict_small_model=False,
        chain_state=chain_state,
        per_prompt_timeout_seconds=1.0,
        reps=3,
        control_seed=20261002,
    )
    assert refused["void"] is True
    assert refused["provider_refused_calls"] == 1
    assert any("provider refused 1 stage call" in r for r in refused["void_reasons"])
    assert refused["summary"]["intent_ok_rate"] is None


def test_unsure_counts_against_accuracy_even_when_the_fallback_guessed_right():
    case = eval_script.PromptCase(
        case_id="unsure",
        message="I prefer Thai food.",
        expected_save_class="durable",
        expected_intent_class="preference",
        expected_mutation_intent="create",
        expected_domains=("food",),
        expect_confirmation=False,
        category="preference",
    )
    guessed = eval_script._planted_result(case)
    guessed.update(intent_used_fallback=True, structure_used_fallback=True, used_fallback=True)
    answer = eval_script._Answer(
        result=guessed, latency_ms=1.0, timed_out=False, failure_class=None, rep=0
    )
    graded = eval_script._score_case(case, answer)
    assert not graded.intent_ok and not graded.save_class_ok and not graded.mutation_ok
    assert not graded.domain_ok
    assert eval_script._durable_domain_coverage_rate([graded]) == 0.0


def test_variance_is_a_gate_n_below_three_or_a_wide_spread_fails():
    from scripts import pkm_eval_integrity as integrity

    steady = integrity.rep_statistics(
        [{"intent_ok_rate": 0.92}, {"intent_ok_rate": 0.96}, {"intent_ok_rate": 0.92}],
        ["intent_ok_rate"],
    )
    assert steady["intent_ok_rate"]["mean"] == 0.9333
    assert steady["intent_ok_rate"]["spread"] == 0.04
    assert integrity.variance_failures(label="x", stats=steady, reps=3, max_spread=0.1) == []
    assert integrity.variance_failures(label="x", stats=steady, reps=1, max_spread=0.1) == [
        "x:variance_unmeasured n=1 < 3"
    ]
    wide = integrity.rep_statistics(
        [{"intent_ok_rate": 0.75}, {"intent_ok_rate": 0.96}, {"intent_ok_rate": 0.88}],
        ["intent_ok_rate"],
    )
    assert integrity.variance_failures(label="x", stats=wide, reps=3, max_spread=0.1) == [
        "x:intent_ok_rate spread 0.2100 > 0.1000"
    ]


def test_ledger_is_append_only_tamper_evident_and_refuses_unlike_profiles(tmp_path):
    from scripts import pkm_eval_integrity as integrity

    profile = {
        "agents": {"agent_memory_intent": {"model": "gemini-3.6-flash", "thinking_level": "low"}}
    }
    ledger = tmp_path / "ledger.v1.jsonl"
    rates = {"intent_ok_rate": {"n": 3, "mean": 0.8, "spread": 0.04}}
    before = integrity.append_ledger(
        ledger,
        {
            "phase": "release_chain_24",
            "status": "fail",
            "capability_profile": profile,
            "rates": rates,
        },
    )
    after = integrity.append_ledger(
        ledger,
        {
            "phase": "release_chain_24",
            "status": "pass",
            "capability_profile": profile,
            "rates": {"intent_ok_rate": {"n": 3, "mean": 0.92, "spread": 0.04}},
        },
    )
    assert integrity.verify_ledger(ledger) == []
    assert after["prev_sha256"] == before["entry_sha256"]
    delta = integrity.compare_entries(before, after)["deltas"]["intent_ok_rate"]
    assert delta["delta_mean"] == 0.12

    other = {
        "agents": {"agent_memory_intent": {"model": "gemini-3.6-flash", "thinking_level": "high"}}
    }
    with pytest.raises(integrity.IncomparableRunsError, match="thinking_level"):
        integrity.compare_entries(before, {**after, "capability_profile": other})
    with pytest.raises(integrity.IncomparableRunsError, match="void"):
        integrity.compare_entries(before, {**after, "status": "void"})

    lines = ledger.read_text().splitlines()
    lines[0] = lines[0].replace('"mean":0.8', '"mean":0.9')
    ledger.write_text("\n".join(lines) + "\n")
    assert any("does not match its content" in error for error in integrity.verify_ledger(ledger))


def test_committed_ledger_chain_is_intact():
    from scripts import pkm_eval_integrity as integrity

    assert integrity.verify_ledger(integrity.DEFAULT_LEDGER_PATH) == []


def test_document_lines_are_graded_from_quotes_not_card_counts():
    from scripts import pkm_eval_document as document_eval

    text = (
        "# Vendors\n- Stripe for payments\n- Plaid for bank connections\n- Stripe for payments\n"
        "# Information not known\n- Information not known: team size\n"
    )
    vendors, unknown = document_eval.parse_document(text)
    assert [line.label for line in vendors.lines] == ["memory", "memory", "duplicate"]
    # Two cards for one line, a do_not_save card for the other, and a
    # paraphrase that matches no line: one of two memory lines is kept.
    response = {
        "preview_cards": [
            {"source_text": "- Stripe for payments", "write_mode": "confirm_first"},
            {"source_text": "Stripe for payments", "write_mode": "confirm_first"},
            {"source_text": "- Plaid for bank connections", "write_mode": "do_not_save"},
            {"source_text": "We use Plaid (paraphrased)", "write_mode": "confirm_first"},
        ]
    }
    verdicts = document_eval.score_passage(vendors, response)
    assert [verdict.flag for verdict in verdicts] == ["", "lost", ""]
    saved = {"preview_cards": [{"source_text": unknown.lines[0].text, "write_mode": "can_save"}]}
    assert [v.flag for v in document_eval.score_passage(unknown, saved)] == ["disclaimer_saved"]
