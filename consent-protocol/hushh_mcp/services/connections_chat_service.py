"""Gemini function-calling chat specialist for the connections graph.

Routes message turns through a Gemini tool-loop (read tools now; write/propose
tools added in Task 3). Selection-result turns (from the frontend pick-card
confirmation flow) bypass the loop and run _complete_action directly.

Disambiguation reuses the SAME selection round-trip the Location specialist uses:
when a name matches more than one directory person, we return a coordinate-free
``clientPrompt`` (kind ``select``) whose option ``ref``s carry the real
``trustedUserId`` (plus a ``label`` and the ``op`` so the follow-up is
self-contained). The frontend renders the pick-list and sends the chosen ref back
as a ``delegate_result`` selection, which routes to THIS agent (bypassing the
classifier) and completes the add/remove.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable
from uuid import uuid4

from hushh_mcp.services.agent_chat_service import get_agent_chat_service
from hushh_mcp.services.connections_service import (
    ConnectionsError,
    ConnectionsService,
)

logger = logging.getLogger(__name__)

_MAX_HISTORY = 12
_MAX_TOOL_STEPS = 4
_LLM_TIMEOUT_S = 30.0
_HISTORY_CHARS = 2000
_UNAVAILABLE_MESSAGE = "The connections assistant is temporarily unavailable. Please try again."
_GAVE_UP_MESSAGE = "I couldn't finish that — please try rephrasing."
_QUERY_TOOL_NAMES = {"list_my_connections", "list_pending_requests", "find_people"}

ModelCall = Callable[[Any, Any], Awaitable[Any]]

_SYSTEM_PROMPT = (
    "You are the user's Connections assistant inside hushh One. You manage the "
    "account holder's two-way connection graph. Tools: `list_my_connections` "
    "lists active connections; `list_pending_requests` lists pending requests "
    "(direction 'incoming' or 'outgoing'); `find_people` searches the user's "
    "directory by name (returns userId, displayName, relationship). To CONNECT "
    "with someone, first `find_people` to resolve them, then call "
    "`propose_send_request` with their userId. If a name matches more than one "
    "person, call `request_person_choice` so the USER picks — never guess. To "
    "ACCEPT or REJECT a request, first `list_pending_requests` to get its id, "
    "then `propose_accept_request` / `propose_reject_request`. To REMOVE a "
    "connection, first `list_my_connections` to get its connectionId, then "
    "`propose_remove_connection`. You NEVER change the graph directly: every "
    "add/accept/reject/remove goes through a propose_* tool, which asks the user "
    "to confirm before anything happens. Be concise and reference the real names "
    "you saw in tool results. Never invent people."
)


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


def _function_declarations(types: Any) -> list:
    schema = types.Schema
    kind = types.Type
    return [
        types.FunctionDeclaration(
            name="list_my_connections",
            description="List the user's active connections (connectionId, userId, displayName). Read-only.",
            parameters=schema(type=kind.OBJECT, properties={}, required=[]),
        ),
        types.FunctionDeclaration(
            name="list_pending_requests",
            description="List pending connection requests. direction='incoming' (received) or 'outgoing' (sent). Read-only.",
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "direction": schema(type=kind.STRING, description="'incoming' or 'outgoing'")
                },
                required=[],
            ),
        ),
        types.FunctionDeclaration(
            name="find_people",
            description="Search the user's directory by display-name fragment. Returns userId, displayName, relationship. Read-only.",
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "query": schema(type=kind.STRING, description="Name fragment to search")
                },
                required=["query"],
            ),
        ),
    ]


class ConnectionsChatService:
    def __init__(
        self,
        service: ConnectionsService | None = None,
        *,
        chat_store: Any = None,
        model_call: ModelCall | None = None,
        genai_types: Any = None,
        ready: Callable[[], bool] | None = None,
    ) -> None:
        self._service = service or ConnectionsService()
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
                return await _llm.agent_chat_model_call(
                    contents, config, total_timeout_s=_LLM_TIMEOUT_S
                )

            self._model_call = _default_call

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None,
        consent_token: str | None = None,
        conversation_id: str | None = None,
        selection_result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        conv = conversation_id or ""

        if selection_result is not None:
            return self._complete_action(user_id, selection_result, conv)

        if not (message or "").strip():
            return self._reply(
                "Tell me who you'd like to connect with, or ask who your connections are.",
                conv,
                state_changed=False,
            )

        turn = await self._chat_store.prepare_turn(
            user_id=user_id, message=message, conversation_id=conversation_id
        )

        if self._types is None or not self._ready():
            return await self._finish(
                turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, prompt=None
            )

        types = self._types
        contents = _history_contents(turn.history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        try:
            reply, errored, prompt = await self._run_tool_loop(user_id=user_id, contents=contents)
        except Exception:
            logger.exception("Connections chat turn failed")
            return await self._finish(
                turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, prompt=None
            )

        return await self._finish(turn, reply or "Done.", user_id, errored=errored, prompt=prompt)

    async def _run_tool_loop(
        self, *, user_id: str, contents: list
    ) -> tuple[str, bool, dict | None]:
        types = self._types
        config = types.GenerateContentConfig(
            system_instruction=_SYSTEM_PROMPT,
            tools=[types.Tool(function_declarations=_function_declarations(types))],
            temperature=0.2,
        )
        tools = self._build_tools(user_id)
        reply = ""
        errored = False
        prompt: dict | None = None
        for _ in range(_MAX_TOOL_STEPS):
            response = await self._model_call(contents, config)
            calls = list(getattr(response, "function_calls", None) or [])
            if not calls:
                reply = (getattr(response, "text", "") or "").strip()
                break
            contents.append(response.candidates[0].content)
            tool_parts = []
            for call in calls:
                result, call_prompt = await self._run_tool(tools, call.name, dict(call.args or {}))
                if call_prompt is not None and prompt is None:
                    prompt = call_prompt
                tool_parts.append(
                    types.Part.from_function_response(name=call.name, response=result)
                )
            contents.append(types.Content(role="tool", parts=tool_parts))
            if prompt is not None:
                # A confirmation/disambiguation was requested; stop and surface it.
                reply = ""
                break
        else:
            reply = _GAVE_UP_MESSAGE
            errored = True
        return reply, errored, prompt

    async def _run_tool(
        self, tools: dict[str, Callable], name: str, args: dict
    ) -> tuple[dict, dict | None]:
        tool = tools.get(name)
        if tool is None:
            logger.warning("connections_chat.tool_dispatch_miss name=%s", name)
            return {"error": "unknown_tool"}, None
        try:
            result = tool(**args)
        except ConnectionsError as exc:
            return {"error": "tool_failed", "message": exc.message}, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("connections_chat.tool_failed name=%s err=%s", name, exc, exc_info=True)
            return {"error": "tool_failed"}, None
        result_dict = _as_response_dict(result)
        prompt = self._prompt_from_tool(name, result_dict)
        return result_dict, prompt

    def _build_tools(self, user_id: str) -> dict[str, Callable]:
        service = self._service

        def list_my_connections() -> dict:
            return {"items": service.list_connections(user_id)}

        def list_pending_requests(direction: str = "incoming") -> dict:
            direction = "outgoing" if str(direction).lower() == "outgoing" else "incoming"
            return {"items": service.list_requests(user_id, direction=direction)}

        def find_people(query: str) -> dict:
            return service.search_directory(user_id, query=query)

        return {
            "list_my_connections": list_my_connections,
            "list_pending_requests": list_pending_requests,
            "find_people": find_people,
        }

    def _prompt_from_tool(self, name: str, result: dict) -> dict | None:
        # Propose/choice tools attach their prompt payload in Task 3/4. Reads never prompt.
        return None

    async def _finish(
        self, turn: Any, reply: str, user_id: str, *, errored: bool, prompt: dict | None
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
            "stateChanged": False,
        }
        if prompt is not None:
            out["clientPrompt"] = prompt
            out["isComplete"] = False
        return out

    # ---- selection round-trip ----
    def _selection_prompt(
        self, name: str, candidates: list[dict[str, Any]], *, op: str, conv: str
    ) -> dict[str, Any]:
        """Build a coordinate-free select prompt whose refs carry the real ids.

        Mirrors the Location specialist's clientPrompt contract so the shared
        frontend pick-card renders it and rounds-trips the choice back here.
        """
        verb = "add" if op == "add" else "remove"
        options = [
            {
                "label": str(c.get("displayName") or "Someone"),
                "ref": {
                    "trustedUserId": str(c.get("userId") or ""),
                    "label": str(c.get("displayName") or "Someone"),
                    "op": op,
                },
                "hint": None,
            }
            for c in candidates
            if c.get("userId")
        ]
        prompt = {
            "id": "prm-" + uuid4().hex[:12],
            "kind": "select",
            "purpose": f"{op}_trusted_connection",
            "question": f'Which "{name}" should I {verb}?',
            "options": options,
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": False,
        }
        return self._reply(
            f'I found more than one match for "{name}". Which one?',
            conv,
            state_changed=False,
            client_prompt=prompt,
        )

    _SUCCESS_TEXT = {
        "send_request": "Sent a connection request to {label}.",
        "accept": "You're now connected with {label}.",
        "reject": "Declined the request from {label}.",
        "remove": "Removed {label} from your connections.",
    }

    def _complete_action(
        self, user_id: str, selection_result: dict[str, Any], conv: str
    ) -> dict[str, Any]:
        if str(selection_result.get("status")) == "cancelled":
            return self._reply("Okay, I won't change anything.", conv, state_changed=False)

        selected = selection_result.get("selected") or []
        chosen = selected[0] if selected and isinstance(selected[0], dict) else {}
        op = str(chosen.get("op") or "")
        label = str(chosen.get("label") or selection_result.get("display") or "them")

        try:
            if op == "send_request":
                addressee = str(chosen.get("addresseeUserId") or "")
                if not addressee:
                    return self._reply(
                        "I didn't catch who to connect with — try again?", conv, state_changed=False
                    )
                self._service.create_request(user_id, addressee_user_id=addressee)
            elif op == "accept":
                rid = str(chosen.get("requestId") or "")
                if not rid:
                    return self._reply(
                        "I didn't catch which request — try again?", conv, state_changed=False
                    )
                self._service.accept_request(user_id, rid)
            elif op == "reject":
                rid = str(chosen.get("requestId") or "")
                if not rid:
                    return self._reply(
                        "I didn't catch which request — try again?", conv, state_changed=False
                    )
                self._service.reject_request(user_id, rid)
            elif op == "remove":
                cid = str(chosen.get("connectionId") or "")
                if not cid:
                    return self._reply(
                        "I didn't catch which connection — try again?", conv, state_changed=False
                    )
                self._service.remove_connection(user_id, cid)
            else:
                return self._reply(
                    "I didn't catch what to do — try again?", conv, state_changed=False
                )
        except ConnectionsError as exc:
            return self._reply(exc.message, conv, state_changed=False)

        return self._reply(self._SUCCESS_TEXT[op].format(label=label), conv, state_changed=True)

    @staticmethod
    def _reply(
        response: str,
        conv: str,
        *,
        state_changed: bool,
        client_prompt: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        out: dict[str, Any] = {
            "response": response,
            "conversationId": conv,
            "isComplete": True,
            "stateChanged": state_changed,
        }
        if client_prompt is not None:
            out["clientPrompt"] = client_prompt
            # A prompt turn is a mid-conversation ask, not a completed action.
            out["isComplete"] = False
        return out
