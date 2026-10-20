"""Pod-side composition of the fixed launcher and authoritative network broker."""

from __future__ import annotations

import asyncio
import os
import socket
import sys
import time
from collections.abc import Callable
from typing import TYPE_CHECKING
from uuid import uuid4

from .connected_executor import ConnectedBrowserExecutor
from .contracts import BrowserAuthorityPort, BrowserBinding, BrowserReadiness, BrowserRefused
from .launch_protocol import (
    AGENT_ID,
    CONTROL_FD,
    connected_socket,
    receive,
    send,
)
from .network import BrowserNetworkAuthorityPort, BrowserNetworkBroker

if TYPE_CHECKING:
    from .consent import BrowserConsentPort

NetworkAuthorityFactory = Callable[
    [BrowserBinding, "BrowserConsentPort", BrowserAuthorityPort], BrowserNetworkAuthorityPort
]


async def _readable(connection: socket.socket) -> None:
    loop = asyncio.get_running_loop()
    ready = loop.create_future()

    def wake() -> None:
        if not ready.done():
            ready.set_result(None)

    descriptor = connection.fileno()
    loop.add_reader(descriptor, wake)
    try:
        await ready
    finally:
        loop.remove_reader(descriptor)


async def _exact(connection: socket.socket, size: int) -> bytes:
    result = b""
    while len(result) < size:
        value = await asyncio.get_running_loop().sock_recv(connection, size - len(result))
        if not value:
            raise BrowserRefused("BROWSER_LAUNCH_REFUSED")
        result += value
    return result


class InPodBrowserLauncher:
    """Only trusted startup can provide readiness and the network authority.

    The inherited descriptor never becomes a route field. A dead/ambiguous
    helper connection is permanently fenced; this adapter never restarts work.
    """

    def __init__(
        self,
        *,
        connection: socket.socket,
        readiness: BrowserReadiness,
        network_authority: NetworkAuthorityFactory,
    ) -> None:
        connected_socket(connection, socket.SOCK_SEQPACKET)
        connection.setblocking(False)
        self.readiness = readiness
        self._connection, self._network_authority = connection, network_authority
        self._lock = asyncio.Lock()
        self._active: str | None = None
        self._closed = False

    @classmethod
    def from_bootstrap(
        cls, *, readiness: BrowserReadiness, network_authority: NetworkAuthorityFactory
    ) -> InPodBrowserLauncher:
        if (
            sys.platform != "linux"
            or os.getresuid() != (AGENT_ID,) * 3
            or os.environ.pop("HUSSH_BROWSER_LAUNCH_FD", None) != str(CONTROL_FD)
        ):
            raise BrowserRefused("BROWSER_LAUNCH_UNAVAILABLE")
        connection = socket.socket(fileno=CONTROL_FD)
        try:
            return cls(
                connection=connection, readiness=readiness, network_authority=network_authority
            )
        except BaseException:
            connection.close()
            raise

    def _fence(self) -> None:
        self._closed = True
        try:
            self._connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._connection.close()

    async def _request(
        self, operation: str, identifier: str, child: socket.socket | None = None
    ) -> None:
        if self._closed:
            raise BrowserRefused("BROWSER_LAUNCH_UNAVAILABLE")
        try:
            async with asyncio.timeout(8):
                send(self._connection, operation, identifier, child)
                await _readable(self._connection)
                result, response_id, descriptor = receive(self._connection)
                if descriptor is not None:
                    descriptor.close()
                    raise BrowserRefused("BROWSER_LAUNCH_REFUSED")
                if response_id != identifier or result != (
                    "started" if operation == "launch" else "stopped"
                ):
                    raise BrowserRefused("BROWSER_LAUNCH_REFUSED")
        except BaseException:
            self._fence()
            raise

    async def _stop(self, identifier: str) -> None:
        async with self._lock:
            if self._active != identifier:
                return
            # No fake settlement after a lost helper. Its EOF handler/deadline
            # may clean up, but update admission needs a confirmed stop receipt.
            await self._request("stop", identifier)
            self._active = None

    async def launch(
        self,
        binding: BrowserBinding,
        *,
        allowed_origins: tuple[str, ...],
        consent: BrowserConsentPort,
        authority: BrowserAuthorityPort,
    ) -> ConnectedBrowserExecutor:
        self.readiness.require_ready()
        await authority.check_binding(binding)
        if binding.expires_at <= time.time():
            raise BrowserRefused("BROWSER_BINDING_EXPIRED")
        identifier = uuid4().hex
        broker = BrowserNetworkBroker(
            binding=binding,
            allowed_origins=frozenset(allowed_origins),
            authority=self._network_authority(binding, consent, authority),
        )
        parent = child = None
        launched = False
        try:
            parent, child = socket.socketpair()
            async with self._lock:
                if self._active is not None:
                    raise BrowserRefused("BROWSER_BUSY")
                self._active = identifier
                launched = True
                await self._request("launch", identifier, child)
            child.close()
            return await self._connect_worker(parent, binding, authority, broker, identifier)
        except BaseException:
            if parent is not None:
                parent.close()
            try:
                try:
                    if launched:
                        await asyncio.shield(self._stop(identifier))
                finally:
                    await broker.close()
            except BaseException:
                # The runtime has no executor yet. An ordinary launch refusal
                # would wrongly look safe to release its update permit.
                raise BrowserRefused("BROWSER_LAUNCH_STOP_UNCONFIRMED") from None
            raise
        finally:
            if child is not None:
                child.close()

    async def _connect_worker(
        self,
        parent: socket.socket,
        binding: BrowserBinding,
        authority: BrowserAuthorityPort,
        broker: BrowserNetworkBroker,
        identifier: str,
    ) -> ConnectedBrowserExecutor:
        parent.setblocking(False)
        async with asyncio.timeout(15):
            raw = binding.model_dump_json().encode()
            await asyncio.get_running_loop().sock_sendall(parent, len(raw).to_bytes(4, "big") + raw)
            if await _exact(parent, 20) != b'\x00\x00\x00\x10{"guarded":true}':
                raise BrowserRefused("BROWSER_LAUNCH_REFUSED")
        await authority.check_binding(binding)
        return await ConnectedBrowserExecutor.connect(
            parent, binding=binding, broker=broker, terminate=lambda: self._stop(identifier)
        )

    async def close(self) -> None:
        try:
            if self._active is not None:
                await self._stop(self._active)
        finally:
            self._fence()
