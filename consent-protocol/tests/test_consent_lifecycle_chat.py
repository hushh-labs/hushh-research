"""The consent lifecycle One can run from chat: list, propose, request, deny, revoke, cancel.

Every tool re-validates VAULT_OWNER like the REST layer; every mutation needs a
spoken yes (the `confirmed` slot); nothing here ever hands the model a raw
`attr.*` scope or approves on the owner's behalf.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.one_adk import action_tools
from hushh_mcp.one_adk.action_tools import (
    BACKEND_DIRECT_ACTION_IDS,
    BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS,
    _BackendDirectConfirmationNeeded,
    _execute_backend_direct_mutation,
    list_pending_information_requests,
    propose_information_request,
)
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.consent_lifecycle_service import (
    ConsentLifecycleError,
    ConsentLifecycleService,
)
from hushh_mcp.services.information_request_service import (
    InformationRequestError,
    InformationRequestService,
)
from hushh_mcp.services.one_email_kyc_service import OneEmailKycService

STATE_USER_ID = action_tools._STATE_USER_ID
STATE_CONSENT_TOKEN = action_tools._STATE_CONSENT_TOKEN
PERSON_REF = "11111111-1111-4111-8111-111111111111"

PROFILE = {
    "displayName": "Sarah Chen",
    "requestableScopes": [
        {
            "scopeRef": "psr_employment",
            "label": "Employment status",
            "domain": "professional",
            "sensitivity": "confidential",
        },
        {
            "scopeRef": "psr_cuisine",
            "label": "Favorite cuisine",
            "domain": "food",
            "sensitivity": "standard",
        },
    ],
}


def _ctx(state: dict) -> SimpleNamespace:
    return SimpleNamespace(state=state, session=SimpleNamespace(id="session_1"))


def _state() -> dict:
    return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}


def _auth():
    return patch(
        "hushh_mcp.one_adk.action_tools.validate_token_with_db",
        new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
    )


def _connections(*people: dict):
    return patch.object(
        ConnectionsService, "list_connections", autospec=True, return_value=list(people)
    )


def _directory(*people: dict):
    return patch.object(
        ConnectionsService,
        "search_directory",
        autospec=True,
        return_value={"items": list(people), "hasMore": False},
    )


def _profile(profile: dict = PROFILE):
    return patch(
        "hushh_mcp.one_adk.action_tools.PersonProfileService.get_viewer_profile",
        new=AsyncMock(return_value=profile),
    )


def _connector(configured: bool = True):
    connector = {"connector_key_id": "ck_1"} if configured else None
    return patch.object(
        OneEmailKycService,
        "get_client_connector",
        new=AsyncMock(return_value={"configured": configured, "connector": connector}),
    )


class TestRegistry:
    def test_consent_actions_are_backend_direct_and_verbally_gated(self):
        assert BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS <= BACKEND_DIRECT_ACTION_IDS
        assert BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS == {
            "consent.request",
            "consent.deny",
            "consent.revoke",
            "consent.cancel_request",
        }

    def test_verbal_gate_replaces_the_browser_card(self):
        # A tap-confirmation preference must not park a directive nothing on
        # screen can run; the spoken `confirmed` slot is the gate instead.
        source = inspect.getsource(action_tools.run_app_action)
        assert "if clean_id in BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS:" in source
        assert "needs_confirmation = False" in source


class TestListPending:
    @pytest.mark.asyncio
    async def test_fails_closed_without_a_vault_owner_session(self):
        result = await list_pending_information_requests(_ctx({}))
        assert result["status"] == "blocked"

    @pytest.mark.asyncio
    async def test_lists_labels_and_ids_only(self):
        pending = [
            {
                "requestId": "req_1",
                "requesterLabel": "Alex Kim",
                "requesterType": "person",
                "description": "Employment status",
                "bundleLabel": None,
                "bundleScopeCount": 1,
                "issuedAt": 1,
                "expiresAt": 2,
            }
        ]
        with (
            _auth(),
            patch.object(
                ConsentLifecycleService,
                "list_pending_incoming",
                new=AsyncMock(return_value=pending),
            ),
        ):
            result = await list_pending_information_requests(_ctx(_state()))
        assert result["status"] == "ok"
        assert result["pendingRequestIds"] == ["req_1"]
        assert result["count"] == 1
        assert "attr." not in str(result)
        assert "tap" in result["nextStep"]

    @pytest.mark.asyncio
    async def test_reports_nothing_waiting(self):
        with (
            _auth(),
            patch.object(
                ConsentLifecycleService, "list_pending_incoming", new=AsyncMock(return_value=[])
            ),
        ):
            result = await list_pending_information_requests(_ctx(_state()))
        assert result["pendingRequestIds"] == []
        assert "Nothing is waiting" in result["nextStep"]


class TestPropose:
    @pytest.mark.asyncio
    async def test_parks_a_proposal_from_spoken_field_labels(self):
        state = _state()
        with (
            _auth(),
            _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}),
            _profile(),
            _connector(True),
        ):
            result = await propose_information_request(
                "Sarah",
                "employment status and favorite cuisine",
                "Planning a dinner for the team",
                _ctx(state),
                48,
            )
        assert result["status"] == "proposal_ready"
        assert result["fields"] == ["Employment status", "Favorite cuisine"]
        assert result["durationHours"] == 48
        assert result["connectorReady"] is True
        assert result["person"]["profilePath"] == f"/people/{PERSON_REF}"
        assert "psr_" not in str(result)
        parked = state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS][result["proposalId"]]
        assert parked["scopeRefs"] == ["psr_employment", "psr_cuisine"]

    @pytest.mark.asyncio
    async def test_a_domain_name_selects_that_domain(self):
        with (
            _auth(),
            _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}),
            _profile(),
            _connector(True),
        ):
            result = await propose_information_request(
                "Sarah Chen", "professional", "Checking references for a role", _ctx(_state())
            )
        assert result["status"] == "proposal_ready"
        assert result["fields"] == ["Employment status"]
        assert result["durationHours"] == 168

    @pytest.mark.asyncio
    async def test_falls_back_to_the_directory_for_a_non_connection(self):
        with (
            _auth(),
            _connections(),
            _directory({"displayName": "Priya Singh", "publicPersonRef": PERSON_REF}),
            _profile({**PROFILE, "displayName": "Priya Singh"}),
            _connector(True),
        ):
            result = await propose_information_request(
                "Priya", "favorite cuisine", "Choosing a restaurant for our meeting", _ctx(_state())
            )
        assert result["status"] == "proposal_ready"
        assert result["person"]["displayName"] == "Priya Singh"

    @pytest.mark.asyncio
    async def test_unknown_fields_offer_the_catalog_instead(self):
        with (
            _auth(),
            _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}),
            _profile(),
        ):
            result = await propose_information_request(
                "Sarah", "blood type", "Emergency planning", _ctx(_state())
            )
        assert result["status"] == "needs_clarification"
        assert result["unmatchedFields"] == ["blood type"]
        assert result["availableFields"] == {
            "professional": ["Employment status"],
            "food": ["Favorite cuisine"],
        }

    @pytest.mark.asyncio
    async def test_ambiguous_names_refuse_to_guess(self):
        with (
            _auth(),
            _connections(
                {"displayName": "Alex Kim", "publicPersonRef": "ref-1"},
                {"displayName": "Alex Singh", "publicPersonRef": "ref-2"},
            ),
            _profile(),
        ):
            result = await propose_information_request(
                "Alex", "favorite cuisine", "Dinner planning", _ctx(_state())
            )
        assert result["status"] == "needs_clarification"
        assert "Alex Kim" in result["message"] and "Alex Singh" in result["message"]

    @pytest.mark.asyncio
    async def test_short_purpose_and_bad_duration_are_asked_back(self):
        with (
            _auth(),
            _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}),
            _profile(),
            _connector(True),
        ):
            short = await propose_information_request("Sarah", "food", "hi", _ctx(_state()))
            long_duration = await propose_information_request(
                "Sarah", "food", "Dinner planning for the offsite", _ctx(_state()), 9999
            )
        assert short["status"] == "needs_clarification"
        assert "purpose" in short["message"].lower()
        assert long_duration["status"] == "needs_clarification"
        assert "720" in long_duration["message"]

    @pytest.mark.asyncio
    async def test_missing_connector_points_at_the_profile(self):
        with (
            _auth(),
            _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}),
            _profile(),
            _connector(False),
        ):
            result = await propose_information_request(
                "Sarah", "food", "Dinner planning for the offsite", _ctx(_state())
            )
        assert result["status"] == "proposal_ready"
        assert result["connectorReady"] is False
        assert "profilePath" in result["nextStep"]


class TestBackendDirect:
    async def _run(self, action_id: str, slots: dict, state: dict):
        return await _execute_backend_direct_mutation(action_id, slots, "user_1", _ctx(state))

    @pytest.mark.asyncio
    async def test_request_needs_a_proposal_then_a_spoken_yes(self):
        with pytest.raises(ConsentLifecycleError) as missing:
            await self._run("consent.request", {"proposal_id": "nope", "confirmed": True}, _state())
        assert missing.value.code == "PROPOSAL_NOT_FOUND"

        state = _state()
        state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS] = {
            "p1": {
                "personRef": PERSON_REF,
                "displayName": "Sarah Chen",
                "scopeRefs": ["psr_employment"],
                "labels": ["Employment status"],
                "purpose": "Checking references for a role",
                "durationHours": 48,
            }
        }
        with pytest.raises(_BackendDirectConfirmationNeeded) as ask:
            await self._run("consent.request", {"proposal_id": "p1"}, state)
        assert "Sarah Chen" in str(ask.value) and "Employment status" in str(ask.value)

    @pytest.mark.asyncio
    async def test_confirmed_request_creates_the_bundle_with_the_active_connector(self):
        state = _state()
        state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS] = {
            "p1": {
                "personRef": PERSON_REF,
                "displayName": "Sarah Chen",
                "scopeRefs": ["psr_employment"],
                "labels": ["Employment status"],
                "purpose": "Checking references for a role",
                "durationHours": 48,
            }
        }
        create = AsyncMock(return_value={"bundleId": "bundle_1", "status": "pending"})
        with _connector(True), patch.object(InformationRequestService, "create", new=create):
            message, subject = await self._run(
                "consent.request", {"proposal_id": "p1", "confirmed": True}, state
            )
        assert "Sent Sarah Chen a request" in message
        assert subject == {"name": "Sarah Chen"}
        kwargs = create.call_args.kwargs
        assert kwargs["scope_refs"] == ["psr_employment"]
        assert kwargs["duration_seconds"] == 48 * 3600
        assert kwargs["connector_key_id"] == "ck_1"
        assert kwargs["idempotency_key"] == "agent-chat-p1"
        assert state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS] == {}
        assert state[action_tools._STATE_LAST_INFORMATION_REQUEST]["bundleId"] == "bundle_1"

    @pytest.mark.asyncio
    async def test_request_without_a_connector_fails_with_the_profile_hint(self):
        state = _state()
        state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS] = {
            "p1": {
                "personRef": PERSON_REF,
                "displayName": "Sarah Chen",
                "scopeRefs": ["psr_employment"],
                "labels": ["Employment status"],
                "purpose": "Checking references for a role",
                "durationHours": 48,
            }
        }
        with _connector(False), pytest.raises(ConsentLifecycleError) as exc:
            await self._run("consent.request", {"proposal_id": "p1", "confirmed": True}, state)
        assert exc.value.code == "CONNECTOR_NOT_READY"
        assert "profile" in exc.value.message

    @pytest.mark.asyncio
    async def test_service_refusals_become_spoken_safe_errors(self):
        state = _state()
        state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS] = {
            "p1": {
                "personRef": PERSON_REF,
                "displayName": "Sarah Chen",
                "scopeRefs": ["psr_employment"],
                "labels": ["Employment status"],
                "purpose": "Checking references for a role",
                "durationHours": 48,
            }
        }
        failing = AsyncMock(
            side_effect=InformationRequestError("One or more requested fields are unavailable.")
        )
        with _connector(True), patch.object(InformationRequestService, "create", new=failing):
            with pytest.raises(ConsentLifecycleError) as exc:
                await self._run("consent.request", {"proposal_id": "p1", "confirmed": True}, state)
        assert exc.value.code == "INFORMATION_REQUEST_FAILED"
        assert "unavailable" in exc.value.message

    @pytest.mark.asyncio
    async def test_deny_and_revoke_need_a_target_and_a_yes(self):
        with pytest.raises(ConsentLifecycleError):
            await self._run("consent.deny", {"confirmed": True}, _state())
        with pytest.raises(_BackendDirectConfirmationNeeded):
            await self._run("consent.deny", {"request_id": "req_1"}, _state())
        with pytest.raises(ConsentLifecycleError):
            await self._run("consent.revoke", {"confirmed": True}, _state())
        with pytest.raises(_BackendDirectConfirmationNeeded):
            await self._run("consent.revoke", {"request_id": "req_1"}, _state())

    @pytest.mark.asyncio
    async def test_confirmed_deny_and_revoke_call_the_shared_service(self):
        deny = AsyncMock(return_value={"status": "denied", "message": "Consent denied to Alex"})
        revoke = AsyncMock(return_value={"status": "revoked", "message": "ok", "lockVault": False})
        with (
            patch.object(ConsentLifecycleService, "deny_pending_request", new=deny),
            patch.object(ConsentLifecycleService, "revoke_active_grant", new=revoke),
        ):
            denied, _ = await self._run(
                "consent.deny", {"request_id": "req_1", "confirmed": True}, _state()
            )
            revoked, _ = await self._run(
                "consent.revoke", {"request_id": "req_2", "confirmed": True}, _state()
            )
        assert "Denied" in denied
        assert deny.call_args.args == ("user_1", "req_1")
        assert "Revoked" in revoked
        assert revoke.call_args.kwargs == {"scope": None, "request_id": "req_2"}

    @pytest.mark.asyncio
    async def test_cancel_resolves_the_last_request_sent_from_this_session(self):
        state = _state()
        state[action_tools._STATE_LAST_INFORMATION_REQUEST] = {
            "bundleId": "bundle_9",
            "displayName": "Sarah Chen",
        }
        cancel = AsyncMock(return_value={"status": "cancelled"})
        with patch.object(InformationRequestService, "cancel", new=cancel):
            with pytest.raises(_BackendDirectConfirmationNeeded):
                await self._run("consent.cancel_request", {"bundle_id": "last"}, state)
            message, _ = await self._run(
                "consent.cancel_request", {"bundle_id": "that", "confirmed": True}, state
            )
        assert "Cancelled" in message
        assert cancel.call_args.kwargs == {"requester_user_id": "user_1", "bundle_id": "bundle_9"}
        assert state[action_tools._STATE_LAST_INFORMATION_REQUEST] == {}

    @pytest.mark.asyncio
    async def test_cancel_without_any_request_asks_which_one(self):
        with pytest.raises(ConsentLifecycleError) as exc:
            await self._run("consent.cancel_request", {"confirmed": True}, _state())
        assert exc.value.code == "INFORMATION_REQUEST_ID_REQUIRED"
