"""Bounded hub courier for an already admitted private Live connection.

This module opens no network connection and grants no admission. The caller must
supply current owner/serving-target/consent validation, and a pod socket opened
with audience-bound IAM. No provider executes on this hub path.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any

from api.routes.one.pod_live_authority import HubVoiceAuthority
from api.routes.one.pod_live_transport import (
    MAX_FRAME_BYTES,
    REQUEST_TYPE,
    RESULT_TYPE,
    LiveSocket,
)

logger = logging.getLogger(__name__)


async def run_live_courier(
    browser: LiveSocket,
    pod: LiveSocket,
    *,
    authority: HubVoiceAuthority,
    require_access: Callable[[], Awaitable[None]],
    recheck_seconds: float = 1.0,
    authority_timeout: float = 10.0,
    send_timeout: float = 10.0,
    shutdown_timeout: float = 3.0,
) -> None:
    """Close both peers and drain owned pumps on refusal, outage or disconnect.

    Revalidation runs throughout the connection, including while neither peer
    sends anything. Action mutations additionally revalidate in HubVoiceAuthority.
    Polling is a bounded observation interval, not instantaneous revocation proof.
    """
    if min(recheck_seconds, authority_timeout, send_timeout, shutdown_timeout) <= 0:
        raise ValueError("positive authority limits required")
    stopped = asyncio.Event()
    pod_write = asyncio.Lock()
    browser_write = asyncio.Lock()
    tasks: list[asyncio.Task[None]] = []

    async def check() -> None:
        async with asyncio.timeout(authority_timeout):
            await require_access()

    async def receive(socket: LiveSocket) -> dict[str, Any]:
        raw = await socket.receive_text()
        if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ValueError("voice frame too large")
        frame = json.loads(raw)
        if not isinstance(frame, dict):
            raise ValueError("voice object frame required")
        return frame

    async def send(socket: LiveSocket, lock: asyncio.Lock, frame: dict[str, Any]) -> None:
        raw = json.dumps(frame, allow_nan=False)
        if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ValueError("voice frame too large")
        async with lock:
            if stopped.is_set():
                return
            async with asyncio.timeout(send_timeout):
                await socket.send_text(raw)

    async def from_browser() -> None:
        while not stopped.is_set():
            frame = await receive(browser)
            if frame.get("type") in {REQUEST_TYPE, RESULT_TYPE}:
                raise ValueError("browser cannot supply authority frames")
            authority.observe_browser(frame)
            if isinstance(frame.get("appContext"), dict):
                # The browser's vault master and purported specialist grants
                # must not cross to a pod. The admitted route supplies scoped
                # authority separately; UI context never grants it.
                frame["appContext"] = {
                    key: value
                    for key, value in frame["appContext"].items()
                    if key
                    not in {"consent_token", "consentToken", "data_door_grants", "dataDoorGrants"}
                }
            await send(pod, pod_write, frame)

    async def from_pod() -> None:
        while not stopped.is_set():
            frame = await receive(pod)
            if frame.get("type") == REQUEST_TYPE:
                async with asyncio.timeout(authority_timeout):
                    response = await authority.dispatch(frame)
                await send(pod, pod_write, response)
            elif frame.get("type") == RESULT_TYPE:
                raise ValueError("pod cannot supply authority results")
            else:
                await send(browser, browser_write, authority.validate_outbound(frame))

    async def watch() -> None:
        while not stopped.is_set():
            await asyncio.sleep(recheck_seconds)
            await check()

    async def close(socket: LiveSocket) -> None:
        with suppress(Exception):
            async with asyncio.timeout(3.0):
                await socket.close(code=1008, reason="Private voice connection ended.")

    try:
        await check()
        tasks = [asyncio.create_task(pump()) for pump in (from_browser, from_pod, watch)]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        # Retrieve every completed exception without disclosing peer contents or
        # provider/credential errors. No mutation or connection is retried here.
        for task in done:
            task.result()
    except Exception:
        pass
    finally:
        stopped.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(close(browser), close(pod))
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=shutdown_timeout)
            for task in tasks:
                if task.done() and not task.cancelled():
                    task.exception()
            if pending:
                # Python cannot kill cancellation-resistant code. Transport
                # publication is fenced and peers are closed; surface the gap
                # rather than claiming every underlying operation stopped.
                logger.error("pod_live_courier_shutdown_incomplete pending=%s", len(pending))
                for task in pending:
                    task.cancel()
                    task.add_done_callback(
                        lambda finished: None if finished.cancelled() else finished.exception()
                    )
