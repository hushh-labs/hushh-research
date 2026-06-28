"""Control-plane chat orchestration for the One Location agent (v1).

Runs a Gemini function-calling loop restricted to the 5 control-plane tools,
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

Coordinate safety: the 5 control-plane tools never read or return coordinates,
so neither the prompt, the tool results fed back to Gemini, nor the reply ever
carries lat/lng.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from hushh_mcp.agents.location.agent import get_location_chat_agent
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.agent_chat_service import get_agent_chat_service

logger = logging.getLogger(__name__)

_MAX_HISTORY = 12
_MAX_TOOL_STEPS = 5
_LLM_TIMEOUT_S = 30.0
_HISTORY_CHARS = 2000

# Tools that only read state — invoking them should NOT trigger a UI refresh.
_QUERY_TOOL_NAMES = {"list_location_recipients", "list_active_location_shares"}

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
    """Function declarations for the 5 control-plane tools (no crypto-handoff)."""
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

        # System prompt + tool set come from the control-plane agent definition
        # (the hardened agent.yaml prompt + the 5-tool allow-list).
        need_agent = system_prompt is None or tools is None
        agent = get_location_chat_agent() if need_agent else None
        self._system_prompt = (
            system_prompt if system_prompt is not None else agent.manifest.system_instruction
        )
        tool_list = tools if tools is not None else agent.hushh_tools
        self._dispatch = {getattr(t, "_name", getattr(t, "__name__", "")): t for t in tool_list}

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str,
        consent_token: str,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
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
        config = types.GenerateContentConfig(
            system_instruction=self._system_prompt,
            tools=[types.Tool(function_declarations=_function_declarations(types))],
            temperature=0.2,
        )
        contents = _history_contents(turn.history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        reply = ""
        errored = False
        state_changed = False

        try:
            with HushhContext(user_id=user_id, consent_token=consent_token, vault_keys={}):
                for _ in range(_MAX_TOOL_STEPS):
                    response = await self._model_call(contents, config)
                    calls = list(getattr(response, "function_calls", None) or [])
                    if not calls:
                        reply = (getattr(response, "text", "") or "").strip()
                        break
                    # Echo the model's function-call turn, then append each result.
                    contents.append(response.candidates[0].content)
                    for call in calls:
                        result, mutated = await self._run_tool(call.name, dict(call.args or {}))
                        state_changed = state_changed or mutated
                        contents.append(
                            types.Content(
                                role="tool",
                                parts=[
                                    types.Part.from_function_response(
                                        name=call.name, response=result
                                    )
                                ],
                            )
                        )
                else:
                    reply = _GAVE_UP_MESSAGE
                    errored = True
        except Exception:
            logger.exception("Location chat turn failed")
            return await self._finish(
                turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, state_changed=False
            )

        if not reply:
            reply = "Done."
        return await self._finish(
            turn, reply, user_id, errored=errored, state_changed=state_changed and not errored
        )

    async def _run_tool(self, name: str, args: dict) -> tuple[dict, bool]:
        """Execute one tool inside the active HushhContext. Returns (result, mutated)."""
        tool = self._dispatch.get(name)
        if tool is None:
            return {"error": "unknown_tool"}, False
        try:
            result = await tool(**args)
        except PermissionError:
            return {"error": "consent_denied"}, False
        except ValueError as exc:
            # Invalid/guessed argument (e.g. a non-UUID id). Surface the guidance to
            # the model so it can look the id up and retry within the turn.
            return {"error": "invalid_argument", "message": str(exc)}, False
        except Exception as exc:
            logger.warning("Location tool %s failed: %s", name, exc)
            return {"error": "tool_failed"}, False
        mutated = name not in _QUERY_TOOL_NAMES
        return _as_response_dict(result), mutated

    async def _finish(
        self,
        turn: Any,
        reply: str,
        user_id: str,
        *,
        errored: bool,
        state_changed: bool,
    ) -> dict[str, Any]:
        await self._chat_store.add_message(
            conversation_id=turn.conversation_id,
            user_id=user_id,
            role="assistant",
            content=reply,
            status="error" if errored else "complete",
        )
        return {
            "conversationId": turn.conversation_id,
            "response": reply,
            "isComplete": not errored,
            "stateChanged": state_changed,
        }
