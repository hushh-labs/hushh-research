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
from hushh_mcp.agents.location.tools import CONTROL_PLANE_LOCATION_TOOLS
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
