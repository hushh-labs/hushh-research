"""Consume an admitted POD turn after its mobile event reader disconnects."""

import asyncio
from contextlib import aclosing

from ag_ui.core import EventType, RunErrorEvent

from hushh_mcp.one_adk.agui_turn_timing import server_is_draining
from hushh_mcp.services.chat_key import retain_request_chat_key


async def publish(queue, detached, event):
    if detached.is_set():
        return
    put = asyncio.create_task(queue.put(event))
    left = asyncio.create_task(detached.wait())
    try:
        await asyncio.wait({put, left}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (put, left):
            if not task.done():
                task.cancel()
        await asyncio.gather(put, left, return_exceptions=True)


async def run_retained_turn(self, input, track_task):
    self._pod_retained = True

    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    detached = asyncio.Event()

    async def produce():
        with retain_request_chat_key():
            try:
                # This pump owns the full event consumer, access checks,
                # final writes, memory hooks and admission until settlement.
                async with self._pod_request_lifetime():
                    async with aclosing(self._run_owned(input)) as stream:
                        async for event in stream:
                            await publish(queue, detached, event)
            except Exception:
                await publish(
                    queue,
                    detached,
                    RunErrorEvent(
                        code="POD_CHAT_BACKGROUND_UNAVAILABLE",
                        message="Your private agent could not finish this request. Reconnect and try again.",
                    ),
                )
            finally:
                await publish(queue, detached, None)

    producer = asyncio.create_task(produce())
    track_task(producer)
    received_terminal = False
    try:
        while (event := await queue.get()) is not None:
            if event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}:
                received_terminal = True
                self._pod_consumer_resolved.set()
            yield event
    finally:
        self._pod_consumer_detached = not received_terminal and not server_is_draining()
        self._pod_consumer_resolved.set()
        detached.set()
        if not self._pod_consumer_detached:
            if not received_terminal:
                producer.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(producer), timeout=10)
            except (TimeoutError, asyncio.CancelledError):
                # Owned producer stays tracked until its resources settle.
                pass
