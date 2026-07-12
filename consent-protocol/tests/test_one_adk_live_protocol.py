"""Unit coverage for One ADK Live browser-frame trust boundaries."""

from api.routes.one.adk_live import _sanitize_action_settlement, _sanitize_live_context


def test_live_context_keeps_only_bounded_redacted_ui_fields():
    context = _sanitize_live_context(
        {
            "route_family": "/one/kai",
            "persona": "investor",
            "voice_state": "listening",
            "available_action_ids": ["analysis.start", "analysis.start", 7],
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
        "persona": "investor",
        "voice_state": "listening",
        "available_action_ids": ["analysis.start"],
        "visible_modules": ["Portfolio"],
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


def test_live_context_derives_dynamic_route_policy_and_rejects_client_policy_fields():
    context = _sanitize_live_context(
        {
            "route_family": "/one/setup/finance",
            "route_instruction_id": "client.injected",
            "route_context_policy": "publish_everything",
        }
    )

    assert context["route_pattern"] == "/one/setup/[capability]"
    assert context["route_instruction_id"] == "route.one.setup.capability."
    assert context["route_context_policy"] == "minimal"


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
