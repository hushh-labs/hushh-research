"""The consent lifecycle One can run from chat: list, propose, request, deny, revoke, cancel.

Every tool re-validates VAULT_OWNER like the REST layer, and nothing here ever
hands the model a raw ``attr.*`` scope, a token, a bundle id, or an approval on
the owner's behalf.

What changed, and why this file was rewritten
---------------------------------------------
This file used to assert the opposite of the rule it now protects. Its thesis
was that "every mutation needs a spoken yes (the ``confirmed`` slot)", carried
by a ``_BackendDirectConfirmationNeeded`` control-flow signal. That design made
the model's own report of a yes the authority for a consent mutation, and it
was deliberately replaced: ``run_app_action`` now DELETES a ``confirmed`` slot
before dispatch, because "a model-produced slot, including a truthful boolean,
is not authority and must not cross the action boundary." Authorization is the
person's tap on the app's confirmation card, bound to the directive ledger.

The class was deleted in 7837c6466 and the import at the top of this file was
not, so all 438 lines collected **zero tests** and went on reporting nothing for
two days. That is why ``scripts/run-test-ci.sh`` now has a collection gate: a
test file that cannot import is indistinguishable, in CI, from one that passes.

So the tests below assert the boundary that exists rather than the one that was
removed: the model cannot self-confirm, the server resolves every identifier,
and a governed action with no mounted browser handler is a dead end that must
be caught here rather than by a person in chat.
"""

from __future__ import annotations

import inspect
import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.one_adk import action_tools
from hushh_mcp.one_adk.action_tools import (
    _GOVERNED_LEDGER_CONFIRMATION_ACTION_IDS,
    BACKEND_DIRECT_ACTION_IDS,
    BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS,
    _execute_backend_direct_mutation,
    _resolved_directive_slots,
    list_active_grants,
    list_my_outgoing_information_requests,
    list_pending_information_requests,
    propose_information_request,
)
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.consent_lifecycle_service import (
    ConsentLifecycleService,
)
from hushh_mcp.services.information_request_service import (
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


CONSENT_LIFECYCLE_IDS = frozenset(
    {"consent.request", "consent.deny", "consent.revoke", "consent.cancel_request"}
)


class TestRegistry:
    def test_the_four_consent_actions_are_the_lifecycle(self):
        assert BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS == CONSENT_LIFECYCLE_IDS
        assert BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS <= BACKEND_DIRECT_ACTION_IDS

    def test_every_consent_mutation_is_ledger_authorized(self):
        # The property the deleted design did not have. Membership here is what
        # makes run_app_action strip `confirmed` and park a directive instead
        # of dispatching, so it is the boundary itself, not a preference.
        assert CONSENT_LIFECYCLE_IDS <= _GOVERNED_LEDGER_CONFIRMATION_ACTION_IDS

    def test_a_model_supplied_confirmation_never_reaches_the_action(self):
        source = inspect.getsource(action_tools.run_app_action)
        assert 'clean_slots.pop("confirmed", None)' in source
        # And it is reached for these ids specifically, not only for the
        # contract's confirm_required set, so removing a policy from the
        # generated contract cannot quietly re-open the hole.
        assert "clean_id in _GOVERNED_LEDGER_CONFIRMATION_ACTION_IDS" in source

    def test_no_consent_id_can_be_executed_server_side(self):
        # The compatibility seam raises for every governed id. Asserted over
        # the whole set rather than one example, because the failure mode is a
        # future id being added to one list and not the other.
        source = inspect.getsource(action_tools._execute_backend_direct_mutation)
        assert "must be executed through the directive ledger" in source

    @pytest.mark.asyncio
    async def test_each_consent_action_fails_closed_at_the_backend_seam(self):
        for action_id in sorted(CONSENT_LIFECYCLE_IDS):
            with pytest.raises(AssertionError, match="directive ledger"):
                await _execute_backend_direct_mutation(
                    action_id, {"confirmed": True}, "user_1", _ctx(_state())
                )


class TestBrowserHandlersExist:
    """A governed action with no mounted handler is a dead end.

    This is the gate that was missing. `consent.request` had no handler for as
    long as it existed, and `consent.deny`, `consent.revoke` and
    `consent.cancel_request` had none either -- the backend refused to execute
    them and delegated to a browser handler nobody had written, so the agent's
    only remaining move was to send someone to a screen. Nothing failed. The
    action simply never happened, which is the worst shape a consent bug can
    take.

    Reading the frontend from a backend test is deliberate: the contract is
    cross-repo, so a test that lives on only one side cannot see the break.
    """

    HANDLERS = Path(__file__).resolve().parents[2] / "hushh-webapp"

    def _mounted_action_ids(self) -> set[str]:
        found: set[str] = set()
        for path in self.HANDLERS.glob("components/**/*.tsx"):
            text = path.read_text(encoding="utf-8")
            if "useLocalOnboardingActionHandler" not in text:
                continue
            found.update(re.findall(r'useLocalOnboardingActionHandler\(\s*"([^"]+)"', text))
        return found

    def test_the_frontend_tree_is_where_this_test_thinks_it_is(self):
        # Without this, a moved or renamed webapp directory turns the test
        # below into a silent pass -- zero files scanned, zero ids missing.
        assert self.HANDLERS.is_dir(), self.HANDLERS
        assert self._mounted_action_ids(), "no mounted handlers found at all"

    def test_every_consent_action_has_a_mounted_browser_handler(self):
        mounted = self._mounted_action_ids()
        missing = sorted(CONSENT_LIFECYCLE_IDS - mounted)
        assert not missing, (
            f"{missing} are authorized through the directive ledger and have no browser "
            "handler to run them. The agent can offer these and never complete them."
        )


class TestServerSideResolution:
    """The model passes handles; the server turns them into the mutation.

    This is what makes running the lifecycle from chat safe at all: the model
    never holds a scope, a token, or a bundle id, so it cannot widen or
    retarget a mutation between the read-back and the tap.
    """

    def test_a_proposal_expands_to_the_request_and_a_stable_key(self):
        state = _state()
        state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS] = {
            "abc123def456abc123def456abc12345": {
                "personRef": PERSON_REF,
                "displayName": "Sarah Chen",
                "scopeRefs": ["psr_employment"],
                "labels": ["Employment status"],
                "purpose": "Checking references for a role",
                "durationHours": 48,
            }
        }
        resolved = _resolved_directive_slots(
            "consent.request",
            {"proposal_id": "abc123def456abc123def456abc12345"},
            _ctx(state),
        )
        assert resolved["personRef"] == PERSON_REF
        assert resolved["scopeRefs"] == ["psr_employment"]
        # The whole duplicate story in one assertion: the key is derived from
        # the proposal, so a redelivered directive resolves to the same bundle
        # instead of creating a second live request.
        assert resolved["idempotencyKey"] == "agent-chat-abc123def456abc123def456abc12345"
        assert len(resolved["idempotencyKey"]) >= 16

    def test_the_same_proposal_always_mints_the_same_key(self):
        state = _state()
        state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS] = {
            "abc123def456abc123def456abc12345": {"personRef": PERSON_REF, "scopeRefs": ["psr_x"]}
        }
        first = _resolved_directive_slots(
            "consent.request", {"proposal_id": "abc123def456abc123def456abc12345"}, _ctx(state)
        )
        second = _resolved_directive_slots(
            "consent.request", {"proposal_id": "abc123def456abc123def456abc12345"}, _ctx(state)
        )
        assert first["idempotencyKey"] == second["idempotencyKey"]

    def test_an_unknown_handle_expands_to_nothing(self):
        for action_id, slots in (
            ("consent.request", {"proposal_id": "gone"}),
            ("consent.revoke", {"grant_id": "gone"}),
            ("consent.cancel_request", {"request_id": "gone"}),
        ):
            resolved = _resolved_directive_slots(action_id, slots, _ctx(_state()))
            # Unchanged, so the handler refuses rather than acting on a guess.
            assert resolved == slots

    def test_a_grant_handle_expands_to_the_scope_the_model_never_saw(self):
        state = _state()
        state[action_tools._STATE_ACTIVE_GRANT_HANDLES] = {
            "g1": {
                "scope": "attr.professional.employment",
                "requestId": "req_7",
                "label": "Professional Employment",
                "holderLabel": "Sarah Chen",
            }
        }
        resolved = _resolved_directive_slots("consent.revoke", {"grant_id": "g1"}, _ctx(state))
        assert resolved["scope"] == "attr.professional.employment"
        assert resolved["requestId"] == "req_7"

    def test_cancelling_without_naming_one_takes_the_most_recent(self):
        # The documented usual case: "withdraw the request I just sent".
        state = _state()
        state[action_tools._STATE_SENT_REQUEST_HANDLES] = {
            "r1": {"bundleId": "bundle_newest", "displayName": "Sarah Chen"},
            "r2": {"bundleId": "bundle_older", "displayName": "Dev Patel"},
        }
        resolved = _resolved_directive_slots("consent.cancel_request", {}, _ctx(state))
        assert resolved["bundleId"] == "bundle_newest"
        named = _resolved_directive_slots(
            "consent.cancel_request", {"request_id": "r2"}, _ctx(state)
        )
        assert named["bundleId"] == "bundle_older"

    def test_a_deny_target_is_normalized_to_one_spelling(self):
        resolved = _resolved_directive_slots(
            "consent.deny", {"request_id": "req_3"}, _ctx(_state())
        )
        assert resolved["requestId"] == "req_3"


class TestRevokeAndCancelAreTargetable:
    """Both actions match on an identifier nothing used to be able to produce.

    `revoke_active_grant` matches on a scope or a request id and
    `InformationRequestService.cancel` takes a bundle id. Until these two read
    tools existed there was no way to learn any of the three, so both actions
    were reachable in the contract and impossible to aim.
    """

    @pytest.mark.asyncio
    async def test_active_grants_are_listed_as_words_with_opaque_handles(self):
        grants = [
            {
                "scope": "attr.professional.employment",
                "requestId": "req_7",
                "label": "Professional Employment",
                "holderLabel": "Sarah Chen",
                "issuedAt": 1,
                "expiresAt": 2,
            }
        ]
        state = _state()
        with (
            _auth(),
            patch.object(
                ConsentLifecycleService, "list_active_grants", new=AsyncMock(return_value=grants)
            ),
        ):
            result = await list_active_grants(_ctx(state))
        assert result["status"] == "ok"
        assert result["grants"] == [
            {
                "grantId": "g1",
                "label": "Professional Employment",
                "sharedWith": "Sarah Chen",
                "expiresAt": 2,
            }
        ]
        # The raw scope stays on the server, against the handle.
        assert "attr." not in json.dumps(result)
        assert state[action_tools._STATE_ACTIVE_GRANT_HANDLES]["g1"]["scope"] == (
            "attr.professional.employment"
        )

    @pytest.mark.asyncio
    async def test_sent_requests_are_listed_newest_first_without_bundle_ids(self):
        sent = [
            {
                "bundleId": "bundle_newest",
                "personRef": PERSON_REF,
                "displayName": "Sarah Chen",
                "purpose": "Checking references",
                "sentAt": "2026-09-11",
            },
            {
                "bundleId": "bundle_older",
                "personRef": PERSON_REF,
                "displayName": "Dev Patel",
                "purpose": "Older ask",
                "sentAt": "2026-09-01",
            },
        ]
        state = _state()
        with (
            _auth(),
            patch.object(
                InformationRequestService, "list_outgoing", new=AsyncMock(return_value=sent)
            ),
        ):
            result = await list_my_outgoing_information_requests(_ctx(state))
        assert result["status"] == "ok"
        assert [row["requestId"] for row in result["requests"]] == ["r1", "r2"]
        assert "bundle_newest" not in json.dumps(result)
        # Insertion order is load-bearing: _resolved_directive_slots takes the
        # first entry when the model names none.
        handles = state[action_tools._STATE_SENT_REQUEST_HANDLES]
        assert list(handles) == ["r1", "r2"]
        assert handles["r1"]["bundleId"] == "bundle_newest"

    @pytest.mark.asyncio
    async def test_both_listings_fail_closed_without_a_vault_owner_session(self):
        assert (await list_active_grants(_ctx({})))["status"] == "blocked"
        assert (await list_my_outgoing_information_requests(_ctx({})))["status"] == "blocked"


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
        # Not a link to a screen. The proposal is still parked and still
        # readable; what is missing is the owner's own key, so the remedy is
        # unlocking, not navigating. This assertion read `profilePath` for two
        # days after the message stopped saying it, because the file could not
        # import and nothing ran.
        assert "unlock their private agent" in result["nextStep"]
        assert "profilePath" not in result["nextStep"]
