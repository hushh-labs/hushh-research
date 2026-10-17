"""Recorded external responses must exercise the real structured PKM stage."""

import json

import pytest

from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService
from scripts.profile_discovery_fixture_backend import fixture_contract


@pytest.mark.asyncio
async def test_recorded_correction_preserves_unaffected_information(monkeypatch):
    monkeypatch.setattr(PKMAgentLabService, "_run_agent_contract", fixture_contract)
    result = await PKMAgentLabService().generate_structure_preview(
        user_id="fixture-model-contract",
        message="Fixture Advisor",
        domain_registry_override=[
            {"domain_key": "professional", "description": "Professional information"}
        ],
        capture_execution_trace=True,
    )
    payload = json.dumps(result["candidate_payload"])
    assert "Fixture Advisor" in payload
    assert "Fixture Research" in payload
    assert result["structure_skipped"] is False
    assert result["structure_used_fallback"] is False
