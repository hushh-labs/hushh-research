"""Shared single-turn runtime stays bounded and validates model output."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel, PrivateAttr, ValidationError

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from tests.services.test_azure_adk import message, model, request, response

PKM_CHAIN_MANIFESTS = (
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
async def test_output_validation_scope_isolated_and_restored_when_turn_is_cancelled(monkeypatch):
    import asyncio

    from hushh_mcp.hushh_adk import single_turn
    from hushh_mcp.runtime_providers.json_schema import (
        bind_validated_output_schema,
        current_validated_output_schema,
        normalize_json_schema,
    )

    schema = {"type": "OBJECT", "properties": {"payload": {"type": "OBJECT"}}}
    expected = normalize_json_schema(schema)
    entered = asyncio.Event()
    after = []

    async def suspended(**_kwargs):
        snapshot = current_validated_output_schema()
        assert snapshot == expected
        snapshot["properties"].clear()
        assert current_validated_output_schema() == expected
        with bind_validated_output_schema({"type": "object", "additionalProperties": False}):
            assert current_validated_output_schema() != expected
        assert current_validated_output_schema() == expected
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(single_turn, "run_specialist_adk_turn", suspended)
    agent = build_single_turn_agent(_manifest(), output_schema=schema, model=ScriptedLlm("{}"))

    async def run():
        try:
            await run_single_turn(
                agent, prompt_parts="Synthetic", user_id="owner", consent_token=""
            )
        finally:
            after.append(current_validated_output_schema())

    task = asyncio.create_task(run())
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert current_validated_output_schema() is None
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert after == [None]


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

    from hushh_mcp import constants
    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan

    # Exercise a measured multi-region release; the 3.8 default is global-only.
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.7-flash")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "local")
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


@pytest.mark.parametrize("invalid", [False, True])
async def test_actual_memory_gene_preserves_dynamic_maps_and_original_host_schema(invalid):
    from copy import deepcopy

    from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
    from hushh_mcp.runtime_providers.json_schema import (
        current_validated_output_schema,
        normalize_json_schema,
    )
    from hushh_mcp.services.pkm_agent_lab_service import (
        _STRUCTURE_PREVIEW_SCHEMA,
        PKMAgentLabService,
    )

    original = deepcopy(_STRUCTURE_PREVIEW_SCHEMA)
    payload = {
        "candidate_payload": {"preferences": {"checklist_style": "short"}},
        "structure_decision": {
            "action": "create_domain",
            "target_domain": "professional",
            "json_paths": ["preferences.checklist_style"],
            "top_level_scope_paths": ["preferences"],
            "externalizable_paths": [],
            "summary_projection": {"checklist_style": "short"},
            "sensitivity_labels": {"preferences.checklist_style": "private"},
            "confidence": 0.9,
            "source_agent": "agent_pkm_structure",
            "contract_version": 1,
        },
        "write_mode": "confirm_first",
        "primary_json_path": "preferences.checklist_style",
        "target_entity_scope": "preferences",
        "validation_hints": [],
    }
    if invalid:
        payload["write_mode"] = "bypass_owner_review"
    adapter, client, _, _ = model([response(message(json.dumps(payload)))])
    manifest = PKMAgentLabService().structure_manifest
    agent = build_single_turn_agent(manifest, output_schema=original, model=adapter)

    async def run():
        return await run_single_turn(
            agent,
            prompt_parts="Synthetic memory schema qualification only.",
            user_id="synthetic",
            consent_token="",
            timeout_seconds=5,
        )

    if invalid:
        with pytest.raises(ValueError, match="does not match output schema"):
            await run()
    else:
        assert await run() == payload
    assert client.requests[0]["text"]["format"] == {"type": "json_object"}
    assert (
        json.dumps(normalize_json_schema(original), sort_keys=True)
        in client.requests[0]["instructions"]
    )
    assert len(client.requests) == client.closed == 1
    assert _STRUCTURE_PREVIEW_SCHEMA == original
    assert current_validated_output_schema() is None


@pytest.mark.parametrize("mismatched", [False, True])
@pytest.mark.parametrize("stream", [False, True])
async def test_open_response_without_matching_host_validation_fails_before_io(mismatched, stream):
    from contextlib import nullcontext

    from hushh_mcp.runtime_providers.json_schema import bind_validated_output_schema

    schema = {"type": "object", "properties": {"payload": {"type": "object"}}}
    other = {"type": "object", "properties": {"different": {"type": "object"}}}
    adapter, client, factory, token = model([])
    with bind_validated_output_schema(other) if mismatched else nullcontext():
        with pytest.raises(ValueError, match="original host validator"):
            _ = [
                item
                async for item in adapter.generate_content_async(
                    request(response_schema=schema), stream=stream
                )
            ]
    assert client.requests == []
    factory.assert_not_called()
    token.assert_not_called()


def test_response_maps_keep_schema_alternatives_and_ignore_example_values():
    from hushh_mcp.runtime_providers.azure_response_schema import response_format
    from hushh_mcp.runtime_providers.json_schema import bind_validated_output_schema

    closed = {"type": "object", "additionalProperties": False}
    assert response_format(closed)[0]["schema"]["properties"] == {}
    fixed = {
        "type": "object",
        "properties": {"name": {"type": "string", "examples": [{"type": "object"}]}},
    }
    assert response_format(fixed)[0]["type"] == "json_schema"
    original = {
        "type": "object",
        "properties": {"value": {"$ref": "#/$defs/map"}},
        "$defs": {
            "map": {
                "oneOf": [
                    {"type": "object", "additionalProperties": {"type": "string"}},
                    {"type": "null"},
                ]
            }
        },
    }
    with bind_validated_output_schema(original):
        wire, instruction = response_format(original)
    assert wire == {"type": "json_object"}
    assert json.loads(instruction.split("\n", 1)[1]) == original
