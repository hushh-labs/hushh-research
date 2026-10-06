"""Browser-only sandbox entrypoint. It contains no provider or pod credentials."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from .contracts import (
    BrowserAction,
    BrowserBinding,
    BrowserRefused,
    BrowserRequest,
    BrowserResponse,
)
from .mailbox import BrowserMailbox
from .playwright_executor import SandboxedPlaywrightExecutor
from .worker_identity import prepare_worker_identity


class _NetworkBridge:
    def __init__(self, mailbox: BrowserMailbox) -> None:
        self.mailbox = mailbox
        self.binding: BrowserBinding | None = None

    async def fetch(self, request: BrowserRequest) -> BrowserResponse:
        if self.binding is None:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        try:
            response = await self.mailbox.exchange(
                {
                    "binding": self.binding.model_dump(mode="json"),
                    "request": request.model_dump(mode="json"),
                },
                timeout=20,
            )
        except Exception:
            # An unknown/lost broker receipt cannot establish that no request
            # was dispatched. Keep this sticky at the executor, never read it
            # as an ordinary blocked subresource followed by a good screenshot.
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN") from None
        if response.get("error"):
            if response["error"] == "BROWSER_OUTCOME_UNCERTAIN":
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN")
            raise BrowserRefused("BROWSER_NETWORK_REFUSED")
        try:
            return BrowserResponse.model_validate_json(json.dumps(response))
        except ValueError:
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN") from None


async def run(directory: Path) -> None:
    prepare_worker_identity()
    commands = BrowserMailbox(directory, lane="command")
    network = _NetworkBridge(BrowserMailbox(directory, lane="network"))
    # This entrypoint is started only by the native sandbox launcher. There is
    # no production direct-process mode or unsandboxed retry in the launcher.
    executor = SandboxedPlaywrightExecutor(network=network, sandbox_verified=True)
    previous = None
    try:
        async with asyncio.timeout(20 * 60):
            while True:
                received = commands.receive(previous)
                if received is None:
                    await asyncio.sleep(0.01)
                    continue
                message_id, payload = received
                previous = message_id
                try:
                    if set(payload) != {"binding", "operation", "action"}:
                        raise BrowserRefused("BROWSER_BRIDGE_INVALID")
                    bound = BrowserBinding.model_validate_json(json.dumps(payload["binding"]))
                    if network.binding is None:
                        network.binding = bound
                    if network.binding != bound:
                        raise BrowserRefused("BROWSER_BINDING_REFUSED")
                    match payload["operation"]:
                        case "initialize" if payload["action"] is None:
                            await executor.initialize()
                            result = {"initialized": True}
                        case "execute":
                            action = BrowserAction.model_validate_json(
                                json.dumps(payload["action"])
                            )
                            frame = await executor.execute(action)
                            result = frame.model_dump(mode="json")
                        case "close" if payload["action"] is None:
                            await executor.close()
                            commands.reply(message_id, {"closed": True})
                            return
                        case _:
                            raise BrowserRefused("BROWSER_ACTION_INVALID")
                    commands.reply(message_id, result)
                except Exception as exc:
                    # Raw Playwright/page errors must never reach stdout/stderr.
                    code = (
                        "BROWSER_OUTCOME_UNCERTAIN"
                        if isinstance(exc, BrowserRefused)
                        and exc.code == "BROWSER_OUTCOME_UNCERTAIN"
                        else "BROWSER_EXECUTOR_REFUSED"
                    )
                    commands.reply(message_id, {"error": code})
    finally:
        await executor.close()
        network.mailbox.close()
        commands.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mailbox", type=Path, required=True)
    args = parser.parse_args()
    try:
        asyncio.run(run(args.mailbox))
    except Exception:
        # Native launcher checks exit status, not potentially private traceback.
        raise SystemExit(1) from None
