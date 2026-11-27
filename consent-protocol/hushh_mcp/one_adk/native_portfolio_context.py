# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""One-use, owner-bound device reads inside a live native ADK turn."""

from __future__ import annotations

import asyncio
import json
from secrets import compare_digest, token_hex
from typing import Any, Literal

from google.adk.events import Event
from google.adk.tools import ToolContext

from hushh_mcp.one_adk.portfolio_context_contract import (
    PORTFOLIO_CONTEXT_TOOL,
    Section,
    Source,
    validate_portfolio_context_request,
    validate_portfolio_context_result,
)
from hushh_mcp.one_adk.queued_input import registry
from hushh_mcp.one_adk.receipt_client_tools import STATE_RECEIPT_RESULT
from hushh_mcp.one_adk.request_secrets import consume_request_secret, store_request_secret

PORTFOLIO_READ_TIMEOUT = 20
_pending: dict[str, NativePortfolioContext] = {}


class NativePortfolioContext:
    """A native turn may make one fresh, answer-only device read."""

    def __init__(self, owner: str, thread: str, run: str, binding: bytes) -> None:
        self.owner, self.thread, self.run = owner, thread, run
        self._binding = binding
        self._request_id: str | None = None
        self._call_id: str | None = None
        self._request: dict[str, Any] | None = None
        self._result: asyncio.Future[dict] | None = None
        self._expiry: asyncio.TimerHandle | None = None
        self._handoff: str | None = None

    def offer(self, event: Event) -> bytes | None:
        if event.author != "one" or event.partial or self._request_id is not None:
            return None
        calls = event.get_function_calls()
        if len(calls) != 1 or calls[0].name != PORTFOLIO_CONTEXT_TOOL or not calls[0].id:
            return None
        call = calls[0]
        try:
            request = validate_portfolio_context_request(call.args)
        except ValueError:
            return None
        if request.get("detail") != "expanded":
            return None
        request_id = token_hex(24)
        self._request_id, self._call_id, self._request = request_id, call.id, request
        loop = asyncio.get_running_loop()
        self._result = loop.create_future()
        self._expiry = loop.call_later(PORTFOLIO_READ_TIMEOUT, self.close)
        _pending[request_id] = self
        payload = json.dumps({"requestId": request_id, "request": request}, separators=(",", ":"))
        return f"event: portfolio_context\ndata: {payload}\n\n".encode()

    def close(self) -> None:
        if self._request_id is not None:
            _pending.pop(self._request_id, None)
        if self._expiry is not None:
            self._expiry.cancel()
        if self._result is not None and not self._result.done():
            self._result.set_result({"status": "unavailable", "reason": "source_unavailable"})

    def finish(self) -> None:
        self.close()
        if self._handoff is not None:
            consume_request_secret(self._handoff)
        self._result = None
        self._request = None

    async def read_portfolio_context(
        self,
        section: Section,
        source: Source,
        detail: Literal["expanded"],
        tool_context: ToolContext,
        ticker: str | None = None,
    ) -> dict:
        """Read the saved portfolio on the owner's device when facts are needed.

        For current holdings, allocation or performance, use source active and
        detail expanded. Use last_card only for a reference to a previous card.
        An optional ticker selects a single quoted symbol for a holdings question.
        Call this tool alone and answer from its result without making another offer.
        """
        request: dict[str, str] = {"section": section, "source": source, "detail": detail}
        if ticker is not None:
            request["ticker"] = ticker
        if (
            self._result is None
            or self._call_id is None
            or tool_context.user_id != self.owner
            or tool_context.function_call_id != self._call_id
            or request != self._request
        ):
            return {"status": "unavailable", "reason": "source_unavailable"}
        try:
            result = await self._result
            if registry.stop_requested(self.owner, self.thread, self.run):
                return {"status": "unavailable", "reason": "source_unavailable"}
            # Only the existing ephemeral receipt callback gives values to the
            # model. The ADK FunctionResponse itself remains value-free.
            self._handoff = store_request_secret(
                json.dumps(
                    {
                        "owner": self.owner,
                        "conversation": self.thread,
                        "results": [
                            {
                                "operation": PORTFOLIO_CONTEXT_TOOL,
                                "call_id": self._call_id,
                                "result": result,
                            }
                        ],
                    }
                ),
                ttl_seconds=60,
            )
            tool_context.state[STATE_RECEIPT_RESULT] = self._handoff
            return {"status": "read_complete", "content_redacted": True}
        finally:
            self.close()


def resolve_native_portfolio(
    *, owner: str, thread: str, run: str, request_id: str, binding: bytes, result: object
) -> bool:
    read = _pending.get(request_id)
    if (
        read is None
        or (read.owner, read.thread, read.run) != (owner, thread, run)
        or not compare_digest(read._binding, binding)
        or registry.stop_requested(owner, thread, run)
        or read._result is None
        or read._result.done()
        or read._request is None
    ):
        return False
    value = validate_portfolio_context_result(read._request, result)
    read._result.set_result(value)
    _pending.pop(request_id, None)
    return True
