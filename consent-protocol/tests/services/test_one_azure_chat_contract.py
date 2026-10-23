"""One Azure search, processor and stream-lifecycle regression contracts."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from google.genai import types

from hushh_mcp.runtime_providers.azure_adk import AzureOpenAIAdkModel
from tests.services.test_azure_adk import Stream, call, message, model, request, response


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


@pytest.mark.parametrize("status", [429, 503])
async def test_one_chat_never_falls_back_or_changes_processor(monkeypatch, status):
    from unittest.mock import AsyncMock

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")
    error = RuntimeError("synthetic provider failure")
    error.status_code = status
    calls = []

    async def azure(self, req, stream=False):
        calls.append("azure")
        raise error
        yield

    alternate = Mock(side_effect=AssertionError("One must never construct Vertex"))
    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    base, _, _, _ = model([])
    wrapped = managed.ManagedPrimaryTextModel(
        **base.model_dump(exclude={"api_key", "client"}),
        token_supplier=lambda: "synthetic",
        require_current=AsyncMock(),
        fallback_factory=alternate,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
    )
    with pytest.raises(RuntimeError, match="synthetic provider failure"):
        _ = [item async for item in wrapped.generate_content_async(request())]
    assert calls == ["azure"]
    alternate.assert_not_called()
    with pytest.raises(ValueError, match="managed Azure"):
        managed.build_managed_text_model(scope="one_text_chat", provider="vertex")


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


async def test_actual_one_roster_executes_azure_search_then_answers(monkeypatch):
    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent
    from hushh_mcp.one_adk.registered_mcp_toolset import RegisteredMcpToolset
    from tests.test_azure_web_receipts import response as search_response

    async def no_external_catalog(self, *args, **kwargs):
        return []

    monkeypatch.setattr(RegisteredMcpToolset, "get_tools", no_external_catalog)
    raw = search_response()
    raw["model"] = "synthetic-azure-version"
    adapter, client, _, _ = model(
        [
            response(call('{"request":"Look up a synthetic public source"}', name="google_search")),
            raw,
            response(message("The public source confirms the synthetic result [1].")),
        ]
    )
    adapter.allow_web_search = True
    root = build_one_text_agent(model=adapter)
    child = next(t.agent for t in root.tools if getattr(t, "name", None) == "google_search")
    observed = []

    async def observe(callback_context, llm_response):
        if llm_response.grounding_metadata:
            observed.append(llm_response.grounding_metadata)

    child.after_model_callback = observe
    result = await run_specialist_adk_turn(
        agent=root,
        app_name="synthetic_one_search",
        user_id="synthetic-public-reader",
        consent_token="",
        message="Find the synthetic public source and answer.",
        max_llm_calls=3,
    )
    assert result.final_text == "The public source confirms the synthetic result [1]."
    assert len(client.requests) == 3
    assert client.requests[1]["tools"] == [{"type": "web_search", "external_web_access": False}]
    assert all(r["model"] == adapter.model and r["store"] is False for r in client.requests)
    assert observed[0].grounding_chunks[0].web.uri == "https://example.test/team/owner"


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
    assert not first.allow_fallback and first.fallback_factory is None
