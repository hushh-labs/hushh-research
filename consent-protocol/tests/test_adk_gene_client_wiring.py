"""ADK genes must build and answer under the deployed model-client configuration.

Two migration defects (2026-09-15/16) passed CI because CI runs one Vertex
location and the existing tests replaced the model builder with fakes:

- Kai's portfolio optimizer and Connected Systems' CRM schema mapper built
  ``Gemini(client=build_managed_runtime_client(...))``. With more than one
  configured location (UAT/production: global,us,eu) that client is a
  ``VertexRegionalClient``, which ADK 2.9's ``Gemini.client`` (typed
  ``genai.Client``) rejects, so every call failed before a request was sent.
- Location transcription and attribute learning call
  ``gene.model_config_for_runtime()`` on their single-location branch; a gene is
  an ``AgentSubagentConfig``, which has no such method.

These tests build the real ADK objects -- only the network client is faked.
"""

from __future__ import annotations

import io
import json
import wave
from types import SimpleNamespace
from typing import Any

import pytest
from google import genai
from google.genai import types

_REGIONAL_ENV = {
    "HUSHH_GENAI_AUTH_MODE": "vertex_adc",
    "GOOGLE_GENAI_USE_VERTEXAI": "true",
    "GENAI_GOOGLE_CLOUD_PROJECT": "synthetic-genai-project",
    "GOOGLE_CLOUD_LOCATION": "global",
    "HUSHH_VERTEX_LOCATIONS": "global,us",
}


def _install_fake_regional_clients(monkeypatch, answer: dict[str, Any]) -> list[str]:
    """Deployed-style config with a fake genai.Client behind every location."""
    from hushh_mcp.runtime_providers import factory

    for name, value in _REGIONAL_ENV.items():
        monkeypatch.setenv(name, value)
    locations: list[str] = []

    class FakeClient:
        def __init__(self, *, vertexai=True, project=None, location=None, **_options):
            self.vertexai, self.project, self.location = vertexai, project, location
            self.aio = SimpleNamespace(
                models=SimpleNamespace(
                    generate_content=self.generate_content,
                    generate_content_stream=self.generate_content_stream,
                )
            )

        def _answer(self) -> types.GenerateContentResponse:
            locations.append(self.location)
            return types.GenerateContentResponse(
                candidates=[
                    types.Candidate(
                        content=types.Content(
                            role="model", parts=[types.Part(text=json.dumps(answer))]
                        ),
                        finish_reason=types.FinishReason.STOP,
                    )
                ]
            )

        async def generate_content(self, **_kwargs):
            return self._answer()

        async def generate_content_stream(self, **_kwargs):
            response = self._answer()

            async def stream():
                yield response

            return stream()

    monkeypatch.setattr("google.genai.Client", FakeClient)
    monkeypatch.setattr(factory, "_REGIONAL_ADK_CLIENTS", {})
    return locations


_ACTION = {"symbol": "AAPL", "action": "TRIM", "rationale": "Concentration."}
_OPTIMIZER_ANSWER = {
    "criteria_context": "rubric",
    "summary": {
        "health_score": 61.0,
        "projected_health_score": 72.0,
        "health_reasons": ["Concentrated in one holding."],
        "plans": {
            "minimal": {"actions": [_ACTION]},
            "standard": {"actions": [_ACTION]},
            "maximal": {"actions": [_ACTION]},
        },
    },
    "losers": [
        {"symbol": "AAPL", "name": "APPLE INC", "action": "trim", "rationale": "Concentration."}
    ],
    "portfolio_level_takeaways": ["Diversify."],
}


@pytest.mark.asyncio
async def test_kai_optimizer_runs_with_multiple_configured_vertex_locations(monkeypatch):
    from hushh_mcp.agents.kai.runtime import run_kai_portfolio_optimizer

    locations = _install_fake_regional_clients(monkeypatch, _OPTIMIZER_ANSWER)

    payload = await run_kai_portfolio_optimizer(
        prompt="Use the supplied portfolio snapshot.",
        user_id="owner",
        consent_token="vault-owner-token",  # noqa: S106 - test fixture token
        timeout_seconds=20,
    )

    assert payload["losers"][0]["symbol"] == "AAPL"
    assert payload["summary"]["plans"]["standard"]["actions"][0]["action"] == "TRIM"
    assert locations == ["global"]


@pytest.mark.asyncio
async def test_crm_schema_mapper_runs_with_multiple_configured_vertex_locations(monkeypatch):
    from hushh_mcp.agents.connected_systems.runtime import (
        CRM_SCHEMA_MAPPING_SCHEMA,
        run_connected_systems_gene,
    )

    semantics = CRM_SCHEMA_MAPPING_SCHEMA["properties"]["mappings"]["required"]
    answer = {
        "mappings": {
            key: {"fieldKey": f"crm_{key}", "confidence": 0.9, "reason": "Named field."}
            for key in semantics
        }
    }
    locations = _install_fake_regional_clients(monkeypatch, answer)

    payload = await run_connected_systems_gene(
        gene_id="crm_schema_mapper",
        prompt="Map these CRM fields.",
        user_id="owner",
        consent_token="vault-owner-token",  # noqa: S106 - test fixture token
        output_schema=CRM_SCHEMA_MAPPING_SCHEMA,
        timeout_seconds=20,
    )

    assert payload["mappings"]["email"]["fieldKey"] == "crm_email"
    assert locations == ["global"]


def _bare_objects(schema: Any, path: str = "$") -> list[str]:
    found: list[str] = []
    if isinstance(schema, dict):
        if str(schema.get("type", "")).upper() == "OBJECT" and not schema.get("properties"):
            found.append(path)
        for key, value in (schema.get("properties") or {}).items():
            found.extend(_bare_objects(value, f"{path}.{key}"))
        if isinstance(schema.get("items"), dict):
            found.extend(_bare_objects(schema["items"], f"{path}[]"))
    return found


def test_optimizer_schema_declares_every_object_it_asks_for():
    """A bare OBJECT decodes to {}; the optimizer's plans and losers would be empty."""
    from hushh_mcp.agents.kai.runtime import PORTFOLIO_OPTIMIZER_SCHEMA

    assert _bare_objects(PORTFOLIO_OPTIMIZER_SCHEMA) == []


class _SingleLocationClient(genai.Client):
    """A real genai.Client type (single-location builds return one) with no network."""

    def __init__(self) -> None:  # noqa: D107 - deliberately skips credential setup
        pass


def _speech_wav() -> str:
    import base64

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(16000)
        recording.writeframes(b"\x10\x00\xf0\xff" * 4000)
    return base64.b64encode(buffer.getvalue()).decode()


@pytest.mark.asyncio
async def test_location_transcription_single_location_branch_resolves_the_gene_model(
    monkeypatch,
):
    from hushh_mcp.agents.location.command_brain import LocationCommandBrain
    from hushh_mcp.hushh_adk import single_turn
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    seen: dict[str, Any] = {}

    async def fake_run_single_turn(agent, **_kwargs):
        seen["model"] = getattr(agent.model, "model", None)
        return {"transcript": "share my location with mom"}

    monkeypatch.setattr(single_turn, "run_single_turn", fake_run_single_turn)

    brain = LocationCommandBrain(client=_SingleLocationClient())
    transcript = await brain.transcribe(_speech_wav())

    assert transcript == "share my location with mom"
    assert seen["model"] == resolve_fleet_model_name("gemini-default")


@pytest.mark.asyncio
async def test_attribute_learning_single_location_branch_resolves_the_gene_model(monkeypatch):
    from hushh_mcp.services import attribute_learner

    async def fake_run_single_turn(_agent, **_kwargs):
        return {
            "attributes": [
                {"domain": "food", "key": "favorite cuisine", "value": "thai", "confidence": 0.9}
            ]
        }

    monkeypatch.setattr(attribute_learner, "run_single_turn", fake_run_single_turn)

    learner = attribute_learner.AttributeLearner()
    learner._client = _SingleLocationClient()
    attributes = await learner.extract_attributes("I love thai food", "Noted!")

    assert [(a.domain, a.key, a.value) for a in attributes] == [
        ("food", "favorite_cuisine", "thai")
    ]
