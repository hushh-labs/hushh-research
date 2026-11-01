"""One Azure search, processor and stream-lifecycle regression contracts."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from google.genai import types

from tests.services.test_azure_adk import Stream, call, message, model, request, response


@pytest.fixture
async def advance_model_clock(monkeypatch):
    import asyncio

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")
    loop = asyncio.get_running_loop()
    original = loop.time
    elapsed = 0.0
    monkeypatch.setattr(loop, "time", lambda: original() + elapsed)

    async def advance(seconds):
        nonlocal elapsed
        elapsed += seconds
        pending = loop.create_future()
        loop.call_soon(pending.set_result, None)
        await pending

    return advance


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("reason", ["content_filter", "max_output_tokens", None, "unknown"])
async def test_explicit_filtered_output_is_a_refusal_without_accepting_other_incomplete_output(
    caplog, stream, reason
):
    import logging

    from hushh_mcp.runtime_providers.azure_call_lifecycle import AzureContentFilteredError

    incomplete = response(message("Synthetic partial text"))
    incomplete.status = "incomplete"
    incomplete.incomplete_details = SimpleNamespace(reason=reason)
    events = Stream(
        [
            {"type": "response.output_text.delta", "delta": "Synthetic partial text"},
            {"type": "response.incomplete", "response": incomplete},
        ]
    )
    adapter, client, _, _ = model([events if stream else incomplete])
    caplog.set_level(logging.INFO, logger="hushh_mcp.runtime_providers.azure_adk")
    seen = []
    expected = AzureContentFilteredError if reason == "content_filter" else ValueError
    with pytest.raises(expected):
        async for item in adapter.generate_content_async(request(), stream=stream):
            seen.append(item)
    assert all(item.partial for item in seen)
    assert len(client.requests) == 1 and client.closed == 1
    assert not stream or events.closed
    telemetry = next(
        r.getMessage() for r in caplog.records if "azure_model_call_complete" in r.message
    )
    assert f"error_kind={'filtered' if reason == 'content_filter' else 'protocol'}" in telemetry
    assert "Synthetic partial text" not in telemetry


@pytest.mark.parametrize("event_type", ["error", "response.failed"])
async def test_provider_failure_cannot_masquerade_as_a_filter_refusal(event_type):
    failed = response(message("Partial"))
    failed.status = "incomplete"
    failed.incomplete_details = SimpleNamespace(reason="content_filter")
    events = Stream([{"type": event_type, "response": failed}])
    adapter, _, _, _ = model([events])
    with pytest.raises(ValueError):
        _ = [item async for item in adapter.generate_content_async(request(), stream=True)]
    assert events.closed


@pytest.mark.parametrize(
    "code", ["content_filter", "rate_limit_exceeded", "invalid_encrypted_content", None, {}]
)
@pytest.mark.parametrize("partial", [False, True])
async def test_actual_sdk_sse_errors_preserve_failure_codes_without_inspecting_text(
    caplog, code, partial
):
    import json
    import logging

    import httpx
    from openai import APIError, AsyncOpenAI

    from hushh_mcp.runtime_providers.azure_call_lifecycle import (
        AzureContentFilteredError,
        AzureRateLimitedError,
    )

    calls = []

    async def send(req):
        calls.append(req)
        frames = (
            [
                {
                    "type": "response.output_text.delta",
                    "delta": "Partial",
                    "sequence_number": 0,
                    "item_id": "synthetic",
                    "output_index": 0,
                    "content_index": 0,
                    "logprobs": [],
                },
            ]
            if partial
            else []
        )
        frames.append({"error": {"code": code, "message": "Untrusted content_filter wording"}})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content="".join("data: " + json.dumps(frame) + "\n\n" for frame in frames),
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(send))
    adapter, _, _, _ = model([])
    adapter.client_factory = lambda **kw: AsyncOpenAI(**kw, http_client=http)
    caplog.set_level(logging.INFO, logger="hushh_mcp.runtime_providers.azure_adk")
    seen = []
    expected = (
        AzureContentFilteredError
        if code == "content_filter"
        else AzureRateLimitedError
        if code == "rate_limit_exceeded"
        else APIError
    )
    with pytest.raises(expected):
        async for item in adapter.generate_content_async(request(), stream=True):
            seen.append(item)
    assert len(calls) == 1 and http.is_closed
    assert len(seen) == int(partial) and all(item.partial for item in seen)
    telemetry = next(
        r.getMessage() for r in caplog.records if "azure_model_call_complete" in r.message
    )
    assert ("error_kind=filtered" in telemetry) is (code == "content_filter")
    assert ("error_kind=quota" in telemetry) is (code == "rate_limit_exceeded")
    assert "status=0" in telemetry
    if code == "rate_limit_exceeded":
        assert "provider_code=rate.limit" in telemetry
    assert "Untrusted content_filter wording" not in telemetry


@pytest.mark.parametrize("status", [400, 401, 403, 429, 500, 503])
async def test_http_error_status_takes_precedence_over_stream_quota_code(caplog, status):
    import logging

    import httpx
    from openai import APIStatusError, AsyncOpenAI

    calls = []

    async def send(req):
        calls.append(req)
        return httpx.Response(
            status,
            json={"error": {"code": "rate_limit_exceeded", "message": "Private provider body"}},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(send))
    adapter, _, _, _ = model([])
    adapter.client_factory = lambda **kw: AsyncOpenAI(**kw, http_client=http)
    caplog.set_level(logging.INFO, logger="hushh_mcp.runtime_providers.azure_adk")
    with pytest.raises(APIStatusError) as failure:
        _ = [item async for item in adapter.generate_content_async(request(), stream=True)]
    assert failure.value.status_code == status and len(calls) == 1 and http.is_closed
    telemetry = next(
        r.getMessage() for r in caplog.records if "azure_model_call_complete" in r.message
    )
    kind = (
        "auth"
        if status in {401, 403}
        else "quota"
        if status == 429
        else "server"
        if status >= 500
        else "other"
    )
    assert f"error_kind={kind}" in telemetry and f"status={status}" in telemetry
    assert "Private provider body" not in telemetry


async def test_managed_minimal_effort_preserves_explicit_specialist_reasoning():
    adapter, client, _, _ = model([response(message("first")), response(message("second"))])
    adapter.default_reasoning_effort = "minimal"
    for level in ["LOW", "HIGH"]:
        _ = [
            item
            async for item in adapter.generate_content_async(
                request(thinking_config=types.ThinkingConfig(thinking_level=level))
            )
        ]
    assert [r["reasoning"]["effort"] for r in client.requests] == ["minimal", "high"]
    assert client.requests[0]["parallel_tool_calls"] is False


async def test_managed_owner_guard_preserves_validation_outage_as_actionable(monkeypatch):
    from hushh_mcp.adk_bridge.delegation import OwnerTokenValidationUnavailable
    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")

    async def unavailable():
        raise OwnerTokenValidationUnavailable("Owner authority validation unavailable")

    base, _, _, _ = model([])
    wrapped = managed.ManagedPrimaryTextModel(
        **base.model_dump(exclude={"api_key", "client"}),
        token_supplier=lambda: "synthetic",
        require_current=unavailable,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
    )
    with pytest.raises(OwnerTokenValidationUnavailable):
        await wrapped._require_current()


@pytest.mark.parametrize("delayed_call", [1, 2])
async def test_managed_one_sse_allows_bounded_search_and_post_tool_first_output(
    monkeypatch, delayed_call, advance_model_clock
):
    from functools import partial

    from google.adk.agents.run_config import RunConfig, StreamingMode

    from hushh_mcp.adk_bridge import delegation
    from hushh_mcp.hushh_adk import turn
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent
    from hushh_mcp.one_adk.registered_mcp_toolset import RegisteredMcpToolset
    from hushh_mcp.one_adk.request_secrets import store_request_secret
    from hushh_mcp.runtime_providers import managed_text as managed
    from tests.test_azure_web_receipts import response as search_response

    monkeypatch.setattr(managed, "ONE_TOOL_FIRST_OUTPUT_SECONDS", 1.0)

    monkeypatch.setattr(RegisteredMcpToolset, "get_tools", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        delegation, "validate_first_party_owner_token", AsyncMock(return_value=object())
    )

    raw = search_response()
    outputs = [
        response(call('{"request":"Find the public source"}', name="google_search")),
        raw,
        response(message("The source confirms this [1].")),
    ]
    streams = [Stream([{"type": "response.completed", "response": outputs[i]}]) for i in (0, 2)]
    adapter, client, factory, token = model([streams[0], raw, streams[1]])
    create = client.create

    async def delayed_create(**kwargs):
        if len(client.requests) == delayed_call:
            await advance_model_clock(0.12)
        return await create(**kwargs)

    monkeypatch.setattr(client, "create", delayed_create)
    fallback = Mock(side_effect=AssertionError("One must never construct Vertex"))
    wrapped = managed.ManagedPrimaryTextModel(
        **adapter.model_dump(exclude={"api_key", "client"}),
        client_factory=factory,
        token_supplier=token,
        fallback_factory=fallback,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
        primary_seconds=0.05,
    )
    root = build_one_text_agent(model=wrapped)
    child = next(t.agent for t in root.tools if getattr(t, "name", None) == "google_search")
    grounding = []

    async def observe(callback_context, llm_response):
        if llm_response.grounding_metadata:
            grounding.append(llm_response.grounding_metadata)

    child.after_model_callback = observe
    monkeypatch.setattr(turn, "RunConfig", partial(RunConfig, streaming_mode=StreamingMode.SSE))
    state = {"hussh:user_id": "synthetic-reader"}
    state["hussh:consent_token"] = store_request_secret(token())
    result = await turn.run_specialist_adk_turn(
        agent=root,
        app_name="managed_search_regression",
        user_id="synthetic-reader",
        consent_token=token(),
        state=state,
        message="Find and cite the public source.",
        max_llm_calls=3,
    )
    assert len(client.requests) == 3 and client.closed == 3
    assert all(stream.closed for stream in streams)
    assert len(result.tool_calls) == 1
    assert result.final_text == "The source confirms this [1]."
    assert client.requests[0]["stream"] is True and client.requests[2]["stream"] is True
    _assert_compact_search_wire(client.requests)
    assert any(item.get("type") == "function_call_output" for item in client.requests[2]["input"])
    assert grounding[0].grounding_chunks[0].web.uri == "https://example.test/team/owner"
    assert all(r["store"] is False for r in client.requests)
    fallback.assert_not_called()


def _assert_compact_search_wire(requests):
    assert requests[1]["tools"] == [{"type": "web_search", "external_web_access": False}]
    assert tuple(r.get("text", {}).get("verbosity") for r in requests) == (None, "low", None)


@pytest.mark.parametrize("phase", ["fresh", "named_tool", "old_result", "native", "continuation"])
async def test_managed_first_output_phases_remain_bounded_without_replay(
    monkeypatch, phase, advance_model_clock
):
    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setattr(managed, "ONE_TOOL_FIRST_OUTPUT_SECONDS", 0.15)
    function = {"name": "google_search", "id": "call_123"}
    history = [
        {"role": "model", "parts": [{"function_call": {**function, "args": {}}}]},
        {
            "role": "user",
            "parts": [{"function_response": {**function, "response": {"result": "source"}}}],
        },
    ]
    fresh = types.Content(role="user", parts=[types.Part(text="New question")])
    config = {}
    if phase == "native":
        config["tools"] = [types.Tool(google_search=types.GoogleSearch())]
    elif phase == "named_tool":
        config["tools"] = [{"function_declarations": [{"name": "google_search"}]}]
    req = request(
        *(
            history
            if phase == "continuation"
            else [*history, fresh]
            if phase == "old_result"
            else [fresh]
        ),
        **config,
    )

    class AdvancingStream(Stream):
        async def __anext__(self):
            if not self.started.is_set():
                await advance_model_clock(0.2 if phase in {"native", "continuation"} else 0.07)
            return await super().__anext__()

    blocked = AdvancingStream(
        [{"type": "response.completed", "response": response(message("late"))}]
    )
    adapter, client, factory, token = model([blocked])
    fallback = Mock(side_effect=AssertionError("One must never construct Vertex"))
    wrapped = managed.ManagedPrimaryTextModel(
        model=adapter.model,
        endpoint=adapter.endpoint,
        client_factory=factory,
        token_supplier=token,
        require_current=AsyncMock(),
        fallback_factory=fallback,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
        allow_fallback=False,
        allow_web_search=True,
        primary_seconds=0.03,
    )
    with pytest.raises(TimeoutError):
        _ = [item async for item in wrapped.generate_content_async(req, stream=True)]
    assert len(client.requests) == 1 and client.closed == 1 and blocked.closed
    fallback.assert_not_called()


async def test_public_readiness_runs_actual_managed_search_without_owner_authority(monkeypatch):
    from google.adk.agents import LlmAgent

    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent
    from hushh_mcp.runtime_providers import managed_text as managed
    from scripts.probe_managed_capabilities import _synthetic_public_search_agent
    from tests.test_azure_web_receipts import response as search_response

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    raw = search_response()
    adapter, client, factory, token = model([raw])
    wrapped = managed.ManagedPrimaryTextModel(
        model=adapter.model,
        endpoint=adapter.endpoint,
        client_factory=factory,
        token_supplier=token,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
        allow_fallback=False,
    )
    root = build_one_text_agent(model=wrapped)
    child = next(t.agent for t in root.tools if getattr(t, "name", None) == "google_search")
    assert isinstance(child, managed.ManagedTextAgent)
    probe = _synthetic_public_search_agent(root)
    assert type(probe) is LlmAgent
    result = await run_specialist_adk_turn(
        agent=probe,
        app_name="synthetic_managed_search",
        user_id="synthetic-public-reader",
        consent_token="",
        message="Search the synthetic public source.",
        max_llm_calls=1,
    )
    assert result.final_text
    assert len(client.requests) == 1
    assert client.requests[0]["tools"] == [{"type": "web_search", "external_web_access": False}]
    # The production child still rejects the same empty owner authority.
    with pytest.raises(managed.ManagedTextAuthorityError):
        bound = await child.canonical_model_async(SimpleNamespace(state={}))
        _ = [item async for item in bound.generate_content_async(request())]


async def test_azure_stream_rechecks_revocation_between_deltas_and_closes(caplog):
    stream = Stream(
        [
            {"type": "response.output_text.delta", "delta": "first"},
            {"type": "response.output_text.delta", "delta": "must not escape"},
        ]
    )
    adapter, client, _, _ = model([stream])
    checks = 0

    async def current():
        nonlocal checks
        checks += 1
        if checks >= 3:
            raise PermissionError("synthetic private revocation detail")

    adapter.require_current = current
    generator = adapter.generate_content_async(request(), stream=True)
    assert (await anext(generator)).content.parts[0].text == "first"
    with pytest.raises(PermissionError):
        await anext(generator)
    assert stream.closed and client.closed == 1
    assert "must not escape" not in caplog.text
    assert "synthetic private revocation detail" not in caplog.text


def test_managed_chat_reuses_credential_cache_and_aligns_stream_budget(monkeypatch):
    from hushh_mcp.runtime_providers import managed_text as managed
    from hushh_mcp.runtime_providers.managed_azure import _credential_supplier

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")
    first = managed.build_managed_text_model(scope="one_text_chat")
    second = managed.build_managed_text_model(scope="one_text_chat")
    assert first.token_supplier is second.token_supplier
    assert first.token_supplier is _credential_supplier(
        first.runtime_binding.tenant_id, first.runtime_binding.client_id
    )
    assert first.default_reasoning_effort == "minimal"
    assert first.timeout_seconds == 60 and first.primary_seconds == 10
    assert first.allow_fallback and callable(first.fallback_factory)
