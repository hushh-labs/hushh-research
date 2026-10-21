"""Synthetic real-Playwright/connected-FD qualification, never owner readiness.

The parent supplies one fixed HTML fixture. No website, model, owner information
or approval is involved. This qualifies the executor transport, not broker policy.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import socket
import sys
from pathlib import Path

from .connected_transport import ConnectedBrowserTransport
from .contracts import BrowserAction, BrowserFrame, BrowserRefused, BrowserRequest, BrowserResponse
from .namespace_probe import PREFIX, _command, verify_isolation
from .playwright_executor import PlaywrightExecutor

_PAGE = b"""<!doctype html><title>Private browser fixture</title>
<style>body{background:white}button,input{position:absolute;left:10px;width:200px;
height:40px}button{top:10px}input{top:70px}</style>
<button onclick="document.body.style.background='lightgreen'">Change colour</button>
<input aria-label="Synthetic input"><div style="height:1800px"></div>"""


class _FixtureNetwork:
    channel: ConnectedBrowserTransport

    async def fetch(self, request: BrowserRequest) -> BrowserResponse:
        try:
            result = await self.channel.exchange(request.model_dump(mode="json"))
            return BrowserResponse.model_validate_json(json.dumps(result))
        except Exception:
            raise BrowserRefused("BROWSER_NETWORK_UNAVAILABLE") from None


async def _worker(guards: dict) -> None:
    network = _FixtureNetwork()
    executor = PlaywrightExecutor(network=network, chromium_sandbox=True)

    async def command(payload: dict) -> dict:
        if payload == {"operation": "initialize"}:
            await executor.initialize()
            return {"initialized": True, "guards": guards}
        if set(payload) != {"action"}:
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")
        action = BrowserAction.model_validate_json(json.dumps(payload["action"]))
        return dict((await executor.execute(action)).model_dump(mode="json"))

    connection = socket.socket(fileno=int(sys.argv[3]))
    network.channel = await ConnectedBrowserTransport.connect(connection, command)
    try:
        await network.channel._pump
    finally:
        await executor.close()
        await network.channel.close()


async def _stop_worker(process: asyncio.subprocess.Process, *, grace_seconds: float = 15) -> dict:
    try:
        await asyncio.wait_for(process.wait(), grace_seconds)
    except TimeoutError:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await asyncio.wait_for(process.wait(), 5)
    result = {"worker_exit": process.returncode, "process_group_absent": False}
    try:
        os.killpg(process.pid, 0)
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        result["process_group_absent"] = True
    return result


async def _exercise(channel: ConnectedBrowserTransport) -> dict:
    frames = []
    actions: list[dict] = [
        {"operation": "navigate", "url": "https://example.com/"},
        {"operation": "click", "x": 80, "y": 30},
        {"operation": "type", "x": 90, "y": 90, "text": "Synthetic"},
        {"operation": "scroll", "direction": "down", "magnitude": 250},
    ]
    for sequence, arguments in enumerate(actions, start=1):
        action = BrowserAction(sequence=sequence, control_epoch=1, **arguments)
        response = await channel.exchange(
            {"action": action.model_dump(mode="json", exclude_unset=True)}
        )
        frame = BrowserFrame.model_validate_json(json.dumps(response))
        frames.append(hashlib.sha256(frame.png).hexdigest())
    return {
        "frame_verified": True,
        "viewport": [frame.width, frame.height],
        "frame_hashes": frames,
        "input_changed_frames": len(set(frames)) == 4,
    }


async def run_probe() -> dict:
    if os.geteuid() != 10002 or not Path("/agent/synthetic-secret").is_file():
        return {"code": "BROWSER_NEGATIVE_CONTROL_MISSING"}
    parent, child = socket.socketpair()
    channel = None
    process = None
    requests = 0
    result: dict = {"frame_verified": False}

    async def fixture(payload: dict) -> dict:
        nonlocal requests
        request = BrowserRequest.model_validate_json(json.dumps(payload))
        requests += 1
        if requests > 8 or request.method != "GET" or request.url != "https://example.com/":
            raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
        return dict(
            BrowserResponse(
                status=200, headers=(("content-type", "text/html"),), body=_PAGE
            ).model_dump(mode="json")
        )

    try:
        process = await asyncio.create_subprocess_exec(
            *_command(bridge_fd=child.fileno()),
            pass_fds=(child.fileno(),),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
            start_new_session=True,
        )
        child.close()
        channel = await ConnectedBrowserTransport.connect(parent, fixture)
        initialized = await channel.exchange({"operation": "initialize"})
        result["initialized"] = initialized.get("initialized") is True
        result["guards"] = initialized.get("guards", {})
        result.update(await _exercise(channel))
        result.update(
            broker_requests=requests,
            code="BROWSER_NAMESPACE_BRIDGE_VERIFIED",
        )
    except Exception:
        result["code"] = "BROWSER_NAMESPACE_BRIDGE_REFUSED"
    finally:
        child.close()
        try:
            if channel is not None:
                await channel.close()
            else:
                parent.close()
        finally:
            if process is not None:
                result.update(await _stop_worker(process))
    if not all(
        (
            result.get("frame_verified"),
            result.get("initialized"),
            result.get("input_changed_frames"),
            result.get("process_group_absent"),
            result.get("worker_exit") == 0,
        )
    ):
        result["code"] = "BROWSER_NAMESPACE_BRIDGE_REFUSED"
    return result


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--inside":
            checks = verify_isolation()
            if checks.get("code") != "BROWSER_NAMESPACE_GUARDS_VERIFIED":
                raise SystemExit(1)
            asyncio.run(_worker(checks))
        else:
            print(PREFIX + json.dumps(asyncio.run(run_probe())), flush=True)
    except Exception:
        raise SystemExit(1) from None
