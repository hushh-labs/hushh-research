"""Typed execution transport over a task-only mailbox, never arbitrary commands."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable

from .contracts import BrowserAction, BrowserBinding, BrowserFrame, BrowserRefused, BrowserRequest
from .mailbox import BrowserMailbox
from .network import BrowserNetworkBroker


class MailboxExecutor:
    def __init__(
        self,
        *,
        binding: BrowserBinding,
        mailbox: BrowserMailbox,
        broker: BrowserNetworkBroker,
        terminate: Callable[[], Awaitable[None]],
    ) -> None:
        self._binding = binding
        self._mailbox = mailbox
        self._broker = broker
        self._terminate = terminate

    async def _call(self, operation: str, action: BrowserAction | None = None) -> dict:
        response = await self._mailbox.exchange(
            {
                "binding": self._binding.model_dump(mode="json"),
                "operation": operation,
                "action": None
                if action is None
                else action.model_dump(mode="json", exclude_unset=True),
            }
        )
        if response.get("error"):
            if response["error"] == "BROWSER_OUTCOME_UNCERTAIN":
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
            # Never echo a sandbox-controlled error body into ADK/platform logs.
            raise BrowserRefused("BROWSER_EXECUTOR_REFUSED")
        return response

    async def initialize(self) -> None:
        response = await self._call("initialize")
        if response != {"initialized": True}:
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")

    async def execute(self, action: BrowserAction) -> BrowserFrame:
        await self._broker.check_observation()
        response = await self._call("execute", action)
        await self._broker.check_observation()
        try:
            return BrowserFrame.model_validate_json(json.dumps(response))
        except ValueError:
            raise BrowserRefused("BROWSER_BRIDGE_INVALID") from None

    async def close(self) -> None:
        try:
            # Out-of-band trusted launcher termination must interrupt a pending
            # browser action. A close message behind the same queue cannot do so.
            await self._terminate()
        finally:
            self._mailbox.close()


async def serve_network_bridge(
    *,
    binding: BrowserBinding,
    mailbox: BrowserMailbox,
    broker: BrowserNetworkBroker,
) -> None:
    previous = None
    requests = 0
    try:
        while True:
            received = mailbox.receive(previous)
            if received is None:
                await asyncio.sleep(0.01)
                continue
            message_id, payload = received
            previous = message_id
            requests += 1
            if requests > 512:
                mailbox.reply(message_id, {"error": "BROWSER_NETWORK_REFUSED"})
                return
            try:
                if set(payload) != {"binding", "request"} or payload[
                    "binding"
                ] != binding.model_dump(mode="json"):
                    raise BrowserRefused("BROWSER_BINDING_REFUSED")
                request = BrowserRequest.model_validate_json(json.dumps(payload["request"]))
                response = await broker.fetch(request)
                mailbox.reply(message_id, response.model_dump(mode="json"))
            except Exception as exc:
                code = (
                    "BROWSER_OUTCOME_UNCERTAIN"
                    if isinstance(exc, BrowserRefused) and exc.code == "BROWSER_OUTCOME_UNCERTAIN"
                    else "BROWSER_NETWORK_REFUSED"
                )
                mailbox.reply(message_id, {"error": code})
    finally:
        await broker.close()
        mailbox.close()
