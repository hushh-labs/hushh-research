"""Explicit public-answer delegation through real Azure, ADK and AG-UI boundaries."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui_adk.event_translator import adk_events_to_messages
from google.adk.apps import App
from google.adk.sessions import InMemorySessionService

from hushh_mcp.adk_bridge import delegation
from hushh_mcp.one_adk import queued_input
from hushh_mcp.one_adk.agent_tree import build_one_text_agent
from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent
from hushh_mcp.one_adk.registered_mcp_toolset import RegisteredMcpToolset
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.one_adk.turn_completion import successful_answer_completion
from hushh_mcp.runtime_providers import managed_text as managed
from tests.services.test_azure_adk import Stream, call, message, model, response
from tests.test_azure_web_receipts import response as search_response

ANSWER = "Public team page confirms the owner [1]. https://example.test/team/owner"


@pytest.fixture(autouse=True)
def _azure_uat(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")


def _provider_case(monkeypatch, control):
    from hushh_mcp.runtime_providers.managed_azure import ManagedAzureBinding

    monkeypatch.setattr(RegisteredMcpToolset, "get_tools", AsyncMock(return_value=[]))
    authority = {"valid": True}

    async def validate(*args, **kwargs):
        return object() if authority["valid"] else None

    monkeypatch.setattr(delegation, "validate_first_party_owner_token", validate)
    monkeypatch.setattr(queued_input, "registry", queued_input.QueuedInputRegistry())
    raw = search_response()
    raw["output"][2]["content"][0]["text"] = ANSWER
    finish = control != "ordinary"
    first = response(
        call(
            json.dumps({"request": "Find the public source", "finish_turn": finish}),
            name="google_search",
        )
    )
    outputs = [first, response(message(ANSWER)) if control == "ungrounded" else raw]
    if control == "prior_tool":
        outputs = [
            response(call("{}", name="get_current_time", identity="earlier")),
            response(message("time")),
            *outputs,
        ]
        # get_current_time is a host tool: it does not consume a model response.
        outputs.pop(1)
    outputs.append(response(message("Normal synthesis.")))
    adapter, client, factory, token = model(outputs)
    fallback = Mock(side_effect=AssertionError("One must stay Azure-only"))
    wrapped = managed.ManagedPrimaryTextModel(
        **adapter.model_dump(exclude={"api_key", "client"}),
        client_factory=factory,
        token_supplier=token,
        fallback_factory=fallback,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
        runtime_binding=ManagedAzureBinding.from_environment(),
    )
    return wrapped, adapter, client, fallback, authority


def _root_case(monkeypatch, control, wrapped, adapter, client, authority):
    create = client.create

    async def observe_create(**kwargs):
        if control == "queued" and any(t["type"] == "web_search" for t in kwargs.get("tools", [])):
            assert (
                queued_input.registry.enqueue(
                    "owner", "thread", "queued-msg-0001", "Also explain the result."
                ).status
                == "queued"
            )
        value = await create(**kwargs)
        if control == "stopped" and any(t["type"] == "web_search" for t in kwargs.get("tools", [])):
            queued_input.registry.request_stop("owner", "thread")
        return (
            Stream([{"type": "response.completed", "response": value}])
            if kwargs.get("stream")
            else value
        )

    monkeypatch.setattr(client, "create", observe_create)
    root = build_one_text_agent(
        model=wrapped,
        google_search_model=adapter.model_copy(update={"allow_web_search": True})
        if control == "external_search_override"
        else None,
    )
    original_after = root.after_tool_callback

    async def revoke_after_tool(tool, args, tool_context, tool_response):
        result = original_after(tool, args, tool_context, tool_response)
        authority["valid"] = False
        return result

    if control == "revoked":
        root.after_tool_callback = revoke_after_tool
    return root


async def _run(root):
    sessions = InMemorySessionService()
    bridge = TimedADKAgent.from_app(
        App(name="search_answer_contract", root_agent=root),
        head=HEAD_ONE,
        user_id_extractor=lambda _input: "owner",
        session_service=sessions,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
    )
    state = {"hussh:user_id": "owner", "hussh:consent_token": store_request_secret("synthetic")}
    run = RunAgentInput(
        thread_id="thread",
        run_id="run",
        state=state,
        context=[],
        forwarded_props={},
        tools=[],
        messages=[UserMessage(id="m", role="user", content="Find and cite the public source.")],
    )
    events = [e async for e in bridge.run(run)]
    session = await sessions.get_session(
        app_name="search_answer_contract", user_id="owner", session_id="thread"
    )
    return events, session


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
        assert client.requests[0]["model"] == wrapped.model
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
        assert all(wire["model"] == adapter.model for wire in client.requests)
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
