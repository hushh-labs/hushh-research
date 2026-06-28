"""Control-plane chat orchestration for the One Location agent (v1).

Reuses AgentChatService ONLY for durable, encrypted conversation persistence.
The LLM turn runs through LocationAgent.handle_message (the consent-gated ADK
path) restricted to control-plane tools — never through the Gemini-direct
streaming path, which would bypass consent enforcement.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from hushh_mcp.agents.location.agent import get_location_chat_agent
from hushh_mcp.services.agent_chat_service import get_agent_chat_service

logger = logging.getLogger(__name__)

_MAX_HISTORY_CHARS = 2000


def _format_history(history: list[Any]) -> str:
    lines: list[str] = []
    for message in history:
        role = getattr(message, "role", "")
        if role not in ("user", "assistant"):
            continue
        speaker = "User" if role == "user" else "Assistant"
        content = (getattr(message, "content", "") or "")[:_MAX_HISTORY_CHARS]
        lines.append(f"{speaker}: {content}")
    return "\n".join(lines)


class LocationChatService:
    def __init__(self, *, agent: Any = None, chat_store: Any = None) -> None:
        self._agent = agent if agent is not None else get_location_chat_agent()
        self._chat_store = chat_store if chat_store is not None else get_agent_chat_service()

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

        preamble = _format_history(turn.history)
        composed = f"{preamble}\n\nLatest user message:\n{message}" if preamble else message

        # handle_message is synchronous (wraps a blocking LLM call); run it off
        # the event loop so the async route stays responsive.
        result = await asyncio.to_thread(
            self._agent.handle_message,
            composed,
            user_id,
            consent_token,
        )

        reply = result.get("response", "")
        errored = "error" in result

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
            "isComplete": bool(result.get("is_complete", not errored)),
            # v1: refresh on every successful turn (handle_message does not report
            # which tools ran). Precise per-tool detection is a v2 concern.
            "stateChanged": not errored,
        }
