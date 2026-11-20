"""Sharing tool family: requests, private shares, check-ins, public links.

Every handler is exercised against an injected Location service double, so the
assertions are about the tool contract -- statuses, spoken facts derived from
the double's data, the confirmation-card summary, and that a spoken name can
never stand in for a person id.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from hushh_mcp.one_voice.tools import sharing
from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    EntityContext,
    ScreenContext,
    ToolContext,
    ToolPolicy,
    ToolSpec,
    now_iso,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError

ME = "user-me"
AYESHA_ID = "user-ayesha"
BOB_ID = "user-bob"
CAROL_ID = "user-carol"
REQUEST_ID = "2f4b7e2c-2c1e-4d3a-9c7f-1a2b3c4d5e6f"
GRANT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
INVITE_ID = "9b2c7d1e-3f4a-4b5c-8d6e-7f8a9b0c1d2e"


def _fixture_credential(kind: str) -> str:
    """A test double for a token; never a real credential."""
    return f"{kind}-fixture-token"


def _iso_in(hours: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _person(
    user_id: str, name: str, *, relationship: str = "connected", key: bool = True
) -> ConfirmedPerson:
    return ConfirmedPerson(
        user_id=user_id,
        display_name=name,
        relationship=relationship,  # type: ignore[arg-type]
        has_location_key=key,
        confirmed_at=now_iso(),
    )


class FakeLocationService:
    """Records every call; returns canned payloads shaped like the real service."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.errors: dict[str, Exception] = {}
        self.results: dict[str, Any] = {}

    def _call(self, name: str, **kwargs: Any) -> Any:
        self.calls.append((name, kwargs))
        if name in self.errors:
            raise self.errors[name]
        return self.results.get(name)

    def called(self, name: str) -> dict[str, Any] | None:
        for called, kwargs in self.calls:
            if called == name:
                return kwargs
        return None

    def list_pending_requester_requests(self, **kwargs: Any) -> Any:
        return self._call("list_pending_requester_requests", **kwargs) or []

    def request_access(self, **kwargs: Any) -> Any:
        return self._call("request_access", **kwargs)

    def list_state(self, **kwargs: Any) -> Any:
        return self._call("list_state", **kwargs) or {}

    def approve_request(self, **kwargs: Any) -> Any:
        return self._call("approve_request", **kwargs)

    def deny_request(self, **kwargs: Any) -> Any:
        return self._call("deny_request", **kwargs)

    def withdraw_request(self, **kwargs: Any) -> Any:
        return self._call("withdraw_request", **kwargs)

    def list_verified_recipients(self, **kwargs: Any) -> Any:
        return self._call("list_verified_recipients", **kwargs) or []

    def create_grant(self, **kwargs: Any) -> Any:
        return self._call("create_grant", **kwargs)

    def revoke_grant(self, **kwargs: Any) -> Any:
        return self._call("revoke_grant", **kwargs)

    def set_grant_duration(self, **kwargs: Any) -> Any:
        return self._call("set_grant_duration", **kwargs)

    def create_public_invite(self, **kwargs: Any) -> Any:
        return self._call("create_public_invite", **kwargs)

    def revoke_public_invite(self, **kwargs: Any) -> Any:
        return self._call("revoke_public_invite", **kwargs)


def _ctx(service: FakeLocationService | None = None) -> tuple[ToolContext, FakeLocationService]:
    fake = service or FakeLocationService()
    entities = EntityContext()
    entities.remember_person(_person(AYESHA_ID, "Ayesha Sharma"))
    entities.remember_person(_person(BOB_ID, "Bob Iyer", relationship="none"))
    entities.remember_person(_person(CAROL_ID, "Carol Mehta", key=False))
    ctx = ToolContext(
        user_id=ME,
        conversation_id="conv-1",
        entities=entities,
        screen=ScreenContext(),
        vault_owner_token=_fixture_credential("vault"),
        services={"location": fake},
    )
    return ctx, fake


def _tool(name: str) -> ToolSpec:
    for spec in sharing.TOOLS:
        if spec.name == name:
            return spec
    raise AssertionError(f"no tool {name}")


def _request(**overrides: Any) -> dict[str, Any]:
    row = {
        "id": REQUEST_ID,
        "ownerUserId": AYESHA_ID,
        "requesterUserId": ME,
        "requesterDisplayName": None,
        "ownerDisplayName": "Ayesha Sharma",
        "status": "pending",
        "message": None,
        "requestedAt": now_iso(),
        "expiresAt": _iso_in(24),
        "resolvedAt": None,
        "approvedGrantId": None,
        "requestedDurationHours": 2.0,
        "requestedDurationMode": "timed",
        "extendsGrantId": None,
        "isExtension": False,
        "requestRevision": 1,
    }
    row.update(overrides)
    return row


def _grant(**overrides: Any) -> dict[str, Any]:
    row = {
        "id": GRANT_ID,
        "ownerUserId": ME,
        "recipientUserId": AYESHA_ID,
        "ownerDisplayName": None,
        "recipientDisplayName": "Ayesha Sharma",
        "status": "active",
        "durationMode": "timed",
        "durationHours": 1.0,
        "expiresAt": _iso_in(1),
        "createdAt": now_iso(),
        "revokedAt": None,
        "latestEnvelopeId": None,
        "shareKind": "share",
        "shareMessage": None,
    }
    row.update(overrides)
    return row


def _invite(**overrides: Any) -> dict[str, Any]:
    row = {
        "id": INVITE_ID,
        "ownerUserId": ME,
        "status": "active",
        "durationHours": 1.0,
        "expiresAt": _iso_in(1),
        "createdAt": now_iso(),
        "revokedAt": None,
        "publicUrl": "/one/location/view/me.abc123",
    }
    row.update(overrides)
    return row


# -- catalog ---------------------------------------------------------------------


EXPECTED_BINDINGS = {
    "request_location": (ToolPolicy.confirm_voice, "location.send_request"),
    "list_requests": (ToolPolicy.read, "location.open_needs_review"),
    "respond_request": (ToolPolicy.confirm_voice, "location.approve_request"),
    "withdraw_request": (ToolPolicy.confirm_voice, "location.send_request"),
    "share_with": (ToolPolicy.confirm_voice, "location.share_selected"),
    "list_shares": (ToolPolicy.read, "location.open_active_shares"),
    "stop_share": (ToolPolicy.confirm_tap, "location.stop_share"),
    "change_share_duration": (ToolPolicy.confirm_voice, "location.change_share_duration"),
    "create_check_in": (ToolPolicy.confirm_voice, "location.send_check_in"),
    "list_links": (ToolPolicy.read, "location.open_links"),
    "create_public_link": (ToolPolicy.confirm_voice, "location.create_public_link"),
    "revoke_public_link": (ToolPolicy.confirm_tap, "location.revoke_public_link"),
}


def test_catalog_policies_and_gateway_bindings():
    assert {spec.name for spec in sharing.TOOLS} == set(EXPECTED_BINDINGS)
    for spec in sharing.TOOLS:
        policy, action_id = EXPECTED_BINDINGS[spec.name]
        assert spec.policy is policy, spec.name
        assert spec.gateway_action_id == action_id, spec.name
        assert spec.firebase_plane is False, spec.name
        if spec.policy.needs_confirmation:
            assert spec.summarize is not None, spec.name


def test_every_gateway_id_exists_in_the_contract():
    contract = (
        Path(__file__).resolve().parents[2] / "contracts" / "kai" / "kai-action-gateway.vnext.json"
    )
    action_ids = {row["action_id"] for row in json.loads(contract.read_text())["actions"]}
    for spec in sharing.TOOLS:
        assert spec.gateway_action_id in action_ids, spec.name


def test_person_targeted_tools_take_person_refs_only():
    for name in ("request_location", "share_with", "create_check_in"):
        spec = _tool(name)
        assert spec.person_args == ("person",)
        schema = spec.declaration()["parameters_json_schema"]
        assert schema["properties"]["person"]["properties"] == {
            "user_id": schema["properties"]["person"]["properties"]["user_id"]
        }
        assert "person" in schema["required"]


def test_no_input_accepts_a_free_text_name():
    for spec in sharing.TOOLS:
        fields = set(spec.input_model.model_fields)
        assert not fields & {"name", "display_name", "person_name", "recipient_name"}, spec.name
        with pytest.raises(ValidationError):
            spec.input_model.model_validate({"person_name": "Ayesha"})
    for name in ("request_location", "share_with", "create_check_in"):
        model = _tool(name).input_model
        with pytest.raises(ValidationError):
            model.model_validate({"person": "Ayesha Sharma"})
        with pytest.raises(ValidationError):
            model.model_validate({"person": {"user_id": AYESHA_ID, "name": "Ayesha"}})
        with pytest.raises(ValidationError):
            model.model_validate({"person": {"display_name": "Ayesha Sharma"}})


def test_declarations_inline_the_person_ref():
    for spec in sharing.TOOLS:
        assert "$defs" not in json.dumps(spec.declaration())


# -- request_location ------------------------------------------------------------


async def test_request_location_pending_states_approval_and_real_expiry():
    ctx, fake = _ctx()
    fake.results["request_access"] = _request()
    spec = _tool("request_location")
    args = spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}, "duration_hours": 2})

    result = await spec.handler(ctx, args)

    assert result.status == "pending"
    assert result.request_id == REQUEST_ID
    assert result.display_name == "Ayesha Sharma"
    assert result.spoken_facts[0] == "Asked Ayesha Sharma to share their location for 2 hours."
    assert "approve" in result.spoken_facts[1]
    assert result.spoken_facts[2] == "The request stays open for 24 hours."
    call = fake.called("request_access")
    assert call == {
        "requester_user_id": ME,
        "owner_user_id": AYESHA_ID,
        "message": None,
        "requested_duration_hours": 2.0,
        "requested_duration_mode": "timed",
    }
    assert spec.summarize(ctx, args) == "ask Ayesha Sharma for their location for 2 hours"


async def test_request_location_extension_wording_comes_from_the_service():
    ctx, fake = _ctx()
    fake.results["request_access"] = _request(
        isExtension=True, extendsGrantId=GRANT_ID, requestedDurationHours=3
    )
    spec = _tool("request_location")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}})
    )
    assert result.status == "pending"
    assert result.is_extension is True
    assert (
        result.spoken_facts[0]
        == "Asked Ayesha Sharma for 3 hours more on the share you already have."
    )


async def test_request_location_already_pending_never_sends_again():
    ctx, fake = _ctx()
    fake.results["list_pending_requester_requests"] = [_request(expiresAt=_iso_in(5))]
    spec = _tool("request_location")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}})
    )
    assert result.status == "already_pending"
    assert result.request_id == REQUEST_ID
    assert result.spoken_facts == [
        "You already asked Ayesha Sharma for their location; that request is still waiting for their approval.",
        "It stays open for another 5 hours.",
    ]
    assert fake.called("request_access") is None


async def test_request_location_not_connected_asks_to_invite():
    ctx, fake = _ctx()
    spec = _tool("request_location")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": BOB_ID}})
    )
    assert result.status == "not_connected"
    assert result.needs == "invite"
    assert result.spoken_facts == [
        "You are not connected with Bob Iyer yet. Would you like to invite them first?"
    ]
    assert fake.calls == []


async def test_request_location_recipient_without_key_is_not_ready():
    ctx, fake = _ctx()
    spec = _tool("request_location")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": CAROL_ID}})
    )
    assert result.status == "recipient_not_ready"
    assert "Carol Mehta" in result.spoken_facts[0]
    assert fake.calls == []


async def test_request_location_rejects_an_unconfirmed_person():
    ctx, fake = _ctx()
    spec = _tool("request_location")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": "user-stranger"}})
    )
    assert result.status == "rejected"
    assert result.reason_code == "person_not_confirmed"
    assert result.needs == "disambiguation"
    assert fake.calls == []


async def test_request_location_maps_service_errors_to_rejected():
    ctx, fake = _ctx()
    fake.errors["request_access"] = OneLocationAgentError(
        "LOCATION_REQUEST_SELF", "Request a different person's location.", status_code=422
    )
    spec = _tool("request_location")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}})
    )
    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_REQUEST_SELF"
    assert result.spoken_facts == ["Request a different person's location."]


# -- list_requests ---------------------------------------------------------------


async def test_list_requests_splits_direction_and_keeps_real_statuses():
    ctx, fake = _ctx()
    fake.results["list_state"] = {
        "requests": [
            _request(
                id="11111111-1111-4111-8111-111111111111",
                ownerUserId=ME,
                requesterUserId=BOB_ID,
                requesterDisplayName="Bob Iyer",
                ownerDisplayName=None,
            ),
            _request(id="22222222-2222-4222-8222-222222222222"),
            _request(
                id="33333333-3333-4333-8333-333333333333",
                status="denied",
                ownerUserId=ME,
                requesterUserId=CAROL_ID,
                requesterDisplayName="Carol Mehta",
            ),
        ]
    }
    spec = _tool("list_requests")
    result = await spec.handler(ctx, spec.input_model.model_validate({}))
    assert result.status == "ok"
    assert [item["direction"] for item in result.requests] == ["incoming", "outgoing", "incoming"]
    assert [item["status"] for item in result.requests] == ["pending", "pending", "denied"]
    assert result.incoming_pending == 1
    assert result.outgoing_pending == 1
    assert result.spoken_facts == [
        "1 request is waiting for your approval: Bob Iyer.",
        "1 request you sent is still waiting: Ayesha Sharma.",
        "1 earlier request has already been settled.",
    ]
    assert fake.called("list_state") == {"user_id": ME}


async def test_list_requests_direction_filter_and_empty():
    ctx, fake = _ctx()
    fake.results["list_state"] = {"requests": [_request()]}
    spec = _tool("list_requests")
    result = await spec.handler(ctx, spec.input_model.model_validate({"direction": "incoming"}))
    assert result.status == "empty"
    assert result.requests == []
    assert result.spoken_facts == ["No location requests are waiting for your approval."]


# -- respond_request -------------------------------------------------------------


async def test_respond_request_approve_creates_grant_and_needs_publish():
    ctx, fake = _ctx()
    fake.results["approve_request"] = {
        "request": _request(
            ownerUserId=ME,
            requesterUserId=AYESHA_ID,
            status="approved",
            requesterDisplayName="Ayesha Sharma",
            approvedGrantId=GRANT_ID,
        ),
        "grant": _grant(durationHours=2.0, expiresAt=_iso_in(2)),
        "recipient": {"userId": AYESHA_ID},
    }
    spec = _tool("respond_request")
    args = spec.input_model.model_validate(
        {"request_id": REQUEST_ID, "approve": True, "duration_hours": 2}
    )
    result = await spec.handler(ctx, args)
    assert result.status == "approved"
    assert result.needs == "client_step"
    assert result.client_step == {
        "kind": "publish_location_envelopes",
        "grant_ids": [GRANT_ID],
        "purpose": "share",
    }
    assert result.grant_id == GRANT_ID
    assert result.requester_name == "Ayesha Sharma"
    assert result.spoken_facts == [
        "Approved. Share created for Ayesha Sharma for 2 hours; sending your position now."
    ]
    assert fake.called("approve_request") == {
        "owner_user_id": ME,
        "request_id": REQUEST_ID,
        "approval_mode": "manual",
        "duration_hours": 2.0,
        "duration_mode": "timed",
    }
    assert spec.summarize(ctx, args) == "approve that location request and share for 2 hours"


async def test_respond_request_deny_and_summary():
    ctx, fake = _ctx()
    fake.results["deny_request"] = _request(
        ownerUserId=ME, requesterUserId=AYESHA_ID, status="denied"
    )
    spec = _tool("respond_request")
    args = spec.input_model.model_validate({"request_id": REQUEST_ID, "approve": False})
    result = await spec.handler(ctx, args)
    assert result.status == "denied"
    assert result.spoken_facts == ["Declined Ayesha Sharma's location request. Nothing was shared."]
    assert fake.called("deny_request") == {"owner_user_id": ME, "request_id": REQUEST_ID}
    assert spec.summarize(ctx, args) == "decline that location request"


@pytest.mark.parametrize(
    ("code", "status"),
    [("LOCATION_REQUEST_NOT_FOUND", "not_found"), ("LOCATION_REQUEST_EXPIRED", "expired")],
)
async def test_respond_request_missing_or_expired(code: str, status: str):
    ctx, fake = _ctx()
    fake.errors["approve_request"] = OneLocationAgentError(code, "gone", status_code=404)
    spec = _tool("respond_request")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"request_id": REQUEST_ID, "approve": True})
    )
    assert result.status == status
    assert result.reason_code == code


async def test_respond_request_sharing_off_needs_setup():
    ctx, fake = _ctx()
    fake.errors["approve_request"] = OneLocationAgentError(
        "LOCATION_SHARING_OFF",
        "Location sharing is turned off. Turn it on to share.",
        status_code=409,
    )
    spec = _tool("respond_request")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"request_id": REQUEST_ID, "approve": True})
    )
    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_SHARING_OFF"
    assert result.needs == "setup"
    assert result.spoken_facts == ["Location sharing is off. Turn it on first."]


async def test_respond_request_rejects_a_non_uuid_id():
    ctx, fake = _ctx()
    spec = _tool("respond_request")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"request_id": "Ayesha", "approve": True})
    )
    assert result.status == "rejected"
    assert result.reason_code == "invalid_id"
    assert fake.calls == []


# -- withdraw_request ------------------------------------------------------------


async def test_withdraw_request_names_the_owner_when_known():
    ctx, fake = _ctx()
    fake.results["withdraw_request"] = _request(status="cancelled", ownerDisplayName=None)
    spec = _tool("withdraw_request")
    args = spec.input_model.model_validate({"request_id": REQUEST_ID})
    result = await spec.handler(ctx, args)
    assert result.status == "withdrawn"
    # The service row carries no owner name; the confirmed entity supplies it.
    assert result.spoken_facts == ["Took back your location request to Ayesha Sharma."]
    assert fake.called("withdraw_request") == {"requester_user_id": ME, "request_id": REQUEST_ID}
    assert spec.summarize(ctx, args) == "take back the location request you sent"


async def test_withdraw_request_not_found():
    ctx, fake = _ctx()
    fake.errors["withdraw_request"] = OneLocationAgentError(
        "LOCATION_REQUEST_NOT_FOUND", "nope", status_code=404
    )
    spec = _tool("withdraw_request")
    result = await spec.handler(ctx, spec.input_model.model_validate({"request_id": REQUEST_ID}))
    assert result.status == "not_found"


# -- share_with ------------------------------------------------------------------


async def test_share_with_creates_grant_and_hands_publish_to_the_client():
    ctx, fake = _ctx()
    fake.results["list_verified_recipients"] = [
        {"userId": BOB_ID, "keyId": "key-bob"},
        {"userId": AYESHA_ID, "keyId": "key-ayesha"},
    ]
    fake.results["create_grant"] = _grant()
    spec = _tool("share_with")
    args = spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}})
    result = await spec.handler(ctx, args)
    assert result.status == "grant_created"
    assert result.needs == "client_step"
    assert result.client_step == {
        "kind": "publish_location_envelopes",
        "grant_ids": [GRANT_ID],
        "purpose": "share",
    }
    assert result.spoken_facts == [
        "Share created for Ayesha Sharma for 1 hour; sending your position now."
    ]
    assert "shared" not in " ".join(result.spoken_facts).lower()
    assert fake.called("create_grant") == {
        "owner_user_id": ME,
        "recipient_user_id": AYESHA_ID,
        "recipient_key_id": "key-ayesha",
        "duration_hours": 1.0,
        "duration_mode": "timed",
        "reason": None,
        "share_kind": "share",
        "enforce_connection": True,
        "require_recipient_phone_verified": False,
    }
    assert spec.summarize(ctx, args) == "share your location with Ayesha Sharma for 1 hour"


async def test_share_with_until_stopped():
    ctx, fake = _ctx()
    fake.results["list_verified_recipients"] = [{"userId": AYESHA_ID, "keyId": "key-ayesha"}]
    fake.results["create_grant"] = _grant(
        durationMode="until_stopped", durationHours=None, expiresAt=None
    )
    spec = _tool("share_with")
    args = spec.input_model.model_validate(
        {"person": {"user_id": AYESHA_ID}, "until_stopped": True}
    )
    result = await spec.handler(ctx, args)
    assert result.status == "grant_created"
    assert result.spoken_facts == [
        "Share created for Ayesha Sharma until you stop it; sending your position now."
    ]
    call = fake.called("create_grant")
    assert call["duration_hours"] is None
    assert call["duration_mode"] == "until_stopped"
    assert spec.summarize(ctx, args) == "share your location with Ayesha Sharma until you stop it"


async def test_share_with_sharing_off_needs_setup():
    ctx, fake = _ctx()
    fake.results["list_verified_recipients"] = [{"userId": AYESHA_ID, "keyId": "key-ayesha"}]
    fake.errors["create_grant"] = OneLocationAgentError(
        "LOCATION_SHARING_OFF", "off", status_code=409
    )
    spec = _tool("share_with")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}})
    )
    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_SHARING_OFF"
    assert result.needs == "setup"
    assert result.spoken_facts == ["Location sharing is off. Turn it on first."]


async def test_share_with_recipient_missing_from_verified_list_is_not_ready():
    ctx, fake = _ctx()
    fake.results["list_verified_recipients"] = [{"userId": BOB_ID, "keyId": "key-bob"}]
    spec = _tool("share_with")
    result = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}})
    )
    assert result.status == "recipient_not_ready"
    assert result.spoken_facts == ["Ayesha Sharma isn't ready to receive your location yet."]
    assert fake.called("create_grant") is None


async def test_share_with_not_connected_and_unconfirmed():
    ctx, fake = _ctx()
    spec = _tool("share_with")
    not_connected = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": BOB_ID}})
    )
    assert not_connected.status == "not_connected"
    assert not_connected.needs == "invite"
    unconfirmed = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": "user-x"}})
    )
    assert unconfirmed.status == "rejected"
    assert unconfirmed.reason_code == "person_not_confirmed"
    assert fake.calls == []


# -- list_shares -----------------------------------------------------------------


async def test_list_shares_reports_direction_status_and_first_position():
    ctx, fake = _ctx()
    fake.results["list_state"] = {
        "ownerGrants": [
            _grant(),
            _grant(
                id="44444444-4444-4444-8444-444444444444",
                status="revoked",
                recipientUserId=BOB_ID,
                recipientDisplayName="Bob Iyer",
            ),
        ],
        "receivedGrants": [
            _grant(
                id="55555555-5555-4555-8555-555555555555",
                ownerUserId=CAROL_ID,
                recipientUserId=ME,
                ownerDisplayName="Carol Mehta",
                recipientDisplayName=None,
                latestEnvelopeId="env-1",
                durationMode="until_stopped",
                durationHours=None,
                expiresAt=None,
            ),
        ],
    }
    spec = _tool("list_shares")
    result = await spec.handler(ctx, spec.input_model.model_validate({}))
    assert result.status == "ok"
    assert result.active_outgoing == 1
    assert result.active_incoming == 1
    assert result.outgoing[0]["awaiting_first_position"] is True
    assert result.outgoing[1]["status"] == "revoked"
    assert result.outgoing[1]["awaiting_first_position"] is False
    assert result.incoming[0]["has_latest_envelope"] is True
    assert result.spoken_facts == [
        "You're sharing your location with 1 person: Ayesha Sharma (1 hour left, no position sent yet).",
        "1 person is sharing with you: Carol Mehta (until stopped).",
    ]


async def test_list_shares_empty():
    ctx, fake = _ctx()
    fake.results["list_state"] = {"ownerGrants": [], "receivedGrants": []}
    spec = _tool("list_shares")
    result = await spec.handler(ctx, spec.input_model.model_validate({}))
    assert result.status == "empty"
    assert result.spoken_facts == ["No active location shares right now."]


# -- stop_share ------------------------------------------------------------------


async def test_stop_share_revokes_and_names_the_recipient():
    ctx, fake = _ctx()
    fake.results["revoke_grant"] = _grant(
        status="revoked", revokedAt=now_iso(), recipientDisplayName=None
    )
    spec = _tool("stop_share")
    args = spec.input_model.model_validate({"grant_id": GRANT_ID})
    result = await spec.handler(ctx, args)
    assert result.status == "stopped"
    assert result.reason_code is None
    assert result.spoken_facts == ["Stopped sharing your location with Ayesha Sharma."]
    assert fake.called("revoke_grant") == {"owner_user_id": ME, "grant_id": GRANT_ID}
    assert spec.summarize(ctx, args) == "stop that location share"


async def test_stop_share_already_ended_and_not_found():
    ctx, fake = _ctx()
    fake.results["revoke_grant"] = _grant(status="expired")
    spec = _tool("stop_share")
    ended = await spec.handler(ctx, spec.input_model.model_validate({"grant_id": GRANT_ID}))
    assert ended.status == "stopped"
    assert ended.reason_code == "already_ended"
    assert ended.spoken_facts == ["That share had already ended."]
    fake.errors["revoke_grant"] = OneLocationAgentError(
        "LOCATION_GRANT_NOT_FOUND", "nope", status_code=404
    )
    missing = await spec.handler(ctx, spec.input_model.model_validate({"grant_id": GRANT_ID}))
    assert missing.status == "not_found"
    assert missing.reason_code == "LOCATION_GRANT_NOT_FOUND"


# -- change_share_duration -------------------------------------------------------


async def test_change_share_duration_updates_with_real_expiry():
    ctx, fake = _ctx()
    fake.results["set_grant_duration"] = _grant(
        durationHours=2.0, expiresAt=_iso_in(2), recipientDisplayName=None
    )
    spec = _tool("change_share_duration")
    args = spec.input_model.model_validate({"grant_id": GRANT_ID, "duration_hours": 2})
    result = await spec.handler(ctx, args)
    assert result.status == "updated"
    assert result.spoken_facts == [
        "Your share with Ayesha Sharma is now set to 2 hours, with 2 hours left."
    ]
    assert fake.called("set_grant_duration") == {
        "owner_user_id": ME,
        "grant_id": GRANT_ID,
        "duration_hours": 2.0,
        "duration_mode": "timed",
    }
    assert spec.summarize(ctx, args) == "change that location share to 2 hours"


async def test_change_share_duration_until_stopped_and_not_active():
    ctx, fake = _ctx()
    fake.results["set_grant_duration"] = _grant(
        durationMode="until_stopped", durationHours=None, expiresAt=None
    )
    spec = _tool("change_share_duration")
    args = spec.input_model.model_validate({"grant_id": GRANT_ID, "until_stopped": True})
    result = await spec.handler(ctx, args)
    assert result.status == "updated"
    assert result.spoken_facts == ["Your share with Ayesha Sharma now runs until you stop it."]
    assert fake.called("set_grant_duration")["duration_mode"] == "until_stopped"
    assert spec.summarize(ctx, args) == "keep that location share running until you stop it"

    fake.results["set_grant_duration"] = _grant(status="revoked")
    stale = await spec.handler(ctx, args)
    assert stale.status == "not_active"
    assert stale.spoken_facts == ["That share is revoked, so its length can't be changed."]


async def test_change_share_duration_requires_a_length():
    ctx, fake = _ctx()
    spec = _tool("change_share_duration")
    result = await spec.handler(ctx, spec.input_model.model_validate({"grant_id": GRANT_ID}))
    assert result.status == "rejected"
    assert result.reason_code == "invalid_arguments"
    assert fake.calls == []


# -- create_check_in -------------------------------------------------------------


async def test_create_check_in_uses_note_as_reason_and_needs_publish():
    ctx, fake = _ctx()
    fake.results["list_verified_recipients"] = [{"userId": AYESHA_ID, "keyId": "key-ayesha"}]
    fake.results["create_grant"] = _grant(shareKind="check_in", shareMessage="Home safe")
    spec = _tool("create_check_in")
    args = spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}, "note": "Home  safe"})
    result = await spec.handler(ctx, args)
    assert result.status == "check_in_created"
    assert result.needs == "client_step"
    assert result.client_step == {
        "kind": "publish_location_envelopes",
        "grant_ids": [GRANT_ID],
        "purpose": "check_in",
    }
    assert result.spoken_facts == [
        "Check-in created for Ayesha Sharma; sending your position now.",
        "Your note: Home safe",
    ]
    call = fake.called("create_grant")
    assert call["share_kind"] == "check_in"
    assert call["reason"] == "Home safe"
    assert call["duration_hours"] == 1
    assert call["enforce_connection"] is True
    assert call["require_recipient_phone_verified"] is False
    assert (
        spec.summarize(ctx, args)
        == 'send Ayesha Sharma a check-in with your location saying "Home safe"'
    )


async def test_create_check_in_without_note_and_gates():
    ctx, fake = _ctx()
    fake.results["list_verified_recipients"] = [{"userId": AYESHA_ID, "keyId": "key-ayesha"}]
    fake.results["create_grant"] = _grant(shareKind="check_in")
    spec = _tool("create_check_in")
    args = spec.input_model.model_validate({"person": {"user_id": AYESHA_ID}})
    result = await spec.handler(ctx, args)
    assert result.status == "check_in_created"
    assert fake.called("create_grant")["reason"] == "check_in"
    assert spec.summarize(ctx, args) == "send Ayesha Sharma a check-in with your location"
    not_connected = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": BOB_ID}})
    )
    assert not_connected.status == "not_connected"
    not_ready = await spec.handler(
        ctx, spec.input_model.model_validate({"person": {"user_id": CAROL_ID}})
    )
    assert not_ready.status == "recipient_not_ready"


# -- list_links ------------------------------------------------------------------


async def test_list_links_reports_status_and_url():
    ctx, fake = _ctx()
    fake.results["list_state"] = {
        "publicInvites": [
            _invite(),
            _invite(id="66666666-6666-4666-8666-666666666666", status="expired", publicUrl=None),
            _invite(id="77777777-7777-4777-8777-777777777777", status="revoked", publicUrl=None),
        ]
    }
    spec = _tool("list_links")
    result = await spec.handler(ctx, spec.input_model.model_validate({}))
    assert result.status == "ok"
    assert result.active_count == 1
    assert [item["status"] for item in result.links] == ["active", "expired", "revoked"]
    assert result.links[0]["url"] == "/one/location/view/me.abc123"
    assert result.spoken_facts == [
        "You have 1 live public link: 1 hour left. Anyone with a live link can see your location.",
        "2 earlier links have ended.",
    ]


async def test_list_links_empty():
    ctx, fake = _ctx()
    fake.results["list_state"] = {"publicInvites": []}
    spec = _tool("list_links")
    result = await spec.handler(ctx, spec.input_model.model_validate({}))
    assert result.status == "empty"
    assert result.spoken_facts == ["No live public location links."]


# -- create_public_link ----------------------------------------------------------


async def test_create_public_link_returns_url_and_share_sheet_step():
    ctx, fake = _ctx()
    fake.results["create_public_invite"] = {
        "invite": _invite(durationHours=0.5, expiresAt=_iso_in(0.5)),
        "publicToken": "abc123",
        "publicUrl": "/one/location/view/me.abc123",
    }
    spec = _tool("create_public_link")
    args = spec.input_model.model_validate({"duration_hours": 0.5})
    result = await spec.handler(ctx, args)
    assert result.status == "created"
    assert result.needs == "client_step"
    assert result.url == "/one/location/view/me.abc123"
    assert result.client_step == {"kind": "open_share_sheet", "url": "/one/location/view/me.abc123"}
    assert result.spoken_facts == [
        "Public link created; it stays live for 30 minutes.",
        "Anyone with the link can see your location while it's live.",
    ]
    assert "abc123" not in " ".join(result.spoken_facts)
    # Manual lane: no command binding without a matching operation id.
    assert fake.called("create_public_invite") == {"owner_user_id": ME, "duration_hours": 0.5}
    assert (
        spec.summarize(ctx, args)
        == "create a public location link that anyone can open for 30 minutes"
    )


async def test_create_public_link_reused_and_service_duration_cap():
    ctx, fake = _ctx()
    fake.results["create_public_invite"] = {
        "invite": _invite(expiresAt=_iso_in(0.75)),
        "publicToken": "abc123",
        "publicUrl": "/one/location/view/me.abc123",
        "reused": True,
    }
    spec = _tool("create_public_link")
    reused = await spec.handler(ctx, spec.input_model.model_validate({}))
    assert reused.status == "reused"
    assert reused.spoken_facts[0] == "You already have a live public link; it has 45 minutes left."

    fake.errors["create_public_invite"] = OneLocationAgentError(
        "LOCATION_DURATION_INVALID",
        "A public location link can stay live for at most 2 hours.",
        status_code=422,
    )
    capped = await spec.handler(ctx, spec.input_model.model_validate({"duration_hours": 2}))
    assert capped.status == "rejected"
    assert capped.reason_code == "LOCATION_DURATION_INVALID"
    assert capped.spoken_facts == ["A public location link can stay live for at most 2 hours."]


# -- revoke_public_link ----------------------------------------------------------


async def test_revoke_public_link_and_not_found():
    ctx, fake = _ctx()
    fake.results["revoke_public_invite"] = _invite(
        status="revoked", revokedAt=now_iso(), publicUrl=None
    )
    spec = _tool("revoke_public_link")
    args = spec.input_model.model_validate({"invite_id": INVITE_ID})
    result = await spec.handler(ctx, args)
    assert result.status == "revoked"
    assert result.invite_id == INVITE_ID
    assert result.spoken_facts == ["That public link is revoked. It no longer opens for anyone."]
    assert fake.called("revoke_public_invite") == {"owner_user_id": ME, "invite_id": INVITE_ID}
    assert spec.summarize(ctx, args) == "revoke that public location link"

    fake.errors["revoke_public_invite"] = OneLocationAgentError(
        "LOCATION_PUBLIC_INVITE_NOT_FOUND", "nope", status_code=404
    )
    missing = await spec.handler(ctx, args)
    assert missing.status == "not_found"
    assert missing.reason_code == "LOCATION_PUBLIC_INVITE_NOT_FOUND"


# -- service wiring --------------------------------------------------------------


def test_real_service_factory_is_used_when_nothing_is_injected(monkeypatch: pytest.MonkeyPatch):
    from hushh_mcp.one_voice.tools import sharing as module

    created: list[object] = []

    class Stub:
        def __init__(self) -> None:
            created.append(self)

    monkeypatch.setattr(module, "OneLocationAgentService", Stub)
    ctx = ToolContext(
        user_id=ME,
        conversation_id="c",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token=_fixture_credential("vault"),
    )
    assert module._service(ctx) is created[0]
    assert module._service(ctx) is created[0]
