"""Control-plane chat orchestration for the One Location agent (v1 + v2).

Runs a Gemini function-calling loop restricted to the control-plane tools,
executed INSIDE a HushhContext so each @hushh_tool enforces consent scope
(DB-backed, via validate_token_with_db). Reuses AgentChatService for durable,
encrypted conversation persistence.

Why not HushhAgent / Google ADK execution: that wrapper (hushh_adk/core.py)
targets an ADK API incompatible with the pinned google-adk (wrong import path,
no synchronous .run(), wrong constructor field) and silently falls back to a
stub that raises — it has never executed. We therefore call the backend's
server-side Gemini client (operons.kai.llm) directly. Consent is fully preserved
because the tool callables themselves validate scope against the active
HushhContext; this service only opens that context around the tool loop.

Coordinate safety: the control-plane tools never read or return coordinates,
so neither the prompt, the tool results fed back to Gemini, nor the reply ever
carries lat/lng.

v2 additions:
- Wider tool set (create_location_share, approve_location_request, propose_public_link,
  propose_location_view, list_incoming_location_shares, list_public_links,
  revoke_public_link).
- Directive translation: successful grant-creating / propose tool calls produce a
  coordinate-free ``clientAction`` descriptor returned to the browser.
- Action-result turn: deterministic confirmation (no LLM, no coordinates) for
  ``action_result`` payloads sent back by the browser after the user acts.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable
from uuid import uuid4

from hushh_mcp.agents.location.agent import get_location_chat_agent_v2
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.agent_chat_service import get_agent_chat_service

logger = logging.getLogger(__name__)

_MAX_HISTORY = 12

# Keys that must never appear in the human-readable selection display string.
# Includes opaque id keys and every coordinate-variant key name.
_NON_DISPLAY_REF_KEYS = {
    "recipientUserId",
    "recipientKeyId",
    "grantId",
    "latitude",
    "longitude",
    "coordinates",
    "lat",
    "lng",
    "lon",
    "accuracyM",
}
_MAX_TOOL_STEPS = 5
_LLM_TIMEOUT_S = 30.0
_HISTORY_CHARS = 2000

# Tools that only read state — invoking them should NOT trigger a UI refresh.
# propose_* tools only stage a client action; they mutate nothing server-side.
_QUERY_TOOL_NAMES = {
    "list_location_recipients",
    "list_active_location_shares",
    "list_incoming_location_shares",
    "list_public_links",
    "propose_public_link",
    "propose_location_view",
    "propose_sos_panic",
    "propose_check_in",
    "request_recipient_choice",
    "request_active_share_choice",
    "request_duration_choice",
    "request_request_choice",
    "request_incoming_choice",
    "request_confirmation",
}

# Tools whose successful result produces a client-action directive.
_DIRECTIVE_GRANT_TOOLS = {"create_location_share", "approve_location_request"}

# Prompt-builder tools: their result yields a clientPrompt, and they mutate nothing.
_PROMPT_TOOL_NAMES = {
    "request_recipient_choice",
    "request_active_share_choice",
    "request_duration_choice",
    "request_request_choice",
    "request_incoming_choice",
    "request_confirmation",
}

_ACTION_RESULT_TEMPLATES = {
    ("publish_share", "completed"): "Done — your live location is now shared. ✓",
    ("publish_share", "cancelled"): "No problem — I didn't share your location.",
    ("view_envelope", "completed"): "Here's the latest location I could open.",
    ("create_public_link", "completed"): "Your public location link is ready.",
    ("create_public_link", "cancelled"): "Okay — I didn't create a public link.",
    ("sos_panic", "completed"): "SOS sent — your emergency contacts are being notified.",
    ("sos_panic", "cancelled"): "Okay — I didn't send an SOS.",
    ("check_in", "completed"): "Done — your trusted contacts can see your check-in. ✓",
    ("check_in", "cancelled"): "Okay — I didn't check you in.",
}

_UNAVAILABLE_MESSAGE = (
    "The location assistant is temporarily unavailable. Please try again, or use "
    "the controls on this page to manage your sharing."
)
_GAVE_UP_MESSAGE = (
    "I couldn't finish that — please try rephrasing, or use the controls on this "
    "page to manage your sharing."
)

# model call seam: (contents, config) -> Gemini response. Injectable for tests.
ModelCall = Callable[[Any, Any], Awaitable[Any]]


def _function_declarations(types: Any) -> list:
    """Function declarations for the 6 v1 control-plane tools (no crypto-handoff)."""
    schema = types.Schema
    kind = types.Type
    return [
        types.FunctionDeclaration(
            name="list_location_recipients",
            description=(
                "List the people who can currently see the user's live location and "
                "the verified people eligible to receive it. Read-only."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "limit": schema(type=kind.INTEGER, description="Max recipients to return")
                },
                required=[],
            ),
        ),
        types.FunctionDeclaration(
            name="list_active_location_shares",
            description=(
                "List the user's active outgoing live-location shares with their grant "
                "ids and recipient names. Call this FIRST to get a real grant_id before "
                "revoking or referring — never guess an id. Read-only."
            ),
            parameters=schema(type=kind.OBJECT, properties={}, required=[]),
        ),
        types.FunctionDeclaration(
            name="revoke_location_share",
            description=(
                "Stop sharing the user's live location for one active share. "
                "grant_id MUST come from list_active_location_shares — never invent it."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "grant_id": schema(type=kind.STRING, description="Active grant id to revoke")
                },
                required=["grant_id"],
            ),
        ),
        types.FunctionDeclaration(
            name="request_location_access",
            description=(
                "Ask another user to share their live location with the current user. "
                "This only sends a request; it never grants access."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "owner_user_id": schema(type=kind.STRING, description="User to ask"),
                    "message": schema(type=kind.STRING, description="Optional note"),
                },
                required=["owner_user_id"],
            ),
        ),
        types.FunctionDeclaration(
            name="deny_location_request",
            description="Deny a pending incoming location-access request. request_id identifies the request.",
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "request_id": schema(type=kind.STRING, description="Pending request id")
                },
                required=["request_id"],
            ),
        ),
        types.FunctionDeclaration(
            name="refer_location_recipient",
            description="Refer another verified user into an owner approval request.",
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "grant_id": schema(type=kind.STRING),
                    "referred_user_id": schema(type=kind.STRING),
                    "message": schema(type=kind.STRING, description="Optional note"),
                },
                required=["grant_id", "referred_user_id"],
            ),
        ),
    ]


def _function_declarations_v2(types: Any) -> list:
    """v1 control-plane declarations + v2 prep/intent/read/control declarations."""
    schema = types.Schema
    kind = types.Type
    decls = _function_declarations(types)
    decls.extend(
        [
            types.FunctionDeclaration(
                name="create_location_share",
                description=(
                    "Create a recipient-bound live-location grant (no coordinates). "
                    "recipient_user_id and recipient_key_id MUST come from "
                    "list_location_recipients. After this, the browser captures and "
                    "encrypts the location."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "recipient_user_id": schema(type=kind.STRING),
                        "recipient_key_id": schema(type=kind.STRING),
                        "duration_hours": schema(type=kind.NUMBER, description="0 < hours <= 24"),
                        "reason": schema(type=kind.STRING, description="Optional note"),
                    },
                    required=["recipient_user_id", "recipient_key_id", "duration_hours"],
                ),
            ),
            types.FunctionDeclaration(
                name="approve_location_request",
                description=(
                    "Approve a pending incoming request and create a recipient-scoped "
                    "grant. request_id MUST come from looking up pending requests."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "request_id": schema(type=kind.STRING),
                        "duration_hours": schema(type=kind.NUMBER, description="0 < hours <= 24"),
                    },
                    required=["request_id", "duration_hours"],
                ),
            ),
            types.FunctionDeclaration(
                name="list_incoming_location_shares",
                description=(
                    "List active shares where the user is the recipient (grant ids + "
                    "owner names). Call FIRST before proposing to view a location. Read-only."
                ),
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="list_public_links",
                description=(
                    "List the user's active public location links (ids + expiry). Call "
                    "FIRST before revoking a public link. Read-only."
                ),
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="propose_public_link",
                description=(
                    "Propose an owner-confirmed public link valid for duration_hours. "
                    "The browser creates it after explicit confirmation."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "duration_hours": schema(type=kind.NUMBER, description="0 < hours <= 24")
                    },
                    required=["duration_hours"],
                ),
            ),
            types.FunctionDeclaration(
                name="propose_location_view",
                description=(
                    "Propose viewing an incoming share's latest location. grant_id MUST "
                    "come from list_incoming_location_shares. The browser decrypts it."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={"grant_id": schema(type=kind.STRING)},
                    required=["grant_id"],
                ),
            ),
            types.FunctionDeclaration(
                name="revoke_public_link",
                description=(
                    "Revoke an active public location link. invite_id MUST come from "
                    "list_public_links."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={"invite_id": schema(type=kind.STRING)},
                    required=["invite_id"],
                ),
            ),
            types.FunctionDeclaration(
                name="request_recipient_choice",
                description=(
                    "Ask the user to choose who to share with (returns selectable options). "
                    "Call when no single recipient was named. When the user DID name a person "
                    "but more than one contact matches that name (e.g. two 'Neelesh Meena'), "
                    "pass `name` with the name they gave so the options are limited to just "
                    "those matches instead of the whole directory."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "name": schema(
                            type=kind.STRING,
                            description=(
                                "The name the user gave, used to limit the choices to matching "
                                "contacts. Omit only when the user named no one."
                            ),
                        )
                    },
                    required=[],
                ),
            ),
            types.FunctionDeclaration(
                name="request_active_share_choice",
                description="Ask the user which active share(s) to stop (selectable options incl. 'Stop all'). Call when stopping a share with no single target.",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_duration_choice",
                description="Ask the user how long a share should last (1/8/24h or custom).",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_request_choice",
                description="Ask the user which pending incoming request to act on.",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_incoming_choice",
                description="Ask the user whose incoming shared location to view.",
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="request_confirmation",
                description="Ask the user to confirm an irreversible or bulk action before it runs.",
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "summary": schema(type=kind.STRING, description="What to confirm"),
                        "destructive": schema(type=kind.BOOLEAN),
                    },
                    required=["summary"],
                ),
            ),
            types.FunctionDeclaration(
                name="propose_sos_panic",
                description=(
                    "Propose an emergency SOS broadcast to all of the user's ready trusted "
                    "contacts. The browser creates 8h grants per recipient, encrypts, "
                    "publishes, and records the incident. Coordinate-free. Call "
                    "request_confirmation first before proposing this."
                ),
                parameters=schema(type=kind.OBJECT, properties={}, required=[]),
            ),
            types.FunctionDeclaration(
                name="propose_check_in",
                description=(
                    "Propose a check-in: share live location with the user's ready "
                    "trusted contacts for duration_hours (0<h<=24) with an optional note. "
                    "The browser creates grants per recipient, encrypts, and publishes. "
                    "Coordinate-free. Ask for the duration first (request_duration_choice)."
                ),
                parameters=schema(
                    type=kind.OBJECT,
                    properties={
                        "duration_hours": schema(type=kind.NUMBER, description="0 < hours <= 24"),
                        "note": schema(type=kind.STRING, description="Optional short note"),
                    },
                    required=["duration_hours"],
                ),
            ),
        ]
    )
    return decls


def _history_contents(history: list[Any], types: Any) -> list:
    contents: list = []
    for message in history[-_MAX_HISTORY:]:
        role = getattr(message, "role", "")
        if role not in ("user", "assistant"):
            continue
        genai_role = "user" if role == "user" else "model"
        text = (getattr(message, "content", "") or "")[:_HISTORY_CHARS]
        contents.append(types.Content(role=genai_role, parts=[types.Part(text=text)]))
    return contents


def _as_response_dict(result: Any) -> dict:
    return result if isinstance(result, dict) else {"result": result}


def _selection_seed_text(selection_result: dict) -> str:
    """Coordinate-free instruction the agent acts on for a selection turn."""
    if str(selection_result.get("status")) == "cancelled":
        return "I changed my mind — cancel that, take no action."
    free = selection_result.get("free_text") or selection_result.get("freeText")
    if free:
        return str(free)
    if str(selection_result.get("kind")) == "confirm":
        return "Yes, go ahead." if selection_result.get("confirmed") else "No, do not proceed."
    selected = selection_result.get("selected") or []
    parts = [
        "; ".join(f"{k}={v}" for k, v in ref.items()) for ref in selected if isinstance(ref, dict)
    ]
    refs = " | ".join(parts)
    return f"I selected: {refs}. Use exactly these ids — do not guess — and proceed."


def _selection_display_text(selection_result: dict) -> str:
    """Human-readable, coordinate-free summary of the user's choice for the UI chip.

    Prefers a frontend-supplied ``display`` label (which knows the friendly names).
    Falls back to option values (never the raw id seed) so a missing label never
    leaks ``recipientUserId=…`` into the transcript.
    """
    if str(selection_result.get("status")) == "cancelled":
        return "Cancelled"
    display = selection_result.get("display")
    if isinstance(display, str) and display.strip():
        return display.strip()
    free = selection_result.get("free_text") or selection_result.get("freeText")
    if free:
        return str(free)
    if str(selection_result.get("kind")) == "confirm":
        return "Confirmed" if selection_result.get("confirmed") else "Declined"
    selected = selection_result.get("selected") or []
    labels: list[str] = []
    for ref in selected:
        if not isinstance(ref, dict):
            continue
        # Show human-facing values only; skip opaque id keys and coordinate keys.
        for key, value in ref.items():
            if key in _NON_DISPLAY_REF_KEYS:
                continue
            labels.append(str(value))
    return ", ".join(labels) if labels else "Your selection"


class LocationChatService:
    def __init__(
        self,
        *,
        chat_store: Any = None,
        model_call: ModelCall | None = None,
        genai_types: Any = None,
        ready: Callable[[], bool] | None = None,
        tools: list | None = None,
        system_prompt: str | None = None,
    ) -> None:
        self._chat_store = chat_store if chat_store is not None else get_agent_chat_service()

        if model_call is not None:
            self._model_call = model_call
            self._types = genai_types
            self._ready = ready or (lambda: True)
        else:
            from hushh_mcp.operons.kai import llm as _llm

            self._types = genai_types or _llm.types
            self._ready = ready or _llm._require_gemini_ready

            async def _default_call(contents: Any, config: Any) -> Any:
                return await asyncio.wait_for(
                    _llm._gemini_client.aio.models.generate_content(
                        model=_llm._gemini_model_name,
                        contents=contents,
                        config=config,
                    ),
                    timeout=_LLM_TIMEOUT_S,
                )

            self._model_call = _default_call

        # System prompt + tool set come from the control-plane agent definition.
        # Default to the v2 agent when neither prompt nor tools are injected.
        need_agent = system_prompt is None or tools is None
        agent = get_location_chat_agent_v2() if need_agent else None
        self._system_prompt = (
            system_prompt if system_prompt is not None else agent.manifest.system_instruction
        )
        tool_list = tools if tools is not None else agent.hushh_tools
        self._dispatch = {getattr(t, "_name", getattr(t, "__name__", "")): t for t in tool_list}

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None = None,
        consent_token: str,
        conversation_id: str | None = None,
        action_result: dict | None = None,
        selection_result: dict | None = None,
    ) -> dict[str, Any]:
        # Branch: action-result confirmation turn (deterministic, no LLM, no coords).
        if action_result is not None:
            return await self._handle_action_result(
                user_id=user_id,
                conversation_id=conversation_id,
                action_result=action_result,
            )
        if selection_result is not None:
            return await self._handle_selection_result(
                user_id=user_id,
                consent_token=consent_token,
                conversation_id=conversation_id,
                selection_result=selection_result,
            )

        if not message:
            # Nothing to do; return a prompt shape rather than calling the model.
            return {
                "conversationId": conversation_id or "",
                "response": "Tell me what you'd like to do with your location sharing.",
                "isComplete": True,
                "stateChanged": False,
            }

        turn = await self._chat_store.prepare_turn(
            user_id=user_id,
            message=message,
            conversation_id=conversation_id,
        )

        if self._types is None or not self._ready():
            return await self._finish(
                turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, state_changed=False
            )

        types = self._types
        contents = _history_contents(turn.history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        try:
            reply, errored, state_changed, directives, prompts = await self._run_tool_loop(
                user_id=user_id, consent_token=consent_token, contents=contents
            )
        except Exception:
            logger.exception("Location chat turn failed")
            return await self._finish(
                turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, state_changed=False
            )

        client_prompt = self._build_client_prompt(prompts)
        client_action = None if client_prompt is not None else self._build_client_action(directives)
        if client_action is not None or client_prompt is not None:
            state_changed = False

        if not reply:
            reply = "Done."
        return await self._finish(
            turn,
            reply,
            user_id,
            errored=errored,
            state_changed=state_changed and not errored,
            client_action=client_action,
            client_prompt=client_prompt,
        )

    async def _run_tool_loop(
        self, *, user_id: str, consent_token: str, contents: list
    ) -> tuple[str, bool, bool, list[dict], list[dict]]:
        """Run the Gemini function-calling loop inside HushhContext.

        Returns (reply, errored, state_changed, directives, prompts).
        """
        types = self._types
        config = types.GenerateContentConfig(
            system_instruction=self._system_prompt,
            tools=[types.Tool(function_declarations=_function_declarations_v2(types))],
            temperature=0.2,
        )
        reply = ""
        errored = False
        state_changed = False
        directives: list[dict] = []
        prompts: list[dict] = []
        with HushhContext(user_id=user_id, consent_token=consent_token, vault_keys={}):
            for _ in range(_MAX_TOOL_STEPS):
                try:
                    calls, reply = await self._model_step(contents, config)
                except Exception:
                    # A model/transport failure (e.g. the follow-up summarization
                    # call times out). If a mutating tool has ALREADY committed a
                    # change this turn, do NOT report total failure: the grant /
                    # revoke is real, so surface the accumulated state (state_changed
                    # + any clientAction) with a deterministic reply. Only a failure
                    # BEFORE any side effect is a truthful "temporarily unavailable",
                    # so re-raise in that case for the caller's fallback.
                    if state_changed or directives or prompts:
                        logger.warning(
                            "Location model step failed after side effects; "
                            "returning partial turn result",
                            exc_info=True,
                        )
                        break
                    raise
                if not calls:
                    break
                for call in calls:
                    result, mutated, directive, prompt = await self._run_tool(
                        call.name, dict(call.args or {})
                    )
                    state_changed = state_changed or mutated
                    if directive is not None:
                        directives.append(directive)
                    if prompt is not None:
                        prompts.append(prompt)
                    contents.append(
                        types.Content(
                            role="tool",
                            parts=[
                                types.Part.from_function_response(name=call.name, response=result)
                            ],
                        )
                    )
            else:
                reply = _GAVE_UP_MESSAGE
                errored = True
        return reply, errored, state_changed, directives, prompts

    async def _model_step(self, contents: list, config: Any) -> tuple[list, str]:
        """Run one model turn. Returns (function_calls, reply_text).

        When the model requests tool calls, its content is appended to ``contents``
        and reply_text is "". When it answers, calls is empty and reply_text holds
        the text. Isolating the throwing model interaction here lets the loop treat
        a post-mutation model failure as recoverable (see _run_tool_loop).
        """
        response = await self._model_call(contents, config)
        calls = list(getattr(response, "function_calls", None) or [])
        if not calls:
            return [], (getattr(response, "text", "") or "").strip()
        contents.append(response.candidates[0].content)
        return calls, ""

    async def _run_tool(self, name: str, args: dict) -> tuple[dict, bool, dict | None, dict | None]:
        """Execute one tool inside the active HushhContext.

        Returns (result, mutated, directive, prompt): directive → a clientAction
        descriptor; prompt → a clientPrompt descriptor; either may be None.
        """
        tool = self._dispatch.get(name)
        if tool is None:
            return {"error": "unknown_tool"}, False, None, None
        try:
            result = await tool(**args)
        except PermissionError:
            return {"error": "consent_denied"}, False, None, None
        except ValueError as exc:
            return {"error": "invalid_argument", "message": str(exc)}, False, None, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("Location tool %s failed: %s", name, exc)
            return {"error": "tool_failed"}, False, None, None
        result_dict = _as_response_dict(result)
        directive = self._directive_from_tool(name, result_dict)
        prompt = self._prompt_from_tool(name, result_dict)
        mutated = name not in _QUERY_TOOL_NAMES
        return result_dict, mutated, directive, prompt

    @staticmethod
    def _directive_from_tool(name: str, result: dict) -> dict | None:
        """Translate a successful directive-producing tool result into a
        coordinate-free client-action descriptor."""
        if isinstance(result, dict) and result.get("error"):
            return None
        if name in _DIRECTIVE_GRANT_TOOLS:
            grant = result.get("grant") if "grant" in result else result
            if not isinstance(grant, dict) or not grant.get("id"):
                return None
            return {
                "type": "publish_share",
                "share": {
                    "grantId": str(grant.get("id")),
                    "recipientUserId": str(grant.get("recipientUserId") or ""),
                    "recipientKeyId": str(grant.get("recipientKeyId") or ""),
                    "label": grant.get("recipientDisplayName") or "your recipient",
                },
            }
        if name == "propose_public_link" and result.get("proposed") == "create_public_link":
            return {"type": "create_public_link", "durationHours": result.get("durationHours")}
        if name == "propose_location_view" and result.get("proposed") == "view_envelope":
            return {"type": "view_envelope", "grantId": result.get("grantId")}
        if name == "propose_sos_panic" and result.get("proposed") == "sos_panic":
            return {"type": "sos_panic"}
        if name == "propose_check_in" and result.get("proposed") == "check_in":
            return {
                "type": "check_in",
                "durationHours": result.get("durationHours"),
                "note": result.get("note"),
            }
        return None

    @staticmethod
    def _prompt_from_tool(name: str, result: dict) -> dict | None:
        """Extract a coordinate-free prompt payload from a prompt-builder tool result."""
        if name not in _PROMPT_TOOL_NAMES:
            return None
        prompt = result.get("prompt") if isinstance(result, dict) else None
        return prompt if isinstance(prompt, dict) else None

    def _build_client_prompt(self, prompts: list[dict]) -> dict | None:
        """Fold collected prompt payloads into one clientPrompt (first one wins)."""
        if not prompts:
            return None
        return {"id": "prm-" + uuid4().hex[:12], **prompts[0]}

    def _build_client_action(self, directives: list[dict]) -> dict | None:
        """Fold collected per-tool directives into one client-action payload.

        Priority: publish_share > view_envelope > create_public_link > sos_panic.
        Multiple publish_share grants are combined into a single shares[] list.
        """
        if not directives:
            return None
        action_id = "act-" + uuid4().hex[:12]
        shares = [
            d["share"] for d in directives if d.get("type") == "publish_share" and d.get("share")
        ]
        if shares:
            labels = ", ".join(s["label"] for s in shares)
            return {
                "id": action_id,
                "type": "publish_share",
                "shares": shares,
                "summary": f"Share your live location with {labels}",
            }
        view = next((d for d in directives if d.get("type") == "view_envelope"), None)
        if view:
            return {
                "id": action_id,
                "type": "view_envelope",
                "grantId": view.get("grantId"),
                "summary": "Open the latest shared location",
            }
        link = next((d for d in directives if d.get("type") == "create_public_link"), None)
        if link:
            hours = link.get("durationHours")
            return {
                "id": action_id,
                "type": "create_public_link",
                "durationHours": hours,
                "summary": f"Create a public link (viewable for {hours}h)",
            }
        sos = next((d for d in directives if d.get("type") == "sos_panic"), None)
        if sos:
            return {
                "id": action_id,
                "type": "sos_panic",
                "summary": "Send an emergency SOS to all your trusted contacts",
            }
        check_in = next((d for d in directives if d.get("type") == "check_in"), None)
        if check_in:
            hours = check_in.get("durationHours")
            return {
                "id": action_id,
                "type": "check_in",
                "durationHours": hours,
                "note": check_in.get("note"),
                "summary": f"Check in with your trusted contacts for {hours}h"
                if hours is not None
                else "Check in with your trusted contacts",
            }
        return None

    async def _handle_action_result(
        self,
        *,
        user_id: str,
        conversation_id: str | None,
        action_result: dict,
    ) -> dict[str, Any]:
        """Deterministic confirmation turn for action_result payloads.

        No LLM call, no coordinates.
        """
        action_type = str(action_result.get("type") or "")
        status = str(action_result.get("status") or "")
        detail = action_result.get("detail")
        public_url = action_result.get("publicUrl")

        if action_type == "create_public_link" and status == "completed" and public_url:
            reply = (
                f"Your public link is ready: {public_url} — anyone with it can view "
                "this location until it expires, and you can revoke it anytime."
            )
        elif status == "failed":
            suffix = f" ({detail})" if detail else ""
            reply = f"That didn't go through{suffix}. You can try again."
        else:
            reply = _ACTION_RESULT_TEMPLATES.get((action_type, status), "Okay, that's handled.")

        errored = status == "failed"
        state_changed = status == "completed" and action_type in (
            "publish_share",
            "create_public_link",
            "sos_panic",
            "check_in",
        )
        conv_id = conversation_id or ""
        if conv_id:
            await self._chat_store.add_message(
                conversation_id=conv_id,
                user_id=user_id,
                role="assistant",
                content=reply,
                status="error" if errored else "complete",
            )
        return {
            "conversationId": conv_id,
            "response": reply,
            "isComplete": not errored,
            "stateChanged": state_changed,
        }

    async def _handle_selection_result(
        self,
        *,
        user_id: str,
        consent_token: str,
        conversation_id: str | None,
        selection_result: dict,
    ) -> dict[str, Any]:
        """Seed the Gemini loop with the user's choice (resolved refs) and act."""
        conv_id = conversation_id or ""
        if not conv_id:
            return {
                "conversationId": "",
                "response": "Let's start again — what would you like to do with your location sharing?",
                "isComplete": True,
                "stateChanged": False,
            }
        if self._types is None or not self._ready():
            await self._chat_store.add_message(
                conversation_id=conv_id,
                user_id=user_id,
                role="assistant",
                content=_UNAVAILABLE_MESSAGE,
                status="error",
            )
            return {
                "conversationId": conv_id,
                "response": _UNAVAILABLE_MESSAGE,
                "isComplete": False,
                "stateChanged": False,
            }

        types = self._types
        history = await self._chat_store.get_recent_messages(
            conv_id, user_id=user_id, limit=_MAX_HISTORY
        )
        seed = _selection_seed_text(selection_result)
        display = _selection_display_text(selection_result)
        # Persist the user's choice so a later turn in a multi-step clarification
        # chain (e.g. pick recipient -> then pick duration) still sees the earlier
        # answer. History was fetched above, so the current turn's contents are not
        # duplicated; future turns' get_recent_messages will include this choice.
        # `content` keeps the raw seed (the LLM needs exact ids — "do not guess");
        # the UI-facing display string rides in encrypted metadata so the transcript
        # shows "Abdul Zalil", not the id dump.
        await self._chat_store.add_message(
            conversation_id=conv_id,
            user_id=user_id,
            role="user",
            content=seed,
            status="complete",
            metadata={"kind": "selection", "display": display},
        )
        contents = _history_contents(history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=seed)]))

        try:
            reply, errored, state_changed, directives, prompts = await self._run_tool_loop(
                user_id=user_id, consent_token=consent_token, contents=contents
            )
        except Exception:
            logger.exception("Location chat selection turn failed")
            await self._chat_store.add_message(
                conversation_id=conv_id,
                user_id=user_id,
                role="assistant",
                content=_UNAVAILABLE_MESSAGE,
                status="error",
            )
            return {
                "conversationId": conv_id,
                "response": _UNAVAILABLE_MESSAGE,
                "isComplete": False,
                "stateChanged": False,
            }

        client_prompt = self._build_client_prompt(prompts)
        client_action = None if client_prompt is not None else self._build_client_action(directives)
        if client_action is not None or client_prompt is not None:
            state_changed = False
        if not reply:
            reply = "Done."
        await self._chat_store.add_message(
            conversation_id=conv_id,
            user_id=user_id,
            role="assistant",
            content=reply,
            status="error" if errored else "complete",
        )
        out: dict[str, Any] = {
            "conversationId": conv_id,
            "response": reply,
            "isComplete": not errored,
            "stateChanged": state_changed and not errored,
        }
        if client_action is not None:
            out["clientAction"] = client_action
        if client_prompt is not None:
            out["clientPrompt"] = client_prompt
        return out

    async def _finish(
        self,
        turn: Any,
        reply: str,
        user_id: str,
        *,
        errored: bool,
        state_changed: bool,
        client_action: dict | None = None,
        client_prompt: dict | None = None,
    ) -> dict[str, Any]:
        await self._chat_store.add_message(
            conversation_id=turn.conversation_id,
            user_id=user_id,
            role="assistant",
            content=reply,
            status="error" if errored else "complete",
        )
        out: dict[str, Any] = {
            "conversationId": turn.conversation_id,
            "response": reply,
            "isComplete": not errored,
            "stateChanged": state_changed,
        }
        if client_action is not None:
            out["clientAction"] = client_action
        if client_prompt is not None:
            out["clientPrompt"] = client_prompt
        return out
