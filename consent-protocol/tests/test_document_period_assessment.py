"""Contract tests: fake model output proves host fences, not model accuracy."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from google.genai import _transformers
from pydantic import ValidationError

from hushh_mcp.one_adk import document_period_assessment as periods

TEXT = "Manish's statements from January through December, twenty twenty-six."
TEXTS = (TEXT,)


def assessment(**changes):
    value = {
        "decision": "supported",
        "basis": "absolute",
        "period_start": "2026-01-01",
        "period_end": "2026-12-31",
        "missing_dimension": None,
        "source_spans": [{"message_index": 0, "start": 0, "end": len(TEXT), "quote": TEXT}],
    }
    value.update(changes)
    return value


def clock(**changes):
    value = {
        "invocation_id": "turn-a",
        "user_texts_sha256": periods.user_texts_sha256(TEXTS),
        "status": "ok",
        "date": "2027-01-01",
        "time_zone": "Asia/Kolkata",
        "time_zone_source": "owner",
    }
    value.update(changes)
    return periods.HostClockReceipt.model_validate(value)


def validate(value, **kwargs):
    return periods.validate_period_assessment(
        value, current_user_texts=TEXTS, invocation_id="turn-a", **kwargs
    )


def test_spelled_year_can_be_supported_without_clock_or_numeric_year_heuristic():
    assert validate(assessment()).period_start == "2026-01-01"


def test_period_output_schema_converts_through_vertex_sdk_before_transport():
    # Exercise the pinned SDK conversion that rejected exclusiveMinimum in UAT.
    schema = _transformers.t_schema(
        SimpleNamespace(vertexai=True), periods.DocumentPeriodAssessment
    )
    assert schema is not None
    assert schema.properties["source_spans"].items.properties["end"].minimum == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"period_start": "2026-01-01T00:00:00Z"},
        {"period_start": "20260101"},
        {"period_start": "2026-02-30"},
        {"period_start": "2027-01-01"},
        {"missing_dimension": "year"},
        {"basis": None},
        {"source_spans": []},
        {"confidence": 100},
    ],
)
def test_invalid_or_incoherent_assessment_rejected(changes):
    with pytest.raises(ValueError):
        validate(assessment(**changes))


@pytest.mark.parametrize(
    "span",
    [
        {"message_index": 0, "start": 0, "end": 0, "quote": TEXT},
        {"message_index": 1, "start": 0, "end": len(TEXT), "quote": TEXT},
        {"message_index": 0, "start": 1, "end": len(TEXT), "quote": TEXT},
        {"message_index": 0, "start": 0, "end": len(TEXT) + 1, "quote": TEXT},
        {"message_index": 0, "start": 2, "end": 1, "quote": TEXT},
        {"message_index": 0, "start": 0, "end": 7, "quote": "another"},
    ],
)
def test_forged_stale_or_wrong_offsets_rejected(span):
    with pytest.raises(ValueError):
        validate(assessment(source_spans=[span]))


@pytest.mark.parametrize(
    "receipt",
    [
        None,
        {"invocation_id": "old-turn"},
        {"user_texts_sha256": "0" * 64},
        {"time_zone_source": "utc_fallback", "time_zone": "UTC"},
    ],
)
def test_supported_relative_requires_current_bound_owner_clock(receipt):
    with pytest.raises(ValueError):
        validate(assessment(basis="relative"), clock_receipt=clock(**receipt) if receipt else None)


@pytest.mark.parametrize("zone", ["Asia/Kolkata", "UTC"])
def test_actual_owner_clock_accepts_explicit_utc_and_non_utc(zone):
    assert (
        validate(assessment(basis="relative"), clock_receipt=clock(time_zone=zone)).decision
        == "supported"
    )


def test_invalid_iana_zone_cannot_form_owner_receipt():
    with pytest.raises(ValidationError):
        clock(time_zone="America/Not_A_Real_City")


def test_requested_timezone_receipt_requires_exact_current_user_quote():
    reply = "Use Asia/Kolkata"
    receipt = clock(
        time_zone_source="request",
        user_time_zone_quote="Asia/Kolkata",
        user_texts_sha256=periods.user_texts_sha256((reply,)),
    )
    value = assessment(
        basis="relative",
        source_spans=[
            {
                "message_index": 0,
                "start": 0,
                "end": len(reply),
                "quote": reply,
            }
        ],
    )
    assert (
        periods.validate_period_assessment(
            value,
            current_user_texts=(reply,),
            invocation_id="turn-a",
            clock_receipt=receipt,
        ).decision
        == "supported"
    )
    unsupported = clock(
        time_zone_source="request",
        user_time_zone_quote="Asia/Kolkata",
        user_texts_sha256=periods.user_texts_sha256(TEXTS),
    )
    with pytest.raises(ValueError, match="trusted clock"):
        validate(assessment(basis="relative"), clock_receipt=unsupported)


@pytest.mark.parametrize("quote", [None, "America/Los_Angeles"])
def test_request_clock_cannot_claim_a_different_or_absent_zone_quote(quote):
    with pytest.raises(ValueError, match="exact timezone evidence"):
        clock(time_zone_source="request", user_time_zone_quote=quote)


def test_owner_receipt_cannot_smuggle_request_zone_evidence():
    with pytest.raises(ValueError, match="only a requested timezone"):
        clock(user_time_zone_quote="Asia/Kolkata")


def test_clarification_cannot_smuggle_guessed_bounds():
    with pytest.raises(ValueError):
        validate(assessment(decision="clarify", missing_dimension="year"))
    result = validate(
        assessment(decision="clarify", missing_dimension="year", period_start=None, period_end=None)
    )
    assert result.decision == "clarify"


def test_unicode_source_spans_use_exact_characters():
    text = "मनीष के पिछले पूरे वर्ष के विवरण"
    value = assessment(
        source_spans=[
            {
                "message_index": 0,
                "start": 0,
                "end": len(text),
                "quote": text,
            }
        ]
    )
    assert (
        periods.validate_period_assessment(
            value, current_user_texts=(text,), invocation_id="turn-a"
        )
        .source_spans[0]
        .quote
        == text
    )
    assert periods.user_texts_sha256((text,)) != periods.user_texts_sha256((text + " ",))


@pytest.fixture
def model_seam(monkeypatch):
    gene = SimpleNamespace(
        id=periods.GENE_ID,
        privacy=SimpleNamespace(plaintext_telemetry=False),
        runtime=SimpleNamespace(adk_mode="single_turn", transport=["in_process"]),
    )
    monkeypatch.setattr(periods.ManifestLoader, "load", lambda _: SimpleNamespace(subagents=[gene]))
    agent = object()
    builds = []

    def build(actual, *, output_schema):
        assert actual is gene
        assert output_schema is periods.DocumentPeriodAssessment
        builds.append(actual)
        return agent

    monkeypatch.setattr(periods, "build_single_turn_agent", build)
    calls = []

    async def run(actual, **kwargs):
        assert actual is agent
        calls.append(kwargs)
        return periods.DocumentPeriodAssessment.model_validate(assessment())

    monkeypatch.setattr(periods, "run_single_turn", run)
    return calls, builds


async def assess(**kwargs):
    return await periods.assess_document_period(
        current_user_texts=TEXTS,
        user_id="owner",
        consent_token="",
        invocation_id="turn-a",
        **kwargs,
    )


@pytest.mark.asyncio
async def test_one_tool_free_call_hides_candidate_and_matches_afterward(model_seam):
    calls, builds = model_seam
    result = await assess(candidate_start="1999-01-01", candidate_end="1999-12-31")
    assert result.status == "candidate_mismatch"
    assert result.assessment.period_start == "2026-01-01"
    assert len(calls) == len(builds) == 1
    assert calls[0]["timeout_seconds"] == 12
    prompt = json.loads(calls[0]["prompt_parts"])
    assert prompt == {
        "current_user_messages": [{"message_index": 0, "text": TEXT, "character_count": len(TEXT)}],
        "host_clock": None,
        "pending_clarification": None,
    }
    assert "1999" not in calls[0]["prompt_parts"]


@pytest.mark.asyncio
async def test_exact_candidate_supported(model_seam):
    result = await assess(candidate_start="2026-01-01", candidate_end="2026-12-31")
    assert result.status == "supported"


@pytest.mark.asyncio
async def test_clock_ids_not_sent_to_model(model_seam):
    await assess(clock_receipt=clock())
    visible = json.loads(model_seam[0][0]["prompt_parts"])["host_clock"]
    assert set(visible) == {"status", "date", "time_zone", "time_zone_source"}


@pytest.mark.asyncio
async def test_stale_receipt_rejected_before_model(model_seam):
    result = await assess(clock_receipt=clock(invocation_id="old-turn"))
    assert result.status == "invalid_input"
    assert model_seam == ([], [])


@pytest.mark.parametrize(
    "error,status",
    [
        (TimeoutError(), "timeout"),
        (ValueError(), "invalid_response"),
        (RuntimeError(), "unavailable"),
    ],
)
@pytest.mark.asyncio
async def test_operational_failures_never_become_ambiguity(model_seam, monkeypatch, error, status):
    async def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(periods, "run_single_turn", fail)
    assert (await assess()).status == status


@pytest.mark.asyncio
async def test_wrapped_framework_timeout_preserves_timeout(model_seam, monkeypatch):
    async def fail(*args, **kwargs):
        try:
            raise TimeoutError()
        except TimeoutError as error:
            raise RuntimeError("turn failed") from error

    monkeypatch.setattr(periods, "run_single_turn", fail)
    assert (await assess()).status == "timeout"


@pytest.mark.asyncio
async def test_cancellation_is_not_swallowed(model_seam, monkeypatch):
    async def fail(*args, **kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(periods, "run_single_turn", fail)
    with pytest.raises(asyncio.CancelledError):
        await assess()


@pytest.mark.asyncio
async def test_input_over_budget_fails_without_truncation_or_call(model_seam):
    result = await periods.assess_document_period(
        current_user_texts=("x" * periods.MAX_INPUT_BYTES,),
        user_id="owner",
        consent_token="",
        invocation_id="turn-a",
    )
    assert result.status == "invalid_input"
    assert result.reason == "input_budget_exceeded"
    assert model_seam == ([], [])


def test_continuation_requires_exact_pending_and_current_evidence():
    prior = "Statements from February 3 through May 11"
    current = "twenty twenty-six"
    pending = periods.PendingPeriodContext(
        original_user_texts=[prior], asked_missing_dimension="year"
    )
    spans = [
        {"source": "pending", "message_index": 0, "start": 0, "end": len(prior), "quote": prior},
        {
            "source": "current",
            "message_index": 0,
            "start": 0,
            "end": len(current),
            "quote": current,
        },
    ]
    result = periods.validate_period_assessment(
        assessment(period_start="2026-02-03", period_end="2026-05-11", source_spans=spans),
        current_user_texts=(current,),
        invocation_id="new-turn",
        pending_context=pending,
    )
    assert result.period_end == "2026-05-11"
    with pytest.raises(ValueError, match="current-message"):
        periods.validate_period_assessment(
            assessment(source_spans=spans[:1]),
            current_user_texts=(current,),
            invocation_id="new-turn",
            pending_context=pending,
        )
    with pytest.raises(ValueError, match="source span"):
        periods.validate_period_assessment(
            assessment(source_spans=spans),
            current_user_texts=(current,),
            invocation_id="new-turn",
        )


@pytest.mark.parametrize("texts", [[], [" "], ["x" * 4097], ["x"] * 18])
def test_pending_context_is_bounded_without_silent_truncation(texts):
    with pytest.raises(ValueError):
        periods.PendingPeriodContext(original_user_texts=texts, asked_missing_dimension="year")


@pytest.mark.asyncio
async def test_pending_input_is_separately_labeled_and_clock_stays_current_bound(model_seam):
    pending = periods.PendingPeriodContext(
        original_user_texts=["Earlier calendar period"], asked_missing_dimension="year"
    )
    result = await assess(pending_context=pending, clock_receipt=clock())
    assert result.status == "supported"
    payload = json.loads(model_seam[0][0]["prompt_parts"])
    assert payload["pending_clarification"] == {
        "asked_missing_dimension": "year",
        "original_user_messages": [
            {
                "message_index": 0,
                "text": "Earlier calendar period",
                "character_count": 23,
            }
        ],
    }
    assert payload["current_user_messages"][0]["text"] == TEXT
