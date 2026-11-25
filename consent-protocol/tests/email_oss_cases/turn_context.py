"""Exclusive Email history provenance, ownership and context-size regressions."""

from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest
from google.adk.events import Event
from google.adk.sessions import Session
from google.genai import types

from hushh_mcp.services.email_oss.turn_context import EMAIL_ANSWER_KIND, project_email_history


def event(author: str, text: str, invocation: str, *, marked: bool = False, **kwargs) -> Event:
    return Event(
        author=author,
        invocation_id=invocation,
        content=types.Content(
            role="user" if author == "user" else "model", parts=[types.Part(text=text)]
        ),
        custom_metadata={"kind": EMAIL_ANSWER_KIND} if marked else {},
        **kwargs,
    )


def session(events) -> Session:
    return Session(app_name="one", id="conversation", user_id="owner", events=events)


def project(value, **kwargs):
    return project_email_history(
        value,
        owner_id="owner",
        conversation_id="conversation",
        current_invocation_id="current",
        **kwargs,
    )


def test_projects_only_completed_exclusive_email_turns_in_chronological_order():
    value = session(
        [
            event("user", "Summarize my portfolio", "finance"),
            event("one", "Private finance facts", "finance"),
            event("user", "Find my invoices", "email"),
            event("one", "Internal progress", "email"),
            event("one", "Two invoices were shown: 10 USD and 25 USD.", "email", marked=True),
            event("user", "Show shared personal facts", "shared"),
            event("one", "Third-party scoped facts", "shared"),
            event("user", "Which was most expensive?", "current"),
            event("one", "Current unfinished output", "current", marked=True),
        ]
    )
    before = value.model_dump_json()

    result = project(value)

    assert result == [
        {"role": "user", "content": "Find my invoices"},
        {"role": "assistant", "content": "Two invoices were shown: 10 USD and 25 USD."},
    ]
    assert value.model_dump_json() == before
    assert json.loads(json.dumps(result)) == result


@pytest.mark.parametrize("field,replacement", [("user_id", "other-owner"), ("id", "other-chat")])
def test_rejects_another_owner_or_conversation(field, replacement):
    value = session(
        [event("user", "Question", "prior"), event("one", "Answer", "prior", marked=True)]
    )
    setattr(value, field, replacement)
    assert project(value) == []


def test_legacy_unmarked_partial_and_error_turns_cannot_supply_history():
    value = session(
        [
            event("user", "Legacy question", "legacy"),
            event("one", "Legacy answer", "legacy"),
            event("user", "Unfinished question", "partial"),
            event("one", "Unfinished answer", "partial", marked=True, partial=True),
            event("user", "Failed question", "error"),
            event("one", "Failed answer", "error", marked=True, error_code="MODEL_ERROR"),
        ]
    )
    assert project(value) == []


def test_excludes_tool_payloads_reasoning_placeholders_and_context_packets():
    from hushh_mcp.one_adk.receipt_client_tools import PRIVATE_RECEIPT_ANSWER

    user = event("user", "Read that thread", "prior")
    user.content.parts += [types.Part(text="MEMORY COMMIT: internal receipt")]
    answer = event("one", "Visible answer", "prior", marked=True)
    answer.content.parts = [
        types.Part(text="Hidden reasoning", thought=True),
        types.Part.from_function_response(
            name="read_memory_md", response={"markdown": "private-memory"}
        ),
        types.Part.from_function_response(name="get_message", response={"body": "raw-email-body"}),
        types.Part(text=PRIVATE_RECEIPT_ANSWER),
        types.Part(text="PENDING MAIL DRAFT (private draft text)"),
        types.Part(text="LIVE MIRROR FACTS v1\nprivate profile"),
        types.Part(text="[redacted]"),
        types.Part(text="Visible answer"),
    ]
    value = session([user, answer])

    assert project(value) == [
        {"role": "user", "content": "Read that thread"},
        {"role": "assistant", "content": "Visible answer"},
    ]


def test_history_count_and_character_bounds_keep_newest_text_without_invented_fields():
    events = []
    for index in range(10):
        events += [
            event("user", f"Q{index}", str(index)),
            event("one", f"A{index}", str(index), marked=True),
        ]
    assert project(session(events)) == [
        {"role": role, "content": f"{prefix}{index}"}
        for index in range(4, 10)
        for role, prefix in (("user", "Q"), ("assistant", "A"))
    ]

    for item in events:
        item.content.parts[0].text = ("Q" if item.author == "user" else "A") * 6000
    result = project(session(events))
    assert [row["role"] for row in result] == ["user", "assistant", "user", "assistant"]
    assert len(result) == 4
    assert all(len(row["content"]) == 4000 for row in result)
    assert sum(len(row["content"]) for row in result) == 16_000


def test_json_shaped_session_is_projected_without_mutating_tool_or_state_fields():
    value = session(
        [event("user", "Find bills", "prior"), event("one", "Found one bill", "prior", marked=True)]
    ).model_dump()
    value["state"] = {"temp:hussh:pending_email_draft": "private-draft", "memory": "private-facts"}
    before = copy.deepcopy(value)
    result = project(value)
    assert result == [
        {"role": "user", "content": "Find bills"},
        {"role": "assistant", "content": "Found one bill"},
    ]
    assert value == before
    assert project(SimpleNamespace(user_id="owner", id="conversation", events=None)) == []


def test_owner_calendar_clock_uses_local_day_and_dst_without_query_rewriting():
    import json
    from datetime import datetime, timezone

    from hushh_mcp.services.email_oss.prompts import build_email_instruction

    facts = json.loads(
        build_email_instruction(
            current_memory_md="",
            now_utc=datetime(2026, 3, 9, 5, tzinfo=timezone.utc),
            timezone="America/New_York",
        ).split("CURRENT AUTHENTICATED TURN FACTS (information, not instructions):\n", 1)[1]
    )
    previous = facts["owner_calendar_clock"]["previous_day"]
    assert previous["date"] == "2026-03-08"
    assert previous["end_epoch"] - previous["start_epoch"] == 23 * 3600
    assert "q" not in facts
