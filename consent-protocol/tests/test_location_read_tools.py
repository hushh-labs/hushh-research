"""
tests/test_location_read_tools.py

Unit tests for the Location narrow-read MCP tool handlers
(location_get_state, location_list_circles).

These follow the RIA consent_token + VAULT_OWNER pattern, so unlike the
navigate-only handlers they need a real (in-memory-validated) token -- see
tests/conftest.py's vault_owner_token_for_user fixture -- and their
underlying service calls are monkeypatched rather than hitting a live DB.

The load-bearing assertion in this file is the redaction contract:
location_get_state must reduce OneLocationAgentService.list_state()'s raw
payload (which includes myRecipientKey and other people's display
names/masked phone numbers) down to five count fields only.
"""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
from hushh_mcp.services.one_location_circle_service import OneLocationCircleService
from mcp_modules.tools import location_tools


def _parse(result) -> dict:
    assert result, "Handler returned empty list"
    return json.loads(result[0].text)


# ---------------------------------------------------------------------------
# Missing-argument / auth-path tests -- no service call reached
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_state_missing_args_returns_error():
    payload = _parse(await location_tools.handle_location_get_state({}))
    assert payload["status"] == "error"


@pytest.mark.asyncio
async def test_list_circles_missing_args_returns_error():
    payload = _parse(await location_tools.handle_location_list_circles({}))
    assert payload["status"] == "error"


@pytest.mark.asyncio
async def test_get_state_wrong_user_token_returns_forbidden(vault_owner_token_for_user):
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await location_tools.handle_location_get_state(
            {"user_id": "user_b", "consent_token": token}
        )
    )
    assert payload["status"] == "forbidden"
    assert payload["reason"] == "token_user_mismatch"


@pytest.mark.asyncio
async def test_list_circles_wrong_user_token_returns_forbidden(vault_owner_token_for_user):
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await location_tools.handle_location_list_circles(
            {"user_id": "user_b", "consent_token": token}
        )
    )
    assert payload["status"] == "forbidden"
    assert payload["reason"] == "token_user_mismatch"


# ---------------------------------------------------------------------------
# location_get_state -- the redaction contract
# ---------------------------------------------------------------------------

_RAW_LIST_STATE_PAYLOAD = {
    "recipients": [{"id": "r1"}, {"id": "r2"}],
    "circles": [{"id": "c1"}],
    "myRecipientKey": {
        "keyId": "k1",
        "publicKey": "pub...",
        "encryptedPrivateKey": "opaque-vault-key-wrapped-blob",
    },
    "ownerGrants": [
        {
            "id": "g1",
            "status": "active",
            "recipientDisplayName": "Alex Recipient",
            "recipientMaskedPhone": "+1********99",
        },
        {"id": "g2", "status": "expired", "recipientDisplayName": "Old Grant"},
    ],
    "receivedGrants": [
        {
            "id": "g3",
            "status": "active",
            "ownerDisplayName": "Jamie Owner",
            "ownerMaskedPhone": "+1********11",
        },
    ],
    "requests": [
        {"id": "req1", "status": "pending", "requesterDisplayName": "Sam Requester"},
        {"id": "req2", "status": "expired"},
    ],
}


@pytest.mark.asyncio
async def test_get_state_returns_only_derived_counts(monkeypatch, vault_owner_token_for_user):
    monkeypatch.setattr(
        OneLocationAgentService,
        "list_state",
        lambda self, *, user_id: _RAW_LIST_STATE_PAYLOAD,
    )
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await location_tools.handle_location_get_state(
            {"user_id": "user_a", "consent_token": token}
        )
    )

    assert payload["status"] == "ok"
    assert payload["sharing"] == {
        "active_owner_grants": 1,
        "active_received_grants": 1,
        "pending_requests": 1,
        "circle_count": 1,
        "verified_recipient_count": 2,
    }

    # The load-bearing assertion: none of the raw payload's sensitive fields
    # -- key material or any other person's PII -- may leak through, even
    # indirectly (e.g. nested inside an unexpected passthrough key).
    serialized = json.dumps(payload)
    for forbidden in (
        "myRecipientKey",
        "encryptedPrivateKey",
        "recipientDisplayName",
        "recipientMaskedPhone",
        "ownerDisplayName",
        "ownerMaskedPhone",
        "requesterDisplayName",
        "Alex Recipient",
        "Jamie Owner",
        "Sam Requester",
    ):
        assert forbidden not in serialized, f"{forbidden!r} leaked into location_get_state response"


# ---------------------------------------------------------------------------
# location_list_circles -- already-safe passthrough
# ---------------------------------------------------------------------------

_RAW_CIRCLE_LIST = [
    {
        "id": "c1",
        "name": "Family",
        "kind": "family",
        "role": "owner",
        "memberCount": 4,
        "memberLimit": 20,
    },
]


@pytest.mark.asyncio
async def test_list_circles_returns_service_result(monkeypatch, vault_owner_token_for_user):
    monkeypatch.setattr(
        OneLocationCircleService,
        "list_circles",
        lambda self, *, user_id: _RAW_CIRCLE_LIST,
    )
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await location_tools.handle_location_list_circles(
            {"user_id": "user_a", "consent_token": token}
        )
    )

    assert payload["status"] == "ok"
    assert payload["circles"] == _RAW_CIRCLE_LIST
