"""Contract tests for the flag-gated A2A discovery card at /.well-known/agent-card.json.

Public discovery document (no auth). Off by default -> 404 (today's release gate);
on -> a conformant A2A v1 AgentCard that honestly declares the invocation-preview
transport rather than overclaiming full A2A v1 Tasks.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import a2a


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(a2a.well_known_router)
    return TestClient(app)


def test_well_known_card_is_404_when_flag_off(monkeypatch):
    monkeypatch.delenv("A2A_AGENT_CARD_ENABLED", raising=False)
    resp = _client().get("/.well-known/agent-card.json")
    assert resp.status_code == 404


def test_well_known_card_is_conformant_when_flag_on(monkeypatch):
    monkeypatch.setenv("A2A_AGENT_CARD_ENABLED", "1")
    resp = _client().get("/.well-known/agent-card.json")
    assert resp.status_code == 200
    card = resp.json()

    # Core conformant A2A AgentCard fields present.
    assert card["protocolVersion"]
    assert card["name"]
    assert card["description"]
    assert card["version"]
    assert card["url"].endswith("/api/one/a2a/message")
    assert card["preferredTransport"] == "HTTP+JSON"
    assert card["provider"]["organization"]
    assert isinstance(card["skills"], list) and card["skills"]
    assert {"streaming", "pushNotifications", "stateTransitionHistory"}.issubset(
        card["capabilities"]
    )

    # Honest: the current invocation-preview contract is declared via a capability
    # extension, never claimed as full A2A v1 Tasks.
    ext = card["capabilities"]["extensions"][0]
    assert ext["params"]["officialA2A"] is False


def test_well_known_card_default_off_is_the_same_gate_as_before(monkeypatch):
    # Explicitly-disabled behaves identically to unset (both 404).
    monkeypatch.setenv("A2A_AGENT_CARD_ENABLED", "0")
    resp = _client().get("/.well-known/agent-card.json")
    assert resp.status_code == 404
