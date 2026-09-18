"""Shared single-turn runtime stays bounded and validates model output."""

from __future__ import annotations

from pathlib import Path

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel, PrivateAttr, ValidationError

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

PKM_CHAIN_MANIFESTS = (
    "financial_guard",
    "memory_segmentation",
    "memory_intent",
    "memory_merge",
    "pkm_structure",
)


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


@pytest.mark.parametrize("manifest_name", PKM_CHAIN_MANIFESTS)
def test_pkm_chain_manifests_build_low_thinking_adk_agents(manifest_name: str) -> None:
    manifest_path = (
        Path(__file__).resolve().parents[1] / "hushh_mcp" / "agents" / manifest_name / "agent.yaml"
    )
    manifest = ManifestLoader.load(str(manifest_path))

    assert manifest.model_config_for_runtime().thinking_level == "low"
    agent = build_single_turn_agent(
        manifest,
        output_schema=dict,
        model="gemini-3.7-flash",
    )
    thinking_config = agent.generate_content_config.thinking_config
    assert getattr(getattr(thinking_config, "thinking_level", None), "value", None) == "LOW"


@pytest.mark.parametrize("payload", ["{}", '{"count":"bad"}', '{"count":true}'])
def test_dictionary_schema_rejects_missing_or_wrong_typed_fields(payload):
    from hushh_mcp.hushh_adk.single_turn import _decode

    with pytest.raises(ValueError, match="output schema"):
        _decode(
            payload,
            {"type": "OBJECT", "properties": {"count": {"type": "INTEGER"}}, "required": ["count"]},
        )


def test_dictionary_schema_preserves_nullable_nested_values():
    from hushh_mcp.hushh_adk.single_turn import _decode

    schema = {
        "type": "OBJECT",
        "properties": {"rows": {"type": "ARRAY", "items": {"type": "STRING", "nullable": True}}},
    }
    assert _decode('{"rows":[null,"ok"]}', schema) == {"rows": [None, "ok"]}
    assert schema["type"] == "OBJECT"


@pytest.mark.asyncio
async def test_single_turn_uses_agent_schema_and_full_caller_deadline(monkeypatch):
    from types import SimpleNamespace

    from hushh_mcp.hushh_adk import single_turn

    agent = build_single_turn_agent(_manifest(), output_schema=Decision, model=ScriptedLlm("{}"))
    captured = {}

    async def turn(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(final_text='{"answer":"ok","score":1}')

    monkeypatch.setattr(single_turn, "run_specialist_adk_turn", turn)
    # An independently copied agent owns its schema, without a global identity registry.
    result = await run_single_turn(
        agent.model_copy(),
        prompt_parts="request",
        user_id="owner",
        consent_token="fixture",  # noqa: S106 - synthetic test authority
        timeout_seconds=75,
    )
    assert result.answer == "ok"
    assert captured["first_event_timeout_s"] == 75
    assert captured["between_event_timeout_s"] == 75
    assert captured["total_timeout_s"] == 75
