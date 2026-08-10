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
import re
from typing import Any

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.services.action_gateway import (
    get_action_gateway_action,
    is_navigation_action,
    list_action_gateway_actions,
)
from hushh_mcp.services.live_voice_context import read_live_voice_context

logger = logging.getLogger(__name__)

# Session state keys shared with agent_tree/adk_live (duplicated string to
# avoid a circular import; guarded by a test asserting equality).
_STATE_PENDING_DIRECTIVE = "hussh:pending_directive"
_STATE_SCREEN = "hussh:screen"
_STATE_VOICE_CONTEXT = "hussh:voice_context"
_STATE_GOAL_RUN = "hussh:goal_run"

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
_MAX_QUERY_TOKENS = 8
# On-screen actions a queried call may keep for context after the real matches.
_MAX_QUERY_FILLER = 4
# Words that appear in almost every spoken request and would otherwise pull
# unrelated actions to the front of a bounded result list.
_QUERY_STOPWORDS = frozenset(
    {
        "the",
        "a",
        "an",
        "my",
        "me",
        "i",
        "you",
        "can",
        "could",
        "would",
        "please",
        "for",
        "to",
        "of",
        "on",
        "in",
        "at",
        "and",
        "or",
        "is",
        "it",
        "this",
        "that",
        "with",
        "do",
        "does",
        "want",
        "need",
        "get",
        "show",
        "let",
        "us",
        "we",
        "how",
        "what",
        "one",
    }
)
# Prefer what One can act on now when relevance ties.
_AVAILABILITY_ORDER = {
    "on_screen": 0,
    "journey": 1,
    "navigate_first": 2,
}


def _voice_context(tool_context: ToolContext) -> Any:
    """The freshest sanitized browser context available to this tool.

    ``run_live`` opens one long invocation per socket, so ``tool_context.state``
    is frozen at connect time: after a navigation the relay knows the new
    screen while every tool still reads the screen the person was on when they
    started talking. A cross-screen journey could therefore never continue, and
    each retry re-read the same stale value instead of converging.

    Prefer the relay's live publication, keyed by this session, and fall back
    to session state for non-live callers (typed chat, tests) which have no
    socket and no staleness problem.
    """
    session_id = getattr(getattr(tool_context, "session", None), "id", None)
    live = read_live_voice_context(session_id) if session_id else None
    if isinstance(live, dict):
        return live
    return tool_context.state.get(_STATE_VOICE_CONTEXT)


def _available_action_ids(tool_context: ToolContext) -> set[str] | None:
    """Return the browser-declared executable ids when live context exists.

    The browser may publish arbitrary descriptive metadata, but action ids are
    filtered against the generated gateway before reaching this state. An
    absent context preserves compatibility for non-live callers; a present but
    empty list deliberately means no executable controls are available.
    """
    context = _voice_context(tool_context)
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

    context = _voice_context(tool_context)
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
            # Guide mode: manual_only is not a dead end. State the guidance once
            # and hand off -- the next [App route context] note (already
            # re-injected on any visible_modules/interaction_layer change,
            # regardless of action) is the existing, generic signal that the
            # person acted; resume narrating from there.
            "next_step": (
                "Tell the person exactly what to do, then wait silently. Do not "
                "repeat this guidance and do not propose an alternate action. "
                "When a fresh [App route context] note arrives, that is your "
                "signal the person acted -- resume narrating the next step from "
                "its available action inventory."
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
        # A journey entry action is legitimately off-screen right now, but it is
        # not out of reach: start_app_goal navigates to its authored destination
        # first. Say so, instead of reporting a dead end the model can only
        # answer by falling back to plain navigation.
        if _is_journey_startable(entry):
            logger.info("one_adk_action_decision action=%s status=use_start_app_goal", clean_id)
            return {
                "status": "use_start_app_goal",
                "message": (
                    f"'{clean_id}' is not on this screen, but it is a journey. "
                    "Call start_app_goal with this exact action id and its "
                    "required slots; it will open the right screen first."
                ),
            }
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

    if clean_id == "kyc.draft.request_redraft":
        instruction = clean_slots.get("instruction")
        instruction = instruction.strip() if isinstance(instruction, str) else ""
        if not instruction or len(instruction) > 1000:
            return {
                "status": "input_needed",
                "missing_slot": "instruction",
                "message": "How should I revise the current response draft?",
            }
        # This action admits one bounded model slot only. Workflow IDs, draft
        # bodies, exports, and scopes are resolved by the mounted KYC handler.
        clean_slots = {"instruction": instruction}

    # A model-selected action is a proposal, never user activation. Every
    # generated app action, including navigation, waits for an explicit tap in
    # chat or voice. The gateway still enforces the authored risk policy.
    directive_payload: dict[str, Any] = {
        "actionId": clean_id,
        "slots": clean_slots,
        "needsConfirmation": True,
        "trustedActivationRequired": True,
    }
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
        "action_id": clean_id,
        # Proactive-prompting: like open_screen, this text is the tool
        # RESULT the model reads on its next turn - there is no separate
        # server-injected system turn after a tool call. Nudging here means
        # One offers a next step after every governed action it runs, not
        # only after an onboarding screen change.
        "next_step": (
            "Wait for explicit confirmation and the correlated browser action "
            "settlement before saying "
            f"{label} completed. Then acknowledge only the reported outcome "
            "and, if there is an obvious next step, offer it before waiting to "
            "be asked."
        ),
    }


def _context_revision(tool_context: ToolContext) -> str:
    context = _voice_context(tool_context)
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


_JOURNEY_SLOT_MAX_CHARS = 64


def _journey_slots(entry: dict[str, Any], slots: dict[str, Any]) -> dict[str, Any]:
    """Bounded slot values for a journey run, per the action's goal contract.

    Only slots the generated contract declares survive, so a journey can never
    carry arbitrary model-authored state across a navigation. Values are
    trimmed and length-capped; declared defaults fill an omitted slot.
    """
    raw_goal = entry.get("goal")
    goal: dict[str, Any] = raw_goal if isinstance(raw_goal, dict) else {}
    raw_schema = goal.get("slot_schema")
    schema: dict[str, str] = (
        {str(key): str(value) for key, value in raw_schema.items()}
        if isinstance(raw_schema, dict)
        else {}
    )
    defaults: dict[str, Any] = {}
    for spec in goal.get("required_inputs") or []:
        if not isinstance(spec, dict):
            continue
        slot_name = str(spec.get("slot") or spec.get("name") or "").strip()
        if not slot_name:
            continue
        schema.setdefault(slot_name, str(spec.get("resolver") or ""))
        if spec.get("default_value") not in (None, ""):
            defaults[slot_name] = spec["default_value"]

    resolved: dict[str, Any] = {}
    for slot_name, resolver in schema.items():
        name = slot_name.strip()
        if not name:
            continue
        raw = (slots or {}).get(name)
        if raw in (None, ""):
            raw = defaults.get(name)
        if raw in (None, ""):
            continue
        value = str(raw).strip()[:_JOURNEY_SLOT_MAX_CHARS]
        # The contract names the resolver, so normalization stays declared
        # rather than hardcoded per action. A ticker is canonically uppercase.
        if resolver == "ticker_symbol":
            value = value.upper()
        resolved[name] = value
    return resolved


def _navigation_action_for_route(route: str) -> str | None:
    """The wired ``route.*`` action that opens ``route``, if one exists.

    A navigate-then-execute journey is only real when One actually has a
    generated way to reach the destination. Resolving it from the gateway --
    rather than naming one in code -- is what keeps the journey authored in
    the contract. Sorted so the choice is deterministic when a route has more
    than one navigation action.
    """
    clean_route = str(route or "").strip()
    if not clean_route:
        return None
    candidates: list[str] = []
    for candidate in list_action_gateway_actions():
        action_id = str(candidate.get("action_id") or "").strip()
        if not action_id.startswith("route."):
            continue
        target = candidate.get("execution_target") or {}
        if target.get("path") != "route" or target.get("status") != "wired":
            continue
        if str(target.get("target") or "").strip() == clean_route:
            candidates.append(action_id)
    return sorted(candidates)[0] if candidates else None


def _navigation_journey_definition(entry: dict[str, Any], action_id: str) -> dict[str, Any] | None:
    """Return an authored navigate-then-execute journey for ``action_id``.

    The complement of ``_settled_journey_definition``: that shape runs an
    action HERE and then offers a choice where it lands, while this one
    navigates to an authored destination FIRST and runs the action there.

    Both are declared entirely by the generated contract. This one is a single
    ``action`` step naming itself plus the ``settlement_target`` it needs to be
    standing on. Adding a second journey is therefore a contract edit, not a
    code change -- which is the whole point: this path used to be a literal
    ``if action_id != "analysis.start"``, so the app could only ever have one.
    """
    if action_id.startswith("route."):
        # Navigation actions already ARE the navigation. Wrapping one in a
        # journey would make it navigate to itself.
        return None
    goal = entry.get("goal")
    if not isinstance(goal, dict):
        return None
    goal_id = str(goal.get("goal_id") or "").strip()
    steps = goal.get("workflow_steps")
    if not goal_id or not isinstance(steps, list) or len(steps) != 1:
        return None
    step = steps[0] if isinstance(steps[0], dict) else {}
    settlement_target = step.get("settlement_target")
    if (
        step.get("type") != "action"
        or str(step.get("action_id") or "") != action_id
        or not isinstance(settlement_target, dict)
    ):
        return None
    route = str(settlement_target.get("route") or "").strip()
    screen = str(settlement_target.get("screen") or "").strip()
    if not route or not screen:
        return None
    navigation_action_id = _navigation_action_for_route(route)
    if not navigation_action_id:
        return None
    return {
        "goal_id": goal_id,
        "destination_route": route,
        "destination_screen": screen,
        "navigation_action_id": navigation_action_id,
        "label": str(step.get("label") or "").strip(),
    }


def _is_journey_startable(entry: dict[str, Any]) -> bool:
    """True when ``start_app_goal`` can begin this action from ANY screen.

    This deliberately mirrors ``start_app_goal``'s own two accepted paths so
    discovery can never advertise an action the runtime would then refuse: an
    authored two-stage journey, or an authored navigate-then-execute journey.
    Every other action still falls through to ``run_app_action``, which
    correctly requires the control to be mounted on the current screen.

    Without this, a journey's own entry action was unlistable from anywhere
    except the screen it already lives on -- so One could never discover that
    "analyze Nvidia" had a real cross-screen path, and settled for the plain
    route.* navigation it could see instead.
    """
    action_id = str(entry.get("action_id") or "").strip()
    if not action_id:
        return False
    if _settled_journey_definition(entry, action_id) is not None:
        return True
    return _navigation_journey_definition(entry, action_id) is not None


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
    if result.get("status") == "use_start_app_goal":
        # We ARE start_app_goal. Forwarding its "call start_app_goal" redirect
        # would bounce the model straight back here forever, so collapse it to
        # the honest terminal status: this journey's own first step is not
        # mounted on the current screen, so the journey cannot begin.
        return {
            "status": "action_unavailable",
            "message": (
                f"'{action_id}' cannot start from this screen. "
                "Call list_app_actions for the controls currently available."
            ),
        }
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
    navigation_journey = (
        _navigation_journey_definition(entry, clean_id) if entry is not None else None
    )
    if navigation_journey is None:
        return await run_app_action(clean_id, slots, tool_context)
    goal_id = navigation_journey["goal_id"]
    destination_screen = navigation_journey["destination_screen"]
    missing = _missing_required_slot(entry or {}, slots or {})
    if missing is not None:
        return {
            "status": "input_needed",
            "missing_slot": missing["slot"],
            "message": missing["prompt"],
        }
    journey_slots = _journey_slots(entry or {}, slots or {})
    context = _voice_context(tool_context)
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
    # Asking for the action while already ON its destination needs no
    # navigation, so there is no incoming context to wait for.
    already_on_destination = current_screen == destination_screen
    run = {
        "schema_version": "one.goal_run.v1",
        "goal_id": goal_id,
        "action_id": clean_id,
        # Bounded, non-sensitive action slots declared by the action's own
        # generated goal contract. Nothing outside that schema is carried.
        "slots": journey_slots,
        "step_cursor": 0,
        "expected_screen": destination_screen,
        # This revision exists so continue_app_goal refuses to act on the
        # OUTGOING screen's context after a navigation. With no navigation,
        # stamping the current revision made that guard compare the value
        # against itself and settle forever -- "analyse Nvidia" from the
        # Analysis tab could never start, and retrying could never clear it
        # because nothing was coming to change the revision. Leaving it empty
        # stands the guard down for exactly the case it does not police.
        "expected_context_revision": (
            "" if already_on_destination else _context_revision(tool_context)
        ),
        "status": "awaiting_destination_screen",
    }
    tool_context.state[_STATE_GOAL_RUN] = run
    if already_on_destination:
        return await continue_app_goal(tool_context)

    navigation_action_id = navigation_journey["navigation_action_id"]
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:goal:{goal_id}"] = {
        "kind": "action",
        "payload": {
            "actionId": navigation_action_id,
            "slots": {},
            "goalId": goal_id,
            "goalRun": run,
        },
    }
    # This navigation is indistinguishable from a bare route.* directive in the
    # relay log -- both surface as the same route action. Without this line
    # there is no way to tell "One started the journey" from "One just
    # navigated and gave up", which is exactly the failure being chased.
    logger.info(
        "one_adk_goal_decision goal=%s action=%s status=navigation_started",
        goal_id,
        clean_id,
    )
    return {
        "status": "navigation_started",
        "message": (
            f"Opening the {destination_screen.replace('_', ' ')} screen, then I will continue."
        ),
        "goal_id": goal_id,
    }


async def _continue_settled_journey(
    run: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    """Make an authored choice eligible only on its accepted destination."""
    context = _voice_context(tool_context)
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
    # Every outcome below is logged with a distinct reason. A stalled journey
    # ("it opened Analysis and then nothing happened") is indistinguishable
    # from a never-started one in the relay log, because both end at the same
    # route.kai_analysis settlement. The reason tag is what separates "One
    # never continued" from "One continued but the screen was not ready yet".
    if (
        not isinstance(run, dict)
        or run.get("schema_version") != "one.goal_run.v1"
        or not str(run.get("goal_id") or "").strip()
    ):
        logger.info("one_adk_goal_decision status=no_active_goal")
        return {"status": "no_active_goal", "message": "There is no app goal waiting to continue."}
    goal_id = str(run["goal_id"])
    journey_action_id = str(run.get("action_id") or "").strip()
    destination_screen = str(run.get("expected_screen") or "").strip()
    context = _voice_context(tool_context)
    if not isinstance(context, dict) or context.get("context_pending") is True:
        logger.info("one_adk_goal_decision status=settling reason=context_pending")
        return {"status": "settling", "message": "Waiting for fresh destination context."}
    if (
        context.get("pending_settlement") is True
        or str(context.get("screen") or "") != destination_screen
    ):
        logger.info(
            "one_adk_goal_decision status=settling reason=screen_not_settled screen=%s",
            str(context.get("screen") or "")[:64],
        )
        return {"status": "settling", "message": "Waiting for the destination screen to settle."}
    expected_revision = str(run.get("expected_context_revision") or "")
    current_revision = _context_revision(tool_context)
    if (
        expected_revision
        and current_revision
        and expected_revision == current_revision
        and run.get("step_cursor") == 0
    ):
        logger.info("one_adk_goal_decision status=settling reason=stale_context_revision")
        return {"status": "settling", "message": "Waiting for a fresh destination context."}

    # The preview is minted exactly once per goal. Without this, every later
    # continue_app_goal call re-minted a fresh analysis.start directive: the
    # staleness guard above only inspects step_cursor 0, so once the preview
    # had started there was nothing left to stop the loop, and the person got
    # a new confirmation card every turn while none of them could complete.
    if run.get("step_cursor", 0) >= 1:
        logger.info("one_adk_goal_decision goal=%s status=preview_already_open", goal_id)
        return {
            "status": "preview_already_open",
            "message": (
                "This journey's step is already open on the screen. Ask the person "
                "to confirm it there; do not start another one."
            ),
            "goal_id": goal_id,
        }

    slots = run.get("slots") if isinstance(run.get("slots"), dict) else {}
    next_run = {
        **run,
        "step_cursor": 1,
        "expected_context_revision": current_revision,
        "status": "preview_started",
    }
    tool_context.state[_STATE_GOAL_RUN] = next_run
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:goal:{goal_id}:preview"] = {
        "kind": "action",
        "payload": {
            "actionId": journey_action_id,
            "slots": slots,
            "goalId": goal_id,
            "goalRun": next_run,
        },
    }
    logger.info(
        "one_adk_goal_decision goal=%s action=%s status=preview_started",
        goal_id,
        journey_action_id,
    )
    return {
        "status": "preview_started",
        "message": (
            "The journey's step is open on the screen. It waits for the person's confirmation."
        ),
        "goal_id": goal_id,
    }


def _query_tokens(query: str) -> list[str]:
    """Lowercase word tokens from a model query, bounded and deduplicated."""
    tokens: list[str] = []
    for raw in re.split(r"[^a-z0-9]+", str(query or "").lower()):
        token = raw.strip()
        if len(token) < 2 or token in _QUERY_STOPWORDS or token in tokens:
            continue
        tokens.append(token)
        if len(tokens) >= _MAX_QUERY_TOKENS:
            break
    return tokens


def _relevance_score(entry: dict[str, Any], tokens: list[str]) -> int:
    """Rank one action against the query's tokens.

    Purely lexical, over fields the contract already authors for this purpose
    (aliases and search_keywords exist precisely so a person's words can find
    an action). One still makes the final choice; this only decides which
    actions get to be in front of it, because the result list is bounded and
    an alphabetical slice is not a search.
    """
    if not tokens:
        return 0
    action_id = str(entry.get("action_id") or "").lower()
    label = str(entry.get("label") or "").lower()
    meaning = str(entry.get("meaning") or "").lower()
    aliases = [str(value).lower() for value in (entry.get("aliases") or [])]
    keywords = [str(value).lower() for value in (entry.get("search_keywords") or [])]

    score = 0
    joined = " ".join(tokens)
    if joined and joined in aliases:
        score += 90
    for token in tokens:
        if token in action_id:
            score += 25
        if token in label:
            score += 20
        if any(token in alias for alias in aliases):
            score += 15
        if token in keywords:
            score += 12
        if token in meaning:
            score += 5
    return score


def _reachability(
    entry: dict[str, Any],
    action_id: str,
    available_action_ids: set[str] | None,
) -> tuple[str, str | None]:
    """How One could actually reach ``action_id`` from where it is standing.

    Discovery is not authority: ``run_app_action`` still refuses anything the
    browser has not declared. What this adds is an honest next step, so an
    off-screen answer becomes "open X first" instead of a dead end.
    """
    if available_action_ids is None or action_id in available_action_ids:
        return "on_screen", None
    if is_navigation_action(entry):
        return "on_screen", None
    if _is_journey_startable(entry):
        return "journey", None
    for route in (entry.get("reachability") or {}).get("routes") or []:
        navigation_action_id = _navigation_action_for_route(str(route))
        if navigation_action_id:
            return "navigate_first", navigation_action_id
    return "unreachable_from_here", None


async def list_app_actions(query: str, tool_context: ToolContext) -> dict[str, Any]:
    """List generated actions One can reach from the active app context.

    Semantic selection still belongs to One, but the result list is bounded:
    without ranking, One saw an alphabetical prefix of the catalog and simply
    could not know that most of the app existed. ``query`` now decides which
    actions occupy those slots, and a queried call may surface actions that
    live on other screens -- each carrying how to reach it.

    Execution authority is unchanged. Everything here is still filtered by the
    generated manifest, and ``run_app_action`` still refuses any action the
    browser has not declared on the current screen.
    """
    tokens = _query_tokens(query)
    available_action_ids = _available_action_ids(tool_context)
    candidates: list[tuple[int, int, str, dict[str, Any], str, str | None]] = []
    for entry in list_action_gateway_actions():
        if (entry.get("execution_target") or {}).get("status") != "wired":
            continue
        action_id = str(entry.get("action_id") or "")
        if not action_id:
            continue
        availability, open_first = _reachability(entry, action_id, available_action_ids)
        score = _relevance_score(entry, tokens)
        if availability == "unreachable_from_here":
            continue
        # An unqueried call is "what can I do here" -- answer with this screen
        # rather than the whole app. Only an actual query opens the catalog,
        # and then only to actions the query matched.
        if availability not in {"on_screen", "journey"} and (not tokens or score <= 0):
            continue
        candidates.append(
            (
                -score,
                _AVAILABILITY_ORDER.get(availability, 9),
                str(entry.get("label") or ""),
                entry,
                availability,
                open_first,
            )
        )

    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    if tokens:
        # A queried call padded to the cap with whatever happened to be on
        # screen buries the two or three actions that actually answered the
        # question. Keep some on-screen context, but never at the cost of a
        # match: a short relevant list beats a full mostly-irrelevant one.
        matched = [item for item in candidates if item[0] < 0]
        filler = [item for item in candidates if item[0] == 0][:_MAX_QUERY_FILLER]
        candidates = matched + filler
    selected = candidates[:_MAX_LIST_RESULTS]
    results = []
    for _, _, _, entry, availability, open_first in selected:
        delegate_tool = _DELEGATE_TOOL_BY_AGENT_ID.get(str(entry.get("delegate_agent_id") or ""))
        # Always name the tool; never leave it to be inferred. A delegate wins
        # (it owns the turn), then a journey (start_app_goal opens the right
        # screen first), and everything else runs through run_app_action.
        #
        # Leaving it unset for ordinary actions left One to guess, and it
        # guessed the action id WAS the tool. ADK then raised "Tool
        # 'analysis.open_summary_tab' not found", which escaped the live flow
        # and killed the relay pump -- one bad guess dropped the whole call.
        # An action id and a tool name are different kinds of thing, so every
        # result now says which one it is holding.
        use_tool = delegate_tool or (
            "start_app_goal" if _is_journey_startable(entry) else "run_app_action"
        )
        results.append(
            {
                "action_id": entry["action_id"],
                "label": str(entry.get("label") or ""),
                "meaning": str(entry.get("meaning") or ""),
                # Read from the action's own field. This used to read a `risk`
                # object that is null on every generated action, so all 117
                # reported as allow_direct -- One was told that 23 manual_only
                # and 8 confirm_required actions needed no confirmation.
                "policy": str(entry.get("execution_policy") or "allow_direct"),
                "availability": availability,
                **({"use_tool": use_tool} if use_tool else {}),
                **({"open_first_action_id": open_first} if open_first else {}),
            }
        )
    return {
        "status": "ok",
        "total_actions": len(list_action_gateway_actions()),
        "results": results,
    }
