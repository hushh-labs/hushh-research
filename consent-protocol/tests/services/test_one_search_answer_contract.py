"""Explicit public-answer delegation through real Azure, ADK and AG-UI boundaries."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from ag_ui.core import EventType
from ag_ui_adk.event_translator import adk_events_to_messages

from hushh_mcp.one_adk import queued_input
from hushh_mcp.one_adk.turn_completion import successful_answer_completion
from hushh_mcp.runtime_providers import managed_text as managed

# Publication cases share this owner's existing Azure autouse fixture.
from tests.email_oss_cases.publication import (
    test_complete_email_answer_publishes_exact_durable_text_without_root_resynthesis as test_complete_email_answer_publishes_exact_durable_text_without_root_resynthesis,
)
from tests.email_oss_cases.publication import (
    test_email_native_deltas_arrive_before_completion_without_duplicate_final_text as test_email_native_deltas_arrive_before_completion_without_duplicate_final_text,
)
from tests.helpers.one_search_cases import (
    ANSWER,
)
from tests.helpers.one_search_cases import (
    _azure_uat as _azure_uat,
)
from tests.helpers.one_search_cases import (
    _provider_case as _provider_case,
)
from tests.helpers.one_search_cases import (
    _root_case as _root_case,
)
from tests.helpers.one_streaming import run_agent_chat as _run
from tests.services.test_azure_adk import Stream, call, response
from tests.test_azure_web_receipts import response as search_response


def _observe_pending_handoff(monkeypatch, authority):
    from hushh_mcp.one_adk.search_answer import OneSearchAnswerAgent
    from hushh_mcp.one_adk.turn_completion import newest_turn_pending

    original = OneSearchAnswerAgent._require_publication
    checks = []

    async def observe(self, ctx):
        checks.append(True)
        if len(checks) == 2:
            assert ctx.session.events[-1].get_function_responses()
            assert newest_turn_pending(ctx.session.events)
            authority["pending_seen"] = True
        await original(self, ctx)

    monkeypatch.setattr(OneSearchAnswerAgent, "_require_publication", observe)


@pytest.mark.parametrize(
    "control",
    [
        "finish",
        "ordinary",
        "queued",
        "stopped",
        "prior_tool",
        "ungrounded",
        "revoked",
        "external_search_override",
    ],
)
async def test_explicit_search_answer_agui_live_and_recovered_history_agree(monkeypatch, control):
    wrapped, adapter, client, fallback, authority = _provider_case(monkeypatch, control)
    root = _root_case(monkeypatch, control, wrapped, adapter, client, authority)
    if control == "finish":
        _observe_pending_handoff(monkeypatch, authority)
    events, session = await _run(root)
    text = "".join(e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT)
    recovered = adk_events_to_messages(session.events)
    assistant_text = [m.content for m in recovered if m.role == "assistant" and m.content]
    if control == "revoked":
        assert not text and ANSWER not in assistant_text
        assert sum(e.type == EventType.RUN_ERROR for e in events) == 1
        assert not any(e.type == EventType.TOOL_CALL_RESULT for e in events)
        assert len(client.requests) == 2
    elif control == "stopped":
        assert text == queued_input.STOPPED_ANSWER and ANSWER not in assistant_text
        assert len(client.requests) == 2
    elif control == "finish":
        assert authority["pending_seen"] is True
        assert text == ANSWER and assistant_text == [ANSWER]
        assert len(client.requests) == 2
        final = session.events[-1]
        assert (
            final.grounding_metadata.grounding_chunks[0].web.uri
            == "https://example.test/team/owner"
        )
        assert successful_answer_completion(final, session.events)
        assert sum(e.type == EventType.RUN_FINISHED for e in events) == 1
        assert not any(e.type == EventType.RUN_ERROR for e in events)
        search_wire = client.requests[1]
        assert search_wire["tools"][0]["search_context_size"] == "low"
        assert search_wire["model"] == "one-search-gpt-54-mini-eval"
        assert search_wire["reasoning"] == {"effort": "none"}
        assert client.requests[0]["model"] == managed.one_chat_root_model(wrapped).model
        assert "Find the public source" in str(search_wire["input"])
        assert "finish_turn" not in str(search_wire["input"])
    else:
        assert text == "Normal synthesis." and assistant_text == ["Normal synthesis."]
        assert len(client.requests) == (4 if control == "prior_tool" else 3)
    assert client.closed == len(client.requests)
    assert all(r["store"] is False for r in client.requests)
    fallback.assert_not_called()
    original = next(tool for tool in root.tools if tool.name == "google_search")
    assert original.agent.model.web_search_context_size is None
    if control in {"ordinary", "prior_tool", "external_search_override"}:
        search_wire = next(
            w for w in client.requests if any(t["type"] == "web_search" for t in w.get("tools", []))
        )
        assert search_wire["model"] == adapter.model
        assert all(
            "search_context_size" not in tool
            for wire in client.requests
            for tool in wire.get("tools", [])
        )


async def test_search_answer_wrapper_closes_sdk_stream_on_reader_cancellation(monkeypatch):
    from google.adk.events import Event

    from hushh_mcp.one_adk.search_answer import _ANSWER, OneSearchAnswerAgent
    from hushh_mcp.runtime_providers.managed_text import ManagedTextAgent

    closed = []

    async def sdk_stream(self, ctx):
        try:
            yield Event(author="one", invocation_id=ctx.invocation_id)
        finally:
            closed.append(True)

    monkeypatch.setattr(ManagedTextAgent, "_run_async_impl", sdk_stream)
    root = OneSearchAnswerAgent(name="one", model="synthetic")
    stream = root._run_async_impl(SimpleNamespace(invocation_id="cancelled"))
    await anext(stream)
    await stream.aclose()
    assert closed == [True] and _ANSWER.get() is None


async def test_compact_and_ordinary_searches_share_no_mutable_model_configuration(monkeypatch):
    import asyncio

    from google.adk.tools.agent_tool import AgentTool

    from hushh_mcp.one_adk.search_answer import _ANSWER, SearchAnswerTool, _Answer
    from hushh_mcp.runtime_providers.managed_text import ManagedTextAgent

    wrapped, _, _, _, _ = _provider_case(monkeypatch, "finish")
    tool = SearchAnswerTool(agent=ManagedTextAgent(name="google_search", model=wrapped))
    barrier = asyncio.Barrier(2)
    observed = {}

    async def dispatch(self, *, args, tool_context):
        await barrier.wait()
        observed[args["request"]] = (
            self.agent.model.model,
            self.agent.model.web_search_context_size,
            self.agent.model.default_reasoning_effort,
        )
        return "unpublished synthetic result"

    monkeypatch.setattr(AgentTool, "run_async", dispatch)

    async def invoke(finish):
        event = SimpleNamespace(
            invocation_id="i",
            partial=False,
            author="one",
            content=None,
            get_function_calls=lambda: [SimpleNamespace(name="google_search")],
        )
        ctx = SimpleNamespace(
            state={},
            _invocation_context=SimpleNamespace(
                invocation_id="i", session=SimpleNamespace(events=[event])
            ),
        )
        token = _ANSWER.set(_Answer("i"))
        try:
            await tool.run_async(
                args={"request": str(finish), "finish_turn": finish}, tool_context=ctx
            )
        finally:
            _ANSWER.reset(token)

    await asyncio.gather(invoke(True), invoke(False))
    assert observed == {
        "True": ("one-search-gpt-54-mini-eval", "low", "none"),
        "False": (wrapped.model, None, wrapped.default_reasoning_effort),
    }
    assert tool.agent.model.web_search_context_size is None


@pytest.mark.parametrize(
    "control",
    [
        "finish",
        "multipart",
        "missing_citation",
        "mismatch",
        "callback_rewrite",
        "queued",
        "stopped",
        "revoked",
    ],
)
async def test_search_deltas_precede_completion_and_only_valid_final_enters_history(
    monkeypatch, control
):
    import asyncio

    wrapped, adapter, client, fallback, authority = _provider_case(monkeypatch, "finish")
    root = _root_case(monkeypatch, "finish", wrapped, adapter, client, authority)
    from tests.services._one_search_stream import install_gated_search

    release, closed, completed, prefix = install_gated_search(
        monkeypatch, client, control, root=root
    )
    early = []

    async def observe(event):
        if event.type != EventType.TEXT_MESSAGE_CONTENT or early:
            return
        assert event.delta == prefix and not completed
        early.append(True)
        if control == "queued":
            assert (
                queued_input.registry.enqueue(
                    "owner", "thread", "later-message-001", "Also explain that."
                ).status
                == "returned"
            )
        elif control == "stopped":
            queued_input.registry.request_stop("owner", "thread")
        elif control == "revoked":
            authority["valid"] = False
        release.set()

    events, session = await asyncio.wait_for(_run(root, observe), timeout=5)
    assert early and closed
    recovered = adk_events_to_messages(session.events)
    answers = [m.content for m in recovered if m.role == "assistant" and m.content]
    text = "".join(e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT)
    if control in {"finish", "queued", "multipart"}:
        expected = ANSWER + ("\nAdditional public detail." if control == "multipart" else "")
        assert text == expected and answers == [expected]
        assert sum(e.type == EventType.RUN_FINISHED for e in events) == 1
        assert successful_answer_completion(session.events[-1], session.events)
    else:
        assert ANSWER not in answers
        assert not any(
            e.custom_metadata and e.custom_metadata.get("kind") == "one_delegated_search_answer_v1"
            for e in session.events
        )
        if control != "stopped":
            assert any(e.type == EventType.RUN_ERROR for e in events)
    assert len(client.requests) == 2
    fallback.assert_not_called()


async def test_concurrent_search_streams_keep_owner_text_and_history_isolated(monkeypatch):
    import asyncio

    barrier = asyncio.Barrier(2)
    cases = []
    for owner in ("owner-first", "owner-second"):
        wrapped, adapter, client, _, authority = _provider_case(monkeypatch, "finish")
        root = _root_case(monkeypatch, "finish", wrapped, adapter, client, authority)
        answer = ANSWER + " " + owner
        raw = search_response()
        raw["output"][2]["content"][0]["text"] = answer
        client.outputs = iter(
            [
                response(
                    call(
                        json.dumps({"request": "Find the source", "finish_turn": True}),
                        name="google_search",
                    )
                ),
                raw,
            ]
        )
        create = client.create

        async def streaming_create(_create=create, _answer=answer, **kwargs):
            value = await _create(**kwargs)
            if any(t["type"] == "web_search" for t in kwargs.get("tools", [])):
                await barrier.wait()
                return Stream(
                    [
                        {"type": "response.output_text.delta", "delta": _answer},
                        {"type": "response.completed", "response": raw_for(_answer)},
                    ]
                )
            return value

        monkeypatch.setattr(client, "create", streaming_create)
        cases.append((owner, root, answer))

    def raw_for(answer):
        raw = search_response()
        raw["output"][2]["content"][0]["text"] = answer
        return raw

    results = await asyncio.wait_for(
        asyncio.gather(*(_run(root, owner=owner) for owner, root, _ in cases)), timeout=5
    )
    for (_, _, answer), (events, session) in zip(cases, results, strict=True):
        assert (
            "".join(e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT) == answer
        )
        assert [
            m.content
            for m in adk_events_to_messages(session.events)
            if m.role == "assistant" and m.content
        ] == [answer]


@pytest.mark.parametrize(
    "kind",
    [
        "one_search_preview_v1",
        "one_search_result_v1",
        "one_delegated_search_answer_v1",
        "one_email_preview_v1",
        "one_delegated_email_answer_v1",
    ],
)
async def test_search_publications_revalidate_authority_after_crossing_queue(monkeypatch, kind):
    from google.adk.events import Event

    from hushh_mcp.one_adk.search_answer import _ANSWER, OneSearchAnswerAgent

    async def produce(self, ctx, handoff):
        yield Event(author="one", invocation_id=ctx.invocation_id, custom_metadata={"kind": kind})

    async def denied(self, ctx):
        raise PermissionError("Synthetic authority ended before publication")

    monkeypatch.setattr(OneSearchAnswerAgent, "_answer_events", produce)
    monkeypatch.setattr(OneSearchAnswerAgent, "_require_publication", denied)
    agent = OneSearchAnswerAgent(name="one", model="synthetic")
    stream = agent._run_async_impl(SimpleNamespace(invocation_id="revoked-publication"))
    with pytest.raises(PermissionError):
        await anext(stream)
    assert _ANSWER.get() is None


async def test_cancelled_search_joins_producer_with_full_preview_queue(monkeypatch):
    import asyncio

    from google.adk.events import Event

    from hushh_mcp.one_adk.search_answer import _ANSWER, OneSearchAnswerAgent, _Publication

    filled = asyncio.Event()
    closed = []

    async def produce(self, ctx, handoff):
        try:
            yield Event(author="one", invocation_id=ctx.invocation_id)
            for _ in range(100):
                await handoff.queue.put(
                    _Publication(
                        Event(
                            author="one",
                            invocation_id=ctx.invocation_id,
                            custom_metadata={"kind": "one_search_preview_v1"},
                            partial=True,
                        )
                    )
                )
                if handoff.queue.full():
                    filled.set()
        finally:
            closed.append(True)

    monkeypatch.setattr(OneSearchAnswerAgent, "_answer_events", produce)
    monkeypatch.setattr(OneSearchAnswerAgent, "_require_publication", AsyncMock())
    agent = OneSearchAnswerAgent(name="one", model="synthetic")
    stream = agent._run_async_impl(SimpleNamespace(invocation_id="reader-left"))
    await anext(stream)
    await anext(stream)
    await asyncio.wait_for(filled.wait(), timeout=1)
    await asyncio.wait_for(stream.aclose(), timeout=1)
    assert closed == [True] and _ANSWER.get() is None
