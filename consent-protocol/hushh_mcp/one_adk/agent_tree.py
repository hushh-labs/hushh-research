"""One's ADK agent tree: head agent + the /one roster as subagent tools.

Architecture (0->1 rebuild of One's orchestration):

- ``one`` is the root :class:`LlmAgent`. It owns identity, tone, and the
  delegation decision. There is exactly ONE decision-maker per turn: ADK's
  own function-calling flow. No parallel lexical re-ranker.
- Every product agent on the /one home grid is a subagent exposed to One as
  a callable tool (specialist turn functions delegating to the existing
  ``adk_bridge`` handlers, which own consent validation and business logic).
- ``google_search`` gives One real web access for fresh public information.
- Session state carries the caller's identity/consent posture; tools read it
  from ``tool_context.state`` so the LLM never sees or supplies credentials.

The roster mirrors hushh-webapp/lib/onboarding/one-capabilities.ts plus the
standalone RIA agent: Finance (Kai internal), RIA, Gmail, Email, Location,
Memory, Consent, Information Marketplace, Connected Systems.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Literal, Optional

from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.tools.google_search_tool import GoogleSearchTool
from google.adk.tools.tool_context import ToolContext

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.dispatch import dispatch, is_wired_specialist
from hushh_mcp.agents.onboarding.agent import (
    OnboardingAssessmentV1,
    OnboardingJourneyContext,
)
from hushh_mcp.agents.onboarding.agent import (
    resolve_onboarding_goal as _resolve_onboarding_goal,
)
from hushh_mcp.one_adk.action_tools import list_app_actions, run_app_action
from hushh_mcp.services.route_orchestration_index import is_one_delegate_admitted
from hushh_mcp.services.voice_action_manifest import get_voice_manifest_action

logger = logging.getLogger(__name__)

ONE_APP_NAME = "hussh_one"

# Session-state keys the relay seeds before the first turn. Tools read them
# via tool_context.state; the model neither sees nor supplies them.
STATE_USER_ID = "hussh:user_id"
# State KEY name, not a credential value (the token itself arrives at runtime).
STATE_CONSENT_TOKEN = "hussh:consent_token"  # noqa: S105
STATE_CONVERSATION_ID = "hussh:conversation_id"
STATE_TIMEZONE = "hussh:timezone"
# Current app screen id (from app_context frames); used to rank action search.
STATE_SCREEN = "hussh:screen"
# Redacted browser state used by action tools to avoid proposing controls the
# current surface did not declare available. It never contains vault content,
# credentials, or raw page text.
STATE_VOICE_CONTEXT = "hussh:voice_context"
# Pending client directive (navigation etc.) the relay forwards to the browser
# after the current event batch; written by tools, cleared by the relay.
STATE_PENDING_DIRECTIVE = "hussh:pending_directive"

# Governed navigation allowlist: screen id -> app route. Mirrors the /one
# roster plus core account surfaces. One can ONLY navigate here; anything
# else is refused by construction.
APP_ROUTES: dict[str, str] = {
    "home": "/one",
    "setup": "/one/setup",
    "finance": "/one/kai",
    "ria": "/ria",
    "gmail": "/one/gmail",
    "email": "/one/kyc",
    "location": "/one/location",
    "personal_data": "/one/pkm",
    "consent": "/consents",
    "marketplace": "/one/marketplace",
    "connected_systems": "/one/connected-systems",
    "profile": "/profile",
}

# Voice head runs the GA native-audio Live model on Vertex ADC (regional
# only; it is NOT published on the global endpoint, so the live client pins
# a region via AGENT_ONE_ADK_LOCATION). Model is env-swappable through
# AGENT_ONE_ADK_MODEL with no code change.
_ONE_MODEL = (os.getenv("AGENT_ONE_ADK_MODEL") or "gemini-live-2.5-flash-native-audio").strip()
_ONE_LIVE_LOCATION = (os.getenv("AGENT_ONE_ADK_LOCATION") or "us-central1").strip()
# All worker agents run the same generation: gemini-3.5-flash.
_SPECIALIST_MODEL = (os.getenv("AGENT_ONE_SPECIALIST_MODEL") or "gemini-3.5-flash").strip()


def _onboarding_goals_enabled(user_id: str) -> bool:
    """Apply the deterministic-goal kill switch and optional user allowlist."""
    if (os.getenv("HUSHH_ONBOARDING_GOALS_DISABLED") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return False
    allowlist = {
        value.strip()
        for value in (os.getenv("HUSHH_ONBOARDING_GOALS_ALLOWLIST") or "").split(",")
        if value.strip()
    }
    return not allowlist or user_id in allowlist


def _build_one_live_model():
    """Live model for One's voice head.

    Wraps the model id in an ADK ``Gemini`` with an explicit regional
    location when running on Vertex, because the native-audio Live model is
    served regionally (us-central1 etc.), not on the global endpoint the
    genai client defaults to.
    """
    from google.adk.models import Gemini

    use_vertex = (os.getenv("GOOGLE_GENAI_USE_VERTEXAI") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    if use_vertex and _ONE_LIVE_LOCATION:
        return Gemini(model=_ONE_MODEL, client_kwargs={"location": _ONE_LIVE_LOCATION})
    return _ONE_MODEL


ONE_IDENTITY_INSTRUCTION = (
    "You are One, the private agent inside Hussh, and the head of a team of "
    "specialist agents. If anyone asks your name or who you are, answer "
    'simply: "I\'m One." Never call yourself Kai, Gemini, or any other name. '
    "You hold the relationship layer: speak warmly, concisely, and in plain "
    "English.\n\n"
    "Visible controls take priority over introductions. Use your intelligence in "
    "the current turn to assess what the person means: whether they are asking "
    "for a visible action, asking about the current screen, continuing the "
    "conversation, or expressing genuine ambiguity. When they clearly ask for "
    "a currently available, low-risk visible control whose exact generated id is "
    "in the active inventory, call run_app_action with that id immediately. Use "
    "list_app_actions only to retrieve bounded generated candidates when the exact "
    "id is uncertain; it is not semantic authority and never decides what the "
    "person meant. Do this before greeting, explaining who "
    "you are, or narrating onboarding. Do not infer controls from page text, "
    "offer actions from another screen, or ask for confirmation when the "
    "generated action policy is allow_direct. After dispatch, do not claim it "
    "worked or describe it as complete until the correlated app action "
    "settlement reports the outcome. Deterministic policy may validate, normalize, "
    "reject, and enforce authority, but it must never replace your semantic "
    "assessment or substitute another action. If meaning is genuinely ambiguous, "
    "ask one natural clarifying question and retain the active goal. If no current "
    "action matches, answer as normal conversation instead of forcing a workflow.\n\n"
    "Conversation comes before workflow. Treat short follow-ups such as 'so what?', "
    "'why?', 'how?', 'tell me more', or 'what do you mean?' as replies to "
    "your immediately preceding statement. Answer their underlying question "
    "directly in one or two concrete sentences before offering any setup step, "
    "tool, or specialist. Never treat a conversational challenge as missing "
    "onboarding input, silence, or an instruction to repeat your introduction.\n\n"
    "Your specialist agents (your arms) and what they own:\n"
    "- Finance: markets, portfolio, stock analysis and debates (internally "
    "the Kai runtime). Its subagents: RIA (the advisor workspace with "
    "clients, picks, and requests) and Investor (personal portfolio "
    "review). Route ALL finance, advisor, and investing requests through "
    "Finance.\n"
    "- Gmail: synced purchase receipts and receipt-sync health.\n"
    "- Email: approval drafts and client request workflows.\n"
    "- Location: live sharing with trusted people and local context.\n"
    "- Memory: saved knowledge the user can review (PKM).\n"
    "- Consent Center (Nav): what the user has shared and with whom, approvals, "
    "and revocations. Its Connections subagent handles the trusted-people "
    "graph itself; both surface in the Consent Center.\n"
    "- Information Marketplace: governed information-slice requests and delivery.\n"
    "- Connected Systems: CRM and external system workflows.\n\n"
    "Delegate naturally: when a request belongs to a specialist's domain, call "
    "that specialist's tool with the user's request. When the user asks to go "
    "somewhere in the app ('take me to profile', 'open location'), call "
    "open_screen; it works from any screen. When the user asks to analyze, "
    "research, or run a debate on a stock or company ('analyze Nvidia'), act "
    "immediately: call run_app_action with action id 'analysis.start' and "
    "slots {'symbol': <ticker>}; ask only when you cannot infer the ticker. "
    "For other app actions (opening a workspace tab, connecting Gmail), call "
    "run_app_action "
    "with the exact action id, using list_app_actions first when unsure. "
    "Actions owned by a specialist must go through that specialist's ask_ "
    "tool; run_app_action will redirect you if needed. Use google_search when "
    "the user needs fresh public information from the web. Answer general "
    "questions yourself. Never invent tool results; if a specialist reports "
    "it cannot act (missing consent, locked vault, no information), relay that "
    "honestly and tell the user what would unlock it. You never execute "
    "sensitive actions directly: specialists validate consent and the app "
    "confirms every state change.\n\n"
    "Guiding a new user through account setup is your job, the same way any "
    "other app action is: setup steps (welcome, sign-in, phone verification, "
    "the setup hub, and the Finance preferences wizard) are reachable through "
    "run_app_action. These steps live on DIFFERENT screens and are not all "
    "available at once. For an explicit request matching a current visible "
    "low-risk setup action, execute the generated action first; the resolver "
    "must never delay or replace that command with identity narration. Call "
    "resolve_onboarding_goal when the person asks what to do next, when input "
    "is missing, or when recovering a setup goal; it returns the bounded next "
    "step and never takes over semantic routing. Pass your typed assessment "
    "fields (intent, candidate action, provider, missing input, ambiguity, and "
    "confidence); never pass or lexically reclassify the raw transcript. Only "
    "ever offer what is reachable on the user's "
    "CURRENT screen. If resolve_onboarding_goal returns selected_action_id, call "
    "run_app_action with that exact id immediately; never turn an explicit Apple "
    "or Google request back into a generic provider question. When the exact "
    "generated id is uncertain, call list_app_actions (it returns only actions "
    "valid for the current screen) and pick from that, rather than naming a "
    "step from another screen. For example, do not bring up phone "
    "verification unless the user is actually on the phone screen. While "
    "someone is still finishing setup, be proactive rather than waiting to be "
    "asked: after you open a screen or complete a step, briefly name ONE next "
    "thing they could do THERE and, if that step needs an answer from them, "
    "ask for it directly instead of just describing it. Never invent what "
    "setup has or has not been completed; rely on the action result or the "
    "app state you are given."
)


def _one_runtime_instruction(context: Any) -> str:
    """Inject bounded server-sanitized route, layer, and action guidance."""
    state = getattr(context, "state", None)
    state_getter = getattr(state, "get", None)
    voice_context = state_getter(STATE_VOICE_CONTEXT) if callable(state_getter) else None
    if not isinstance(voice_context, dict):
        return ONE_IDENTITY_INSTRUCTION

    available_action_ids = voice_context.get("available_action_ids")
    verified_action_ids = (
        [
            str(action_id).strip()
            for action_id in available_action_ids[:18]
            if isinstance(action_id, str) and str(action_id).strip()
        ]
        if isinstance(available_action_ids, list)
        else []
    )

    interaction_layer = voice_context.get("interaction_layer")
    if not isinstance(interaction_layer, dict):
        ui_context = voice_context.get("ui")
        interaction_layer = (
            ui_context.get("interaction_layer") if isinstance(ui_context, dict) else None
        )
    if not isinstance(interaction_layer, dict):
        interaction_layer = None

    def bounded(value: Any, limit: int) -> str:
        return str(value).strip()[:limit] if isinstance(value, str) else ""

    layer_action_ids: list[str] = []
    if interaction_layer is not None:
        raw_layer_action_ids = interaction_layer.get("visible_action_ids")
        if isinstance(raw_layer_action_ids, list):
            layer_action_ids = [
                str(action_id).strip()
                for action_id in raw_layer_action_ids[:10]
                if isinstance(action_id, str) and str(action_id).strip() in verified_action_ids
            ]
        dismiss_action_id = bounded(interaction_layer.get("dismiss_action_id"), 128)
        if dismiss_action_id in verified_action_ids and dismiss_action_id not in layer_action_ids:
            layer_action_ids.append(dismiss_action_id)

    modality = bounded(interaction_layer.get("modality"), 16) if interaction_layer else ""
    underlying_actions_available = bool(
        interaction_layer and interaction_layer.get("underlying_actions_available") is True
    )
    if interaction_layer and modality in {"modal", "blocking"} and not underlying_actions_available:
        prompt_action_ids = layer_action_ids
    else:
        prompt_action_ids = layer_action_ids + [
            action_id for action_id in verified_action_ids if action_id not in layer_action_ids
        ]

    action_lines: list[str] = []
    for action_id in prompt_action_ids[:10]:
        entry = get_voice_manifest_action(str(action_id))
        if entry is None:
            continue
        label = str(entry.get("label") or action_id).strip()[:120]
        action_lines.append(f"- {label} => {entry['action_id']}")
    action_inventory = ""
    if action_lines:
        action_inventory = (
            "\n\nACTIVE EXECUTABLE CONTROLS (generated, verified, and bounded):\n"
            + "\n".join(action_lines)
            + "\nFirst assess meaning semantically. For a clear request matching one "
            "of these controls, call run_app_action with that exact id. A clear "
            "provider request selects its exact Apple or Google action; never "
            "replace it with a generic provider explanation. Use list_app_actions "
            "only to retrieve bounded candidates when the id is uncertain. Do not "
            "call open_screen or google_search instead of a matching current control."
        )

    layer_instruction = ""
    if interaction_layer is not None:
        layer_id = bounded(interaction_layer.get("layer_id"), 96) or "active_layer"
        kind = bounded(interaction_layer.get("kind"), 48) or "interaction"
        lifecycle_state = bounded(interaction_layer.get("lifecycle_state"), 24) or "open"
        continuity = bounded(interaction_layer.get("agent_continuity"), 16) or "interactive"
        visible_control_ids = interaction_layer.get("visible_control_ids")
        controls = (
            [bounded(value, 96) for value in visible_control_ids[:10] if bounded(value, 96)]
            if isinstance(visible_control_ids, list)
            else []
        )
        options = interaction_layer.get("options")
        option_labels: list[str] = []
        if isinstance(options, list):
            for option in options[:8]:
                if isinstance(option, dict):
                    label = bounded(option.get("label"), 96)
                else:
                    label = bounded(option, 96)
                if label:
                    option_labels.append(label)
        layer_instruction = (
            "\n\nACTIVE INTERACTION LAYER (strongest current context; guidance only):\n"
            f"Layer: {layer_id} ({kind}, {modality or 'nonmodal'}, {lifecycle_state})\n"
            f"Agent continuity: {continuity}\n"
            f"Visible controls: {', '.join(controls) if controls else 'none'}\n"
            f"Authored options: {', '.join(option_labels) if option_labels else 'none'}\n"
            "Interpret the person's request against this top layer before route "
            "controls or general narration. A clear exact layer action executes; "
            "genuine ambiguity gets one natural clarification. "
            + (
                "Do not offer or execute controls behind this layer. "
                if modality in {"modal", "blocking"} and not underlying_actions_available
                else "Layer actions rank before any permitted underlying route actions. "
            )
            + "The layer never grants action authority; generated contracts and "
            "runtime guards still validate every proposed action. Never claim success "
            "until the correlated browser settlement reports it."
        )

    playbook = voice_context.get("route_playbook")
    if not isinstance(playbook, dict):
        return ONE_IDENTITY_INSTRUCTION + layer_instruction + action_inventory

    purpose = bounded(playbook.get("purpose"), 480)
    entry_cue = bounded(playbook.get("entry_cue"), 240)
    primary_action = bounded(playbook.get("primary_action_id"), 128)
    completion = bounded(playbook.get("completion_boundary"), 480)
    out_of_scope = bounded(playbook.get("out_of_scope_behavior"), 480)
    return (
        ONE_IDENTITY_INSTRUCTION
        + layer_instruction
        + "\n\nACTIVE ROUTE PLAYBOOK (guidance only; never authority):\n"
        + f"Purpose: {purpose or 'Use the verified current screen.'}\n"
        + f"Entry cue: {entry_cue or 'Remain ambient until the person speaks.'}\n"
        + f"Primary generated action reference: {primary_action or 'none'}\n"
        + f"Completion boundary: {completion or 'Wait for browser settlement.'}\n"
        + f"Out-of-scope behavior: {out_of_scope or 'Answer naturally without inventing controls.'}\n"
        + "The generated action gateway, current available actions, and runtime guards "
        + "remain the only execution authority."
        + action_inventory
    )


async def resolve_onboarding_goal(
    tool_context: ToolContext,
    intent: Literal[
        "execute_visible_action",
        "confirm_visible_action",
        "answer_current_page",
        "answer_conversationally",
        "ask_clarifying_question",
        "provide_input",
        "recover",
        "next_step",
    ] = "next_step",
    candidate_action_id: str = "",
    provider: Literal["google", "apple", "none"] = "none",
    missing_input: str = "",
    ambiguous: bool = False,
    confidence: float = 1.0,
    assessment_source: Literal["one", "agent_onboarding"] = "one",
) -> dict[str, Any]:
    """Validate One's typed semantic assessment against redacted journey state.

    Anonymous sign-in guidance must not pass through consent-gated A2A. This
    policy tool receives meaning from One's current ADK turn, reads only the
    bounded live context, and returns a goal that browser/gateway guards still
    independently validate and execute.
    """
    assessment_started_at = time.perf_counter()
    voice_context = tool_context.state.get(STATE_VOICE_CONTEXT)
    if not isinstance(voice_context, dict):
        voice_context = {}
    onboarding = voice_context.get("onboarding")
    if not isinstance(onboarding, dict):
        onboarding = {}
    user_id = str(tool_context.state.get(STATE_USER_ID) or "").strip()
    if not _onboarding_goals_enabled(user_id):
        return {
            "status": "disabled",
            "message": "Onboarding goals are not enabled for this session.",
        }
    consent_token = str(tool_context.state.get(STATE_CONSENT_TOKEN) or "").strip()
    phase = str(onboarding.get("phase") or "anonymous_auth")
    # One's current ADK turn supplies semantic fields. The deterministic layer
    # validates them but never reclassifies the request with keywords.
    try:
        assessment = OnboardingAssessmentV1.model_validate(
            {
                "source": assessment_source,
                "intent": intent,
                "candidate_action_id": candidate_action_id or None,
                "provider": None if provider == "none" else provider,
                "missing_input": missing_input or None,
                "ambiguous": ambiguous,
                "confidence": confidence,
            }
        )
    except ValueError:
        return {
            "status": "invalid_assessment",
            "message": "I need to clarify the next onboarding step before acting.",
        }
    context_payload = {
        "phase": phase,
        "authenticated": bool(user_id),
        "phone_verified": onboarding.get("phone_verified"),
        "vault_state": "unlocked" if consent_token else ("locked" if user_id else "absent"),
        "active_capability": onboarding.get("active_capability"),
        "root_resolved": onboarding.get("root_resolved") is True,
        "return_route": onboarding.get("return_route") or "/one/setup",
        "callback_state": onboarding.get("callback_state") or "none",
        "available_action_ids": voice_context.get("available_action_ids") or [],
        "setup_capability_ids": onboarding.get("setup_capability_ids") or [],
        "screen": str(tool_context.state.get(STATE_SCREEN) or "unknown"),
        "assessment": assessment.model_dump(),
    }
    try:
        context = OnboardingJourneyContext.model_validate(context_payload)
    except ValueError:
        return {
            "status": "invalid_context",
            "message": "The app has not supplied a usable onboarding state yet.",
        }
    goal = _resolve_onboarding_goal(context)
    logger.info(
        "one_onboarding_assessment",
        extra={
            "assessment_source": assessment.source,
            "assessment_intent": assessment.intent,
            "assessment_status": goal.assessment_status,
            "assessment_reason": goal.reason_code or "none",
            "assessment_action_id": goal.selected_action_id or "none",
            "assessment_screen": context.screen,
            "assessment_phase": goal.phase,
            "assessment_latency_ms": round(
                (time.perf_counter() - assessment_started_at) * 1000,
                3,
            ),
        },
    )
    return {"status": "ok", "goal": goal.model_dump()}


def _task_from_context(tool_context: ToolContext, request: str) -> Optional[A2ATask]:
    """Build a specialist task from governed session state.

    Returns None when the session has no authenticated user context, in which
    case the tool reports a consent boundary instead of calling the specialist.
    """
    state = tool_context.state
    user_id = str(state.get(STATE_USER_ID) or "").strip()
    consent_token = str(state.get(STATE_CONSENT_TOKEN) or "").strip()
    if not user_id or not consent_token:
        return None
    conversation_id = str(state.get(STATE_CONVERSATION_ID) or "").strip() or None
    timezone_name = str(state.get(STATE_TIMEZONE) or "").strip() or None
    return A2ATask(
        user_id=user_id,
        consent_token=consent_token,
        conversation_id=conversation_id,
        message=request,
        timezone=timezone_name,
    )


async def _specialist_turn(
    agent_id: str, request: str, tool_context: ToolContext
) -> dict[str, Any]:
    """Run one governed specialist turn through the existing A2A dispatch."""
    # Importing adk_bridge registers the built-in specialists at import time.
    import hushh_mcp.adk_bridge  # noqa: F401 - side-effect registration

    if not is_wired_specialist(agent_id):
        return {
            "status": "unavailable",
            "message": f"The {agent_id} specialist is not available right now.",
        }
    voice_context = tool_context.state.get(STATE_VOICE_CONTEXT)
    route_family = (
        str(voice_context.get("route_family") or "").strip()
        if isinstance(voice_context, dict)
        else ""
    )
    admission = is_one_delegate_admitted(route_family, agent_id)
    if admission is False:
        return {
            "status": "route_not_admitted",
            "message": (
                "That specialist is not available from the current route. "
                "Open its declared workspace first; consent and TrustLink "
                "checks still apply after route admission."
            ),
        }
    task = _task_from_context(tool_context, request)
    if task is None:
        return {
            "status": "needs_auth",
            "message": (
                "This needs the user to be signed in with an unlocked vault. "
                "Invite them to sign in or unlock first."
            ),
        }
    try:
        result = await dispatch(agent_id, task)
    except PermissionError as exc:
        return {"status": "consent_denied", "message": str(exc)}
    except Exception:  # noqa: BLE001 - specialist failures must not kill the session
        logger.exception("one_adk.specialist_turn_failed agent_id=%s", agent_id)
        return {
            "status": "error",
            "message": "The specialist hit an internal error on that request.",
        }
    if result.conversation_id:
        tool_context.state[STATE_CONVERSATION_ID] = result.conversation_id
    payload: dict[str, Any] = {
        "status": "ok",
        "text": result.text,
        "is_complete": result.is_complete,
    }
    if not result.is_complete:
        # Proactive next step: an incomplete turn means the specialist is
        # waiting on the user; tell One to relay exactly that.
        payload["next_step"] = (
            "The specialist needs a reply from the user. Relay its question "
            "and send the user's answer back through this same tool."
        )
    if result.directive is not None:
        directive = {
            "kind": result.directive.kind,
            "payload": result.directive.payload,
            # Which specialist this came from, so voice can route the directive
            # to the same audited confirmation surface chat uses (the relay
            # only forwards opaque directive JSON; it doesn't know delegates).
            "delegateAgentId": agent_id,
        }
        payload["directive"] = directive
        # Park it in state so the relay forwards it to the client for execution.
        tool_context.state[STATE_PENDING_DIRECTIVE] = directive
        if result.directive.kind == "prompt":
            payload["next_step"] = (
                "The app is showing the user a choice card. Tell the user to pick an option there."
            )
    return payload


async def open_screen(screen: str, tool_context: ToolContext) -> dict[str, Any]:
    """Legacy non-live navigation helper.

    Live One sessions must use a generated action currently published by the
    browser. Keeping this compatibility tool fail-closed in a live session
    prevents it from bypassing route, setup, and visible-control authority.
    """
    voice_context = tool_context.state.get(STATE_VOICE_CONTEXT)
    if isinstance(voice_context, dict) and voice_context.get("route_family"):
        return {
            "status": "action_required",
            "message": (
                "Use one of the generated actions available on the current screen; "
                "I cannot navigate around its controls directly."
            ),
        }
    key = str(screen or "").strip().lower().replace("-", "_").replace(" ", "_")
    route = APP_ROUTES.get(key)
    if not route:
        return {
            "status": "unknown_screen",
            "message": f"'{screen}' is not a screen I can open.",
            "valid_screens": sorted(APP_ROUTES),
        }
    tool_context.state[STATE_PENDING_DIRECTIVE] = {
        "kind": "navigate",
        "payload": {"route": route, "screen": key},
    }
    return {
        "status": "ok",
        "message": f"Opening {key.replace('_', ' ')}.",
        "route": route,
        # Proactive-prompting: this text becomes the tool RESULT the model
        # reads on its next turn (there is no separate server-injected
        # system turn for tool results, unlike the greeting/screen-change
        # notes in adk_live.py). Nudging here means One offers a next step
        # after every screen it opens, not only after onboarding-tagged
        # screen changes.
        "next_step": "Wait for route settlement before describing the next step.",
    }


async def ask_email_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Email specialist about inbox tasks, approval drafts, or client request workflows."""
    return await _specialist_turn("agent_email", request, tool_context)


async def ask_gmail_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Gmail specialist about synced purchase receipts, spending at merchants, or receipt sync status."""
    return await _specialist_turn("agent_gmail", request, tool_context)


async def ask_location_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Location specialist about live location sharing with trusted people, check-ins, or SOS."""
    return await _specialist_turn("agent_location", request, tool_context)


async def ask_marketplace_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Information Marketplace specialist about data-slice subscriptions, requests, and approvals."""
    return await _specialist_turn("agent_personal_information", request, tool_context)


async def ask_connected_systems_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Connected Systems specialist about CRM records and external system workflows."""
    return await _specialist_turn("agent_connected_systems", request, tool_context)


async def ask_consent_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Consent Center; Nav delegates trusted-people work to Connections."""
    return await _specialist_turn("agent_nav", request, tool_context)


def _build_ria_agent() -> LlmAgent:
    """RIA subagent of Finance: advisor workspace persona."""
    return LlmAgent(
        name="ria",
        model=_SPECIALIST_MODEL,
        description="RIA subagent: the advisor workspace with clients, picks, and requests.",
        instruction=(
            "You are RIA, the advisor-workspace subagent of Finance. Help "
            "with advisor workflows: clients, picks, and requests. Workspace "
            "mutations are governed app actions confirmed by the app."
        ),
    )


def _build_investor_agent() -> LlmAgent:
    """Investor subagent of Finance: personal investing analysis persona."""
    return LlmAgent(
        name="investor",
        model=_SPECIALIST_MODEL,
        description=(
            "Investor subagent: personal portfolio review and stock-analysis "
            "framing for the account holder."
        ),
        instruction=(
            "You are Investor, the personal-investing subagent of Finance. "
            "Answer portfolio and stock questions from provided context. "
            "Analysis runs and trades are governed app actions confirmed by "
            "the app; explain what the user can start, never claim you "
            "executed anything."
        ),
    )


def _build_finance_agent() -> LlmAgent:
    """Finance head (the internal Kai runtime) with RIA + Investor subagents.

    Kai is the ONE finance decision-maker under One. RIA (advisor workspace)
    and Investor (personal investing) are its subagents, reached through
    Finance rather than as One-level siblings. Finance turns run through the
    Kai chat/analysis services; the debate engine itself stays a governed app
    goal (the app confirms and renders runs), so this agent answers
    market/portfolio questions and frames the governed next step rather than
    claiming execution.
    """
    from google.adk.tools.agent_tool import AgentTool

    return LlmAgent(
        name="finance",
        model=_SPECIALIST_MODEL,
        description=(
            "Finance specialist: markets, portfolio context, stock analysis "
            "framing, advisor (RIA) and personal-investing (Investor) "
            "subagents. Internally the Kai runtime."
        ),
        instruction=(
            "You are Finance, One's markets and portfolio specialist (the Kai "
            "runtime internally). Answer market and portfolio questions from "
            "provided context. Consult your subagents when the request is "
            "clearly theirs: 'ria' for advisor workspace matters (clients, "
            "picks, requests) and 'investor' for the user's personal "
            "portfolio review. Analysis runs and trades are governed app "
            "actions confirmed by the app; explain what the user can start, "
            "never claim you executed anything."
        ),
        tools=[
            AgentTool(agent=_build_ria_agent()),
            AgentTool(agent=_build_investor_agent()),
        ],
    )


def _one_roster_tools() -> list:
    """The full /one specialist roster, shared by every One head.

    AgentTool wraps the LLM-backed specialists (Finance, RIA) so One can
    consult them as tools; the dispatch-backed specialists (email, location,
    connections, marketplace, connected systems, consent) are plain function
    tools that call the existing governed adk_bridge handlers.

    Uses GoogleSearchTool(bypass_multi_tools_limit=True) rather than the bare
    google_search function-tool. Binding Gemini's native google_search
    directly alongside this many custom function/agent tools in the SAME
    LlmAgent.tools=[...] list is unstable on google-adk 2.4.0 (verified in
    hushh-search-console's adk_runtime.py via 15+ live trials: redundant
    tool calls, intermittent TaskGroup errors, occasional full timeouts).
    bypass_multi_tools_limit=True makes LlmAgent's own tool conversion wrap
    google_search as an isolated per-call sub-agent turn (a
    GoogleSearchAgentTool with propagate_grounding_metadata=True), which ADK
    itself maintains and which still propagates real grounding metadata
    (search queries + grounding chunks with real URLs) back onto One's own
    event stream - so voice/chat answers keep real citations, not just a
    plain summarized string. That isolated search turn is text-only, so it
    MUST use the text specialist model rather than inherit One's native-audio
    Live model: native-audio models are valid for BidiGenerateContent, not
    the nested GenerateContent turn ADK uses for this tool.
    """
    from google.adk.tools.agent_tool import AgentTool

    return [
        GoogleSearchTool(
            bypass_multi_tools_limit=True,
            model=_SPECIALIST_MODEL,
        ),
        open_screen,
        resolve_onboarding_goal,
        run_app_action,
        list_app_actions,
        AgentTool(agent=_build_finance_agent()),
        ask_email_agent,
        ask_gmail_agent,
        ask_location_agent,
        ask_marketplace_agent,
        ask_connected_systems_agent,
        ask_consent_agent,
    ]


def build_one_root_agent() -> LlmAgent:
    """Build the One VOICE head (native-audio Live model) with the full roster."""
    return LlmAgent(
        name="one",
        model=_build_one_live_model(),
        description="One, the Hussh head private agent and orchestrator.",
        instruction=_one_runtime_instruction,
        tools=_one_roster_tools(),
    )


def build_one_text_agent() -> LlmAgent:
    """Build the One TEXT head: same brain, same tools, text model.

    Used by non-audio entries (external A2A today; chat when it migrates).
    The Live native-audio model rejects text-only run_async turns, so text
    surfaces run the specialist-generation model with the identical
    instruction and roster - ONE decision-maker, two transport heads.
    """
    return LlmAgent(
        name="one",
        model=_SPECIALIST_MODEL,
        description="One, the Hussh head private agent and orchestrator.",
        instruction=ONE_IDENTITY_INSTRUCTION,
        tools=_one_roster_tools(),
    )


_runner: Runner | None = None


def get_one_runner() -> Runner:
    """Process-wide Runner for One (in-memory sessions; voice sessions are
    ephemeral and the durable record lives in the app's own stores).

    SCALE SEAM (Agent Architecture Doctrine, AGENTS.md): InMemorySessionService
    means a mid-conversation reconnect that lands on another worker/instance
    starts with zero context, and session count is bounded by one process's
    memory. The documented upgrade is ADK's DatabaseSessionService on the
    existing Postgres (asyncpg driver, SELECT FOR UPDATE row locking) for
    resumable voice sessions; swap here, contract unchanged. Gate that swap on
    a voice-session write-load measurement against the DB pool budget.
    """
    global _runner
    if _runner is None:
        _runner = Runner(
            app_name=ONE_APP_NAME,
            agent=build_one_root_agent(),
            session_service=InMemorySessionService(),
            auto_create_session=True,
        )
    return _runner


_text_runner: Runner | None = None


def get_one_text_runner() -> Runner:
    """Process-wide Runner for One's text head (external A2A, future chat).

    Sessions are per-request ephemeral today; the same DatabaseSessionService
    scale seam documented on get_one_runner applies here when multi-turn
    external conversations need durability.
    """
    global _text_runner
    if _text_runner is None:
        _text_runner = Runner(
            app_name=ONE_APP_NAME,
            agent=build_one_text_agent(),
            session_service=InMemorySessionService(),
            auto_create_session=True,
        )
    return _text_runner
