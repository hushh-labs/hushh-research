"""Unit coverage for One ADK Live browser-frame trust boundaries."""

from api.routes.one.adk_live import (
    _compose_route_context_note,
    _InitialGreetingGate,
    _sanitize_action_settlement,
    _sanitize_live_context,
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


def test_live_context_keeps_only_bounded_redacted_ui_fields():
    context = _sanitize_live_context(
        {
            "route_family": "/one/kai",
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
        "route_family": "/one/kai",
        "route_pattern": "/one/kai",
        "route_instruction_id": "route.one.kai",
        "route_context_policy": "publish",
        "route_playbook": context["route_playbook"],
        "screen": "kai_market",
        "persona": "investor",
        "voice_state": "listening",
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
    assert context["available_action_ids"] == ["setup.connect_gmail"]


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


def test_action_settlement_requires_matching_issued_directive_and_can_retry_after_invalid():
    issued = {"directive-1": "analysis.start"}

    assert (
        _sanitize_action_settlement(
            {
                "directiveId": "directive-1",
                "actionId": "analysis.start",
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
            "status": "blocked",
            "summary": "Portfolio access is locked.",
            "reason": "vault_locked",
            "routeAfter": "/one/kai",
            "screenAfter": "finance",
        },
        issued,
    )

    assert settlement is not None
    assert settlement["status"] == "blocked"
    assert settlement["summary"] == "Portfolio access is locked."
    assert issued == {}
