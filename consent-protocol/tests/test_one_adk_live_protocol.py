"""Unit coverage for One ADK Live browser-frame trust boundaries."""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from api.routes.one.adk_live import (
    _GOAL_CONTINUATION_NOTE,
    _close_quietly,
    _directive_dedup_fingerprint,
    _goal_continuation_is_already_ready,
    _InitialGreetingGate,
    _navigation_continuation_screen,
    _receive_runtime_bootstrap,
    _safe_json_dumps,
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


def test_safe_json_dumps_survives_a_value_the_plain_encoder_rejects():
    """Every outbound websocket frame in this module goes through this
    instead of a bare json.dumps -- a raw datetime (or any other type the
    encoder does not know) anywhere in a directive payload otherwise throws
    mid-send and kills the whole live session with nothing surfaced to the
    user. This is the backstop for the whole class of bug, not a fix for
    one instance of it."""
    payload = {
        "clientDirective": {
            "kind": "action_result",
            "payload": {
                "actionId": "location.share_selected",
                "status": "completed",
                # A raw datetime should never reach here (upstream services
                # own stringifying their own timestamps), but this proves
                # the send survives even if one does.
                "leakedTimestamp": datetime(2026, 8, 26, tzinfo=timezone.utc),
            },
        }
    }
    dumped = _safe_json_dumps(payload)
    parsed = json.loads(dumped)
    assert parsed["clientDirective"]["payload"]["leakedTimestamp"] == "2026-08-26 00:00:00+00:00"


def test_safe_json_dumps_matches_plain_json_dumps_for_ordinary_payloads():
    # The fallback must never change what an already-serializable payload
    # produces -- default=str is a last resort, not a reformatter.
    payload = {"serverContent": {"modelTurn": {"parts": [{"text": "hi"}]}}}
    assert _safe_json_dumps(payload) == json.dumps(payload, default=str)


def test_directive_dedup_fingerprint_distinguishes_different_slot_values():
    # The predecessor fingerprint hashed only sorted(slots.keys()) -- "analyse
    # Nvidia" then "analyse Tesla" shared one key shape ({"symbol"}), so the
    # second collided with the first's still-unsettled directive and was
    # silently deduped away instead of being issued.
    nvidia = _directive_dedup_fingerprint("analysis.start", {"symbol": "NVDA"})
    tesla = _directive_dedup_fingerprint("analysis.start", {"symbol": "TSLA"})
    assert nvidia != tesla


def test_directive_dedup_fingerprint_is_stable_for_the_same_request():
    first = _directive_dedup_fingerprint("location.share_selected", {"person": "Sarah"})
    second = _directive_dedup_fingerprint("location.share_selected", {"person": "Sarah"})
    assert first == second


def test_directive_dedup_fingerprint_never_carries_the_raw_value():
    # A SHA-256 digest, not the value itself -- issued_action_fingerprints
    # holds this for the life of the GC window (up to 300s), and a slot can
    # carry something like an OTP.
    fingerprint = _directive_dedup_fingerprint("auth.verify_code", {"code": "483920"})
    assert "483920" not in fingerprint
    assert len(fingerprint) == 64  # a hex sha256 digest


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
    (
        mode,
        credential,
        transport,
        project,
        location,
        _resume,
        _voice,
    ) = await _receive_runtime_bootstrap(
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
    (
        mode,
        credential,
        transport,
        project,
        location,
        _resume,
        _voice,
    ) = await _receive_runtime_bootstrap(
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


@pytest.mark.asyncio
async def test_runtime_bootstrap_accepts_an_allowlisted_voice_name():
    *_rest, voice_name = await _receive_runtime_bootstrap(
        _BootstrapSocket(
            {
                "type": "runtime_bootstrap",
                "runtime_credential_mode": "hushh_managed_vertex",
                "voice_name": "Aoede",
            }
        ),
        uid=None,
    )

    assert voice_name == "Aoede"


@pytest.mark.asyncio
async def test_runtime_bootstrap_drops_a_voice_name_outside_the_allowlist():
    *_rest, voice_name = await _receive_runtime_bootstrap(
        _BootstrapSocket(
            {
                "type": "runtime_bootstrap",
                "runtime_credential_mode": "hushh_managed_vertex",
                "voice_name": "not-a-real-voice",
            }
        ),
        uid=None,
    )

    assert voice_name is None


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
        "voice_settings": {
            "voice_enabled": True,
            "require_tap_confirmation": False,
            "disabled_domains": [],
        },
    }


def test_voice_settings_fails_open_when_absent_or_malformed():
    # Every field here is a person's own restriction on a capability they
    # already have, not a grant -- missing or corrupted input must resolve to
    # today's exact behavior, never to "block everything".
    absent = _sanitize_live_context({"route_family": "/one/kai/market"})
    assert absent["voice_settings"] == {
        "voice_enabled": True,
        "require_tap_confirmation": False,
        "disabled_domains": [],
    }

    malformed = _sanitize_live_context(
        {"route_family": "/one/kai/market", "voice_settings": "not-a-dict"}
    )
    assert malformed["voice_settings"] == {
        "voice_enabled": True,
        "require_tap_confirmation": False,
        "disabled_domains": [],
    }


def test_voice_settings_honours_explicit_restrictions():
    context = _sanitize_live_context(
        {
            "route_family": "/one/kai/market",
            "voice_settings": {
                "voice_enabled": False,
                "require_tap_confirmation": True,
                "disabled_domains": ["location", "kyc"],
            },
        }
    )
    assert context["voice_settings"] == {
        "voice_enabled": False,
        "require_tap_confirmation": True,
        "disabled_domains": ["location", "kyc"],
    }


def test_voice_settings_drops_domains_the_server_cannot_enforce():
    # "finance" and "calendar" are real domain keys the UI can show as
    # "coming soon", but neither routes through a server-side choke point --
    # accepting them here would let a client believe a restriction applies
    # when nothing downstream checks it. Unrecognised strings are dropped the
    # same way.
    context = _sanitize_live_context(
        {
            "route_family": "/one/kai/market",
            "voice_settings": {
                "disabled_domains": ["location", "finance", "calendar", "not_a_real_domain"],
            },
        }
    )
    assert context["voice_settings"]["disabled_domains"] == ["location"]


def test_voice_settings_caps_before_filtering_not_after():
    # bounded_text_list truncates the RAW list at LIVE_MODULE_CAP before the
    # allowlist filter ever runs, so a valid domain past the cap is dropped
    # even though it would otherwise pass -- the same order enforced
    # elsewhere in this module (available_action_ids, visible_modules, ...).
    padding = [f"garbage_{i}" for i in range(10)]
    context = _sanitize_live_context(
        {
            "route_family": "/one/kai/market",
            "voice_settings": {"disabled_domains": [*padding, "location"]},
        }
    )
    assert context["voice_settings"]["disabled_domains"] == []


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
    # cross-screen requests like "go to profile" stay proposable. Gmail setup
    # now declares real local actions in the generated index (it was dormant
    # when this test was written), so its own route-declared action survives
    # the intersection too.
    assert context["available_action_ids"] == [
        "route.profile",
        "setup.connect_gmail",
    ]


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

    assert (
        _navigation_continuation_screen("goal.location.select_share_recipient", run, "succeeded")
        == "one_location"
    )
    assert (
        _navigation_continuation_screen(
            "goal.analysis.start_debate",
            _navigation_run("goal.analysis.start_debate", "kai_analysis"),
            "started",
        )
        == "kai_analysis"
    )


def test_a_journey_releases_when_destination_context_precedes_route_settlement():
    # Agent Bar publishes and receives the destination context acknowledgement
    # before it emits `action_settled`. The relay must treat that latest,
    # already-sanitized snapshot as sufficient rather than wait forever for a
    # second app_context frame.
    assert _goal_continuation_is_already_ready({"screen": "one_location"}, "one_location")
    assert not _goal_continuation_is_already_ready({"screen": "one_location"}, "connect")
    assert not _goal_continuation_is_already_ready({}, "one_location")


def test_a_settled_action_step_is_never_mistaken_for_another_cue_to_act():
    # `continue_app_goal` stamps step_cursor 1 before issuing the action. What
    # settles then is the pick itself, carrying the matched name One is waiting
    # to hear -- re-arming here would send it back to run the step it just ran.
    ran = _navigation_run("goal.location.select_share_recipient", "one_location", step_cursor=1)

    assert (
        _navigation_continuation_screen("goal.location.select_share_recipient", ran, "succeeded")
        is None
    )


def test_a_navigation_that_did_not_arrive_continues_nothing():
    run = _navigation_run("goal.location.select_share_recipient", "one_location")

    # Nothing to stand on, so there is nothing to run there.
    assert (
        _navigation_continuation_screen("goal.location.select_share_recipient", run, "blocked")
        is None
    )
    assert (
        _navigation_continuation_screen("goal.location.select_share_recipient", run, "failed")
        is None
    )
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


def test_an_action_that_already_succeeded_is_not_run_again():
    """The stop condition that a re-entering model cannot talk its way past.

    Live, One shared a location successfully, the composer cleared its
    selection the way it always does after a send, and One -- which had no way
    to learn it had succeeded -- tried again. Every retry found an empty
    composer, settled "nobody is selected yet", and it tried again. A hard
    loop, on an action that had already worked.

    A tool cannot see settlements through `tool_context.state`: that froze when
    the streaming invocation opened. This is the seam that carries it.
    """
    from hushh_mcp.services.live_voice_context import (
        clear_completed_actions,
        read_completed_action,
        record_completed_action,
    )

    session = "session-loop-test"
    clear_completed_actions(session)
    assert read_completed_action(session, "location.share_selected") is None

    record_completed_action(session, "location.share_selected", '{"duration_hours": "0.25"}')
    assert read_completed_action(session, "location.share_selected") == '{"duration_hours": "0.25"}'
    # Scoped to the action. Finishing a share says nothing about a pause.
    assert read_completed_action(session, "location.pause_updates") is None
    # And to the session, so one person's completed work never suppresses
    # another's identical request.
    assert read_completed_action("someone-else", "location.share_selected") is None

    clear_completed_actions(session)
    assert read_completed_action(session, "location.share_selected") is None


def test_the_guard_distinguishes_different_inputs_to_the_same_action():
    """Repeating an action with DIFFERENT inputs is a new request, not a loop.

    The relay's directive dedupe fingerprints slot KEYS only, which cannot
    tell "share for 15 minutes" from "share for an hour" -- fine for
    suppressing a duplicate still in flight, far too coarse for deciding
    something has already been done. This guard fingerprints values.
    """
    from hushh_mcp.one_adk.action_tools import _slot_fingerprint

    quarter_hour = _slot_fingerprint({"duration_hours": "0.25"})
    an_hour = _slot_fingerprint({"duration_hours": "1"})
    assert quarter_hour != an_hour
    # Stable regardless of dict ordering, or the same request would look new.
    assert _slot_fingerprint({"a": "1", "b": "2"}) == _slot_fingerprint({"b": "2", "a": "1"})
    # Naming a different person is a different request, and must get through.
    assert _slot_fingerprint({"person": "Sarah"}) != _slot_fingerprint({"person": "Abdul"})


def test_an_action_that_just_failed_is_not_run_again():
    """The other half of the guard above, and the half that actually loops.

    Only successes were recorded, so a FAILED action left no trace anywhere:
    the already-completed refusal could not fire, and the relay admitted the
    identical call again. Live on UAT, sharing with someone whose account had
    no encryption keys settled `failed` and `location.share_selected` went out
    24 times in 15 seconds -- roughly twice a second, against a backend that
    could only ever refuse it.

    Failure is the case that loops hardest precisely because it leaves the
    person's request unsatisfied, so the model keeps trying to satisfy it.
    """
    from hushh_mcp.services.live_voice_context import (
        clear_completed_actions,
        read_failed_action,
        record_failed_action,
    )

    session = "session-failure-loop-test"
    clear_completed_actions(session)
    assert read_failed_action(session, "location.share_selected") is None

    record_failed_action(
        session,
        "location.share_selected",
        '{"person": "Abdul"}',
        "Abdul has not finished setting up secure keys.",
    )
    record = read_failed_action(session, "location.share_selected")
    assert record is not None
    fingerprint, reason = record
    assert fingerprint == '{"person": "Abdul"}'
    # The reason is kept, not just the fingerprint. A refusal that hands One
    # nothing to say is one it will try to satisfy by acting again.
    assert reason == "Abdul has not finished setting up secure keys."

    # Scoped to the action, and to the session, exactly like the success store.
    assert read_failed_action(session, "location.pause_updates") is None
    assert read_failed_action("someone-else", "location.share_selected") is None

    # Fresh speech clears it: a person who fixes the problem and asks again
    # must get through. This is why the guard needs no expiry window -- the
    # next thing the person says already ends it.
    clear_completed_actions(session)
    assert read_failed_action(session, "location.share_selected") is None


def test_a_later_success_retires_an_earlier_failure():
    """Otherwise a fixed problem stays "broken" for the rest of the turn.

    The person grants the missing permission, the action works, and without
    this the next legitimate call is still refused by a record describing a
    failure that no longer exists.
    """
    from hushh_mcp.services.live_voice_context import (
        clear_completed_actions,
        clear_failed_action,
        read_failed_action,
        record_failed_action,
    )

    session = "session-failure-retired-test"
    clear_completed_actions(session)
    record_failed_action(session, "location.share_selected", '{"person": "Abdul"}', "no keys")
    assert read_failed_action(session, "location.share_selected") is not None

    clear_failed_action(session, "location.share_selected")
    assert read_failed_action(session, "location.share_selected") is None

    # Clearing an action that never failed is a no-op, not a KeyError -- every
    # success calls this, and most of them follow no failure at all.
    clear_failed_action(session, "location.pause_updates")
    clear_failed_action("session-that-does-not-exist", "location.share_selected")


def test_a_failure_does_not_block_a_different_request_to_the_same_action():
    """Changing the person or the duration is a new request, not the loop.

    The guard matches on the value fingerprint, so "share with Abdul" failing
    must never suppress "share with Sarah". Getting this wrong would turn one
    unreachable contact into an action the person cannot use at all.
    """
    from hushh_mcp.one_adk.action_tools import _slot_fingerprint
    from hushh_mcp.services.live_voice_context import (
        clear_completed_actions,
        read_failed_action,
        record_failed_action,
    )

    session = "session-failure-scope-test"
    clear_completed_actions(session)
    record_failed_action(
        session,
        "location.share_selected",
        _slot_fingerprint({"person": "Abdul"}),
        "no keys",
    )

    record = read_failed_action(session, "location.share_selected")
    assert record is not None
    assert record[0] == _slot_fingerprint({"person": "Abdul"})
    assert record[0] != _slot_fingerprint({"person": "Sarah"})


def test_a_specialist_card_is_not_proposed_twice():
    """The path that had no guard at all, rather than one being escaped.

    `payload.actionId` is the admission gate for every piece of directive
    governance on both sides -- the relay's issue/dedupe/ledger/GC block and the
    browser's directive lease. A specialist directive carries `payload.type` and
    no `actionId`, so it passes through both untouched: never issued, never
    leased, and unable to settle, because the settlement validator refuses any
    directive id the relay did not issue.

    One is therefore never told the card landed. It is told the specialist is
    waiting, the person speaks again, the same grant is re-proposed under the
    same fixed state key with a freshly random payload id, and a second
    identical card reaches the browser. QA saw the same line twice in the
    transcript and heard it twice; both come from this.
    """
    from hushh_mcp.services.live_voice_context import (
        clear_pending_specialist_directives,
        read_pending_specialist_directive,
        record_pending_specialist_directive,
        specialist_directive_fingerprint,
    )

    session = "session-specialist-card"
    clear_pending_specialist_directives(session)

    share = specialist_directive_fingerprint("agent_location", "prompt", "publish_share")
    assert read_pending_specialist_directive(session, share) is False

    record_pending_specialist_directive(session, share)
    assert read_pending_specialist_directive(session, share) is True

    # Scoped by specialist, by kind, and by directive type, so an unrelated
    # proposal is never suppressed by this one.
    assert (
        read_pending_specialist_directive(
            session,
            specialist_directive_fingerprint("agent_location", "prompt", "publish_checkin"),
        )
        is False
    )
    assert (
        read_pending_specialist_directive(
            session,
            specialist_directive_fingerprint("agent_email", "prompt", "publish_share"),
        )
        is False
    )
    # And by session, so one person's open card never silences another's.
    assert read_pending_specialist_directive("someone-else", share) is False

    # Fresh speech releases it. These can never settle -- no directive id was
    # ever issued for them -- so the next thing the person says is the only
    # signal available that the moment has moved on, and someone deliberately
    # asking twice must still get through.
    clear_pending_specialist_directives(session)
    assert read_pending_specialist_directive(session, share) is False


def test_the_specialist_fingerprint_ignores_the_random_payload_id():
    """Including it would make every repeat look new.

    The specialist payload's own id is regenerated per call
    (`"act-" + uuid4().hex[:12]`), so it is different on the duplicate card by
    construction. Fingerprinting on identity that survives a re-proposal is the
    whole reason this guard can fire.
    """
    from hushh_mcp.services.live_voice_context import specialist_directive_fingerprint

    first = specialist_directive_fingerprint("agent_location", "prompt", "publish_share")
    second = specialist_directive_fingerprint("agent_location", "prompt", "publish_share")
    assert first == second
    assert first != specialist_directive_fingerprint("agent_location", "action", "publish_share")


def test_one_settlement_produces_one_turn_even_when_it_arms_a_continuation():
    """A second `send_content` is a second answer, not a second instruction.

    Each `send_content` closes a user turn on the Live API and elicits a full
    model response. A settlement that armed a journey continuation used to send
    two frames -- the outcome, then the continuation note -- so One answered
    twice for one event. That is a second, independent source of the repetition
    QA reported, separate from the specialist-card duplication.

    The two continuation kinds cannot both be live: `continuation_ready_now`
    requires a `one.goal_run.v1` navigation step (step_cursor 0) and
    `journey_continuation_note` requires a `one.settled_action_journey.v1` run.
    This pins that exclusivity, because folding them into one frame is only
    safe while it holds.
    """
    from api.routes.one.adk_live import (
        _is_navigation_step_settlement,
        _navigation_continuation_screen,
    )

    navigation_run = {
        "schema_version": "one.goal_run.v1",
        "step_cursor": 0,
        "expected_screen": "connect",
    }
    settled_run = {
        "schema_version": "one.settled_action_journey.v1",
        "deferred_action_id": "connect.send_request",
    }

    # A navigation step arms the navigation continuation...
    assert _is_navigation_step_settlement(navigation_run) is True
    assert _navigation_continuation_screen("goal.x", navigation_run, "succeeded") == "connect"
    # ...and a settled-action journey never does, so the settled-journey note
    # and the navigation note can never both be produced for one settlement.
    assert _is_navigation_step_settlement(settled_run) is False
    assert _navigation_continuation_screen("goal.x", settled_run, "succeeded") is None

    # Past the navigation step, what settles is the journey's own action, whose
    # result One is waiting on -- never another cue to act.
    assert (
        _navigation_continuation_screen("goal.x", {**navigation_run, "step_cursor": 1}, "succeeded")
        is None
    )
    # A failed navigation arms nothing either.
    assert _navigation_continuation_screen("goal.x", navigation_run, "failed") is None


def test_the_relay_never_sends_activity_signals_while_the_provider_endpoints_itself():
    """Activity signals belong to the client only when automatic VAD is off.

    `AutomaticActivityDetection.disabled` is what decides who owns endpointing:
    "if disabled, the client must send activity signals." This relay leaves
    `realtime_input_config` unset on its `RunConfig`, so automatic detection is
    on and the provider owns it -- and a relay that also sends activity_end is
    asking the provider to close a window it did not hand over.

    The two halves are checked together on purpose. Either one alone is a
    legitimate design: manual VAD WITH activity signals is fine, and automatic
    VAD WITHOUT them is fine. It is the mismatch that is the bug, and it was
    introduced by a comment that read "close the current activity window" as
    though the window were ours to close.
    """
    source = (Path(__file__).resolve().parents[1] / "api/routes/one/adk_live.py").read_text(
        encoding="utf-8"
    )
    # Comments are stripped first. The invariant is about what the relay DOES,
    # and the comment explaining this fix has to be free to name the call it
    # removed -- an assertion that a string is absent from a file otherwise
    # fails on its own rationale, which is exactly what happened here.
    code = "\n".join(line for line in source.splitlines() if not line.strip().startswith("#"))
    assert "queue.send_activity_end()" not in code
    assert "queue.send_activity_start()" not in code
    # If someone ever disables automatic detection, this test should be
    # revisited rather than silently kept passing: that is the configuration
    # where the relay MUST send the signals it is forbidden from sending here.
    assert "realtime_input_config=" not in code
