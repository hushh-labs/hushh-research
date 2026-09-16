"""Shared screen/authority contracts retained after Live transport retirement."""

from api.routes.one.live_context import compose_route_context_note as _compose_route_context_note
from api.routes.one.live_context import sanitize_action_settlement as _sanitize_action_settlement
from api.routes.one.live_context import sanitize_live_context as _sanitize_live_context


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
        # Empty for this route because the generated index declares no actions
        # for it. On a route that does (Location declares 52), this is the
        # uncapped executable set -- see
        # test_execution_is_not_bounded_by_the_prompt_budget.
        "executable_action_ids": [],
        # Empty because this payload publishes no screen state. A surface that
        # does gets a bounded, scalar-only map -- see
        # test_screen_state_reaches_the_model_bounded.
        "screen_state": {},
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


def test_live_context_keeps_a_full_execution_inventory_separate_from_prompt_cap():
    action_ids = [
        "location.open_now",
        "location.open_map",
        "location.open_people",
        "location.open_links",
        "location.open_share",
        "location.open_ask",
        "location.open_invite",
        "location.open_create_circle",
        "location.open_join_circle",
        "location.open_temporary_link",
        "location.open_check_in",
        "location.open_sos",
        "location.open_sms_contacts",
        "location.open_settings",
        "location.open_active_shares",
        "location.open_shared_with_me",
        "location.open_needs_review",
        "location.add_connections",
        "location.open_map",
        "location.refresh",
        "location.pause_updates",
        "location.share_selected",
        "location.create_circle",
    ]
    context = _sanitize_live_context(
        {
            "route_family": "/one/location",
            "available_action_ids": action_ids,
            "executable_action_ids": [*action_ids, "location.rename_circle"],
        }
    )

    assert len(context["available_action_ids"]) <= 58
    assert "location.rename_circle" not in context["available_action_ids"]
    assert "location.rename_circle" in context["executable_action_ids"]


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
