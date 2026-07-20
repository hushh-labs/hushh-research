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


def _settled_journey_definition(entry: dict[str, Any], action_id: str) -> dict[str, Any] | None:
    """Return a validated, authored two-stage journey for ``action_id``.

    Generated contracts may describe many goal shapes.  This runtime only
    treats the deliberately small ``action -> destination choice`` form as a
    deferred journey.  Everything else stays on the legacy direct-action path
    until it has an equally explicit runtime contract.
    """
    goal = entry.get("goal")
    if not isinstance(goal, dict):
        return None
    goal_id = str(goal.get("goal_id") or "").strip()
    steps = goal.get("workflow_steps")
    if not goal_id or not isinstance(steps, list) or len(steps) < 2:
        return None
    initial = steps[0] if isinstance(steps[0], dict) else {}
    choice = steps[1] if isinstance(steps[1], dict) else {}
    settlement_target = initial.get("settlement_target")
    choice_action_ids = choice.get("action_ids")
    if (
        initial.get("type") != "action"
        or str(initial.get("action_id") or "") != action_id
        or not isinstance(settlement_target, dict)
        or not str(settlement_target.get("route") or "").strip()
        or not str(settlement_target.get("screen") or "").strip()
        or choice.get("type") != "choice"
        or not isinstance(choice_action_ids, list)
    ):
        return None
    choices = [
        str(value).strip()
        for value in choice_action_ids
        if isinstance(value, str) and str(value).strip()
    ]
    if not choices:
        return None
    return {
        "goal_id": goal_id,
        "settlement_target": {
            "route": str(settlement_target["route"]).strip(),
            "screen": str(settlement_target["screen"]).strip(),
        },
        "choice_action_ids": choices,
        "carry_explicit_choice": choice.get("carry_explicit_choice") is True,
    }


def _deferred_choice(
    slots: dict[str, Any], journey: dict[str, Any]
) -> tuple[dict[str, Any], str | None]:
    """Separate the volatile next-screen choice from normal action slots."""
    clean_slots = {
        key: value for key, value in (slots or {}).items() if key != "deferred_action_id"
    }
    raw = (slots or {}).get("deferred_action_id")
    deferred_action_id = str(raw or "").strip() or None
    if deferred_action_id and deferred_action_id not in journey["choice_action_ids"]:
        return clean_slots, ""
    return clean_slots, deferred_action_id


async def _start_settled_journey(
    action_id: str,
    slots: dict[str, Any],
    tool_context: ToolContext,
    entry: dict[str, Any],
    journey: dict[str, Any],
) -> dict[str, Any]:
    """Execute one current action and park only an eligible destination choice."""
    action_slots, deferred_action_id = _deferred_choice(slots, journey)
    if deferred_action_id == "":
        return {
            "status": "invalid_choice",
            "message": "That next-screen choice is not authorized by this journey.",
        }
    if deferred_action_id and not journey["carry_explicit_choice"]:
        return {
            "status": "invalid_choice",
            "message": "This journey does not carry a choice between screens.",
        }

    result = await run_app_action(action_id, action_slots, tool_context)
    if result.get("status") not in {"ok", "confirm_pending"}:
        return result

    pending_key = f"{_STATE_PENDING_DIRECTIVE}:{action_id}"
    pending = tool_context.state.get(pending_key)
    if not isinstance(pending, dict) or not isinstance(pending.get("payload"), dict):
        # A direct action must create the same generated directive it would
        # outside a journey.  Never invent a second browser transport path.
        return {
            "status": "settling",
            "message": "The current action is preparing. Wait for its browser directive.",
        }

    run = {
        "schema_version": "one.settled_action_journey.v1",
        "journey_id": journey["goal_id"],
        "goal_id": journey["goal_id"],
        "source_action_id": action_id,
        "settlement_target": journey["settlement_target"],
        "choice_action_ids": journey["choice_action_ids"],
        # This is the sole carried user intent. It is an already-authored id,
        # never speech, slots, a credential, or a durable workflow record.
        "deferred_action_id": deferred_action_id,
        "source_context_revision": _context_revision(tool_context),
        "status": "awaiting_destination_context",
    }
    tool_context.state[_STATE_GOAL_RUN] = run
    tool_context.state[pending_key] = {
        **pending,
        "payload": {
            **pending["payload"],
            "goalId": journey["goal_id"],
            "goalRun": run,
        },
    }
    return {
        "status": "journey_started",
        "message": "Opening the next screen before continuing.",
        "goal_id": journey["goal_id"],
        "deferred_choice": bool(deferred_action_id),
    }


async def start_app_goal(
    action_id: str, slots: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    """Start a generated cross-surface app goal.

    Direct actions remain bound to mounted controls.  Explicit generated
    journeys add exactly one safe continuation: execute a current-screen
    action, wait for its authored destination context, then make a named
    destination action eligible.  No planner or alternate browser executor is
    introduced here.
    """
    clean_id = str(action_id or "").strip()
    entry = get_action_gateway_action(clean_id)
    if entry is not None:
        journey = _settled_journey_definition(entry, clean_id)
        if journey is not None:
            return await _start_settled_journey(clean_id, slots, tool_context, entry, journey)
    if clean_id != "analysis.start":
        return await run_app_action(clean_id, slots, tool_context)
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


async def _continue_settled_journey(
    run: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    """Make an authored choice eligible only on its accepted destination."""
    context = tool_context.state.get(_STATE_VOICE_CONTEXT)
    if not isinstance(context, dict) or context.get("context_pending") is True:
        return {"status": "settling", "message": "Waiting for the destination screen."}
    expected = run.get("settlement_target")
    expected = expected if isinstance(expected, dict) else {}
    if (
        context.get("pending_settlement") is True
        or str(context.get("route_pattern") or "") != str(expected.get("route") or "")
        or str(context.get("screen") or "") != str(expected.get("screen") or "")
    ):
        tool_context.state[_STATE_GOAL_RUN] = None
        return {
            "status": "journey_interrupted",
            "message": "The destination changed, so the pending choice was cleared.",
        }
    source_revision = str(run.get("source_context_revision") or "")
    current_revision = _context_revision(tool_context)
    if source_revision and source_revision == current_revision:
        return {"status": "settling", "message": "Waiting for fresh destination context."}
    available = _available_action_ids(tool_context) or set()
    allowed_choices = {
        str(value).strip()
        for value in (run.get("choice_action_ids") or [])
        if isinstance(value, str) and str(value).strip()
    }
    if not allowed_choices or not allowed_choices.issubset(available):
        tool_context.state[_STATE_GOAL_RUN] = None
        return {
            "status": "journey_interrupted",
            "message": "The destination does not expose this journey's authorized choices.",
        }
    deferred_action_id = str(run.get("deferred_action_id") or "").strip()
    if not deferred_action_id:
        tool_context.state[_STATE_GOAL_RUN] = None
        return {
            "status": "choice_needed",
            "message": "The destination is ready. Ask the person to choose one available option.",
            "action_ids": sorted(allowed_choices),
        }
    # Clear before issuing the confirmation directive. The action itself still
    # performs current-surface and trusted-activation validation.
    tool_context.state[_STATE_GOAL_RUN] = None
    return await run_app_action(deferred_action_id, {}, tool_context)


async def continue_app_goal(tool_context: ToolContext) -> dict[str, Any]:
    """Continue an authored goal only after fresh route context has settled."""
    run = tool_context.state.get(_STATE_GOAL_RUN)
    if isinstance(run, dict) and run.get("schema_version") == "one.settled_action_journey.v1":
        return await _continue_settled_journey(run, tool_context)
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
