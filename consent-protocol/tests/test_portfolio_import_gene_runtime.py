"""Portfolio Import's extraction gene must build and must be able to return data.

Two defects stopped every PDF and CSV import at the extraction step:

- ``run_portfolio_gene`` built ``Gemini(client=build_managed_runtime_client(...))``.
  With more than one configured Vertex location that client is a
  ``VertexRegionalClient``, which ADK 2.9's ``Gemini.client`` (typed
  ``genai.Client``) rejects, so the model object failed validation before any
  request was sent and the route answered "Import could not be completed".
- The response schema declared holdings as bare ``OBJECT``s. Gemini structured
  output only returns declared keys, so every holding decoded to ``{}``.

And a caller that passed no ``model_name`` (portfolio_import_service's text
extractor) crashed resolving it: ``model_config_for_runtime`` exists only on the
top-level manifest, not on a gene.
"""

from __future__ import annotations

import json
import re
from types import SimpleNamespace
from typing import Any

import pytest
from google.genai import types

from hushh_mcp.agents.portfolio_import.runtime import (
    _EXTRACTION_SCHEMA,
    _HOLDINGS_SCHEMA,
    run_portfolio_gene,
)
from hushh_mcp.kai_import.prompt_v2 import build_statement_extract_prompt_v2

_EXTRACTED = {
    "statement_details": {"institution_name": "Example Brokerage"},
    "portfolio_summary": {
        "beginning_value": None,
        "ending_value": 2301.0,
        "change_in_value": None,
        "net_deposits_withdrawals": None,
        "income": None,
        "fees": None,
    },
    "detailed_holdings": [
        {"symbol": "AAPL", "name": "APPLE INC", "quantity": 10, "market_value": 2301.0}
    ],
    "cash_balance": None,
    "total_value": 2301.0,
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model_name",
    [
        pytest.param("gemini-3.8-flash", id="route-passes-model"),
        pytest.param(None, id="service-omits-model"),
    ],
)
async def test_extraction_runs_with_multiple_configured_vertex_locations(monkeypatch, model_name):
    """UAT configures global,us,eu; the gene must still build and answer."""
    from hushh_mcp.runtime_providers import factory

    for name, value in {
        "HUSHH_GENAI_AUTH_MODE": "vertex_adc",
        "GOOGLE_GENAI_USE_VERTEXAI": "true",
        "GENAI_GOOGLE_CLOUD_PROJECT": "synthetic-genai-project",
        "GOOGLE_CLOUD_LOCATION": "global",
        "HUSHH_VERTEX_LOCATIONS": "global,us",
    }.items():
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
                            role="model", parts=[types.Part(text=json.dumps(_EXTRACTED))]
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

    payload, _elapsed_ms = await run_portfolio_gene(
        gene_id="agent_portfolio_import_extract",
        prompt=build_statement_extract_prompt_v2(),
        document_parts=[
            types.Part.from_bytes(data=b"Symbol,Quantity\nAAPL,10\n", mime_type="text/csv")
        ],
        output_schema=_EXTRACTION_SCHEMA,
        model_name=model_name,
        user_id="owner",
        consent_token="vault-owner-token",  # noqa: S106 - test fixture token
        timeout_seconds=20,
    )

    assert payload["detailed_holdings"][0]["symbol"] == "AAPL"
    assert locations == ["global"]


def _bare_objects(schema: Any, path: str = "$") -> list[str]:
    """Every OBJECT node that declares no properties (decodes to {})."""
    found: list[str] = []
    if isinstance(schema, dict):
        if str(schema.get("type", "")).upper() == "OBJECT" and not schema.get("properties"):
            found.append(path)
        for key, value in (schema.get("properties") or {}).items():
            found.extend(_bare_objects(value, f"{path}.{key}"))
        if isinstance(schema.get("items"), dict):
            found.extend(_bare_objects(schema["items"], f"{path}[]"))
    return found


@pytest.mark.parametrize("schema", [_EXTRACTION_SCHEMA, _HOLDINGS_SCHEMA])
def test_no_schema_object_decodes_to_an_empty_dict(schema):
    assert _bare_objects(schema) == []


def test_holding_rows_declare_every_key_the_prompt_asks_for():
    prompt = build_statement_extract_prompt_v2()
    block = re.search(r"preferred keys:\s*(.*?)\n\s*- if unknown", prompt, re.S)
    assert block, "prompt_v2 no longer lists preferred holding keys"
    asked = {key.strip() for key in block.group(1).replace("\n", ",").split(",") if key.strip()}
    declared = set(_EXTRACTION_SCHEMA["properties"]["detailed_holdings"]["items"]["properties"])
    assert asked <= declared, f"prompt asks for undeclared keys: {sorted(asked - declared)}"
