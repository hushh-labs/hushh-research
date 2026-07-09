"""Chat orchestration for the Gmail receipts agent (read-only).

Mirrors ``EmailChatService``: a Gemini function-calling loop over read-only
Gmail receipt tools, with durable conversation persistence via
``AgentChatService``.

The Gmail specialist owns receipt sync and purchase memory: what the user
bought, from which merchants, and whether the receipt sync connection is
healthy. Reads come from the already-synced ``kai_gmail_receipts`` store and
the connection status surface of ``GmailReceiptsService``; nothing here
mutates state. The inbox-triage lane (needs-reply, raw inbox search) belongs
to the Email specialist, not this one.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from hushh_mcp.services.agent_chat_service import get_agent_chat_service
from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

logger = logging.getLogger(__name__)

_MAX_HISTORY = 12
_MAX_TOOL_STEPS = 4
_LLM_TIMEOUT_S = 30.0
_HISTORY_CHARS = 2000

_UNAVAILABLE_MESSAGE = "The Gmail assistant is temporarily unavailable. Please try again."
_GAVE_UP_MESSAGE = "I couldn't finish that - please try rephrasing."

_SYSTEM_PROMPT = (
    "You are the user's Gmail receipts assistant inside hushh One, helping the "
    "account holder review their synced purchase memory. Use the tools: "
    "`list_receipts` pages through synced purchase receipts (merchant, amount, "
    "date, order id), and `sync_status` reports whether the Gmail receipt sync "
    "connection is healthy and when it last ran. Be concise and specific - "
    "reference merchants, amounts, and dates you actually saw in tool results. "
    "You are READ-ONLY: you may summarize and total what was synced, but you "
    "cannot connect, disconnect, or trigger a sync; those are app actions the "
    "user confirms in the Gmail tab. Never invent receipts or merchants you "
    "did not see from a tool result."
)

# model call seam: (contents, config) -> Gemini response. Injectable for tests.
ModelCall = Callable[[Any, Any], Awaitable[Any]]


def _function_declarations(types: Any) -> list:
    """Function declarations for the read-only receipt tools."""
    schema = types.Schema
    kind = types.Type
    return [
        types.FunctionDeclaration(
            name="list_receipts",
            description=(
                "List the user's synced purchase receipts, newest first "
                "(merchant, amount, currency, date, order id, subject). "
                "Read-only. Call this for any 'what did I buy / show my "
                "receipts / how much did I spend' request."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "page": schema(type=kind.INTEGER, description="Page number (default 1)"),
                    "per_page": schema(
                        type=kind.INTEGER, description="Receipts per page (default 25, max 100)"
                    ),
                },
                required=[],
            ),
        ),
        types.FunctionDeclaration(
            name="sync_status",
            description=(
                "Report the Gmail receipt sync connection status: whether an "
                "account is connected, and the latest sync run outcome. "
                "Read-only. Call this when the user asks if their receipts "
                "are up to date or why something is missing."
            ),
            parameters=schema(type=kind.OBJECT, properties={}, required=[]),
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


class GmailChatService:
    def __init__(
        self,
        *,
        chat_store: Any = None,
        gmail_service: Any = None,
        model_call: ModelCall | None = None,
        genai_types: Any = None,
        ready: Callable[[], bool] | None = None,
    ) -> None:
        self._chat_store = chat_store if chat_store is not None else get_agent_chat_service()
        self._gmail = gmail_service if gmail_service is not None else get_gmail_receipts_service()

        if model_call is not None:
            self._model_call = model_call
            self._types = genai_types
            self._ready = ready or (lambda: True)
        else:
            from hushh_mcp.operons.kai import llm as _llm

            self._types = genai_types or _llm.types
            self._ready = ready or _llm._require_gemini_ready

            async def _default_call(contents: Any, config: Any) -> Any:
                # Shared hedged call: short per-attempt deadline + retry inside
                # the total budget collapses rare stalls (tail-at-scale).
                return await _llm.agent_chat_model_call(
                    contents, config, total_timeout_s=_LLM_TIMEOUT_S
                )

            self._model_call = _default_call

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None = None,
        consent_token: str = "",
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        if not message:
            return {
                "conversationId": conversation_id or "",
                "response": (
                    "Ask me about your synced receipts, spending at a merchant, "
                    "or whether receipt sync is up to date."
                ),
                "isComplete": True,
                "stateChanged": False,
            }

        turn = await self._chat_store.prepare_turn(
            user_id=user_id, message=message, conversation_id=conversation_id
        )

        if self._types is None or not self._ready():
            return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True)

        types = self._types
        contents = _history_contents(turn.history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        try:
            reply, errored = await self._run_tool_loop(user_id=user_id, contents=contents)
        except Exception:
            logger.exception("Gmail chat turn failed")
            return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True)

        return await self._finish(turn, reply or "Done.", user_id, errored=errored)

    async def _run_tool_loop(self, *, user_id: str, contents: list) -> tuple[str, bool]:
        types = self._types
        config = types.GenerateContentConfig(
            system_instruction=_SYSTEM_PROMPT,
            tools=[types.Tool(function_declarations=_function_declarations(types))],
            temperature=0.2,
        )
        tools = self._build_tools(user_id)
        reply = ""
        errored = False
        for _ in range(_MAX_TOOL_STEPS):
            response = await self._model_call(contents, config)
            calls = list(getattr(response, "function_calls", None) or [])
            if not calls:
                reply = (getattr(response, "text", "") or "").strip()
                break
            contents.append(response.candidates[0].content)
            # One function_response part per function_call part, in a single tool turn.
            tool_parts = []
            for call in calls:
                result = await self._run_tool(tools, call.name, dict(call.args or {}))
                tool_parts.append(
                    types.Part.from_function_response(name=call.name, response=result)
                )
            contents.append(types.Content(role="tool", parts=tool_parts))
        else:
            reply = _GAVE_UP_MESSAGE
            errored = True
        return reply, errored

    async def _run_tool(self, tools: dict[str, Callable], name: str, args: dict) -> dict:
        tool = tools.get(name)
        if tool is None:
            logger.warning("gmail_chat.tool_dispatch_miss name=%s", name)
            return {"error": "unknown_tool"}
        try:
            result = await tool(**args)
        except Exception as exc:  # noqa: BLE001
            logger.warning("gmail_chat.tool_failed name=%s err=%s", name, exc, exc_info=True)
            return {"error": "tool_failed"}
        return _as_response_dict(result)

    def _build_tools(self, user_id: str) -> dict[str, Callable]:
        """Read-only receipt tools bound to the current user."""
        gmail = self._gmail

        async def list_receipts(page: int = 1, per_page: int = 25) -> dict:
            return await gmail.list_receipts(
                user_id=user_id,
                page=max(1, int(page or 1)),
                per_page=min(max(1, int(per_page or 25)), 100),
            )

        async def sync_status() -> dict:
            return await gmail.get_status(user_id=user_id)

        return {"list_receipts": list_receipts, "sync_status": sync_status}

    async def _finish(
        self, turn: Any, reply: str, user_id: str, *, errored: bool
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
            "stateChanged": False,
        }
