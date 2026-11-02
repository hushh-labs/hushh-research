"""Explicit public-answer delegation through real Azure, ADK and AG-UI boundaries."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from ag_ui.core import EventType
from ag_ui_adk.event_translator import adk_events_to_messages

from hushh_mcp.one_adk import queued_input
from hushh_mcp.one_adk.turn_completion import successful_answer_completion
from tests.services.test_azure_adk import call, message, response
from tests.services.test_one_search_answer_contract import _azure_uat as _azure_uat
from tests.services.test_one_search_answer_contract import (
    _provider_case,
    _root_case,
    _run,
)


@pytest.mark.parametrize("control", ["sole", "compound", "incomplete", "revoked"])
async def test_complete_email_answer_publishes_exact_durable_text_without_root_resynthesis(
    monkeypatch, control
):
    from hushh_mcp.one_adk import agent_tree
    from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
    from hushh_mcp.one_adk.search_answer import OneSearchAnswerAgent
    from hushh_mcp.services import connector_feature_admission

    email_answer = "Found two invoices. One amount is unavailable; the known total is $42.00."
    wrapped, adapter, client, fallback, authority = _provider_case(monkeypatch, "email")
    calls = [
        call(
            json.dumps({"request": "Find invoices from the last seven days"}),
            name="ask_email_agent",
            identity="email-call",
        )
    ]
    if control == "compound":
        calls.append(call("{}", name="get_current_time", identity="clock-call"))
    client.outputs = iter([response(*calls), response(message("Combined root answer."))])
    specialist = AsyncMock(
        return_value={"status": "ok", "text": email_answer, "is_complete": control != "incomplete"}
    )
    monkeypatch.setattr(agent_tree, "_specialist_turn", specialist)
    monkeypatch.setattr(
        connector_feature_admission, "connector_feature_enabled", lambda *_args: True
    )
    root = _root_case(monkeypatch, control, wrapped, adapter, client, authority)
    root.tools = [agent_tree.ask_email_agent, agent_tree.get_current_time]
    publication_checks = []
    original = OneSearchAnswerAgent._require_publication

    async def observe_publication(self, ctx):
        publication_checks.append(True)
        await original(self, ctx)

    monkeypatch.setattr(OneSearchAnswerAgent, "_require_publication", observe_publication)
    events, session = await _run(root, extra_state={STATE_EXECUTION_SURFACE: "typed_chat"})
    live_text = "".join(
        event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT
    )
    recovered = adk_events_to_messages(session.events)
    durable_text = [row.content for row in recovered if row.role == "assistant" and row.content]
    function_results = [
        item
        for event in session.events
        for item in event.get_function_responses() or []
        if item.name == "ask_email_agent"
    ]
    assert specialist.await_count == 1
    # A FunctionTool preserves the dictionary itself; it is not AgentTool's
    # {"result": text} wrapper. The exact native response remains correlated.
    if control != "revoked":
        assert function_results[0].id == "email-call"
        assert function_results[0].response["text"] == email_answer
        assert "result" not in function_results[0].response
    if control == "sole":
        assert live_text == email_answer and durable_text == [email_answer]
        assert len(client.requests) == 1
        assert len(publication_checks) == 1
        final = session.events[-1]
        assert final.author == "one" and final.content.role == "model"
        assert final.custom_metadata["kind"] == "one_delegated_email_answer_v1"
        assert successful_answer_completion(final, session.events)
        assert sum(event.type == EventType.RUN_FINISHED for event in events) == 1
        assert not any(event.type == EventType.RUN_ERROR for event in events)
    elif control == "revoked":
        assert not live_text and email_answer not in durable_text
        assert len(client.requests) == 1 and len(publication_checks) == 1
        assert any(event.type == EventType.RUN_ERROR for event in events)
    else:
        assert live_text == "Combined root answer." and durable_text == ["Combined root answer."]
        assert len(client.requests) == 2 and not publication_checks
    assert client.closed == len(client.requests)
    fallback.assert_not_called()


def _email_stream_case(monkeypatch, control):
    import asyncio

    from hushh_mcp.one_adk import agent_tree
    from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
    from hushh_mcp.one_adk.search_answer import publish_email_preview
    from hushh_mcp.services import connector_feature_admission

    prefix, suffix = (
        "I checked the invoices. ",
        "One readable amount is $42.00; one PDF is unresolved.",
    )
    if control == "connect_required":
        prefix, suffix = (
            "Gmail is not connected. ",
            "Connect Gmail before I can read these invoices.",
        )
    answer = prefix + suffix
    wrapped, adapter, client, fallback, authority = _provider_case(monkeypatch, "email")
    calls = [
        call(
            json.dumps({"request": "Find last week's invoices"}),
            name="ask_email_agent",
            identity="email-call",
        )
    ]
    if control == "compound":
        calls.append(call("{}", name="get_current_time", identity="clock-call"))
    client.outputs = iter([response(*calls), response(message("Combined root answer."))])
    release = asyncio.Event()
    completed, relayed, early = [], [], []

    async def specialist(agent_id, request, tool_context):
        relayed.append(await publish_email_preview(tool_context, prefix))
        if relayed[-1]:
            await release.wait()
            if control != "suffix":
                await publish_email_preview(tool_context, suffix)
        completed.append(True)
        return {
            "status": control if control in {"connect_required", "unavailable"} else "ok",
            "text": "Changed answer." if control == "mismatch" else answer,
            "is_complete": control != "incomplete",
        }

    monkeypatch.setattr(agent_tree, "_specialist_turn", specialist)
    monkeypatch.setattr(
        connector_feature_admission, "connector_feature_enabled", lambda *_args: True
    )
    root = _root_case(monkeypatch, "email", wrapped, adapter, client, authority)
    root.tools = [agent_tree.ask_email_agent, agent_tree.get_current_time]

    return SimpleNamespace(
        root=root,
        prefix=prefix,
        answer=answer,
        authority=authority,
        completed=completed,
        relayed=relayed,
        early=early,
        release=release,
        client=client,
        fallback=fallback,
        surface=STATE_EXECUTION_SURFACE,
    )


@pytest.mark.parametrize(
    "control",
    [
        "complete",
        "compound",
        "revoked",
        "mismatch",
        "suffix",
        "stopped",
        "queued",
        "connect_required",
        "unavailable",
        "incomplete",
    ],
)
async def test_email_native_deltas_arrive_before_completion_without_duplicate_final_text(
    monkeypatch, control
):
    import asyncio

    case = _email_stream_case(monkeypatch, control)

    async def observe(event):
        if event.type != EventType.TEXT_MESSAGE_CONTENT or case.early or control == "compound":
            return
        assert event.delta == case.prefix and not case.completed
        case.early.append(True)
        if control == "revoked":
            case.authority["valid"] = False
        elif control == "stopped":
            queued_input.registry.request_stop("owner", "thread")
        elif control == "queued":
            assert (
                queued_input.registry.enqueue(
                    "owner", "thread", "email-later-message", "Also explain the coverage."
                ).status
                == "returned"
            )
        case.release.set()

    events, session = await asyncio.wait_for(
        _run(case.root, observe, extra_state={case.surface: "typed_chat"}), timeout=5
    )
    live = "".join(event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT)
    durable = [
        row.content
        for row in adk_events_to_messages(session.events)
        if row.role == "assistant" and row.content
    ]
    if control == "compound":
        assert case.relayed == [False] and not case.early
        assert live == "Combined root answer." and durable == [live]
        assert len(case.client.requests) == 2
    else:
        assert case.relayed == [True] and case.early and len(case.client.requests) == 1
        if control in {"complete", "suffix", "queued", "connect_required"}:
            assert live == case.answer and durable == [case.answer]
            assert sum(event.type == EventType.RUN_FINISHED for event in events) == 1
            assert successful_answer_completion(session.events[-1], session.events)
        else:
            assert not durable and "Changed answer." not in live
            assert not any(
                (event.custom_metadata or {}).get("kind") == "one_delegated_email_answer_v1"
                for event in session.events
            )
            if control != "stopped":
                assert any(event.type == EventType.RUN_ERROR for event in events)
    case.fallback.assert_not_called()
