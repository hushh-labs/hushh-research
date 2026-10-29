"""Real chat provider switching preserves history, authority and client ownership."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

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
from hushh_mcp.runtime_providers.azure_response_history import reasoning_part
from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from tests.services.test_azure_adk import message, model, request, response


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


def _vertex_transport(monkeypatch, sent, signature):
    async def vertex_generate(req, stream=False):
        sent.append(req.model_copy(deep=True))
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


async def test_configured_vertex_chat_preserves_completed_history_signatures_and_one_tool_effect(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.delenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", raising=False)
    sent, effects = [], []
    signature = b"synthetic-native-signature"

    native = _vertex_transport(monkeypatch, sent, signature)

    async def lookup(query: str) -> dict:
        """Read one synthetic current result."""
        effects.append(query)
        return {"result": query}

    vertex = managed.build_managed_text_model(scope="one_text_chat", require_current=AsyncMock())
    assert vertex.model == native.model and vertex.allow_fallback is False
    assert vertex.primary_seconds == 30
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
