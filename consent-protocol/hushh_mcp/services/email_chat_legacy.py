"""Retained read-only Email loops for injected ADK/voice compatibility adapters.

UAT Email uses the OSS ingress. These existing operations remain inherited
by EmailChatService so caller overrides, history writes and authority ports keep
their original entrypoints without a second implementation.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from hushh_mcp.agents.email.agent import build_email_agent
from hushh_mcp.agents.email.tools import EMAIL_TOOLS
from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError, run_specialist_adk_turn

logger = logging.getLogger("hushh_mcp.services.email_chat_service")

_MAX_HISTORY = 12

_MAX_TOOL_STEPS = 4

_HISTORY_CHARS = 2000

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
        types.FunctionDeclaration(
            name="list_receipts",
            description=(
                "List the user's synced purchase receipts, newest first. Read-only. "
                "Use for what did I buy, receipts, or spending questions."
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
                "Report whether the user's Gmail receipt sync is connected and healthy. Read-only."
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


async def _run_inbox_tool(tools: dict[str, Callable], name: str, args: dict) -> dict:
    tool = tools.get(name)
    if tool is None:
        logger.warning("email_chat.tool_dispatch_miss name=%s", name)
        return {"error": "unknown_tool"}
    try:
        result = await tool(**args)
    except Exception as exc:  # noqa: BLE001
        logger.warning("email_chat.tool_failed name=%s type=%s", name, type(exc).__name__)
        return {"error": "tool_failed"}
    return _as_response_dict(result)


class LegacyEmailChatOperations:
    async def _run_adk_tool_loop(
        self, *, user_id: str, consent_token: str, message: str, history: list[Any]
    ) -> tuple[str, bool]:
        """Run inbox and receipt reads through the manifest-owned ADK agent."""
        try:
            turn = await run_specialist_adk_turn(
                agent=build_email_agent(tools=EMAIL_TOOLS, model=self._adk_model),
                app_name="email",
                user_id=user_id,
                consent_token=consent_token,
                message=message,
                history=history,
                service_ports={"gmail": self._gmail},
                max_llm_calls=_MAX_TOOL_STEPS,
            )
        except SpecialistAdkTurnError as exc:
            # Email tools are read-only, so an answer produced after a tool
            # failure is safe to return as an errored, finite turn.
            return exc.partial_turn.final_text, True
        return turn.final_text, False

    async def _run_tool_loop(self, *, user_id: str, contents: list) -> tuple[str, bool]:
        types = self._types
        from hushh_mcp.operons.kai.llm import build_kai_generation_config

        config = build_kai_generation_config(
            types,
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
        return await _run_inbox_tool(tools, name, args)

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

        async def list_receipts(page: int = 1, per_page: int = 25) -> dict:
            return await gmail.list_receipts(
                user_id=user_id,
                page=max(1, int(page or 1)),
                per_page=min(max(1, int(per_page or 25)), 100),
            )

        async def sync_status() -> dict:
            return await gmail.get_status(user_id=user_id)

        return {
            "list_needs_reply": list_needs_reply,
            "search_inbox": search_inbox,
            "list_receipts": list_receipts,
            "sync_status": sync_status,
        }

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
