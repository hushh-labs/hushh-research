"""Contract tests for the One realtime voice persona.

The realtime voice path (``/agent/realtime/session``) has no tools, memory, or
app-action loop, so its persona MUST stay honest about that boundary while still
presenting as One and routing specialist work to Kai/Nav/KYC per the agent
ontology. These are pure-string assertions so they run without OpenAI or a live
session.
"""

from __future__ import annotations

from api.routes.kai.agent_realtime import _AGENT_REALTIME_INSTRUCTIONS


def test_realtime_persona_presents_as_one() -> None:
    assert _AGENT_REALTIME_INSTRUCTIONS.startswith("You are One")


def test_realtime_persona_routes_specialists() -> None:
    instructions = _AGENT_REALTIME_INSTRUCTIONS
    assert "Kai" in instructions
    assert "Nav" in instructions
    assert "KYC" in instructions


def test_realtime_persona_does_not_claim_private_data_access() -> None:
    instructions = _AGENT_REALTIME_INSTRUCTIONS.lower()
    assert "no tools" in instructions
    assert "do not claim access to" in instructions


def test_realtime_persona_drops_legacy_agent_branding() -> None:
    assert "You are Agent" not in _AGENT_REALTIME_INSTRUCTIONS
