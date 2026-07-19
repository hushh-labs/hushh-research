"""Contract-derived app action tools for One's agent tree.

The generated action gateway manifest (``contracts/kai/kai-action-gateway.vnext.json``,
loaded through ``hushh_mcp.services.action_gateway``) is the routing authority:

- Actions WITHOUT a wired ``delegate_agent_id`` execute as client directives:
  ``run_app_action`` validates policy + slots and parks a
  ``{kind: "action"}`` directive the relay forwards to the app. Zero LLM
  calls, zero agent hops; the app re-checks guards before executing.
- Actions whose ``delegate_agent_id`` maps to a wired specialist tool are
  REFUSED with a redirect to that ``ask_*`` tool, so contract ownership can
  never be bypassed by the model picking the wrong lane.
- ``manual_only`` actions are refused with where-to-do-it guidance;
  ``confirm_required`` actions park a directive flagged
  ``needsConfirmation`` so the app runs its confirmation surface.

``list_app_actions`` exposes the manifest as an on-demand ranked index
(bounded) instead of bloating the system instruction with 94 entries.
"""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.services.action_gateway import (
    get_action_gateway_action,
    is_navigation_action,
    list_action_gateway_actions,
)

logger = logging.getLogger(__name__)

# Session state keys shared with agent_tree/adk_live (duplicated string to
# avoid a circular import; guarded by a test asserting equality).
_STATE_PENDING_DIRECTIVE = "hussh:pending_directive"
_STATE_SCREEN = "hussh:screen"
_STATE_VOICE_CONTEXT = "hussh:voice_context"
_STATE_GOAL_RUN = "hussh:goal_run"
_ANALYSIS_GOAL_ID = "goal.analysis.start_debate"

# Manifest delegate ids -> One's specialist tool names. Only these redirect;
# other delegate markers (e.g. "agent_kyc", which has no conversational
# specialist) fall through to normal policy handling.
_DELEGATE_TOOL_BY_AGENT_ID: dict[str, str] = {
    "agent_email": "ask_email_agent",
    "agent_location": "ask_location_agent",
    "agent_connections": "ask_consent_agent",
    "agent_connected_systems": "ask_connected_systems_agent",
    "agent_nav": "ask_consent_agent",
}

_MAX_LIST_RESULTS = 10


def _available_action_ids(tool_context: ToolContext) -> set[str] | None:
    """Return the browser-declared executable ids when live context exists.

    The browser may publish arbitrary descriptive metadata, but action ids are
    filtered against the generated gateway before reaching this state. An
    absent context preserves compatibility for non-live callers; a present but
    empty list deliberately means no executable controls are available.
    """
    context = tool_context.state.get(_STATE_VOICE_CONTEXT)
    if not isinstance(context, dict) or "available_action_ids" not in context:
        return None
    ids = context.get("available_action_ids")
    if not isinstance(ids, list):
        return set()
    return {str(value).strip() for value in ids if isinstance(value, str) and value.strip()}


def _missing_required_slot(entry: dict[str, Any], slots: dict[str, Any]) -> dict[str, Any] | None:
    """First required goal input absent from ``slots`` (defaults count as filled)."""
    goal = entry.get("goal") or {}
    for spec in goal.get("required_inputs") or []:
        if not isinstance(spec, dict) or not spec.get("required"):
            continue
        slot_name = str(spec.get("slot") or spec.get("name") or "").strip()
        if not slot_name:
            continue
        if slots.get(slot_name) not in (None, ""):
            continue
        if spec.get("default_value") not in (None, ""):
            continue
        return {
            "slot": slot_name,
            "prompt": str(spec.get("prompt") or f"What should {slot_name} be?"),
        }
    return None


async def run_app_action(
    action_id: str, slots: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    """Run a governed app action by its exact action id.

    Use list_app_actions first when unsure of the id. Pass required inputs in
    slots (e.g. {"symbol": "NVDA"}). The app validates guards and confirms
    sensitive actions; never claim an outcome beyond this tool's status.
    """
    clean_id = str(action_id or "").strip()
    clean_slots = {k: v for k, v in (slots or {}).items() if v not in (None, "")}
    entry = get_action_gateway_action(clean_id)
    if entry is None:
        logger.info("one_adk_action_decision action=%s status=unknown_action", clean_id[:128])
        return {
            "status": "unknown_action",
            "message": f"'{clean_id}' is not a known app action.",
        }

    context = tool_context.state.get(_STATE_VOICE_CONTEXT)
    if isinstance(context, dict) and context.get("context_pending") is True:
        # The live relay seeded this marker at session start; the browser's
        # first app_context frame has not landed yet. Refusing outright here
        # read as "actions never fire" on cold connects; instead report a
        # recoverable status the model can retry after a beat.
        logger.info("one_adk_action_decision action=%s status=context_not_ready", clean_id)
        return {
            "status": "context_not_ready",
            "message": (
                "The app is still publishing its screen state. Acknowledge the "
                "request, wait a moment, and retry this exact action."
            ),
        }
    if isinstance(context, dict) and context.get("pending_settlement") is True:
        # A previous action or navigation has not settled yet. Executing
        # against the outgoing screen's inventory would validate the request
        # against stale state, so hold this turn instead of refusing it.
        logger.info("one_adk_action_decision action=%s status=settling", clean_id)
        return {
            "status": "settling",
            "message": (
                "The previous action is still settling. Wait for the app's "
                "settlement report, then run this action against the fresh "
                "screen state."
            ),
        }

    onboarding = context.get("onboarding") if isinstance(context, dict) else {}
    onboarding = onboarding if isinstance(onboarding, dict) else {}
    if clean_id == "onboarding.claim_one" and (
        (isinstance(context, dict) and context.get("signed_in") is True)
        or onboarding.get("root_resolved") is True
    ):
        return {
            "status": "terminal",
            "message": "One is already claimed for this session.",
        }
    if clean_id == "setup.hub_master_ack" and onboarding.get("root_resolved") is True:
        return {
            "status": "terminal",
            "message": "Setup acknowledgement is already complete.",
        }
    if (
        clean_id in {"phone_mandate.submit_number", "phone_mandate.submit_code"}
        and onboarding.get("phone_verified") is True
    ):
        return {
            "status": "terminal",
            "message": "Phone verification is already complete.",
        }

    policy = str((entry.get("risk") or {}).get("execution_policy") or "allow_direct")
    label = str(entry.get("label") or clean_id)
    if policy == "manual_only":
        screens = (entry.get("scope") or {}).get("screens") or []
        where = f" It lives on the {screens[0]} screen." if screens else ""
        logger.info("one_adk_action_decision action=%s status=manual_only", clean_id)
        return {
            "status": "manual_only",
            "message": (
                f"{label} must be done by the user in the app; I cannot trigger it.{where}"
            ),
        }

    execution_target = entry.get("execution_target") or {}
    execution_status = str(execution_target.get("status") or "unwired")
    if execution_status != "wired":
        reason = str(
            execution_target.get("reason") or "This action is not available in the current runtime."
        )
        logger.info(
            "one_adk_action_decision action=%s status=%s",
            clean_id,
            execution_status,
        )
        return {
            "status": execution_status,
            "message": reason,
        }

    available_action_ids = _available_action_ids(tool_context)
    # Navigation actions (route.*, allow_direct) are invocable from any
    # screen by design; the browser's per-screen inventory does not bound
    # them. All other actions must be declared by the current surface.
    if (
        available_action_ids is not None
        and clean_id not in available_action_ids
        and not is_navigation_action(entry)
    ):
        logger.info("one_adk_action_decision action=%s status=action_unavailable", clean_id)
        return {
            "status": "action_unavailable",
            "message": (
                f"'{clean_id}' is not available in the current app state. "
                "Call list_app_actions for the controls currently available."
            ),
        }

    delegate_id = str(entry.get("delegate_agent_id") or "").strip()
    delegate_tool = _DELEGATE_TOOL_BY_AGENT_ID.get(delegate_id)
    if delegate_tool:
        return {
            "status": "delegated",
            "message": (
                f"'{clean_id}' belongs to a specialist. Call {delegate_tool} "
                "with the user's request instead."
            ),
            "use_tool": delegate_tool,
        }

    # Screen-reachability guard (defense in depth): if the action declares the
    # screens it lives on and the user is NOT on one of them, refuse rather than
    # park a directive for a control that isn't on screen. This is what stops
    # One from, e.g., trying to run phone verification while the user is on the
    # setup hub. Actions with no declared screens are screen-agnostic (global
    # navigation) and always allowed; if we don't know the current screen we
    # cannot judge reachability, so we allow.
    current_screen = str(tool_context.state.get(_STATE_SCREEN) or "").strip()
    action_screens = {
        str(s).strip() for s in ((entry.get("scope") or {}).get("screens") or []) if str(s).strip()
    }
    if (
        current_screen
        and action_screens
        and current_screen not in action_screens
        and not is_navigation_action(entry)
    ):
        label = str(entry.get("label") or clean_id)
        where = sorted(action_screens)[0]
        logger.info("one_adk_action_decision action=%s status=wrong_screen", clean_id)
        return {
            "status": "wrong_screen",
            "message": (
                f"{label} isn't available on the current screen; it lives on "
                f"the {where} screen. Run the matching route action to open "
                "that screen first."
            ),
            "reachable_screens": sorted(action_screens),
        }

    activation_policy = str(entry.get("activation_policy") or "none")
    missing = _missing_required_slot(entry, clean_slots)
    if missing is not None:
        logger.info("one_adk_action_decision action=%s status=input_needed", clean_id)
        return {
            "status": "input_needed",
            "missing_slot": missing["slot"],
            "message": missing["prompt"],
        }

    directive_payload: dict[str, Any] = {"actionId": clean_id, "slots": clean_slots}
    if policy == "confirm_required" or activation_policy == "trusted_activation_required":
        directive_payload["needsConfirmation"] = True
        if activation_policy == "trusted_activation_required":
            directive_payload["trustedActivationRequired"] = True
        tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:{clean_id}"] = {
            "kind": "action",
            "payload": directive_payload,
        }
        logger.info("one_adk_action_decision action=%s status=confirm_pending", clean_id)
        return {
            "status": "confirm_pending",
            "message": (
                f"The app will present the exact {label} action for a trusted tap."
                if activation_policy == "trusted_activation_required"
                else f"The app will ask the user to confirm {label}."
            ),
        }

    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:{clean_id}"] = {
        "kind": "action",
        "payload": directive_payload,
    }
    logger.info("one_adk_action_decision action=%s status=ok", clean_id)
    return {
        "status": "ok",
        "message": f"Running {label}.",
        "action_id": clean_id,
        # Proactive-prompting: like open_screen, this text is the tool
        # RESULT the model reads on its next turn - there is no separate
        # server-injected system turn after a tool call. Nudging here means
        # One offers a next step after every governed action it runs, not
        # only after an onboarding screen change.
        "next_step": (
            "Wait for the correlated browser action settlement before saying "
            f"{label} completed. Then acknowledge only the reported outcome "
            "and, if there is an obvious next step, offer it before waiting to "
            "be asked."
        ),
    }


def _context_revision(tool_context: ToolContext) -> str:
    context = tool_context.state.get(_STATE_VOICE_CONTEXT)
    if not isinstance(context, dict):
        return ""
    return str(context.get("context_revision") or "").strip()[:128]


async def start_app_goal(
    action_id: str, slots: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    """Start a generated cross-surface app goal.

    This is intentionally narrower than ``run_app_action``: direct actions
    remain bound to mounted controls. Today the only cross-surface goal is
    stock analysis, which must navigate to Analysis, receive a fresh bounded
    context, and then open its preview (never start a debate automatically).
    """
    clean_id = str(action_id or "").strip()
    if clean_id != "analysis.start":
        return await run_app_action(clean_id, slots, tool_context)
    entry = get_action_gateway_action(clean_id)
    if entry is None or str((entry.get("goal") or {}).get("goal_id") or "") != _ANALYSIS_GOAL_ID:
        return {"status": "unknown_action", "message": "Stock analysis is not available."}
    symbol = str((slots or {}).get("symbol") or "").strip().upper()
    if not symbol:
        return {
            "status": "input_needed",
            "missing_slot": "symbol",
            "message": "Which stock should I analyze?",
        }
    context = tool_context.state.get(_STATE_VOICE_CONTEXT)
    if not isinstance(context, dict) or context.get("context_pending") is True:
        return {
            "status": "context_not_ready",
            "message": "The app is still publishing its screen state. Please try again in a moment.",
        }
    if context.get("pending_settlement") is True:
        return {
            "status": "settling",
            "message": "The previous action is still settling. Wait for the fresh screen state.",
        }

    current_screen = str(context.get("screen") or "")
    run = {
        "schema_version": "one.goal_run.v1",
        "goal_id": _ANALYSIS_GOAL_ID,
        "action_id": clean_id,
        # Ticker and pick source are non-sensitive, bounded action slots.
        "slots": {
            "symbol": symbol,
            "pickSource": str((slots or {}).get("pickSource") or "default")[:32],
        },
        "step_cursor": 0,
        "expected_screen": "kai_analysis",
        "expected_context_revision": _context_revision(tool_context),
        "status": "awaiting_analysis_context",
    }
    tool_context.state[_STATE_GOAL_RUN] = run
    if current_screen == "kai_analysis":
        return await continue_app_goal(tool_context)

    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:goal:{_ANALYSIS_GOAL_ID}"] = {
        "kind": "action",
        "payload": {
            "actionId": "route.kai_analysis",
            "slots": {},
            "goalId": _ANALYSIS_GOAL_ID,
            "goalRun": run,
        },
    }
    return {
        "status": "navigation_started",
        "message": "Opening Analysis, then I will prepare the stock preview.",
        "goal_id": _ANALYSIS_GOAL_ID,
    }


async def continue_app_goal(tool_context: ToolContext) -> dict[str, Any]:
    """Continue the single generated goal after route settlement/context refresh."""
    run = tool_context.state.get(_STATE_GOAL_RUN)
    if not isinstance(run, dict) or run.get("goal_id") != _ANALYSIS_GOAL_ID:
        return {"status": "no_active_goal", "message": "There is no app goal waiting to continue."}
    context = tool_context.state.get(_STATE_VOICE_CONTEXT)
    if not isinstance(context, dict) or context.get("context_pending") is True:
        return {"status": "settling", "message": "Waiting for fresh Analysis context."}
    if (
        context.get("pending_settlement") is True
        or str(context.get("screen") or "") != "kai_analysis"
    ):
        return {"status": "settling", "message": "Waiting for the Analysis screen to settle."}
    expected_revision = str(run.get("expected_context_revision") or "")
    current_revision = _context_revision(tool_context)
    if (
        expected_revision
        and current_revision
        and expected_revision == current_revision
        and run.get("step_cursor") == 0
    ):
        return {"status": "settling", "message": "Waiting for a fresh Analysis context."}

    slots = run.get("slots") if isinstance(run.get("slots"), dict) else {}
    next_run = {
        **run,
        "step_cursor": 1,
        "expected_context_revision": current_revision,
        "status": "preview_started",
    }
    tool_context.state[_STATE_GOAL_RUN] = next_run
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:goal:{_ANALYSIS_GOAL_ID}:preview"] = {
        "kind": "action",
        "payload": {
            "actionId": "analysis.start",
            "slots": slots,
            "goalId": _ANALYSIS_GOAL_ID,
            "goalRun": next_run,
        },
    }
    return {
        "status": "preview_started",
        "message": "Opening the stock preview. The debate will wait for your confirmation.",
        "goal_id": _ANALYSIS_GOAL_ID,
    }


async def list_app_actions(query: str, tool_context: ToolContext) -> dict[str, Any]:
    """List generated actions that are executable from the active app context.

    ``query`` is preserved for the model-facing tool contract, but is never
    lexically ranked here. Semantic selection belongs to One; this loader only
    projects the generated inventory and the browser's current control set.
    """
    del query
    ranked = sorted(list_action_gateway_actions(), key=lambda entry: str(entry.get("label") or ""))
    available_action_ids = _available_action_ids(tool_context)
    if available_action_ids is not None:
        # Navigation actions stay listable from any screen (matching the
        # run_app_action acceptance rule) so "where can I go" and "go to X"
        # remain answerable even on surfaces with no local controls.
        ranked = [
            entry
            for entry in ranked
            if entry["action_id"] in available_action_ids or is_navigation_action(entry)
        ]
    results = []
    for entry in ranked:
        if (entry.get("execution_target") or {}).get("status") != "wired":
            continue
        delegate_tool = _DELEGATE_TOOL_BY_AGENT_ID.get(str(entry.get("delegate_agent_id") or ""))
        results.append(
            {
                "action_id": entry["action_id"],
                "label": str(entry.get("label") or ""),
                "meaning": str(entry.get("meaning") or ""),
                "policy": str((entry.get("risk") or {}).get("execution_policy") or "allow_direct"),
                **({"use_tool": delegate_tool} if delegate_tool else {}),
            }
        )
    return {
        "status": "ok",
        "total_actions": len(list_action_gateway_actions()),
        "results": results[:_MAX_LIST_RESULTS],
    }
