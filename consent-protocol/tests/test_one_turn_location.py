"""One's turn-scoped location (hushh_mcp/one_adk/turn_location.py).

Location is level-4 personal information. The contract: the device supplies a
coarse position only for the turn that asks; the server keeps it in memory
behind an opaque reference, never in state, forwarded props or logs; without it
the tools say exactly what permission is missing.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk.turn_location import (
    STATE_TURN_LOCATION,
    admit_turn_location,
    get_my_location,
)
from tests.helpers.chat_keys import bound_request_chat_key

# Precise enough to identify a home; the server must only ever hold 2 decimals.
PRECISE = {"status": "available", "latitude": 37.774929, "longitude": -122.419416}


def _context(reference: str = "") -> SimpleNamespace:
    return SimpleNamespace(state={STATE_TURN_LOCATION: reference} if reference else {})


@pytest.mark.parametrize("unlocked", [True, False])
async def test_route_admits_location_only_as_an_opaque_turn_reference(monkeypatch, unlocked):
    from fastapi import HTTPException
    from starlette.requests import Request

    from api.routes.one import agent_chat
    from tests.test_agui_turn_timing import _input

    vault = AsyncMock(return_value={"user_id": "owner", "token": "synthetic"})
    if not unlocked:
        vault.side_effect = HTTPException(status_code=403)
    monkeypatch.setattr(agent_chat, "require_vault_owner_token", vault)
    monkeypatch.setattr(agent_chat, "verify_firebase_bearer", lambda _: "owner")
    monkeypatch.setattr(
        agent_chat,
        "_session_service",
        SimpleNamespace(is_legacy_session=AsyncMock(return_value=False)),
    )
    monkeypatch.setattr(agent_chat, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    headers = [(b"authorization", b"Bearer synthetic")]
    if unlocked:
        headers.append((b"x-hushh-consent", b"synthetic"))
    request = Request({"type": "http", "headers": headers})
    run = _input()
    run.forwarded_props = {"turnLocation": dict(PRECISE)}
    with bound_request_chat_key("owner"):
        state = await agent_chat._extract_state(request, run)

    # Removed before the bridge can copy or serialize forwarded props.
    assert "turnLocation" not in run.forwarded_props
    serialized = json.dumps(state)
    for fragment in ("37.77", "-122.4", "latitude"):
        assert fragment not in serialized
    result = await get_my_location(SimpleNamespace(state=state))
    if unlocked:
        assert state[STATE_TURN_LOCATION].startswith("one_secret_ref:")
        assert result == {
            "status": "available",
            "latitude": 37.77,
            "longitude": -122.42,
            "precision": "approximate, about 1 km",
        }
    else:
        # A pre-vault turn never keeps it.
        assert state[STATE_TURN_LOCATION] == ""
        assert result["status"] == "needs_location_permission"


async def test_admission_rounds_and_rejects_malformed_positions():
    reference = admit_turn_location({"turnLocation": dict(PRECISE)})
    assert await get_my_location(_context(reference)) == {
        "status": "available",
        "latitude": 37.77,
        "longitude": -122.42,
        "precision": "approximate, about 1 km",
    }
    for bad in (
        {"status": "available", "latitude": 91, "longitude": 0},
        {"status": "available", "latitude": True, "longitude": 0},
        {"status": "available", "latitude": float("nan"), "longitude": 0},
        {"status": "granted"},
        "37.77,-122.42",
    ):
        assert admit_turn_location({"turnLocation": bad}) == ""


@pytest.mark.parametrize(
    ("device_state", "expected"),
    [(None, "not_provided"), ("denied", "denied"), ("not_granted", "not_granted")],
)
async def test_without_a_turn_location_the_tool_asks_for_the_missing_permission(
    monkeypatch, device_state, expected
):
    reference = (
        admit_turn_location({"turnLocation": {"status": device_state}}) if device_state else ""
    )
    for tool in (get_my_location,):
        result = await tool(_context(reference))
        assert result["status"] == "needs_location_permission"
        assert result["permission"] == expected
        assert result["message"]
