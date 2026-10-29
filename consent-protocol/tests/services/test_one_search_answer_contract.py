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


async def _run(root, observe=None, *, owner="owner", thread="thread"):
    sessions = InMemorySessionService()
    bridge = TimedADKAgent.from_app(
        App(name="search_answer_contract", root_agent=root),
        head=HEAD_ONE,
        user_id_extractor=lambda _input: owner,
        session_service=sessions,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
    )
    state = {"hussh:user_id": owner, "hussh:consent_token": store_request_secret("synthetic")}
    run = RunAgentInput(
        thread_id=thread,
        run_id="run",
        state=state,
        context=[],
        forwarded_props={},
        tools=[],
        messages=[UserMessage(id="m", role="user", content="Find and cite the public source.")],
    )
    events = []
    async for event in bridge.run(run):
        events.append(event)
        if observe is not None:
            await observe(event)
    session = await sessions.get_session(
        app_name="search_answer_contract", user_id=owner, session_id=thread
    )
    return events, session


@pytest.mark.parametrize("finish", [False, True])
async def test_configured_vertex_search_preserves_native_grounding_and_chat_completion(
    monkeypatch, finish
):
    from google.adk.models.llm_response import LlmResponse
    from google.adk.tools.google_search_tool import GoogleSearchTool
    from google.genai import types

    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.delenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", raising=False)
    monkeypatch.setattr(RegisteredMcpToolset, "get_tools", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        delegation, "validate_first_party_owner_token", AsyncMock(return_value=object())
    )
    monkeypatch.setattr(queued_input, "registry", queued_input.QueuedInputRegistry())
    requests = []

    async def generate(req, stream=False):
        requests.append(req.model_copy(deep=True))
        if len(requests) == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                id="native-search",
                                name="google_search",
                                args={
                                    "request": "Find the public source",
                                    "finish_turn": finish,
                                },
                            ),
                            thought_signature=b"synthetic-native-search",
                        )
                    ],
                ),
                partial=False,
                turn_complete=True,
            )
        elif len(requests) == 2:
            assert any(tool.google_search is not None for tool in req.config.tools)
            if stream:
                yield LlmResponse(
                    content=types.Content(role="model", parts=[types.Part(text=ANSWER)]),
                    partial=True,
                )
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text=ANSWER)]),
                partial=False,
                turn_complete=True,
                grounding_metadata=types.GroundingMetadata(
                    grounding_chunks=[
                        types.GroundingChunk(
                            web=types.GroundingChunkWeb(
                                uri="https://example.test/team/owner", title="Synthetic source"
                            )
                        )
                    ]
                ),
            )
        else:
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text="Normal synthesis.")]),
                partial=False,
                turn_complete=True,
            )

    native = SimpleNamespace(
        model=resolve_fleet_model_name("gemini-default"), generate_content_async=generate
    )
    monkeypatch.setattr(ManagedGeminiRuntimeBinding, "build_adk_model", lambda *a, **k: native)
    wrapped = managed.build_managed_text_model(scope="one_text_chat")
    root = build_one_text_agent(model=wrapped)
    child = next(
        tool.agent for tool in root.tools if getattr(tool, "name", None) == "google_search"
    )
    assert type(child.tools[0]) is GoogleSearchTool
    events, session = await _run(root)
    text = "".join(event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT)
    expected = ANSWER if finish else "Normal synthesis."
    assert text == expected
    assert [
        message.content
        for message in adk_events_to_messages(session.events)
        if message.role == "assistant" and message.content
    ] == [expected]
    assert len(requests) == (2 if finish else 3)
    assert all(req.model == native.model for req in requests)
    assert sum(event.type == EventType.RUN_FINISHED for event in events) == 1
    assert not any(event.type == EventType.RUN_ERROR for event in events)


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
    "kind", ["one_search_preview_v1", "one_search_result_v1", "one_delegated_search_answer_v1"]
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
