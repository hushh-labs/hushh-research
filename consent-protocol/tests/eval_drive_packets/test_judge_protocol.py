"""The judge is independent of the runtime: deterministic checks first, pinned
different models, typed output, exact quotes, unknown on any doubt."""

import json

import pytest

from hushh_eval.drive_packets.deterministic import Finding
from hushh_eval.drive_packets.judge import (
    FakeJudge,
    JudgeConfigError,
    judge_packet,
    judge_payload,
    require_independent,
)

GOLD_CANARY = "GOLD-LABEL-CANARY-3317"
PAGE = "Example Bank\nMonthly statement\nStatement period September 1, 2026 to September 30, 2026\n"


def packet(**overrides):
    value = {
        "state": "ready",
        "title": "Example Bank statements",
        "description": "One statement.",
        "coverage_summary": "September 2026.",
        "utility_rationale": "Complete.",
        "temporal_scope": "document_period",
        "periods": [{"start": "2026-09-01", "end": "2026-09-30"}],
        "gaps": [],
        "pricing": {
            "useful_scope": "period",
            "coverage": "complete",
            "quality": "verified",
            "suggested_price_cents": 777,
        },
        "selected_document_ids": ["d1", "d2"],
        "excluded_documents": [],
        "assessment_score": 97,
        "importance": 412,
        "verification": {"issues": ["RUNTIME-CHECKER-NOTE"]},
    }
    value.update(overrides)
    return value


def members():
    return [
        {
            "document_id": "d1",
            "pages": {1: PAGE},
            "metadata": {"modifiedTime": "2026-10-01T00:00:00Z"},
            "gold": GOLD_CANARY,
        },
        {"document_id": "d2", "pages": {1: PAGE + "page two"}, "metadata": {}},
    ]


def answer(verdict="pass", quote="Monthly statement", ref="m1", severity="none", checks=()):
    return {
        "verdict": verdict,
        "failed_checks": list(checks),
        "severity": severity,
        "citations": [{"document_ref": ref, "page": 1, "quote": quote}],
    }


async def run(j1, j2, **kwargs):
    return await judge_packet(
        batch_id="B",
        packet_key="p1",
        packet=packet(),
        members=members(),
        findings=[],
        j1=j1,
        j2=j2,
        **kwargs,
    )


def test_judge_equal_to_runtime_model_is_refused():
    with pytest.raises(JudgeConfigError, match="judge_equals_runtime_model"):
        require_independent(
            runtime_model="gemini-3.6-flash", j1="gemini-3.6-flash", j2="gemini-3.8-flash"
        )
    with pytest.raises(JudgeConfigError, match="judge_equals_runtime_model"):
        require_independent(
            runtime_model="gemini-3.6-flash", j1="gemini-3.1-pro-preview", j2="gemini-3.6-flash"
        )
    require_independent(
        runtime_model="gemini-3.6-flash", j1="gemini-3.1-pro-preview", j2="gemini-3.8-flash"
    )


def test_prompt_excludes_gold_labels_and_runtime_scores():
    prompt = json.dumps(judge_payload(packet(), members()))
    for hidden in (
        GOLD_CANARY,
        "assessment_score",
        "importance",
        "777",
        "412",
        "RUNTIME-CHECKER-NOTE",
    ):
        assert hidden not in prompt
    assert "Monthly statement" in prompt


async def test_malformed_output_is_unknown_never_pass():
    j1 = FakeJudge("j1", verdicts={"Example Bank statements": {"verdict": "pass"}})
    result = await run(j1, FakeJudge("j2"))
    assert result.consensus == "unknown"
    assert result.rows[0].error_code == "judge_schema_invalid"
    assert [row.reason for row in result.queue] == ["disagreement"]


async def test_inexact_judge_quote_is_unknown():
    j1 = FakeJudge(
        "j1", verdicts={"Example Bank statements": answer(quote="Statement for October")}
    )
    result = await run(j1, FakeJudge("j2"))
    assert result.rows[0].error_code == "judge_citation_invalid"
    assert result.consensus == "unknown"


async def test_disagreement_is_unknown_and_queued_for_a_human():
    fail = answer("fail", severity="S1", checks=["wrong_period"])
    result = await run(FakeJudge("j1"), FakeJudge("j2", verdicts={"Example Bank statements": fail}))
    assert result.consensus == "unknown"
    assert result.queue and result.queue[0].reason == "disagreement"


async def test_agreement_on_fail_keeps_the_worst_severity():
    fail = answer("fail", severity="S1", checks=["request_shown_executed"])
    judge_a = FakeJudge("j1", verdicts={"Example Bank statements": fail})
    judge_b = FakeJudge(
        "j2",
        verdicts={
            "Example Bank statements": answer("fail", severity="S3", checks=["unsupported_wording"])
        },
    )
    result = await run(judge_a, judge_b)
    assert (result.consensus, result.severity) == ("fail", "S1")


async def test_deterministic_failure_is_final_and_costs_no_model_call():
    j1, j2 = FakeJudge("j1"), FakeJudge("j2")
    result = await judge_packet(
        batch_id="B",
        packet_key="p1",
        packet=packet(),
        members=members(),
        findings=[Finding("requested_event", "S1", "request_shown_executed")],
        j1=j1,
        j2=j2,
    )
    assert (result.consensus, result.severity) == ("fail", "S1")
    assert j1.prompts == [] and j2.prompts == []


async def test_rerun_and_order_shuffle_checks_are_recorded():
    j1 = FakeJudge("j1")
    result = await run(j1, FakeJudge("j2"), rerun_fraction=1.0, shuffle_fraction=1.0)
    variants = {(row.judge_id, row.variant) for row in result.rows}
    assert {
        ("J1", "rerun"),
        ("J1", "shuffled"),
        ("J2", "primary"),
        ("consensus", "consensus"),
    } <= variants
    primary, shuffled = json.loads(j1.prompts[0]), json.loads(j1.prompts[-1])

    def texts(payload):
        return sorted(page["text"] for item in payload["documents"] for page in item["pages"])

    # Same evidence, possibly reordered, with references reassigned by position.
    assert texts(primary) == texts(shuffled)


async def test_provider_rate_limits_are_retried_but_other_errors_are_not():
    from hushh_eval.drive_packets.judge import with_retries

    calls, waits = [], []

    async def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("429 RESOURCE_EXHAUSTED")
        return "answer"

    async def no_sleep(delay):
        waits.append(delay)

    assert await with_retries(flaky, sleep=no_sleep) == "answer"
    assert len(calls) == 3 and waits == [4.0, 12.0]

    async def broken():
        raise ValueError("400 INVALID_ARGUMENT")

    with pytest.raises(ValueError):
        await with_retries(broken, sleep=no_sleep)
    assert waits == [4.0, 12.0]
