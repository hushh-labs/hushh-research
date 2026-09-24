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
    list_information_shared_with_me,
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
    "personRef": PERSON_REF,
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
        assert len(result["grants"]) == 1
        grant_id = result["grants"][0]["grantId"]
        assert grant_id.startswith("g_")
        assert result["grants"][0] == {
            "grantId": grant_id,
            "label": "Professional Employment",
            "sharedWith": "Sarah Chen",
            "expiresAt": 2,
        }
        # The raw scope stays on the server, against the handle.
        assert "attr." not in json.dumps(result)
        assert state[action_tools._STATE_ACTIVE_GRANT_HANDLES][grant_id]["scope"] == (
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
        request_handles = [row["requestId"] for row in result["requests"]]
        assert all(handle.startswith("r_") for handle in request_handles)
        assert "bundle_newest" not in json.dumps(result)
        # Listing order remains newest first for the unnamed fallback, while
        # each handle is keyed to its bundle identity.
        handles = state[action_tools._STATE_SENT_REQUEST_HANDLES]
        assert list(handles) == request_handles
        assert handles[request_handles[0]]["bundleId"] == "bundle_newest"

    @pytest.mark.asyncio
    async def test_grant_handles_survive_reordering(self):
        first = [
            {
                "scope": "attr.professional.employment",
                "requestId": "req_a",
                "holderLabel": "Sarah",
            },
            {"scope": "attr.financial.income", "requestId": "req_b", "holderLabel": "Dev"},
        ]
        second = [first[1], first[0]]
        state = _state()
        with (
            _auth(),
            patch.object(
                ConsentLifecycleService,
                "list_active_grants",
                new=AsyncMock(side_effect=[first, second]),
            ),
        ):
            first_result = await list_active_grants(_ctx(state))
            first_handles = {row["sharedWith"]: row["grantId"] for row in first_result["grants"]}
            await list_active_grants(_ctx(state))

        resolved = _resolved_directive_slots(
            "consent.revoke", {"grant_id": first_handles["Sarah"]}, _ctx(state)
        )
        assert resolved["scope"] == "attr.professional.employment"
        assert resolved["requestId"] == "req_a"

    @pytest.mark.asyncio
    async def test_request_handles_survive_reordering_and_removed_rows_fail_closed(self):
        first = [
            {"bundleId": "bundle_newest", "displayName": "Sarah"},
            {"bundleId": "bundle_older", "displayName": "Dev"},
        ]
        second = [first[1]]
        state = _state()
        with (
            _auth(),
            patch.object(
                InformationRequestService,
                "list_outgoing",
                new=AsyncMock(side_effect=[first, second]),
            ),
        ):
            first_result = await list_my_outgoing_information_requests(_ctx(state))
            first_handles = {row["person"]: row["requestId"] for row in first_result["requests"]}
            await list_my_outgoing_information_requests(_ctx(state))

        resolved = _resolved_directive_slots(
            "consent.cancel_request", {"request_id": first_handles["Sarah"]}, _ctx(state)
        )
        assert resolved == {"request_id": first_handles["Sarah"]}

    @pytest.mark.asyncio
    async def test_both_listings_fail_closed_without_a_vault_owner_session(self):
        assert (await list_active_grants(_ctx({})))["status"] == "blocked"
        assert (await list_my_outgoing_information_requests(_ctx({})))["status"] == "blocked"

    @pytest.mark.asyncio
    async def test_cancel_without_a_handle_refreshes_the_newest_open_request(self):
        state = {
            **_state(),
            action_tools._STATE_TYPED_CHAT_CONTEXT: True,
            action_tools._STATE_VOICE_CONTEXT: {
                "screen": "app",
                "available_action_ids": [],
                "executable_action_ids": [],
            },
        }
        sent = [
            {
                "bundleId": "bundle_newest",
                "personRef": PERSON_REF,
                "displayName": "Sarah Chen",
                "purpose": "Checking references",
                "sentAt": "2026-09-21",
            }
        ]
        with (
            _auth(),
            patch.object(
                InformationRequestService, "list_outgoing", new=AsyncMock(return_value=sent)
            ) as list_outgoing,
        ):
            result = await action_tools.run_app_action("consent.cancel_request", {}, _ctx(state))

        assert result["status"] == "confirm_pending"
        assert result["directive"]["slots"]["bundleId"] == "bundle_newest"
        assert result["directive"]["slots"]["displayName"] == "Sarah Chen"
        list_outgoing.assert_awaited_once_with(requester_user_id="user_1")

    def test_chat_lifecycle_actions_remain_reachable_without_screen_inventory(self):
        for action_id in CONSENT_LIFECYCLE_IDS - {"consent.request"}:
            entry = action_tools.get_action_gateway_action(action_id)
            assert entry is not None
            assert action_tools._reachability(entry, action_id, set()) == (
                "on_screen",
                None,
            )


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
        assert result["directive"]["actionId"] == "consent.request"
        assert result["directive"]["needsConfirmation"] is True
        assert result["directive"]["slots"]["personRef"] == PERSON_REF
        assert result["directive"]["slots"]["scopeRefs"] == [
            "psr_employment",
            "psr_cuisine",
        ]
        parked = state[action_tools._STATE_INFORMATION_REQUEST_PROPOSALS][result["proposalId"]]
        assert parked["scopeRefs"] == ["psr_employment", "psr_cuisine"]
        directive = state[f"{action_tools._STATE_PENDING_DIRECTIVE}:consent.request"]
        assert directive["kind"] == "action"
        assert directive["payload"]["actionId"] == "consent.request"
        assert directive["payload"]["needsConfirmation"] is True
        assert directive["payload"]["slots"]["scopeRefs"] == [
            "psr_employment",
            "psr_cuisine",
        ]
        assert "run_app_action" not in result["nextStep"]

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
        assert [item["displayName"] for item in result["candidates"]] == [
            "Alex Kim",
            "Alex Singh",
        ]
        assert len({item["selectionHandle"] for item in result["candidates"]}) == 2

    @pytest.mark.asyncio
    async def test_proposal_rejects_a_profile_for_another_person(self):
        context = _ctx(_state())
        with (
            _auth(),
            _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}),
            _profile({**PROFILE, "personRef": "another-person"}),
        ):
            result = await propose_information_request(
                "Sarah",
                "favorite cuisine",
                "Synthetic dinner planning",
                context,
            )
        assert result["status"] == "failed"
        assert action_tools._STATE_INFORMATION_REQUEST_PROPOSALS not in context.state

    @pytest.mark.parametrize("invalid", ["owner", "session", "expired", "forged"])
    def test_person_choice_cannot_cross_authority(self, invalid):
        context = _ctx(_state())
        result = action_tools._information_person_error(
            action_tools.InformationPersonAmbiguous(
                [
                    {"displayName": "Alex", "publicPersonRef": PERSON_REF},
                ]
            ),
            context,
            "owner-a",
        )
        handle = result["candidates"][0]["selectionHandle"]
        owner = "owner-a"
        if invalid == "owner":
            owner = "owner-b"
        elif invalid == "session":
            context.session.id = "other-thread"
        elif invalid == "expired":
            context.state[action_tools._STATE_INFORMATION_PERSON_CHOICES][handle]["expiresAt"] = 0
        else:
            handle = "forged"
        context.state[action_tools._STATE_REQUESTED_INFORMATION_PERSON] = handle
        with pytest.raises(action_tools.ConsentLifecycleError, match="choose the person again"):
            action_tools._resolve_person_for_information(None, owner, "Alex", context, handle)

    def test_model_supplied_choice_requires_browser_admission(self):
        context = _ctx(_state())
        with pytest.raises(action_tools.ConsentLifecycleError, match="conversation"):
            action_tools._resolve_person_for_information(
                None, "owner-a", "Alex", context, "model-only-handle"
            )

    def test_conversation_state_binds_picker_when_adk_session_id_is_missing(self):
        state = _state()
        state["hussh:conversation_id"] = "thread_1"
        context = _ctx(state)
        context.session.id = None
        result = action_tools._information_person_error(
            action_tools.InformationPersonAmbiguous(
                [{"displayName": "Alex", "publicPersonRef": PERSON_REF}]
            ),
            context,
            "owner-a",
        )
        assert result["candidates"][0]["displayName"] == "Alex"
        handle = result["candidates"][0]["selectionHandle"]
        assert (
            context.state[action_tools._STATE_INFORMATION_PERSON_CHOICES][handle]["session"]
            == "thread_1"
        )

    def test_valid_person_choice_never_resolves_a_different_name(self):
        context = _ctx(_state())
        result = action_tools._information_person_error(
            action_tools.InformationPersonAmbiguous(
                [
                    {"displayName": "Alex", "publicPersonRef": PERSON_REF},
                ]
            ),
            context,
            "owner-a",
        )
        handle = result["candidates"][0]["selectionHandle"]
        context.state[action_tools._STATE_REQUESTED_INFORMATION_PERSON] = handle
        assert action_tools._resolve_person_for_information(
            None,
            "owner-a",
            "Someone else",
            context,
            handle,
        ) == (PERSON_REF, "Alex")

    def test_incomplete_directory_never_establishes_unique_person(self):
        context = _ctx(_state())
        pages = [
            {"items": [{"displayName": "Alex Kim", "publicPersonRef": PERSON_REF}], "hasMore": True}
        ] * action_tools._DIRECTORY_RESOLVE_MAX_PAGES
        with (
            _connections(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                side_effect=pages,
            ),
        ):
            with pytest.raises(action_tools.InformationPersonAmbiguous) as error:
                action_tools._resolve_person_for_information(
                    ConnectionsService(), "owner-a", "Alex", context
                )
        assert error.value.candidates_complete is False

    def test_directory_fallback_preserves_all_normalized_name_tokens(self):
        calls = []

        class Directory:
            def search_directory(self, user_id, *, query, page, limit):
                calls.append((user_id, query, page, limit))
                return {"items": [], "hasMore": False}

        candidates, complete = action_tools._directory_candidates(
            Directory(), "owner-a", "  Kushal-Trivedi  "
        )

        assert candidates == []
        assert complete is True
        assert calls == [
            ("owner-a", "kushal trivedi", 1, action_tools._DIRECTORY_RESOLVE_PAGE_SIZE)
        ]

    @pytest.mark.asyncio
    async def test_proposal_requires_narrowing_when_more_than_fifty_fields_match(self):
        context = _ctx(_state())
        scopes = [
            {
                "scopeRef": f"psr_professional_{index}",
                "label": f"Professional field {index}",
                "domain": "professional",
            }
            for index in range(51)
        ]
        with (
            _auth(),
            _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}),
            _profile({**PROFILE, "requestableScopes": scopes}),
        ):
            result = await propose_information_request(
                "Sarah", "professional", "Synthetic review planning", context
            )
        assert result["status"] == "needs_clarification"
        assert result["fieldCount"] == 51
        assert result["maxFieldsPerRequest"] == 50
        assert action_tools._STATE_INFORMATION_REQUEST_PROPOSALS not in context.state

    @pytest.mark.parametrize("spoken", ["Sarah", "sarah@example.test"])
    def test_unique_lookup_is_retained_for_followups(self, spoken):
        context = _ctx(_state())
        with _connections(
            {
                "displayName": "Sarah Chen",
                "publicPersonRef": PERSON_REF,
                "email": "sarah@example.test",
            }
        ):
            assert action_tools._resolve_person_for_information(
                ConnectionsService(),
                "owner-a",
                spoken,
                context,
            ) == (PERSON_REF, "Sarah Chen")
        # No service is available: a repeat must use the selected stable identity,
        # not another name lookup that might now return someone else.
        for followup in [spoken, "Sarah Chen", spoken, ""]:
            assert action_tools._resolve_person_for_information(
                None,
                "owner-a",
                followup,
                context,
            ) == (PERSON_REF, "Sarah Chen")
        with pytest.raises(action_tools.ConsentLifecycleError):
            action_tools._resolve_person_for_information(None, "owner-b", spoken, context)

    def test_expired_implicit_selection_re_resolves_an_explicit_name(self):
        context = _ctx(_state())
        person = {"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}
        with _connections(person):
            action_tools._resolve_person_for_information(
                ConnectionsService(), "owner-a", "Sarah", context
            )
        old_handle = context.state[action_tools._STATE_SELECTED_INFORMATION_PERSON]["handle"]
        context.state[action_tools._STATE_INFORMATION_PERSON_CHOICES][old_handle]["expiresAt"] = 0

        with _connections(person):
            assert action_tools._resolve_person_for_information(
                ConnectionsService(), "owner-a", "Sarah Chen", context
            ) == (PERSON_REF, "Sarah Chen")
        assert (
            context.state[action_tools._STATE_SELECTED_INFORMATION_PERSON]["handle"] != old_handle
        )

    def test_expired_implicit_selection_re_resolves_when_model_omits_name(self):
        context = _ctx(_state())
        person = {"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}
        with _connections(person):
            action_tools._resolve_person_for_information(
                ConnectionsService(), "owner-a", "Sarah", context
            )
        old_handle = context.state[action_tools._STATE_SELECTED_INFORMATION_PERSON]["handle"]
        context.state[action_tools._STATE_INFORMATION_PERSON_CHOICES][old_handle]["expiresAt"] = 0

        with _connections(person):
            assert action_tools._resolve_person_for_information(
                ConnectionsService(), "owner-a", "", context, old_handle
            ) == (PERSON_REF, "Sarah Chen")

    def test_pruned_implicit_selection_re_resolves_instead_of_blocking(self):
        context = _ctx(_state())
        person = {"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}
        with _connections(person):
            action_tools._resolve_person_for_information(
                ConnectionsService(), "owner-a", "Sarah", context
            )
        context.state[action_tools._STATE_INFORMATION_PERSON_CHOICES] = {}

        with _connections(person):
            assert action_tools._resolve_person_for_information(
                ConnectionsService(), "owner-a", "Sarah Chen", context
            ) == (PERSON_REF, "Sarah Chen")

    def test_email_punctuation_cannot_reuse_another_recipient(self):
        context = _ctx(_state())
        people = [
            {
                "displayName": "Alex",
                "publicPersonRef": PERSON_REF,
                "email": "alex+one@example.test",
            },
            {
                "displayName": "Alex",
                "publicPersonRef": "other-person",
                "email": "alex.one@example.test",
            },
        ]
        with _connections(*people):
            assert (
                action_tools._resolve_person_for_information(
                    ConnectionsService(), "owner-a", people[0]["email"], context
                )[0]
                == PERSON_REF
            )
            with pytest.raises(action_tools.InformationPersonAmbiguous) as change:
                action_tools._resolve_person_for_information(
                    ConnectionsService(), "owner-a", people[1]["email"], context
                )
        assert change.value.candidates[0]["publicPersonRef"] == "other-person"

    def test_switching_from_a_unique_recipient_requires_a_new_choice(self):
        context = _ctx(_state())
        with _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}):
            action_tools._resolve_person_for_information(
                ConnectionsService(),
                "owner-a",
                "Sarah",
                context,
            )
        with _connections({"displayName": "Alex Kim", "publicPersonRef": "different-person"}):
            with pytest.raises(action_tools.InformationPersonAmbiguous):
                action_tools._resolve_person_for_information(
                    ConnectionsService(),
                    "owner-a",
                    "Alex",
                    context,
                )
        assert action_tools._resolve_person_for_information(
            None,
            "owner-a",
            "Sarah",
            context,
        ) == (PERSON_REF, "Sarah Chen")

    @pytest.mark.asyncio
    async def test_shared_information_followup_stays_bound_to_selected_person(self):
        context = _ctx(_state())
        action_tools._remember_information_person(
            context, "user_1", PERSON_REF, "Sarah Chen", "Sarah"
        )
        with (
            _auth(),
            patch.object(
                InformationRequestService,
                "list_granted_shares",
                new=AsyncMock(
                    return_value=[{"person": "Sarah Chen", "label": "Employment status"}]
                ),
            ) as list_shares,
        ):
            result = await list_information_shared_with_me(context)
        assert result["person"] == {"displayName": "Sarah Chen", "personRef": PERSON_REF}
        list_shares.assert_awaited_once_with(requester_user_id="user_1", person_ref=PERSON_REF)

    @pytest.mark.asyncio
    async def test_shared_information_validates_browser_selection_before_listing(self):
        context = _ctx(_state())
        context.state[action_tools._STATE_INFORMATION_PERSON_CHOICES] = {
            "a" * 32: {
                "owner": "user_1",
                "session": "session_1",
                "personRef": PERSON_REF,
                "displayName": "Sarah Chen",
                "expiresAt": 2_000_000_000,
            },
        }
        context.state[action_tools._STATE_REQUESTED_INFORMATION_PERSON] = "a" * 32
        with (
            _auth(),
            patch.object(
                InformationRequestService,
                "list_granted_shares",
                new=AsyncMock(return_value=[]),
            ) as list_shares,
        ):
            result = await list_information_shared_with_me(context)
        assert result["status"] == "ok"
        assert result["person"] == {"displayName": "Sarah Chen", "personRef": PERSON_REF}
        list_shares.assert_awaited_once_with(requester_user_id="user_1", person_ref=PERSON_REF)

    @pytest.mark.asyncio
    async def test_shared_information_does_not_fall_back_to_unfiltered_after_bad_selection(self):
        context = _ctx(_state())
        context.state[action_tools._STATE_REQUESTED_INFORMATION_PERSON] = "forged"

        with (
            _auth(),
            patch.object(
                InformationRequestService,
                "list_granted_shares",
                new=AsyncMock(),
            ) as list_shares,
        ):
            result = await list_information_shared_with_me(context)
        assert result == {
            "status": "needs_clarification",
            "message": "That choice expired. Please choose the person again.",
        }
        list_shares.assert_not_awaited()

    def test_persisted_legacy_selection_cannot_override_a_new_spoken_name(self):
        context = _ctx(_state())
        # Older sessions may still carry the pre-temp key. It is historical
        # state, never current-turn browser admission, and must not redirect a
        # new explicit lookup.
        context.state["hussh:requested_person_selection"] = "expired-handle"
        with _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}):
            assert action_tools._resolve_person_for_information(
                ConnectionsService(), "owner-a", "Sarah Chen", context
            ) == (PERSON_REF, "Sarah Chen")

    @pytest.mark.asyncio
    async def test_shared_information_empty_state_is_bound_to_selected_person(self):
        context = _ctx(_state())
        action_tools._remember_information_person(
            context, "user_1", PERSON_REF, "Sarah Chen", "Sarah"
        )
        with (
            _auth(),
            patch.object(
                InformationRequestService,
                "list_granted_shares",
                new=AsyncMock(return_value=[]),
            ),
        ):
            result = await list_information_shared_with_me(context)

        assert result["nextStep"] == "Sarah Chen has not shared any information with you yet."

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
        state = _state()
        with (
            _auth(),
            _connections({"displayName": "Sarah Chen", "publicPersonRef": PERSON_REF}),
            _profile(),
            _connector(False),
        ):
            result = await propose_information_request(
                "Sarah", "food", "Dinner planning for the offsite", _ctx(state)
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
        assert f"{action_tools._STATE_PENDING_DIRECTIVE}:consent.request" not in state
