"""Real chat provider switching preserves history, authority and client ownership."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.events import Event
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from hushh_mcp.runtime_providers import lifecycle
from hushh_mcp.runtime_providers import managed_text as managed
from hushh_mcp.runtime_providers.azure_adk import AzureOpenAIAdkModel
from hushh_mcp.runtime_providers.azure_response_history import reasoning_part
from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from tests.services.test_azure_adk import message, model, request, response
from tests.services.test_one_azure_chat_contract import advance_model_clock as advance_model_clock


def _completed_azure_history():
    return [
        types.Content(role="user", parts=[types.Part(text="Previous Azure request")]),
        types.Content(
            role="model",
            parts=[
                reasoning_part(
                    {"type": "reasoning", "encrypted_content": "synthetic-azure-private-state"}
                )
            ],
        ),
        types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id="call_previous", name="lookup", args={"query": "previous subject"}
                    )
                )
            ],
        ),
        types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="call_previous", name="lookup", response={"result": "previous result"}
                    )
                )
            ],
        ),
        types.Content(role="model", parts=[types.Part(text="Previous Azure answer")]),
    ]


async def _run(sessions, session, lookup, adapter, text):
    agent = LlmAgent(name="one", model=adapter, instruction="Use lookup once.", tools=[lookup])
    runner = Runner(app=App(name="provider_switch", root_agent=agent), session_service=sessions)
    try:
        return [
            event
            async for event in runner.run_async(
                user_id="synthetic",
                session_id=session.id,
                new_message=types.Content(role="user", parts=[types.Part(text=text)]),
            )
        ]
    finally:
        await runner.close()


def _vertex_transport(monkeypatch, sent, signature, *, advance=None, delayed_call=0):
    async def vertex_generate(req, stream=False):
        sent.append(req.model_copy(deep=True))
        if len(sent) == delayed_call:
            await advance(40)
        if len(sent) == 1:
            part = types.Part(
                function_call=types.FunctionCall(
                    id="adk-vertex-call", name="lookup", args={"query": "current subject"}
                ),
                thought_signature=signature,
            )
        else:
            part = types.Part(text="Vertex completed the current request")
        yield LlmResponse(
            content=types.Content(role="model", parts=[part]), partial=False, turn_complete=True
        )

    native = SimpleNamespace(
        model=resolve_fleet_model_name("gemini-default"), generate_content_async=vertex_generate
    )
    monkeypatch.setattr(ManagedGeminiRuntimeBinding, "build_adk_model", lambda *a, **k: native)
    return native


@pytest.mark.parametrize("delayed_call", [0, 1, 2])
async def test_configured_vertex_chat_preserves_completed_history_signatures_and_one_tool_effect(
    monkeypatch, advance_model_clock, delayed_call
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.delenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", raising=False)
    sent, effects = [], []
    signature = b"synthetic-native-signature"

    native = _vertex_transport(
        monkeypatch, sent, signature, advance=advance_model_clock, delayed_call=delayed_call
    )

    async def lookup(query: str) -> dict:
        """Read one synthetic current result."""
        effects.append(query)
        return {"result": query}

    vertex = managed.build_managed_text_model(scope="one_text_chat", require_current=AsyncMock())
    assert vertex.model == native.model and vertex.allow_fallback is False
    sessions = InMemorySessionService()
    session = await sessions.create_session(
        app_name="provider_switch", user_id="synthetic", session_id="conversation"
    )
    history = _completed_azure_history()
    for content in history:
        await sessions.append_event(
            session,
            Event(
                author="user" if content.role == "user" else "one",
                invocation_id="previous-turn",
                content=content,
            ),
        )
    stored = [event.model_dump() for event in session.events]

    await _run(sessions, session, lookup, vertex, "Lookup the current subject")
    assert effects == ["current subject"] and len(sent) == 2
    assert [event.model_dump() for event in session.events[: len(stored)]] == stored
    assert all(content.parts for req in sent for content in req.contents)
    parts = [part for content in sent[1].contents for part in content.parts]
    assert all(not (p.thought_signature or b"").startswith(b"azure-responses-v1:") for p in parts)
    assert (
        next(
            p for p in parts if p.function_call and p.function_call.id == "adk-vertex-call"
        ).thought_signature
        == signature
    )
    assert any(p.function_response and p.function_response.id == "call_previous" for p in parts)

    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")
    with pytest.raises(managed.ManagedTextAuthorityError, match="policy changed"):
        _ = [r async for r in vertex.generate_content_async(request())]
    adapter, client, factory, token = model([response(message("Azure continued the conversation"))])
    azure = managed.ManagedPrimaryTextModel(
        **adapter.model_dump(exclude={"api_key", "client"}),
        token_supplier=token,
        client_factory=factory,
        require_current=AsyncMock(),
        processing_scope="one_text_chat",
        policy_generation=managed.managed_text_policy()["generation"],
        allow_fallback=False,
    )
    await _run(sessions, session, lookup, azure, "Continue with the completed results")
    assert effects == ["current subject"]
    wire = client.requests[0]["input"]
    assert any(
        item.get("call_id") == "adk-vertex-call" and item["type"] == "function_call_output"
        for item in wire
    )


@pytest.mark.parametrize("outcome", ["completed", "revoked", "cancelled"])
@pytest.mark.parametrize("owned", [True, False])
async def test_vertex_chat_rechecks_each_delta_and_closes_only_its_owned_model(
    monkeypatch, outcome, owned
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.delenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", raising=False)
    active, closed = {"valid": True}, []

    async def current():
        if not active["valid"]:
            raise PermissionError("synthetic private revocation detail")

    async def generate(req, stream=False):
        try:
            for text in ("first", "second"):
                yield LlmResponse(
                    content=types.Content(role="model", parts=[types.Part(text=text)]), partial=True
                )
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text="firstsecond")]),
                partial=False,
                turn_complete=True,
            )
        finally:
            closed.append(True)

    native = SimpleNamespace(
        model=resolve_fleet_model_name("gemini-default"), generate_content_async=generate
    )
    monkeypatch.setattr(ManagedGeminiRuntimeBinding, "build_adk_model", lambda *a, **k: native)
    cleanup = AsyncMock()
    monkeypatch.setattr(lifecycle, "close_owned_adk_model", cleanup)
    wrapped = managed.build_managed_text_model(scope="one_text_chat", require_current=current)
    if not owned:
        wrapped = wrapped.model_copy(update={"fallback_model": native})
    generator = wrapped.generate_content_async(request(), stream=True)
    assert (await anext(generator)).content.parts[0].text == "first"
    if outcome == "revoked":
        active["valid"] = False
        with pytest.raises(managed.ManagedTextAuthorityError):
            await anext(generator)
    elif outcome == "cancelled":
        await generator.aclose()
    else:
        assert [r.content.parts[0].text async for r in generator] == ["second", "firstsecond"]
    assert closed == [True]
    if owned:
        cleanup.assert_awaited_once_with(native)
    else:
        cleanup.assert_not_awaited()


@pytest.mark.parametrize("scope", ["drive_document_requests", "one_text_chat"])
@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
async def test_managed_drive_fallback_targets_gemini_without_replaying_tools(
    monkeypatch, status, scope
):
    from unittest.mock import AsyncMock

    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    calls = []
    error = RuntimeError("synthetic outage")
    error.status_code = status

    async def azure(self, req, stream=False):
        calls.append(("azure", req.model))
        raise error
        yield

    async def gemini(req, stream=False):
        calls.append(("gemini", req.model))
        # Real Gemini non-stream responses do not set turn_complete.
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="Arbitrary topic result")])
        )

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    guard = AsyncMock()
    adapter, _, _, _ = model([])
    wrapped = managed.ManagedPrimaryTextModel(
        **adapter.model_dump(exclude={"api_key", "client"}),
        token_supplier=lambda: "synthetic",
        require_current=guard,
        fallback_model=SimpleNamespace(model="gemini-fallback", generate_content_async=gemini),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope=scope,
    )
    req = request(
        types.Content(role="user", parts=[types.Part(text="Arbitrary topic")]),
        types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(id="adk-existing", name="lookup", args={})
                )
            ],
        ),
        types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="adk-existing", name="lookup", response={"done": True}
                    )
                )
            ],
        ),
    )
    before = req.model_dump()
    result = [item async for item in wrapped.generate_content_async(req)]
    assert result[-1].content.parts[0].text == "Arbitrary topic result"
    assert calls == [("azure", "synthetic-deployment"), ("gemini", "gemini-fallback")]
    assert req.model_dump() == before
    assert guard.await_count == 3  # Each provider plus completion; no tool rerun.


@pytest.mark.parametrize(
    "failure",
    [
        PermissionError("revoked"),
        ValueError("invalid schema"),
        __import__(
            "hushh_mcp.runtime_providers.azure_adk", fromlist=["AzureAuthenticationError"]
        ).AzureAuthenticationError("auth"),
        SimpleNamespace(status_code=401),
        SimpleNamespace(status_code=403),
        SimpleNamespace(status_code=400),
    ],
)
@pytest.mark.parametrize("scope", ["drive_document_requests", "one_text_chat"])
async def test_managed_uat_denial_auth_configuration_never_falls_back(monkeypatch, failure, scope):
    from unittest.mock import AsyncMock, Mock

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    if not isinstance(failure, Exception):
        error = RuntimeError("synthetic provider refusal")
        error.status_code = failure.status_code
    else:
        error = failure

    async def azure(self, req, stream=False):
        raise error
        yield

    fallback = Mock()
    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    wrapped = managed.ManagedPrimaryTextModel(
        model="synthetic",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: "synthetic",
        require_current=AsyncMock(),
        fallback_model=SimpleNamespace(model="gemini", generate_content_async=fallback),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope=scope,
    )
    with pytest.raises(type(error)):
        _ = [item async for item in wrapped.generate_content_async(request())]
    fallback.assert_not_called()


@pytest.mark.parametrize("scope", ["drive_document_requests", "one_text_chat"])
async def test_managed_primary_success_partial_output_and_authority_fence(monkeypatch, scope):
    from unittest.mock import AsyncMock, Mock

    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    fallback = Mock()
    guard = AsyncMock()
    wrapped = managed.ManagedPrimaryTextModel(
        model="synthetic",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: "synthetic",
        require_current=guard,
        fallback_model=SimpleNamespace(model="gemini", generate_content_async=fallback),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope=scope,
    )

    async def azure(self, req, stream=False):
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="valid")]),
            turn_complete=True,
        )

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    assert len([item async for item in wrapped.generate_content_async(request())]) == 1
    fallback.assert_not_called()
    closed = []

    async def partial(self, req, stream=False):
        try:
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text="partial")]),
                partial=True,
            )
            raise TimeoutError
        finally:
            closed.append(True)

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", partial)
    with pytest.raises(TimeoutError):
        _ = [item async for item in wrapped.generate_content_async(request(), stream=True)]
    assert closed == [True]
    fallback.assert_not_called()
    guard.side_effect = PermissionError("revoked source")
    with pytest.raises(managed.ManagedTextAuthorityError):
        _ = [item async for item in wrapped.generate_content_async(request())]
    fallback.assert_not_called()


@pytest.mark.parametrize("status", [429, 503, "sse_quota"])
@pytest.mark.parametrize("observed", [False, True])
async def test_one_chat_falls_back_once_only_before_any_response(
    monkeypatch, caplog, status, observed
):
    import logging

    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.runtime_providers import managed_text as managed
    from hushh_mcp.runtime_providers.azure_call_lifecycle import AzureRateLimitedError

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")
    error = AzureRateLimitedError() if status == "sse_quota" else RuntimeError("synthetic outage")
    if isinstance(status, int):
        error.status_code = status
    calls, receipts = [], []

    async def azure(self, req, stream=False):
        calls.append("azure")
        if observed:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(id="only-call", name="lookup", args={})
                        )
                    ],
                )
            )
        raise error

    async def vertex(req, stream=False):
        calls.append("vertex")
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="Complete")]))

    alternate = Mock(
        return_value=SimpleNamespace(model="gemini-alternate", generate_content_async=vertex)
    )
    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    # Injected model ownership stays with the test; normal factories close theirs.
    wrapped = managed.ManagedPrimaryTextModel(
        model="synthetic",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: "synthetic",
        require_current=AsyncMock(),
        fallback_model=alternate.return_value,
        completion_observer=receipts.append,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
    )
    caplog.set_level(logging.WARNING, logger=managed.__name__)
    if observed:
        with pytest.raises(type(error)):
            _ = [item async for item in wrapped.generate_content_async(request())]
        assert calls == ["azure"] and receipts == []
    else:
        result = [item async for item in wrapped.generate_content_async(request())]
        assert result[-1].content.parts[0].text == "Complete"
        assert calls == ["azure", "vertex"]
        assert receipts == [
            {
                "provider": "vertex",
                "model": "gemini-alternate",
                "location": "global",
                "fallback_reason": "quota" if status in {429, "sse_quota"} else "transient_service",
                "attempt": "2",
            }
        ]
        assert "drift=provider_fallback" in caplog.text
