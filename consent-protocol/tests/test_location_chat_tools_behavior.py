"""Regression tests for the fixes that came out of manual testing:

- a guessed / non-UUID id must fail cleanly BEFORE hitting Postgres
- the runner's function declarations must not drift from the tool allow-list

Tools are invoked via ``.__wrapped__`` to bypass the @hushh_tool token/scope
check (which needs a live token); the underlying logic + HushhContext use is
exercised directly.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from google.genai import types

from hushh_mcp.agents.location import tools as loc_tools
from hushh_mcp.agents.location.tools import (
    V2_LOCATION_TOOLS,
    propose_location_view,
    propose_public_link,
)
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.location_chat_service import _function_declarations

_VALID_UUID = "22e4345c-b84f-4789-853e-f77010b32f91"
_HALLUCINATED = "_-HKa9Do8xBsyZOB-MDeVIWZTFkaSc7pJ5zunMh5mSU"


def test_function_declarations_match_location_tools():
    declared = {decl.name for decl in _function_declarations(types)}
    tool_names = {t._name for t in V2_LOCATION_TOOLS}
    assert declared == tool_names


async def test_propose_public_link_returns_directive_without_mutation():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await propose_public_link.__wrapped__(1)
    assert out == {"proposed": "create_public_link", "durationHours": 1.0}


async def test_propose_public_link_rejects_out_of_range_duration():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        with pytest.raises(ValueError):
            await propose_public_link.__wrapped__(99)


async def test_propose_public_link_refuses_a_duration_the_api_would_reject():
    # 24 was the PRIVATE share ceiling, copied. The route field is le=1 and the
    # service stops at PUBLIC_INVITE_MAX_DURATION_HOURS, so anything above an
    # hour was a proposal the person could accept and then watch 422 -- with
    # the assistant having promised them a two-hour link.
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        with pytest.raises(ValueError):
            await propose_public_link.__wrapped__(2)
        with pytest.raises(ValueError):
            await propose_public_link.__wrapped__(0.1)
        assert (await propose_public_link.__wrapped__(0.5))["durationHours"] == 0.5


async def test_propose_location_view_rejects_non_uuid():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        with pytest.raises(ValueError):
            await propose_location_view.__wrapped__("not-a-uuid")


class _IncomingSvc:
    def __init__(self, expires_at: str) -> None:
        self._expires_at = expires_at

    def list_state(self, *, user_id):
        return {
            "receivedGrants": [
                {
                    "id": "g1",
                    "ownerDisplayName": "Mom",
                    "expiresAt": self._expires_at,
                    "status": "active",
                },
                {"id": "g-expired", "ownerDisplayName": "Dad", "status": "revoked"},
            ]
        }


async def test_request_incoming_choice_options_carry_real_grant_ids(monkeypatch):
    # request_incoming_choice calls _expiry_hint without an explicit `now`, so the
    # fixture timestamp must be relative to real wall-clock time, not a fixed date.
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    monkeypatch.setattr(loc_tools, "_service", lambda: _IncomingSvc(expires_at))
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_incoming_choice.__wrapped__()
    prompt = out["prompt"]
    assert prompt["kind"] == "select" and prompt["purpose"] == "select_incoming"
    assert prompt["options"] == [
        {"label": "Mom", "ref": {"grantId": "g1"}, "hint": "expires in 3 hours"}
    ]
    # coordinate-free
    blob = repr(out).lower()
    assert "latitude" not in blob and "longitude" not in blob and "lat" not in blob.split("late")[0]


async def test_request_incoming_choice_empty_when_no_active_grants(monkeypatch):
    class _NoneSvc:
        def list_state(self, *, user_id):
            return {"receivedGrants": []}

    monkeypatch.setattr(loc_tools, "_service", lambda: _NoneSvc())
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_incoming_choice.__wrapped__()
    assert out == {"incomingShares": []}


_NOW = datetime(2026, 7, 6, 12, 0, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    ("expires_at", "expected"),
    [
        # ISO timestamps (what the service actually emits) -> relative time
        ("2026-07-06T15:00:00+00:00", "expires in 3 hours"),
        ("2026-07-06T12:45:00+00:00", "expires in 45 minutes"),
        ("2026-07-06T12:01:00+00:00", "expires in 1 minute"),  # singular
        ("2026-07-06T13:00:00+00:00", "expires in 1 hour"),  # singular
        ("2026-07-06T12:00:00+00:00", "expired"),  # boundary / already past
        ("2026-07-06T11:30:00+00:00", "expired"),
        # 'Z' suffix is accepted too
        ("2026-07-06T14:00:00Z", "expires in 2 hours"),
        # no timestamp -> no hint
        (None, None),
        ("", None),
    ],
)
def test_expiry_hint_is_relative_and_human_friendly(expires_at, expected):
    assert loc_tools._expiry_hint(expires_at, now=_NOW) == expected


def test_expiry_hint_accepts_datetime_objects():
    assert loc_tools._expiry_hint(_NOW + timedelta(hours=6), now=_NOW) == "expires in 6 hours"


def test_expiry_hint_hours_round_to_nearest():
    # 2h30m rounds up to 3 hours; 1h20m rounds down to 1 hour.
    assert loc_tools._expiry_hint(_NOW + timedelta(hours=2, minutes=30), now=_NOW) == (
        "expires in 3 hours"
    )
    assert loc_tools._expiry_hint(_NOW + timedelta(hours=1, minutes=20), now=_NOW) == (
        "expires in 1 hour"
    )


async def test_request_confirmation_returns_confirm_prompt():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_confirmation.__wrapped__("Revoke your public link?", True)
    assert out["prompt"]["kind"] == "confirm"
    assert out["prompt"]["destructive"] is True
    assert "public link" in out["prompt"]["question"]
