"""Request context, native-message projection, and graph authority middleware."""

from __future__ import annotations

import hashlib
import inspect
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from langchain.agents.middleware import AgentMiddleware


@dataclass(frozen=True)
class EmailRuntimeContext:
    user_id: str
    conversation_id: str
    timezone: str
    now_utc: datetime
    require_access: Callable[[], Awaitable[None]] = field(repr=False)
    consent_token: str = field(default="", repr=False)


async def _await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def review_arguments_digest(arguments: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            (
                part.get("text", "")
                for part in content
                if isinstance(part, dict)
                and part.get("type") == "text"
                and isinstance(part.get("text"), str)
            )
        )
    return ""


class _AccessMiddleware(AgentMiddleware):
    def __init__(self, context: EmailRuntimeContext, counts: dict[str, int], max_tool_calls: int):
        self.context = context
        self.counts = counts
        self.max_tool_calls = max_tool_calls

    async def abefore_model(self, state, runtime):
        await self.context.require_access()
        self.counts["model_calls"] += 1

    async def aafter_model(self, state, runtime):
        await self.context.require_access()

    async def awrap_tool_call(self, request, handler):
        await self.context.require_access()
        self.counts["tool_calls"] += 1
        if self.counts["tool_calls"] > self.max_tool_calls:
            raise RuntimeError("Email tool budget exceeded")
        result = await handler(request)
        await self.context.require_access()
        return result
