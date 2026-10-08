"""Bounded pod-side multiplexing over the admitted Live socket.

One reader separates browser frames from hub directive-authority replies. This
transport grants no authority and owns no ledger. In particular, a Live handler
may await a confirmation RPC without preventing its reply from being read.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from contextlib import suppress
from typing import Any, Literal, Protocol

from fastapi import WebSocketDisconnect

from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

AuthorityMethod = Literal["issue", "confirm", "consume", "settle", "settle_direct", "cancel_voice"]
AUTHORITY_METHODS = frozenset(
    {"issue", "confirm", "consume", "settle", "settle_direct", "cancel_voice"}
)
REQUEST_TYPE = "pod_voice_authority_request"
RESULT_TYPE = "pod_voice_authority_result"
MAX_FRAME_BYTES = 1_000_000
_CLOSE_TIMEOUT_SECONDS = 3.0


class LiveSocket(Protocol):
    async def receive_text(self) -> str: ...
    async def send_text(self, data: str) -> None: ...
    async def close(self, code: int = 1000, reason: str | None = None) -> None: ...


class PodLiveTransport:
    """Connection-scoped socket facade; use as an async context manager.

    A full browser queue closes instead of blocking the sole reader behind audio
    frames while a handler awaits an authority reply. Timeouts close the socket:
    a lost acknowledgement must never silently retry a ledger mutation.
    """

    def __init__(
        self,
        socket: LiveSocket,
        *,
        authority_timeout: float = 10.0,
        max_pending: int = 8,
        browser_queue_size: int = 8,
    ) -> None:
        if authority_timeout <= 0 or max_pending < 1 or browser_queue_size < 1:
            raise ValueError("positive transport limits required")
        self._socket = socket
        self._timeout = authority_timeout
        self._max_pending = max_pending
        self._browser: asyncio.Queue[str] = asyncio.Queue(maxsize=browser_queue_size)
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._closed = asyncio.Event()
        self._send_lock = asyncio.Lock()
        self._reader: asyncio.Task[None] | None = None
        self._close_sent = False

    async def __aenter__(self) -> PodLiveTransport:
        if self._reader is not None or self._closed.is_set():
            raise RuntimeError("transport cannot be reused")
        self._reader = asyncio.create_task(self._read(), name="pod-live-reader")
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    def _finish(self) -> None:
        self._closed.set()
        while not self._browser.empty():
            self._browser.get_nowait()
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ActionDirectiveAuthorityError("voice authority unavailable"))

    async def _read(self) -> None:
        try:
            while not self._closed.is_set():
                raw = await self._socket.receive_text()
                if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
                    raise ValueError("frame too large")
                frame = json.loads(raw)
                if not isinstance(frame, dict):
                    raise ValueError("object frame required")
                if frame.get("type") == RESULT_TYPE:
                    if set(frame) != {"type", "requestId", "ok", "result"}:
                        raise ValueError("invalid authority response")
                    request_id = frame["requestId"]
                    if not isinstance(request_id, str) or type(frame["ok"]) is not bool:
                        raise ValueError("invalid authority response")
                    future = self._pending.get(request_id)
                    if future is None or future.done() or not isinstance(frame["result"], dict):
                        raise ValueError("unmatched authority response")
                    future.set_result(frame)
                elif frame.get("type") == REQUEST_TYPE:
                    raise ValueError("wrong authority direction")
                else:
                    self._browser.put_nowait(raw)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Neither browser contents nor transport/provider errors enter logs.
            pass
        finally:
            self._finish()
            await self._close_socket(code=1008, reason="Voice connection ended.")

    async def receive_text(self) -> str:
        if self._closed.is_set():
            raise WebSocketDisconnect(code=1008)
        receive = asyncio.create_task(self._browser.get())
        closed = asyncio.create_task(self._closed.wait())
        try:
            await asyncio.wait({receive, closed}, return_when=asyncio.FIRST_COMPLETED)
            if self._closed.is_set():
                raise WebSocketDisconnect(code=1008)
            return receive.result()
        finally:
            for task in (receive, closed):
                if not task.done():
                    task.cancel()
            await asyncio.gather(receive, closed, return_exceptions=True)

    async def send_text(self, data: str) -> None:
        if len(data.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ActionDirectiveAuthorityError("voice frame exceeds transport bound")
        async with self._send_lock:
            if self._closed.is_set():
                raise WebSocketDisconnect(code=1008)
            await self._socket.send_text(data)

    async def request(self, method: AuthorityMethod, arguments: dict[str, Any]) -> dict[str, Any]:
        if method not in AUTHORITY_METHODS:
            raise ActionDirectiveAuthorityError("unknown voice authority operation")
        if self._reader is None or self._closed.is_set() or len(self._pending) >= self._max_pending:
            raise ActionDirectiveAuthorityError("voice authority unavailable")
        request_id = secrets.token_urlsafe(18)
        raw = json.dumps(
            {
                "type": REQUEST_TYPE,
                "requestId": request_id,
                "method": method,
                "arguments": arguments,
            },
            allow_nan=False,
        )
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            async with asyncio.timeout(self._timeout):
                await self.send_text(raw)
                response = await future
            if not response["ok"]:
                raise ActionDirectiveAuthorityError("voice directive refused")
            result = response["result"]
            if not isinstance(result, dict):
                raise ActionDirectiveAuthorityError("voice directive result invalid")
            return result
        except asyncio.CancelledError:
            await self.close(code=1008, reason="Voice connection ended.")
            raise
        except ActionDirectiveAuthorityError:
            raise
        except Exception:
            # Even a send error can follow a successful wire write. Never keep
            # the channel open or retry when mutation completion is uncertain.
            await self.close(code=1008, reason="Voice authority unavailable.")
            raise ActionDirectiveAuthorityError("voice authority unavailable") from None
        finally:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                # A send failure may race reader shutdown before awaiting this future.
                future.exception()

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self._finish()
        await self._close_socket(code=code, reason=reason or "Voice connection ended.")
        if self._reader is not None and self._reader is not asyncio.current_task():
            self._reader.cancel()
            with suppress(Exception, asyncio.CancelledError):
                await asyncio.wait_for(self._reader, timeout=_CLOSE_TIMEOUT_SECONDS + 1)

    async def _close_socket(self, *, code: int, reason: str) -> None:
        if self._close_sent:
            return
        self._close_sent = True
        with suppress(Exception):
            async with asyncio.timeout(_CLOSE_TIMEOUT_SECONDS):
                await self._socket.close(code=code, reason=reason)
