"""Unit coverage for One ADK Live browser-frame trust boundaries."""

import pytest

from api.routes.one.adk_live import (
    _GOAL_CONTINUATION_NOTE,
    _close_quietly,
    _InitialGreetingGate,
    _navigation_continuation_screen,
    _receive_runtime_bootstrap,
)
from api.routes.one.live_context import (
    compose_route_context_note as _compose_route_context_note,
)
from api.routes.one.live_context import (
    sanitize_action_settlement as _sanitize_action_settlement,
)
from api.routes.one.live_context import (
    sanitize_live_context as _sanitize_live_context,
)


def test_initial_greeting_gate_allows_one_idle_cue_only():
    gate = _InitialGreetingGate()
    epoch = gate.schedule()

    assert epoch is not None
    assert gate.may_send(epoch) is True
    assert gate.mark_sent(epoch) is True
    assert gate.schedule() is None


def test_initial_greeting_gate_invalidates_a_pending_cue_after_visitor_activity():
    gate = _InitialGreetingGate()
    epoch = gate.schedule()

    assert epoch is not None
    gate.cancel_for_visitor_activity()
    assert gate.may_send(epoch) is False
    assert gate.mark_sent(epoch) is False
    assert gate.schedule() is None


class _BootstrapSocket:
    def __init__(self, frame: dict):
        self._frame = frame

    async def receive_text(self) -> str:
        import json

        return json.dumps(self._frame)


class _CloseSocket:
    """Stand-in for the real websocket's close(), optionally raising to
    simulate the known websockets/uvicorn legacy-protocol bug where close()
    throws AttributeError on a connection whose transfer_data_task never got
    set (client gone before the handshake finished)."""

    def __init__(self, close_error: Exception | None = None):
        self._close_error = close_error
        self.close_calls: list[tuple[int, str]] = []

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.close_calls.append((code, reason))
        if self._close_error is not None:
            raise self._close_error


@pytest.mark.asyncio
async def test_close_quietly_closes_with_the_given_code_and_reason():
    socket = _CloseSocket()

    await _close_quietly(socket, code=1008, reason="Voice relay ticket is expired.")

    assert socket.close_calls == [(1008, "Voice relay ticket is expired.")]


@pytest.mark.asyncio
async def test_close_quietly_swallows_a_close_failure_on_an_already_gone_client():
    socket = _CloseSocket(
        close_error=AttributeError(
            "'WebSocketProtocol' object has no attribute 'transfer_data_task'"
        )
    )

    # Must not raise: the client is already gone, so there is no one left to
    # notify, and a rejection path failing to send its close frame must not
    # itself become an unhandled server exception.
    await _close_quietly(socket, code=1008, reason="Voice session configuration was not accepted.")

    assert socket.close_calls == [(1008, "Voice session configuration was not accepted.")]


@pytest.mark.asyncio
async def test_runtime_bootstrap_accepts_only_the_authenticated_byok_frame():
    mode, credential, transport, project, location, _resume = await _receive_runtime_bootstrap(
        _BootstrapSocket(
            {
                "type": "runtime_bootstrap",
                "runtime_credential_mode": "byok",
                "runtime_credential": "test-key",
                "runtime_credential_transport": "developer_api",
            }
        ),
        uid="user_1",
    )

    assert mode == "byok"
    assert credential == "test-key"
    assert transport == "developer_api"
    assert project is None
    assert location is None


@pytest.mark.asyncio
async def test_runtime_bootstrap_accepts_a_vertex_api_key_only_with_explicit_endpoint_metadata():
    mode, credential, transport, project, location, _resume = await _receive_runtime_bootstrap(
        _BootstrapSocket(
            {
                "type": "runtime_bootstrap",
                "runtime_credential_mode": "byok",
                "runtime_credential": "test-key",
                "runtime_credential_transport": "vertex_api_key",
                "runtime_vertex_project": "customer-vertex-project",
                "runtime_vertex_location": "us-central1",
            }
        ),
        uid="user_1",
    )

    assert (mode, credential, transport, project, location) == (
        "byok",
        "test-key",
        "vertex_api_key",
        "customer-vertex-project",
        "us-central1",
    )


@pytest.mark.asyncio
async def test_runtime_bootstrap_rejects_a_credential_in_managed_mode():
    with pytest.raises(ValueError, match="runtime_bootstrap_invalid"):
        await _receive_runtime_bootstrap(
            _BootstrapSocket(
                {
                    "type": "runtime_bootstrap",
                    "runtime_credential_mode": "hushh_managed_vertex",
                    "runtime_credential": "test-key",
                }
            ),
            uid="user_1",
        )


def test_live_context_keeps_only_bounded_redacted_ui_fields():
    context = _sanitize_live_context(
        {
            "route_family": "/one/kai/market",
            "persona": "investor",
            "voice_state": "listening",
            "available_action_ids": ["analysis.start", "analysis.start", "not.generated", 7],
            "visible_modules": ["Portfolio"],
            "cache_freshness": "fresh_or_stale_safe",
            "vault_ready": True,
            "portfolio_ready": True,
            "busy_operations": ["analysis"],
            "consent_token": "must-not-be-in-context",
            "private_page_text": "must-not-be-in-context",
        }
    )

    assert context == {
        "route_family": "/one/kai/market",
        "route_pattern": "/one/kai/market",
        "route_instruction_id": "route.one.kai.market",
        "route_context_policy": "suppress",
        "route_playbook": context["route_playbook"],
        "screen": "kai_market",
        # Opt-in and absent unless a surface declares it. selected_entity and
        # primary_entity stay out of the boundary entirely: several surfaces
        # fill those with an investor name or email address.
        "spoken_subject": None,
        # Same posture: absent unless a surface says it is stuck, and dropped
        # entirely unless the remedy it names is one this route may run.
        "dead_end": None,
        "persona": "investor",
        "voice_state": "listening",
        "signed_in": False,
        "context_revision": None,
        "available_action_ids": [],
        "visible_modules": ["Portfolio"],
        "visible_control_ids": [],
        "interaction_layer": None,
        "pending_settlement": False,
        "cache_freshness": "fresh_or_stale_safe",
        "vault_ready": True,
        "portfolio_ready": True,
        "busy_operations": ["analysis"],
        "onboarding": {
            "phase": "anonymous_auth",
            "active_capability": None,
            "root_resolved": False,
            "return_route": "/one/setup",
            "callback_state": "none",
            "phone_verified": None,
            "setup_capability_ids": [],
        },
    }


def test_live_context_keeps_only_generated_actions_from_the_top_modal_layer():
    context = _sanitize_live_context(
        {
            "route_family": "/login",
            "available_action_ids": [
                "auth.sign_in_apple",
                "auth.close_legal",
                "not.generated",
            ],
            "interaction_layer": {
                "layer_id": "login_legal_terms",
                "kind": "legal_document",
                "modality": "modal",
                "lifecycle_state": "open",
                "dismissible": True,
                "dismiss_action_id": "auth.close_legal",
                "visible_action_ids": ["auth.close_legal", "not.generated"],
                "visible_control_ids": ["auth_close_legal"],
                "options": [],
                "underlying_actions_available": True,
                "agent_continuity": "interactive",
            },
        }
    )

    assert context["available_action_ids"] == ["auth.close_legal"]
    assert context["interaction_layer"] == {
        "layer_id": "login_legal_terms",
        "kind": "legal_document",
        "modality": "modal",
        "lifecycle_state": "open",
        "dismissible": True,
        "dismiss_action_id": "auth.close_legal",
        "visible_action_ids": ["auth.close_legal"],
        "visible_control_ids": ["auth_close_legal"],
        "options": [],
        "underlying_actions_available": False,
        "agent_continuity": "interactive",
    }


def test_live_context_derives_static_route_policy_and_rejects_client_policy_fields():
    context = _sanitize_live_context(
        {
            "route_family": "/one/setup/finance",
            "route_instruction_id": "client.injected",
            "route_context_policy": "publish_everything",
        }
    )

    assert context["route_pattern"] == "/one/setup/finance"
    assert context["route_instruction_id"] == "route.one.setup.finance"
    assert context["route_context_policy"] == "publish"
    assert context["screen"] == "one_setup_finance"
    assert context["route_playbook"]["primary_action_id"] == "kai.setup.answer_horizon"


def test_live_context_intersects_actions_and_screen_with_generated_route_policy():
    context = _sanitize_live_context(
        {
            "route_family": "/one/setup/gmail",
            "screen": "profile",
            "available_action_ids": ["route.profile", "setup.connect_gmail"],
        }
    )

    assert context["screen"] == "one_setup_gmail"
    # Navigation actions (route.*, allow_direct) survive on every route so
    # cross-screen requests like "go to profile" stay proposable; the
    # route-declared local action survives through the index intersection.
    # Gmail setup is dormant, so only the globally-admitted navigation action
    # remains after generated-contract intersection.
    assert context["available_action_ids"] == ["route.profile"]


def test_live_context_keeps_navigation_actions_on_routes_without_local_actions():
    # /agent is a context_only route whose index entry declares no action
    # ids. Navigation must remain proposable there; junk must still drop.
    context = _sanitize_live_context(
        {
            "route_family": "/agent",
            "available_action_ids": ["route.profile", "analysis.start", "not.generated"],
        }
    )

    assert context["available_action_ids"] == ["route.profile"]


def test_live_context_never_accepts_unknown_ids_via_navigation_branch():
    # A forged route.* id that is not in the generated manifest never passes.
    context = _sanitize_live_context(
        {
            "route_family": "/agent",
            "available_action_ids": ["route.totally_forged"],
        }
    )

    assert context["available_action_ids"] == []


def test_route_note_prioritizes_visible_actions_without_granting_authority():
    context = _sanitize_live_context(
        {"route_family": "/", "available_action_ids": ["onboarding.claim_one"]}
    )
    note = _compose_route_context_note(context)

    assert note is not None
    assert "onboarding.claim_one" in note
    assert "currently visible generated action ids" in note
    assert "current top interaction layer" in note
    assert "before any identity or greeting response" in note
    assert "only execution authority" in note


def test_route_note_surfaces_visible_content_for_active_screen_awareness():
    context = _sanitize_live_context(
        {
            "route_family": "/",
            "available_action_ids": ["onboarding.claim_one"],
            "visible_modules": ["market_summary", "watchlist"],
        }
    )
    note = _compose_route_context_note(context)

    assert note is not None
    # One is told what the person is currently looking at, so a content/selection
    # change on the same route gives it fresh active-screen awareness.
    assert "content currently visible to the person is" in note
    assert "market_summary" in note
    assert "watchlist" in note


def test_dead_end_reaches_the_note_with_the_action_that_resolves_it():
    context = _sanitize_live_context(
        {
            "route_family": "/one/location",
            "available_action_ids": ["location.add_connections"],
            "dead_end": {
                "reason": "There is no one to add as an emergency contact yet.",
                "remedy_action_id": "location.add_connections",
            },
        }
    )

    assert context["dead_end"] == {
        "reason": "There is no one to add as an emergency contact yet.",
        "remedy_action_id": "location.add_connections",
    }

    note = _compose_route_context_note(context)
    assert note is not None
    # The point of the whole path: One is told both that the person is stuck
    # and where it gets unstuck, so "no connections" stops being a full stop.
    assert "currently stuck on this screen" in note
    assert "no one to add as an emergency contact" in note
    assert "location.add_connections" in note
    assert "never run it unasked" in note


def test_dead_end_is_dropped_whole_when_its_remedy_is_not_runnable_here():
    context = _sanitize_live_context(
        {
            "route_family": "/one/location",
            "available_action_ids": ["location.add_connections"],
            "dead_end": {
                "reason": "Nothing to do here.",
                "remedy_action_id": "connect.delete_everyones_account",
            },
        }
    )

    # A screen may describe its own dead end; it may not invent a destination.
    # Half a dead end -- a reason with an unreachable remedy -- would strand the
    # person mid-sentence, so the whole thing goes rather than the remedy alone.
    assert context["dead_end"] is None
    note = _compose_route_context_note(context)
    assert note is not None
    assert "currently stuck on this screen" not in note


def test_dead_end_needs_both_halves():
    for payload in (
        {"reason": "Stuck.", "remedy_action_id": ""},
        {"reason": "", "remedy_action_id": "location.add_connections"},
        {"remedy_action_id": "location.add_connections"},
        "not a mapping",
    ):
        context = _sanitize_live_context(
            {
                "route_family": "/one/location",
                "available_action_ids": ["location.add_connections"],
                "dead_end": payload,
            }
        )
        assert context["dead_end"] is None


def _proactive_context():
    context = _sanitize_live_context(
        {"route_family": "/", "available_action_ids": ["onboarding.claim_one"]}
    )
    playbook = dict(context.get("route_playbook") or {})
    playbook.update({"proactivity": "on_entry", "entry_cue": "Pick a finance view."})
    context["route_playbook"] = playbook
    return context


def test_route_note_spends_the_entry_cue_when_the_person_actually_arrives():
    note = _compose_route_context_note(_proactive_context(), is_route_entry=True)

    assert note is not None
    assert "orient once with this intent" in note
    assert "Pick a finance view." in note


def test_route_note_stays_silent_when_only_content_changed_on_the_same_screen():
    # Opening a preview on the current screen refreshes the inventory but is
    # not an arrival. Spending the on-entry cue here made One announce a
    # navigation that never happened.
    note = _compose_route_context_note(_proactive_context(), is_route_entry=False)

    assert note is not None
    assert "orient once with this intent" not in note
    assert "Use this context silently until the person speaks." in note
    # The refreshed inventory still reaches One; only the spoken cue is held.
    assert "onboarding.claim_one" in note


def test_action_settlement_requires_matching_issued_directive_and_can_retry_after_invalid():
    issued = {"directive-1": "analysis.start"}

    assert (
        _sanitize_action_settlement(
            {
                "directiveId": "directive-1",
                "actionId": "analysis.start",
                "contextRevision": "context-1",
                "status": "invented",
            },
            issued,
        )
        is None
    )
    assert issued == {"directive-1": "analysis.start"}

    settlement = _sanitize_action_settlement(
        {
            "directiveId": "directive-1",
            "actionId": "analysis.start",
            "contextRevision": "context-1",
            "status": "blocked",
            "summary": "Portfolio access is locked.",
            "reason": "vault_locked",
            "routeAfter": "/one/kai",
            "screenAfter": "finance",
            "destinationContextId": "ctx-2",
        },
        issued,
    )

    assert settlement is not None
    assert settlement["status"] == "blocked"
    assert settlement["context_revision"] == "context-1"
    assert settlement["summary"] == "Portfolio access is locked."
    assert settlement["destination_context_id"] == "ctx-2"
    assert issued == {}


def test_live_context_speaks_only_an_opt_in_subject_never_the_raw_entity():
    context = _sanitize_live_context(
        {
            "route_family": "/one/kai",
            "spoken_subject": "QCOM",
            # Several surfaces set these to an investor's name or email, so
            # they must not cross the boundary however useful they look.
            "selected_entity": "investor@example.com",
            "primary_entity": "Jane Investor",
        }
    )

    assert context["spoken_subject"] == "QCOM"
    assert "selected_entity" not in context
    assert "primary_entity" not in context

    note = _compose_route_context_note(context)
    assert note is not None
    assert "The person is looking at: QCOM." in note
    assert "investor@example.com" not in note
    assert "Jane Investor" not in note


def test_live_context_note_omits_the_subject_line_when_none_is_declared():
    context = _sanitize_live_context({"route_family": "/one/kai"})

    note = _compose_route_context_note(context)

    assert note is not None
    assert "The person is looking at" not in note


def _navigation_run(goal_id: str, screen: str, **overrides):
    """A journey run as `start_app_goal` parks it after issuing the route step."""
    return {
        "schema_version": "one.goal_run.v1",
        "goal_id": goal_id,
        "action_id": "location.select_share_recipient",
        "slots": {"person": "sarah"},
        "step_cursor": 0,
        "expected_screen": screen,
        "status": "awaiting_destination_screen",
        **overrides,
    }


def test_a_journey_waits_for_the_screen_its_own_run_names():
    # Reading the destination off the run is what makes every authored journey
    # continue. This was pinned to Analysis, so a journey to anywhere else
    # navigated and then stopped -- the person watched the right screen open
    # and nothing happen on it, which is indistinguishable from success.
    run = _navigation_run("goal.location.select_share_recipient", "one_location")

    assert _navigation_continuation_screen(
        "goal.location.select_share_recipient", run, "succeeded"
    ) == "one_location"
    assert _navigation_continuation_screen(
        "goal.analysis.start_debate",
        _navigation_run("goal.analysis.start_debate", "kai_analysis"),
        "started",
    ) == "kai_analysis"


def test_a_settled_action_step_is_never_mistaken_for_another_cue_to_act():
    # `continue_app_goal` stamps step_cursor 1 before issuing the action. What
    # settles then is the pick itself, carrying the matched name One is waiting
    # to hear -- re-arming here would send it back to run the step it just ran.
    ran = _navigation_run("goal.location.select_share_recipient", "one_location", step_cursor=1)

    assert _navigation_continuation_screen(
        "goal.location.select_share_recipient", ran, "succeeded"
    ) is None


def test_a_navigation_that_did_not_arrive_continues_nothing():
    run = _navigation_run("goal.location.select_share_recipient", "one_location")

    # Nothing to stand on, so there is nothing to run there.
    assert _navigation_continuation_screen("goal.location.select_share_recipient", run, "blocked") is None
    assert _navigation_continuation_screen("goal.location.select_share_recipient", run, "failed") is None
    # A directive with no goal behind it is an ordinary action, not a journey.
    assert _navigation_continuation_screen(None, run, "succeeded") is None
    # The settled-choice journey shape has its own continuation path.
    assert (
        _navigation_continuation_screen(
            "goal.x",
            {"schema_version": "one.settled_action_journey.v1", "expected_screen": "one_location"},
            "succeeded",
        )
        is None
    )


def test_the_continuation_note_names_no_screen_and_forbids_answering_early():
    # One turn of prose serves every journey, so it can never say "Analysis"
    # or "preview". The prohibition is the load-bearing half: on the share
    # chain One holds only the name it HEARD until the pick settles, and
    # asking from that is exactly the wrong-name failure the question exists
    # to catch.
    assert "continue_app_goal" in _GOAL_CONTINUATION_NOTE
    assert "not user speech" in _GOAL_CONTINUATION_NOTE
    assert "do not ask a question" in _GOAL_CONTINUATION_NOTE
    for surface_specific in ("analysis", "debate", "location", "preview"):
        assert surface_specific not in _GOAL_CONTINUATION_NOTE.lower()


def test_the_greeting_hold_is_owed_once_not_once_per_rearm():
    # The cue is armed twice: a generic one when the socket opens, then a
    # screen-aware one when the first app context lands. Re-arming used to
    # restart the wait, so the person paid it again for the context arriving --
    # on top of however long the browser took to publish it, which on a busy
    # dashboard is seconds. The hold guards against talking over someone who
    # opened the mic already speaking; that is owed once per session.
    gate = _InitialGreetingGate(idle_seconds=1.5)

    assert gate.hold_seconds(100.0) == pytest.approx(1.5)
    # 0.4s later the context arrives and the cue is re-armed with the screen.
    assert gate.hold_seconds(100.4) == pytest.approx(1.1)


def test_a_late_first_context_greets_immediately_rather_than_waiting_again():
    gate = _InitialGreetingGate(idle_seconds=1.5)
    gate.hold_seconds(100.0)

    # The browser took 9 seconds to publish its first context. The hold is long
    # spent; nothing is owed, so the screen-aware cue goes out now.
    assert gate.hold_seconds(109.0) == 0.0


def test_the_hold_never_resurrects_a_cue_that_speech_already_cancelled():
    # hold_seconds answers "how long", never "whether" -- schedule() owns that,
    # and visitor speech must keep beating the cue outright.
    gate = _InitialGreetingGate(idle_seconds=1.5)
    gate.hold_seconds(100.0)
    gate.cancel_for_visitor_activity()

    assert gate.schedule() is None
