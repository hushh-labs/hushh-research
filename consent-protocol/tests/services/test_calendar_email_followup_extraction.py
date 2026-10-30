"""Synthetic contract checks for complete-section, source-linked extraction."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import pytest

from hushh_mcp.services.calendar_email_followup_extraction import (
    assess_complete_message,
    validate_chunk,
)
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailMessage,
    split_complete_body,
)

_SYNTHETIC_CONSENT = "synthetic-consent"


def _message(body: str) -> CompleteMailMessage:
    return CompleteMailMessage(
        message_id="synthetic-msg-jhumma",
        thread_id="synthetic-thread-jhumma",
        internal_date_ms=int(datetime(2026, 10, 10, tzinfo=UTC).timestamp() * 1000),
        subject="Document and call",
        sender="Jhumma",
        body=body,
        body_digest=hashlib.sha256(body.encode()).hexdigest(),
        sections=split_complete_body(body, max_section_bytes=1500, overlap_chars=120),
    )


@pytest.mark.asyncio
async def test_five_paragraph_tail_yields_two_distinct_requests():
    preceding = [("Earlier context paragraph. " * 38).strip() for _ in range(4)]
    final = "Please send the document before 26 October. Could we have a call on 27 October?"
    message = _message("\n\n".join([*preceding, final]))
    assert len(message.sections) > 2
    calls: list[int] = []

    async def fake_gene(**kwargs):
        assert kwargs["gene_id"] == "agent_email_followup_extractor"
        prompt = json.loads(kwargs["prompt"])
        index, source = prompt["section_index"], prompt["section_text"]
        calls.append(index)
        if final not in source:
            return {"candidates": [], "updates": []}
        document = "Please send the document before 26 October."
        call = "Could we have a call on 27 October?"
        return {
            "candidates": [
                {
                    "local_index": 0,
                    "section_index": index,
                    "kind": "action",
                    "quote_start": source.index(document),
                    "source_quote": document,
                    "title": "Send the document",
                    "original_due_wording": "before 26 October",
                    "due_date": "2026-10-26",
                    "due_relation": "before",
                    "responsibility": "owner",
                    "ambiguities": ["time"],
                },
                {
                    "local_index": 1,
                    "section_index": index,
                    "kind": "meeting",
                    "quote_start": source.index(call),
                    "source_quote": call,
                    "title": "Review a call",
                    "proposed_date": "2026-10-27",
                    "responsibility": "owner",
                    "ambiguities": ["time", "duration"],
                },
            ],
            "updates": [],
        }

    async def current():
        return None

    result = await assess_complete_message(
        message=message,
        user_id="synthetic-owner",
        consent_token=_SYNTHETIC_CONSENT,
        owner_time_zone="Asia/Kolkata",
        prior_requests=[],
        evidence_key=b"synthetic-purpose-separated-key",
        require_current=current,
        gene_runner=fake_gene,
    )
    assert calls == list(range(len(message.sections)))
    assert result.expected_sections == result.completed_sections == len(message.sections)
    assert {item.kind for item in result.candidates} == {"action", "meeting"}
    assert {item.thread_id for item in result.candidates} == {message.thread_id}
    action = next(item for item in result.candidates if item.kind == "action")
    assert action.original_due_wording == "before 26 October"
    assert action.global_quote_start > len(message.body) // 2


def test_unoffered_quote_and_update_are_rejected():
    message = _message("Please send the document before 26 October.")
    section = message.sections[0]
    base = {
        "section_index": 0,
        "quote_start": 0,
        "source_quote": "Please send the document",
        "target_request_id": "00000000-0000-0000-0000-000000000001",
        "outcome": "cancelled",
        "explanation": "No longer needed",
    }
    with pytest.raises(ValueError, match="unsupported_update_ref"):
        validate_chunk(
            message=message,
            section=section,
            payload={"candidates": [], "updates": [base]},
            prior_request_ids=set(),
            evidence_key=b"synthetic-key",
        )
    bad = {
        "local_index": 0,
        "section_index": 0,
        "kind": "action",
        "quote_start": 0,
        "source_quote": "Not in this mail",
        "title": "Invented",
        "responsibility": "owner",
    }
    with pytest.raises(ValueError, match="unsupported_source_quote"):
        validate_chunk(
            message=message,
            section=section,
            payload={"candidates": [bad], "updates": []},
            prior_request_ids=set(),
            evidence_key=b"synthetic-key",
        )
