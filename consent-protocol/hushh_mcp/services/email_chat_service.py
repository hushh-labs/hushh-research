"""Chat orchestration for the Gmail inbox agent (read-only).

Mirrors ``InformationChatService``: a Gemini function-calling loop over read-only
inbox tools, with durable conversation persistence via ``AgentChatService``.

Unlike the marketplace agent, the tools read Gmail through the connected
``gmail.readonly`` OAuth connection (not vault-scoped ``@hushh_tool`` callables),
so no ``HushhContext`` is opened — the route already gates on ``VAULT_OWNER`` +
user match, and Gmail access is the user's own consented connection. No tool
mutates state; the assistant can summarize / prioritize / draft reply text, but
never sends or changes anything.
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

_UNAVAILABLE_MESSAGE = "The email assistant is temporarily unavailable. Please try again."
_GAVE_UP_MESSAGE = "I couldn't finish that — please try rephrasing."

_SYSTEM_PROMPT = (
    "You are the user's email assistant inside hushh One, helping the account "
    "holder triage their Gmail inbox. Use the tools to read the inbox: "
    "`list_needs_reply` for threads awaiting the user's reply, and `search_inbox` "
    "to find messages by a Gmail search query (e.g. 'from:ravi newer_than:7d', "
    "'subject:invoice', 'is:unread'). Be concise and specific — reference senders "
    "and subjects. You are READ-ONLY: you may summarize, prioritize, and draft "
    "suggested reply text, but you cannot send email or change anything. If asked "
    "to do something you cannot, say so briefly. Never invent emails or senders "
    "you did not see from a tool result."
)

# model call seam: (contents, config) -> Gemini response. Injectable for tests.
ModelCall = Callable[[Any, Any], Awaitable[Any]]


def _function_declarations(types: Any) -> list:
    """Function declarations for the read-only inbox tools."""
    schema = types.Schema
    kind = types.Type
    return [
        types.FunctionDeclaration(
            name="list_needs_reply",
            description=(
                "List inbox threads that appear to need the user's reply (most "
                "recent message is inbound and unanswered, from a human). Read-only. "
                "Call this to answer what needs a response / what is waiting on the user."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "limit": schema(
                        type=kind.INTEGER, description="Max threads to return (default 10)"
                    )
                },
                required=[],
            ),
        ),
        types.FunctionDeclaration(
            name="search_inbox",
            description=(
                "Search the user's Gmail with a raw Gmail search query and return "
                "matching message summaries (subject, sender, snippet, date). "
                "Read-only. Use for any 'find / show me emails about X' request."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "query": schema(
                        type=kind.STRING,
                        description="Gmail search expression, e.g. 'from:ravi newer_than:7d'",
                    ),
                    "limit": schema(
                        type=kind.INTEGER, description="Max results to return (default 10)"
                    ),
                },
                required=["query"],
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


class EmailChatService:
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
                "response": "Ask me what needs a reply, or to find something in your inbox.",
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
            logger.exception("Email chat turn failed")
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
            logger.warning("email_chat.tool_dispatch_miss name=%s", name)
            return {"error": "unknown_tool"}
        try:
            result = await tool(**args)
        except Exception as exc:  # noqa: BLE001
            logger.warning("email_chat.tool_failed name=%s err=%s", name, exc, exc_info=True)
            return {"error": "tool_failed"}
        return _as_response_dict(result)

    def _build_tools(self, user_id: str) -> dict[str, Callable]:
        """Read-only inbox tools bound to the current user."""
        gmail = self._gmail

        async def list_needs_reply(limit: int = 10) -> dict:
            res = await gmail.list_nudges(user_id=user_id, limit=min(int(limit or 10), 25))
            needs_reply = [
                nudge for nudge in res.get("nudges", []) if nudge.get("type") == "needs_reply"
            ]
            return {"nudges": needs_reply, "account_email": res.get("account_email")}

        async def search_inbox(query: str, limit: int = 10) -> dict:
            results = await gmail.search_inbox(
                user_id=user_id, query=query, limit=min(int(limit or 10), 25)
            )
            return {"results": results}

        return {"list_needs_reply": list_needs_reply, "search_inbox": search_inbox}

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
