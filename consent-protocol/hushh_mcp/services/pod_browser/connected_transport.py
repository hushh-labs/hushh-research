"""Bounded duplex RPC over one launcher-owned connected Unix socket.

This is transport only: callers retain the existing binding, consent and dispatch
checks. A lost reply closes the channel; it never authorizes replay. No listener,
filesystem mailbox, caller-selected command or credential is exposed.
"""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import Awaitable, Callable

from .contracts import BrowserRefused
from .mailbox import MAX_ENVELOPE_BYTES

Handler = Callable[[dict], Awaitable[dict]]


def _object(pairs: list[tuple[str, object]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")
        result[key] = value
    return result


def _constant(_value: str) -> None:
    raise BrowserRefused("BROWSER_BRIDGE_INVALID")


class ConnectedBrowserTransport:
    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, handler: Handler
    ) -> None:
        self._reader, self._writer, self._handler = reader, writer, handler
        self._calls, self._writes = asyncio.Lock(), asyncio.Lock()
        self._sequence = self._received = self._queued = 0
        self._pending: tuple[int, asyncio.Future[dict]] | None = None
        self._inbound: asyncio.Task | None = None
        self._shutdown: asyncio.Task | None = None
        self._closed = False
        self._pump = asyncio.create_task(self._read(), name="browser-private-bridge")

    @classmethod
    async def connect(
        cls, connection: socket.socket, handler: Handler
    ) -> ConnectedBrowserTransport:
        """Takes ownership of an already connected, launcher-created descriptor."""
        try:
            if (
                connection.family != socket.AF_UNIX
                or connection.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
            ):
                raise BrowserRefused("BROWSER_BRIDGE_INVALID")
            connection.getpeername()
            connection.set_inheritable(False)
            connection.setblocking(False)
            reader, writer = await asyncio.open_connection(sock=connection)
            return cls(reader, writer, handler)
        except BaseException:
            connection.close()
            raise

    async def _write(self, kind: str, message_id: int, payload: dict) -> None:
        if self._closed:
            raise BrowserRefused("BROWSER_BRIDGE_CLOSED")
        try:
            raw = json.dumps(
                {"id": message_id, "kind": kind, "payload": payload},
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
            if len(raw) > MAX_ENVELOPE_BYTES:
                raise BrowserRefused("BROWSER_BRIDGE_TOO_LARGE")
            async with self._writes, asyncio.timeout(5):
                self._writer.write(len(raw).to_bytes(4, "big") + raw)
                await self._writer.drain()
        except BaseException:
            await self.close()
            raise

    async def exchange(self, payload: dict, *, timeout: float = 25) -> dict:
        if self._closed:
            raise BrowserRefused("BROWSER_BRIDGE_CLOSED")
        if self._queued >= 4:
            raise BrowserRefused("BROWSER_BRIDGE_BUSY")
        self._queued += 1
        future: asyncio.Future[dict] | None = None
        try:
            async with asyncio.timeout(timeout), self._calls:
                if self._closed or self._sequence >= 2**31 - 1:
                    raise BrowserRefused("BROWSER_BRIDGE_CLOSED")
                self._sequence += 1
                future = asyncio.get_running_loop().create_future()
                self._pending = (self._sequence, future)
                await self._write("request", self._sequence, payload)
                return await future
        except BaseException:
            # Cancellation may have interrupted an effect. Close, do not retry.
            await self.close()
            raise
        finally:
            self._queued -= 1
            if future is not None:
                if future.done() and not future.cancelled():
                    future.exception()  # consume a close racing the failed write
                if self._pending and self._pending[1] is future:
                    self._pending = None

    async def _reply(self, message_id: int, payload: dict) -> None:
        try:
            result = await self._handler(payload)
            if not isinstance(result, dict):
                raise BrowserRefused("BROWSER_BRIDGE_INVALID")
            await self._write("response", message_id, result)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Private handler exceptions cannot become bridge diagnostics.
            await self.close()

    def _dispatch(self, envelope: object) -> None:
        if not isinstance(envelope, dict) or set(envelope) != {"id", "kind", "payload"}:
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")
        message_id, kind, payload = (
            envelope["id"],
            envelope["kind"],
            envelope["payload"],
        )
        if (
            type(message_id) is not int
            or not 0 < message_id < 2**31
            or not isinstance(payload, dict)
        ):
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")
        if kind == "response":
            pending = self._pending
            if pending is None or pending[0] != message_id or pending[1].done():
                raise BrowserRefused("BROWSER_BRIDGE_INVALID")
            pending[1].set_result(payload)
        elif kind == "request":
            if message_id != self._received + 1 or self._inbound and not self._inbound.done():
                raise BrowserRefused("BROWSER_BRIDGE_INVALID")
            self._received = message_id
            self._inbound = asyncio.create_task(
                self._reply(message_id, payload), name="browser-private-request"
            )
        else:
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")

    async def _read(self) -> None:
        try:
            while not self._closed:
                prefix = await self._reader.readexactly(4)
                length = int.from_bytes(prefix, "big")
                if not 0 < length <= MAX_ENVELOPE_BYTES:
                    raise BrowserRefused("BROWSER_BRIDGE_TOO_LARGE")
                async with asyncio.timeout(20):
                    raw = await self._reader.readexactly(length)
                self._dispatch(json.loads(raw, object_pairs_hook=_object, parse_constant=_constant))
        except (Exception, asyncio.CancelledError):
            pass  # EOF, protocol failure and cancellation all fence this channel
        finally:
            await self.close()

    async def close(self) -> None:
        current = asyncio.current_task()
        internal = current in (self._pump, self._inbound)
        if self._shutdown is None:
            self._closed = True
            pending = self._pending
            if pending and not pending[1].done():
                pending[1].set_exception(BrowserRefused("BROWSER_BRIDGE_CLOSED"))
            self._shutdown = asyncio.create_task(self._finish_close(), name="browser-bridge-close")
        if internal:
            # The cleanup task joins these workers; they must first unwind.
            return
        await asyncio.shield(self._shutdown)

    async def wait_closed(self) -> None:
        """Join peer closure without cancelling the reader if a caller leaves."""
        await asyncio.shield(self._pump)
        await self.close()

    async def _finish_close(self) -> None:
        tasks = [task for task in (self._pump, self._inbound) if task]
        for task in tasks:
            task.cancel()
        self._writer.close()
        try:
            async with asyncio.timeout(5):
                await asyncio.gather(*tasks, return_exceptions=True)
                try:
                    await self._writer.wait_closed()
                except (ConnectionResetError, BrokenPipeError):
                    # A supervised peer can exit before the socket flushes.
                    # All local handlers have joined and close() has fenced
                    # delivery. Peer reset cannot authorize replay, and is not
                    # evidence of a surviving Browser process; its supervisor
                    # independently confirms process-tree termination.
                    pass
        except (TimeoutError, OSError):
            raise BrowserRefused("BROWSER_BRIDGE_CLOSE_UNCONFIRMED") from None
