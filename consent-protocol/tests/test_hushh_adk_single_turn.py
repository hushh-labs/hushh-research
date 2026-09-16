"""Shared single-turn runtime stays bounded and validates model output."""

from __future__ import annotations

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel, PrivateAttr, ValidationError

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn


class Decision(BaseModel):
    answer: str
    score: float


class ScriptedLlm(BaseLlm):
    _response: str = PrivateAttr()

    def __init__(self, response: str):
        super().__init__(model="gemini-3.7-flash")
        self._response = response

    async def generate_content_async(self, llm_request, stream=False):
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=self._response)])
        )


def _manifest():
    return ManifestLoader.load_from_dict(
        {
            "manifest_version": 2,
            "id": "agent_single_turn_test",
            "name": "Single Turn Test",
            "description": "A bounded single turn test agent.",
            "system_instruction": "Return a decision as JSON.",
            "model": "gemini-3.7-flash",
        }
    )


@pytest.mark.asyncio
async def test_single_turn_uses_none_history_and_returns_pydantic_value():
    agent = build_single_turn_agent(
        _manifest(),
        output_schema=Decision,
        model=ScriptedLlm('{"answer":"keep","score":0.9}'),
    )
    result = await run_single_turn(
        agent,
        prompt_parts=["Request: keep this", "Return only the declared schema."],
        user_id="owner",
        consent_token="token",  # noqa: S106
        thinking_level="high",
    )
    assert result == Decision(answer="keep", score=0.9)
    assert agent.tools == []
    assert agent.include_contents == "none"


@pytest.mark.asyncio
async def test_single_turn_preserves_multimodal_message_content():
    agent = build_single_turn_agent(
        _manifest(),
        output_schema=Decision,
        model=ScriptedLlm('{"answer":"read","score":1.0}'),
    )
    message = types.Content(
        role="user",
        parts=[
            types.Part.from_text(text="Extract this statement."),
            types.Part.from_bytes(data=b"fixture", mime_type="application/pdf"),
        ],
    )
    result = await run_single_turn(
        agent,
        prompt_parts="unused when message_content is supplied",
        message_content=message,
        user_id="owner",
        consent_token="token",  # noqa: S106
    )
    assert result == Decision(answer="read", score=1.0)


@pytest.mark.asyncio
async def test_single_turn_rejects_invalid_structured_output():
    agent = build_single_turn_agent(
        _manifest(), output_schema=Decision, model=ScriptedLlm('{"answer": "missing score"}')
    )
    with pytest.raises((ValidationError, ValueError)):
        await run_single_turn(
            agent,
            prompt_parts="request",
            user_id="owner",
            consent_token="token",  # noqa: S106
        )


def test_single_turn_requires_nonempty_prompt():
    agent = build_single_turn_agent(_manifest(), output_schema=dict, model="gemini-3.7-flash")
    with pytest.raises(ValueError, match="prompt"):
        import asyncio

        asyncio.run(
            run_single_turn(
                agent,
                prompt_parts=[],
                user_id="owner",
                consent_token="token",  # noqa: S106
            )
        )
