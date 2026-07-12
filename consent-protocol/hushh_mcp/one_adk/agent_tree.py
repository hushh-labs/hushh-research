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
from typing import Any, Optional

from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.tools.google_search_tool import GoogleSearchTool
from google.adk.tools.tool_context import ToolContext

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.dispatch import dispatch, is_wired_specialist
from hushh_mcp.one_adk.action_tools import list_app_actions, run_app_action

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
    "You are One, the personal agent inside Hussh, and the head of a team of "
    "specialist agents. If anyone asks your name or who you are, answer "
    'simply: "I\'m One." Never call yourself Kai, Gemini, or any other name. '
    "You hold the relationship layer: speak warmly, concisely, and in plain "
    "English.\n\n"
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
    "- Consent (Nav): what the user has shared and with whom, approvals, "
    "revocations, and the user's trusted connections. The Connections "
    "specialist handles the trusted-people graph itself; both surface in "
    "the consent center (Connections tab).\n"
    "- Information Marketplace: governed data-slice requests and delivery.\n"
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
    "it cannot act (missing consent, locked vault, no data), relay that "
    "honestly and tell the user what would unlock it. You never execute "
    "sensitive actions directly: specialists validate consent and the app "
    "confirms every state change.\n\n"
    "Guiding a new user through account setup is your job, the same way any "
    "other app action is: setup steps (welcome, sign-in, phone verification, "
    "the setup hub, and the Finance preferences wizard) are reachable through "
    "run_app_action. These steps live on DIFFERENT screens and are not all "
    "available at once. Only ever offer what is reachable on the user's "
    "CURRENT screen: call list_app_actions first (it returns only actions "
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
    """Navigate the app to a screen. Valid screens: home, setup, finance, ria,
    gmail, email, location, personal_data, consent, marketplace,
    connected_systems, profile. Works from anywhere in the app. Use 'setup' to
    take the user back to the account setup hub to continue onboarding other
    capabilities after finishing one."""
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
        "next_step": (
            f"Once you land on {key.replace('_', ' ')}, briefly say what the "
            "person can do here and, if there's an obvious next action, offer "
            "it before waiting for them to ask."
        ),
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


async def ask_connections_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Connections specialist about the user's trusted people and connection requests."""
    return await _specialist_turn("agent_connections", request, tool_context)


async def ask_marketplace_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Information Marketplace specialist about data-slice subscriptions, requests, and approvals."""
    return await _specialist_turn("agent_personal_information", request, tool_context)


async def ask_connected_systems_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Connected Systems specialist about CRM records and external system workflows."""
    return await _specialist_turn("agent_connected_systems", request, tool_context)


async def ask_consent_agent(request: str, tool_context: ToolContext) -> dict[str, Any]:
    """Ask the Consent specialist (Nav) what the user has shared, with whom, and how to revoke it."""
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
    plain summarized string.
    """
    from google.adk.tools.agent_tool import AgentTool

    return [
        GoogleSearchTool(bypass_multi_tools_limit=True),
        open_screen,
        run_app_action,
        list_app_actions,
        AgentTool(agent=_build_finance_agent()),
        ask_email_agent,
        ask_gmail_agent,
        ask_location_agent,
        ask_connections_agent,
        ask_marketplace_agent,
        ask_connected_systems_agent,
        ask_consent_agent,
    ]


def build_one_root_agent() -> LlmAgent:
    """Build the One VOICE head (native-audio Live model) with the full roster."""
    return LlmAgent(
        name="one",
        model=_build_one_live_model(),
        description="One, the Hussh head personal agent and orchestrator.",
        instruction=ONE_IDENTITY_INSTRUCTION,
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
        description="One, the Hussh head personal agent and orchestrator.",
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
