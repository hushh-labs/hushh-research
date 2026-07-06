"""Regression tests for the fixes that came out of manual testing:

- the model must be able to discover real grant ids (list_active_location_shares)
- a guessed / non-UUID id must fail cleanly BEFORE hitting Postgres
- the runner's function declarations must not drift from the tool allow-list

Tools are invoked via ``.__wrapped__`` to bypass the @hushh_tool token/scope
check (which needs a live token); the underlying logic + HushhContext use is
exercised directly.
"""

from __future__ import annotations

import pytest
from google.genai import types

from hushh_mcp.agents.location import tools
from hushh_mcp.agents.location import tools as loc_tools
from hushh_mcp.agents.location.tools import (
    CONTROL_PLANE_LOCATION_TOOLS,
    propose_location_view,
    propose_public_link,
)
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.location_chat_service import _function_declarations

_VALID_UUID = "22e4345c-b84f-4789-853e-f77010b32f91"
_HALLUCINATED = "_-HKa9Do8xBsyZOB-MDeVIWZTFkaSc7pJ5zunMh5mSU"


async def test_list_active_shares_returns_only_active_grants_with_ids(monkeypatch):
    class _Svc:
        def list_state(self, *, user_id):
            return {
                "ownerGrants": [
                    {
                        "id": "g-active",
                        "status": "active",
                        "recipientUserId": "r1",
                        "recipientDisplayName": "Mom",
                        "expiresAt": "2026-06-28T10:00:00Z",
                    },
                    {"id": "g-revoked", "status": "revoked", "recipientDisplayName": "Dad"},
                ]
            }

    monkeypatch.setattr(tools, "_service", lambda: _Svc())

    with HushhContext(user_id="u", consent_token="t", vault_keys={}):  # noqa: S106
        out = await tools.list_active_location_shares.__wrapped__()

    assert out == {
        "activeShares": [
            {
                "grantId": "g-active",
                "recipientUserId": "r1",
                "recipientDisplayName": "Mom",
                "expiresAt": "2026-06-28T10:00:00Z",
            }
        ]
    }


async def test_revoke_rejects_hallucinated_id_before_touching_db(monkeypatch):
    calls: list = []

    class _Svc:
        def revoke_grant(self, **kwargs):
            calls.append(kwargs)
            return {}

    monkeypatch.setattr(tools, "_service", lambda: _Svc())

    with HushhContext(user_id="u", consent_token="t", vault_keys={}):  # noqa: S106
        with pytest.raises(ValueError):
            await tools.revoke_location_share.__wrapped__(grant_id=_HALLUCINATED)

    assert calls == []  # the bad id never reached the database


async def test_revoke_passes_valid_uuid_through_to_service(monkeypatch):
    calls: list = []

    class _Svc:
        def revoke_grant(self, **kwargs):
            calls.append(kwargs)
            return {"status": "revoked"}

    monkeypatch.setattr(tools, "_service", lambda: _Svc())

    with HushhContext(user_id="owner-1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await tools.revoke_location_share.__wrapped__(grant_id=_VALID_UUID)

    assert out == {"status": "revoked"}
    assert calls == [{"owner_user_id": "owner-1", "grant_id": _VALID_UUID}]


def test_function_declarations_match_control_plane_tools():
    declared = {decl.name for decl in _function_declarations(types)}
    tool_names = {t._name for t in CONTROL_PLANE_LOCATION_TOOLS}
    assert declared == tool_names


async def test_propose_public_link_returns_directive_without_mutation():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await propose_public_link.__wrapped__(2)
    assert out == {"proposed": "create_public_link", "durationHours": 2.0}


async def test_propose_public_link_rejects_out_of_range_duration():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        with pytest.raises(ValueError):
            await propose_public_link.__wrapped__(99)


async def test_propose_location_view_rejects_non_uuid():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        with pytest.raises(ValueError):
            await propose_location_view.__wrapped__("not-a-uuid")


class _FakeSvc:
    def list_verified_recipients(self, *, owner_user_id, limit=50):
        return [
            {"userId": "u-mom", "displayName": "Mom", "keyId": "k-mom", "canReceiveLocation": True},
            {"userId": "u-kid", "displayName": "Kid", "keyId": None, "canReceiveLocation": False},
        ]

    def list_state(self, *, user_id):
        return {
            "ownerGrants": [
                {
                    "id": "g1",
                    "recipientDisplayName": "Mom",
                    "expiresAt": "later",
                    "status": "active",
                }
            ],
            "receivedGrants": [],
            "requests": [],
        }


async def test_request_recipient_choice_options_carry_real_ids_and_public_link(monkeypatch):
    monkeypatch.setattr(loc_tools, "_service", lambda: _FakeSvc())
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_recipient_choice.__wrapped__()
    prompt = out["prompt"]
    assert prompt["kind"] == "select" and prompt["purpose"] == "select_recipient"
    assert prompt["options"][0]["ref"] == {"recipientUserId": "u-mom", "recipientKeyId": "k-mom"}
    assert prompt["options"][1]["hint"] == "hasn't set up location yet"
    assert prompt["options"][-1]["ref"] == {"publicLink": True}
    # coordinate-free
    blob = repr(out).lower()
    assert "latitude" not in blob and "longitude" not in blob and "lat" not in blob.split("late")[0]


class _DupNameSvc:
    """Directory with two contacts sharing the same display name."""

    def list_verified_recipients(self, *, owner_user_id, limit=50):
        return [
            {
                "userId": "u-abdul",
                "displayName": "Abdul Zalil",
                "keyId": "k1",
                "canReceiveLocation": True,
            },
            {
                "userId": "u-neel-1",
                "displayName": "Neelesh Meena",
                "keyId": "k2",
                "canReceiveLocation": True,
            },
            {
                "userId": "u-gautam",
                "displayName": "Gautam Ahuja",
                "keyId": "k3",
                "canReceiveLocation": True,
            },
            {
                "userId": "u-neel-2",
                "displayName": "Neelesh Meena",
                "keyId": "k4",
                "canReceiveLocation": True,
            },
        ]


async def test_request_recipient_choice_filters_to_named_matches(monkeypatch):
    # Disambiguation bug: when the user named a person that matches >1 contact,
    # the picker must show ONLY those matches, not the whole directory, and must
    # not offer a public link (the user named a specific person).
    monkeypatch.setattr(loc_tools, "_service", lambda: _DupNameSvc())
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_recipient_choice.__wrapped__(name="Neelesh Meena")
    prompt = out["prompt"]
    labels = [o["label"] for o in prompt["options"]]
    assert labels == ["Neelesh Meena", "Neelesh Meena"]
    refs = [o["ref"] for o in prompt["options"]]
    assert {"recipientUserId": "u-neel-1", "recipientKeyId": "k2"} in refs
    assert {"recipientUserId": "u-neel-2", "recipientKeyId": "k4"} in refs
    assert all("publicLink" not in o["ref"] for o in prompt["options"])
    assert "Neelesh Meena" in prompt["question"]


async def test_request_recipient_choice_falls_back_when_name_unmatched(monkeypatch):
    # A name that matches nothing must not strand the user with an empty picker:
    # fall back to the full directory (with the public-link escape hatch).
    monkeypatch.setattr(loc_tools, "_service", lambda: _DupNameSvc())
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_recipient_choice.__wrapped__(name="Nobody Here")
    options = out["prompt"]["options"]
    assert len(options) == 5  # 4 contacts + public link
    assert options[-1]["ref"] == {"publicLink": True}


async def test_request_active_share_choice_includes_stop_all(monkeypatch):
    monkeypatch.setattr(loc_tools, "_service", lambda: _FakeSvc())
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_active_share_choice.__wrapped__()
    refs = [o["ref"] for o in out["prompt"]["options"]]
    assert {"grantId": "g1"} in refs
    assert {"all": True} in refs


async def test_request_confirmation_returns_confirm_prompt():
    with HushhContext(user_id="u1", consent_token="t", vault_keys={}):  # noqa: S106
        out = await loc_tools.request_confirmation.__wrapped__("Stop sharing with everyone?", True)
    assert out["prompt"]["kind"] == "confirm"
    assert out["prompt"]["destructive"] is True
    assert "everyone" in out["prompt"]["question"]
