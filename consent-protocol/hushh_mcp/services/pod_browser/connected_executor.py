"""Typed pod/worker adapter over a launcher-owned socket, without readiness authority.

The trusted launcher supplies both ends with the same immutable binding. Existing
BrowserControl owns action approval and observation suppression; the host broker
owns every request, revocation check and consequential network dispatch.
"""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from .connected_transport import ConnectedBrowserTransport
from .contracts import (
    BrowserAction,
    BrowserBinding,
    BrowserExecutionScope,
    BrowserFrame,
    BrowserRefused,
    BrowserRequest,
    BrowserResponse,
    BrowserSessionExecutionPort,
)
from .origin import public_origin
from .session_state import RememberedState

if TYPE_CHECKING:
    from .network import BrowserNetworkBroker


def _bound(payload: dict, binding: BrowserBinding, fields: set[str]) -> None:
    if set(payload) != fields | {"binding"}:
        raise BrowserRefused("BROWSER_BRIDGE_INVALID")
    if payload["binding"] != binding.model_dump(mode="json"):
        raise BrowserRefused("BROWSER_BINDING_REFUSED")


def _error(exc: Exception, fallback: str) -> dict:
    # No URL, cookie, browser diagnostic or arbitrary exception string crosses.
    return {
        "error": "BROWSER_OUTCOME_UNCERTAIN"
        if isinstance(exc, BrowserRefused) and exc.code == "BROWSER_OUTCOME_UNCERTAIN"
        else fallback
    }


def _origins(raw: object) -> frozenset[str]:
    if (
        not isinstance(raw, list)
        or not 1 <= len(raw) <= 20
        or any(not isinstance(item, str) or len(item) > 4096 for item in raw)
        or len(set(raw)) != len(raw)
        or any(public_origin(item) != item for item in raw)
    ):
        raise BrowserRefused("BROWSER_SESSION_ORIGINS_REFUSED")
    return frozenset(raw)


class ConnectedBrowserExecutor:
    """Host execution port; never launches an unqualified browser itself."""

    def __init__(
        self,
        *,
        binding: BrowserBinding,
        broker: BrowserNetworkBroker,
        terminate: Callable[[], Awaitable[None]],
    ) -> None:
        self._binding, self._broker, self._terminate = binding, broker, terminate
        self._channel: ConnectedBrowserTransport
        self._watcher: asyncio.Task
        self._shutdown: asyncio.Task | None = None
        self._requests = 0
        self._scope: BrowserExecutionScope | None = None

    def bind_scope_validator(self, check: Callable[[BrowserExecutionScope], None]) -> None:
        self._broker.bind_scope_validator(check)

    @property
    def downloads(self):
        return self._broker.downloads

    @classmethod
    async def connect(
        cls,
        connection: socket.socket,
        *,
        binding: BrowserBinding,
        broker: BrowserNetworkBroker,
        terminate: Callable[[], Awaitable[None]],
    ) -> ConnectedBrowserExecutor:
        executor = cls(binding=binding, broker=broker, terminate=terminate)
        try:
            executor._channel = await ConnectedBrowserTransport.connect(connection, executor._fetch)
        except BaseException:
            try:
                await terminate()
            finally:
                await broker.close()
            raise
        executor._watcher = asyncio.create_task(executor._watch(), name="browser-worker-connection")
        return executor

    async def _fetch(self, payload: dict) -> dict:
        try:
            _bound(payload, self._binding, {"request"})
            self._requests += 1
            if self._shutdown is not None or self._requests > 512:
                raise BrowserRefused("BROWSER_STOPPED")
            request = BrowserRequest.model_validate_json(json.dumps(payload["request"]))
            if request.scope != self._scope:
                raise BrowserRefused("BROWSER_ACTION_SCOPE_REFUSED")
            if request.scope is not None:
                request.scope.remaining()
            response = await self._broker.fetch(request)
            return dict(response.model_dump(mode="json"))
        except Exception as exc:
            return _error(exc, "BROWSER_NETWORK_REFUSED")

    async def _call(self, operation: str, *, timeout: float = 25, **values: object) -> dict:
        if self._shutdown is not None:
            raise BrowserRefused("BROWSER_STOPPED")
        await self._broker.check_observation()
        try:
            try:
                result = await self._channel.exchange(
                    {
                        "binding": self._binding.model_dump(mode="json"),
                        "operation": operation,
                        **values,
                    },
                    timeout=timeout,
                )
            except Exception:
                # Even observation can overlap an autosave network request.
                raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN") from None
            await self._broker.check_observation()
            if "error" in result:
                raise BrowserRefused(
                    "BROWSER_OUTCOME_UNCERTAIN"
                    if result == {"error": "BROWSER_OUTCOME_UNCERTAIN"}
                    else "BROWSER_EXECUTOR_REFUSED"
                )
            return dict(result)
        except BaseException:
            await self.close()
            raise

    async def initialize(self) -> None:
        if await self._call("initialize", action=None) != {"initialized": True}:
            await self.close()
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")

    async def execute(
        self, action: BrowserAction, *, scope: BrowserExecutionScope | None = None
    ) -> BrowserFrame:
        if scope is not None:
            scope.require_action(action, self._binding)
        self._scope = scope
        try:
            result = await self._call(
                "execute",
                action=action.model_dump(mode="json", exclude_unset=True),
                scope=scope.model_dump(mode="json") if scope is not None else None,
                timeout=scope.remaining() if scope is not None else 25,
            )
        finally:
            self._scope = None
        try:
            frame = BrowserFrame.model_validate_json(json.dumps(result))
            if frame.sequence != action.sequence:
                raise ValueError("unexpected frame sequence")
            return frame
        except ValueError:
            await self.close()
            raise BrowserRefused("BROWSER_BRIDGE_INVALID") from None

    async def export_session(self, approved_origins: frozenset[str]) -> RememberedState:
        origins = _origins(sorted(approved_origins))
        result = await self._call("session_export", origins=sorted(origins), state=None)
        try:
            return RememberedState.model_validate_json(json.dumps(result)).for_origins(origins)
        except (ValueError, BrowserRefused):
            await self.close()
            raise BrowserRefused("BROWSER_SESSION_STATE_REFUSED") from None

    async def import_session(
        self, state: RememberedState, approved_origins: frozenset[str]
    ) -> None:
        state = state.for_origins(approved_origins)
        result = await self._call(
            "session_import",
            origins=sorted(approved_origins),
            state=state.model_dump(mode="json"),
        )
        if result != {"imported": True}:
            await self.close()
            raise BrowserRefused("BROWSER_SESSION_STATE_REFUSED")

    def _begin_close(self) -> asyncio.Task:
        if self._shutdown is None:
            self._shutdown = asyncio.create_task(self._finish_close(), name="browser-worker-stop")
        return self._shutdown

    async def _watch(self) -> None:
        try:
            await self._channel.wait_closed()
        finally:
            # Do not join here: cleanup itself joins this watcher.
            self._begin_close()

    async def close(self) -> None:
        await asyncio.shield(self._begin_close())

    async def _finish_close(self) -> None:
        try:
            # Out-of-band termination cannot queue behind an in-flight action.
            async with asyncio.timeout(10):
                await self._terminate()
        finally:
            try:
                await self._channel.close()
            finally:
                try:
                    async with asyncio.timeout(5):
                        await self._broker.close()
                finally:
                    await self._watcher


class ConnectedBrowserWorker:
    """Worker dispatcher, composed only after launcher isolation succeeds."""

    def __init__(self, binding: BrowserBinding) -> None:
        self._binding = binding
        self._channel: ConnectedBrowserTransport | None = None
        self._network_gate = asyncio.Lock()
        self._network_requests = 0

    async def fetch(self, request: BrowserRequest) -> BrowserResponse:
        if self._channel is None:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        # Pages load many assets together. Backpressure belongs before the
        # transport queue; a normal burst must not look like a lost dispatch.
        if self._network_requests >= 512:
            raise BrowserRefused("BROWSER_NETWORK_REFUSED")
        self._network_requests += 1
        try:
            async with asyncio.timeout(request.scope.remaining() if request.scope else 20):
                await self._network_gate.acquire()
        except TimeoutError:
            # This request was never sent; unlike reply loss, it is not uncertain.
            raise BrowserRefused("BROWSER_NETWORK_REFUSED") from None
        try:
            return await self._fetch(request)
        finally:
            self._network_gate.release()

    async def _fetch(self, request: BrowserRequest) -> BrowserResponse:
        if self._channel is None:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        try:
            result = await self._channel.exchange(
                {
                    "binding": self._binding.model_dump(mode="json"),
                    "request": request.model_dump(mode="json"),
                },
                timeout=request.scope.remaining() if request.scope else 20,
            )
            if result == {"error": "BROWSER_NETWORK_REFUSED"}:
                raise BrowserRefused("BROWSER_NETWORK_REFUSED")
            return BrowserResponse.model_validate_json(json.dumps(result))
        except Exception as exc:
            if isinstance(exc, BrowserRefused) and exc.code == "BROWSER_NETWORK_REFUSED":
                raise
            # A lost response is not evidence that transmission did not occur.
            raise BrowserRefused("BROWSER_OUTCOME_UNCERTAIN") from None

    async def serve(self, connection: socket.socket, executor: BrowserSessionExecutionPort) -> None:
        async def command(payload: dict) -> dict:
            try:
                session = payload.get("operation") in {"session_export", "session_import"}
                fields = {"operation", "origins", "state"} if session else {"operation", "action"}
                if payload.get("operation") == "execute":
                    fields.add("scope")
                _bound(payload, self._binding, fields)
                return await self._dispatch(executor, payload)
            except Exception as exc:
                return _error(exc, "BROWSER_EXECUTOR_REFUSED")

        try:
            self._channel = await ConnectedBrowserTransport.connect(connection, command)
            async with asyncio.timeout(20 * 60):
                await self._channel.wait_closed()
        finally:
            try:
                if self._channel is not None:
                    await self._channel.close()
                else:
                    connection.close()
            finally:
                await executor.close()

    @staticmethod
    async def _dispatch(executor: BrowserSessionExecutionPort, payload: dict) -> dict:
        match payload["operation"]:
            case "initialize" if payload["action"] is None:
                await executor.initialize()
                return {"initialized": True}
            case "execute":
                action = BrowserAction.model_validate_json(json.dumps(payload["action"]))
                scope = (
                    BrowserExecutionScope.model_validate(payload["scope"])
                    if payload["scope"] is not None
                    else None
                )
                if scope is not None:
                    scope.require_action(action, BrowserBinding.model_validate(payload["binding"]))
                return dict((await executor.execute(action, scope=scope)).model_dump(mode="json"))
            case "session_export" if payload["state"] is None:
                origins = _origins(payload["origins"])
                state = (await executor.export_session(origins)).for_origins(origins)
                return dict(state.model_dump(mode="json"))
            case "session_import":
                origins = _origins(payload["origins"])
                state = RememberedState.model_validate_json(json.dumps(payload["state"]))
                await executor.import_session(state.for_origins(origins), origins)
                return {"imported": True}
            case _:
                raise BrowserRefused("BROWSER_ACTION_INVALID")
