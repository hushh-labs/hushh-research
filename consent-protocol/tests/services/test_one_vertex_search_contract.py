"""Native Vertex Search retains the shared One AG-UI answer contract."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from ag_ui.core import EventType
from ag_ui_adk.event_translator import adk_events_to_messages
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.google_search_tool import GoogleSearchTool
from google.genai import types

from hushh_mcp.adk_bridge import delegation
from hushh_mcp.one_adk import queued_input
from hushh_mcp.one_adk.agent_tree import build_one_text_agent
from hushh_mcp.one_adk.registered_mcp_toolset import RegisteredMcpToolset
from hushh_mcp.runtime_providers import managed_text as managed
from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from tests.services.test_one_search_answer_contract import ANSWER, _run


def _vertex_search_model(monkeypatch, finish):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
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
                finish_reason=types.FinishReason.STOP,
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
                finish_reason=types.FinishReason.STOP,
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
                finish_reason=types.FinishReason.STOP,
            )

    native = SimpleNamespace(
        model=resolve_fleet_model_name("gemini-default"), generate_content_async=generate
    )
    monkeypatch.setattr(ManagedGeminiRuntimeBinding, "build_adk_model", lambda *a, **k: native)
    return native, requests


@pytest.mark.parametrize("finish", [False, True])
async def test_configured_vertex_search_preserves_native_grounding_and_chat_completion(
    monkeypatch, finish
):
    native, requests = _vertex_search_model(monkeypatch, finish)
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
    assert requests[1].config.thinking_config.thinking_level == types.ThinkingLevel.LOW
    assert child.model._primary_timeout(requests[1]) == 60
    assert sum(event.type == EventType.RUN_FINISHED for event in events) == 1
    assert not any(event.type == EventType.RUN_ERROR for event in events)
