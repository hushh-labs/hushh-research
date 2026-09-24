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
    assert (
        agent.generate_content_config.max_output_tokens == _manifest().performance.max_output_tokens
    )


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


async def test_single_turn_genes_fail_over_across_configured_vertex_locations(monkeypatch):
    """A 429 on the primary endpoint replays the one tool-less request in the next.

    Reproduced 2026-09-24: the global endpoint answered 429 RESOURCE_EXHAUSTED on
    7 of 7 calls while `us` answered 3 of 3, yet single-turn genes were pinned to
    global, so every Drive planner turn failed. The cooled-down location is then
    skipped by the next gene instead of failing it first.
    """
    from types import SimpleNamespace

    from google.genai import errors as genai_errors

    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan

    for name, value in {
        "HUSHH_GENAI_AUTH_MODE": "vertex_adc",
        "GOOGLE_GENAI_USE_VERTEXAI": "true",
        "GENAI_GOOGLE_CLOUD_PROJECT": "synthetic-genai-project",
        "GOOGLE_CLOUD_LOCATION": "global",
        "HUSHH_VERTEX_LOCATIONS": "global,us",
    }.items():
        monkeypatch.setenv(name, value)
    calls: list[str] = []

    class FakeClient:
        def __init__(self, *, vertexai=True, project=None, location=None, **_options):
            self.vertexai, self.project, self.location = vertexai, project, location
            self.aio = SimpleNamespace(
                models=SimpleNamespace(
                    generate_content=self.generate_content,
                    generate_content_stream=self.generate_content_stream,
                )
            )

        def _answer(self):
            calls.append(self.location)
            if self.location == "global":
                raise genai_errors.ClientError(
                    429,
                    {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "x"}},
                )
            return types.GenerateContentResponse(
                candidates=[
                    types.Candidate(
                        content=types.Content(
                            role="model",
                            parts=[types.Part(text='{"terms":["bank statement"],"mode":"find"}')],
                        ),
                        finish_reason=types.FinishReason.STOP,
                    )
                ]
            )

        async def generate_content(self, **kwargs):
            return self._answer()

        async def generate_content_stream(self, **kwargs):
            response = self._answer()

            async def stream():
                yield response

            return stream()

    monkeypatch.setattr("google.genai.Client", FakeClient)
    monkeypatch.setattr(factory, "_REGIONAL_ADK_CLIENTS", {})
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "hushh_mcp/agents/documents/agent.yaml")
    )
    gene = next(item for item in manifest.subagents if item.id == "agent_documents_live_search")

    for _ in range(2):
        plan = await run_single_turn(
            build_single_turn_agent(gene, output_schema=LiveSearchPlan),
            prompt_parts="potential bank statement",
            user_id="owner",
            consent_token="",
            timeout_seconds=20,
        )
        assert plan.terms == ["bank statement"]
    assert calls == ["global", "us", "us"]
