"""One unusable model answer no longer fails its whole receipt page.

UAT, Nov 26: a scan of one mailbox answered 502 ``GMAIL_RECEIPT_EXTRACTION_INVALID``
(not retryable) on the same page every time. Five of six answers were fine; the
slowest was unusable, and one unusable answer cancelled the other five and
failed the page, so the owner's sync could never move past it.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest

from hushh_mcp.agents.email.runtime import EMAIL_LIVE_RECEIPT_EXTRACTOR_SCHEMA
from hushh_mcp.hushh_adk.single_turn import (
    SingleTurnInvalidJsonError,
    SingleTurnSchemaMismatchError,
    _decode,
)
from hushh_mcp.services import gmail_live_receipts_service as live_receipts_module
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from tests.services.test_gmail_receipt_live_service import (  # noqa: F401 - autouse lock fixture
    _message,
    _model_for,
    _scan,
    _service,
    receipt_owner_locks,
)

_SCHEMA = EMAIL_LIVE_RECEIPT_EXTRACTOR_SCHEMA
_ODD_SUBJECT = "Your receipt for order #ODD-2"


def _complete_answer() -> dict[str, Any]:
    """The smallest answer that satisfies every required field of the real schema."""

    answer: dict[str, Any] = {}
    for name, spec in _SCHEMA["properties"].items():
        kind = spec["type"]
        if spec.get("nullable"):
            answer[name] = None
        elif "enum" in spec:
            answer[name] = spec["enum"][0]
        elif kind == "BOOLEAN":
            answer[name] = False
        elif kind == "NUMBER":
            answer[name] = 0.9
        elif kind == "ARRAY":
            answer[name] = []
        else:
            answer[name] = "x"
    return answer


def test_the_synthetic_answer_really_satisfies_the_extractor_schema():
    assert _decode(json.dumps(_complete_answer()), _SCHEMA) == _complete_answer()


def test_a_cut_off_answer_names_its_stage_without_its_content():
    text = json.dumps({**_complete_answer(), "cleaned_preview": "private order text"})[:-40]
    with pytest.raises(SingleTurnInvalidJsonError) as caught:
        _decode(text, _SCHEMA)
    detail = live_receipts_module._extraction_failure_detail(caught.value)
    assert detail == f"stage=invalid_json chars={len(text)} closed=false"
    assert "private" not in detail


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ({k: v for k, v in _complete_answer().items() if k != "confidence"}, "required"),
        ({**_complete_answer(), "event_type": "bogus"}, "enum"),
    ],
)
def test_an_off_schema_answer_names_the_rule_and_field(answer, expected):
    with pytest.raises(SingleTurnSchemaMismatchError) as caught:
        _decode(json.dumps(answer), _SCHEMA)
    detail = live_receipts_module._extraction_failure_detail(caught.value)
    field = "confidence" if expected == "required" else "event_type"
    assert detail == f"stage=schema_mismatch keyword={expected} field={field}"


def test_only_schema_owned_names_ever_reach_the_log_line():
    error = SingleTurnSchemaMismatchError(
        "single-turn response does not match output schema",
        keyword="enum",
        path=("owner@example.com", "category"),
    )
    assert (
        live_receipts_module._extraction_failure_detail(error)
        == "stage=schema_mismatch keyword=enum field=category"
    )
    assert live_receipts_module._extraction_failure_detail(ValueError("x")) == "stage=value_error"


def _service_with_model(messages: list[dict], unusable_for: set[str], monkeypatch, bad_text: str):
    """Run the real extractor path; the gene returns bad text for the named subjects."""

    async def gene(*, prompt: str, output_schema: Any, **_kwargs: Any) -> dict[str, Any]:
        payload = json.loads(prompt[prompt.index("{") :])
        if payload["subject"] in unusable_for:
            return _decode(bad_text, output_schema)
        return _model_for(payload)

    monkeypatch.setattr(live_receipts_module, "run_email_gene", gene)
    service = _service(messages)
    service._extractor = service._run_extractor
    return service


def _good(identity: str, order: str) -> dict:
    return _message(
        identity,
        subject=f"Receipt for order #{order}",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 10.00",
    )


def _odd() -> dict:
    return _message(
        "msg-odd",
        subject=_ODD_SUBJECT,
        sender="Apple <orders@apple.com>",
        body="Order total: USD 12.00",
    )


@pytest.mark.parametrize(
    ("bad_text", "stage"),
    [
        (json.dumps(_complete_answer())[:-60], "stage=invalid_json"),
        (json.dumps({**_complete_answer(), "event_type": "bogus"}), "stage=schema_mismatch"),
    ],
    ids=["cut_off", "off_schema"],
)
async def test_one_unusable_answer_is_counted_and_the_other_receipts_are_kept(
    monkeypatch, caplog, bad_text, stage
):
    service = _service_with_model(
        [_good("msg-a", "A-1"), _odd(), _good("msg-b", "B-3")],
        {_ODD_SUBJECT},
        monkeypatch,
        bad_text,
    )
    with caplog.at_level(logging.INFO):
        result = await _scan(service)

    coverage = result["coverage"]
    assert result["returned_count"] == coverage["matched_count"] == 2
    assert coverage["rejection_counts"]["extractor_not_receipt"] == 1
    # The installed app's check: every candidate is a match or a counted rejection.
    assert (
        sum(coverage["rejection_counts"].values()) + coverage["matched_count"]
        == coverage["candidate_count"]
    )
    lines = [record.getMessage() for record in caplog.records]
    assert any(line.startswith("live_receipt_extraction_invalid " + stage) for line in lines)
    assert any(
        "live_receipt_unreadable_skipped unreadable=1 page_candidates=3" in line for line in lines
    )
    # Nothing from the email or the model's answer is logged.
    assert not any("ODD-2" in line or "Order total" in line for line in lines)


async def test_a_page_where_every_answer_is_unusable_still_fails(monkeypatch):
    bad = json.dumps(_complete_answer())[:-60]
    service = _service_with_model(
        [_good("msg-a", "A-1"), _odd()], {_ODD_SUBJECT, "Receipt for order #A-1"}, monkeypatch, bad
    )
    # A failing model must not look like an empty mailbox that was safely checked.
    with pytest.raises(GmailApiError) as caught:
        await _scan(service)
    assert caught.value.code == "GMAIL_RECEIPT_EXTRACTION_INVALID"
    assert caught.value.status_code == 502


async def test_a_transient_failure_still_fails_the_page_so_the_device_retries_it(monkeypatch):
    async def gene(**_kwargs: Any) -> dict[str, Any]:
        raise TimeoutError

    monkeypatch.setattr(live_receipts_module, "run_email_gene", gene)
    monkeypatch.setattr(live_receipts_module, "_EXTRACTOR_RETRY_DELAY_SECONDS", 0)
    service = _service([_good("msg-a", "A-1"), _odd()])
    service._extractor = service._run_extractor
    with pytest.raises(GmailApiError) as caught:
        await _scan(service)
    assert caught.value.code == "GMAIL_RECEIPT_EXTRACTION_TIMEOUT"
