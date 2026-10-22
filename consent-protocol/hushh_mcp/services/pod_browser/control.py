"""Exclusive browser control and bounded dispatch; no parallel approval ledger."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Literal

from .contracts import (
    BrowserAction,
    BrowserAuthorityPort,
    BrowserBinding,
    BrowserExecutionPort,
    BrowserExecutionScope,
    BrowserFrame,
    BrowserReadiness,
    BrowserRefused,
    BrowserViewport,
)
from .downloads import BrowserDownloads
from .geometry import require_frame_geometry, viewport_for_action
from .network import public_origin
from .session_state import RememberedState


class BrowserControl:
    def __init__(
        self,
        *,
        binding: BrowserBinding,
        readiness: BrowserReadiness,
        executor: BrowserExecutionPort,
        authority: BrowserAuthorityPort,
        wall_clock: Callable[[], float] = time.time,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.binding = binding
        self.readiness = readiness
        self._executor = executor
        self._authority = authority
        self._wall_clock = wall_clock
        self._clock = clock
        self._lock = asyncio.Lock()
        self._mode: Literal["agent", "owner", "stopped", "uncertain"] = "agent"
        self._epoch = 1
        self._sequence = 0
        self._actions = 0
        self._native_calls: set[str] = set()
        self._active_seconds = 0.0
        self._agent_started = clock()
        self._last_activity = clock()
        self._initialized = False
        self._frame: BrowserFrame | None = None
        self._revision = 1
        self._outcome_uncertain = False
        self._viewport = BrowserViewport()
        bind_scope = getattr(executor, "bind_scope_validator", None)
        if bind_scope is not None:
            bind_scope(self.require_execution_scope)

    def require_execution_scope(self, scope: BrowserExecutionScope) -> None:
        scope.remaining(self._wall_clock)
        if scope.control_epoch != self._epoch or scope.actor != self._mode:
            raise BrowserRefused("BROWSER_CONTROL_CHANGED")

    def admit_native_call(self, call_id: str) -> None:
        if not isinstance(call_id, str) or not 1 <= len(call_id) <= 256:
            raise BrowserRefused("BROWSER_NATIVE_CALL_INVALID")
        if call_id in self._native_calls or len(self._native_calls) >= 128:
            raise BrowserRefused("BROWSER_ACTION_REPLAY")
        self._native_calls.add(call_id)

    @property
    def viewport(self) -> BrowserViewport:
        return self._viewport

    @property
    def downloads(self) -> BrowserDownloads | None:
        value = getattr(self._executor, "downloads", None)
        return value if isinstance(value, BrowserDownloads) else None

    @property
    def outcome_uncertain(self) -> bool:
        return self._outcome_uncertain

    @property
    def revision(self) -> int:
        return self._revision

    @property
    def control_owner(self) -> Literal["agent", "owner", "stopped", "uncertain"]:
        return self._mode

    @property
    def latest_frame(self) -> BrowserFrame | None:
        """Memory-only owner preview; never a model observation grant."""
        return self._frame

    @property
    def control_epoch(self) -> int:
        return self._epoch

    @property
    def next_sequence(self) -> int:
        return self._sequence + 1

    async def _check(self) -> None:
        self.readiness.require_ready()
        if self.binding.expires_at <= self._wall_clock():
            raise BrowserRefused("BROWSER_AUTHORIZATION_EXPIRED")
        await self._authority.check_binding(self.binding)
        if self._mode in {"stopped", "uncertain"}:
            raise BrowserRefused("BROWSER_" + self._mode.upper())

    async def initialize(self) -> None:
        async with self._lock:
            await self._check()
            if not self._initialized:
                async with asyncio.timeout(30):
                    await self._executor.initialize()
                await self._check()
                self._initialized = True

    async def execute(
        self,
        action: BrowserAction,
        *,
        actor: Literal["agent", "owner"] = "agent",
        native_focus: bool = False,
    ) -> BrowserFrame:
        async with self._lock:
            await self._check()
            if actor != self._mode or action.control_epoch != self._epoch:
                raise BrowserRefused("BROWSER_CONTROL_CHANGED")
            qualified_native_focus = (
                native_focus
                and self.readiness.cloud == "azure"
                and self.readiness.model_transport
                == "hushh_mcp.runtime_providers.azure_browser_adk.AzureBrowserAdkModel"
            )
            if actor != "owner" and (
                action.operation == "resize" or action.focus_existing and not qualified_native_focus
            ):
                raise BrowserRefused("BROWSER_OWNER_INPUT_REQUIRED")
            expected = viewport_for_action(self.viewport, action)
            if action.sequence != self.next_sequence:
                raise BrowserRefused("BROWSER_ACTION_REPLAY")
            if not self._initialized:
                raise BrowserRefused("BROWSER_NOT_INITIALIZED")
            if action.operation == "navigate":
                if action.url is None:
                    raise BrowserRefused("BROWSER_ACTION_INVALID")
                public_origin(action.url)
            active_seconds = self._active_seconds + (
                max(0.0, self._clock() - self._agent_started) if actor == "agent" else 0
            )
            if actor == "agent" and (self._actions >= 60 or active_seconds >= 900):
                raise BrowserRefused("BROWSER_CONTINUATION_REQUIRED")
            # Admission and exact approval apply even when the model omits its
            # native safety_decision. Typing may transmit before any submit.
            scope = BrowserExecutionScope(
                sequence=action.sequence,
                control_epoch=action.control_epoch,
                actor=actor,
                deadline_at=min(float(self.binding.expires_at), self._wall_clock() + 330),
            )
            async with asyncio.timeout(scope.remaining(self._wall_clock)):
                await self._authority.authorize_action(self.binding, action, scope=scope)
            await self._check()
            if actor != self._mode or action.control_epoch != self._epoch:
                raise BrowserRefused("BROWSER_CONTROL_CHANGED")
            effect = action.operation not in {"observe", "hover", "scroll"}
            if effect:
                await self._authority.journal_dispatch(self.binding, action)
                await self._check()
                if actor != self._mode or action.control_epoch != self._epoch:
                    await self._authority.settle_dispatch(self.binding, action, uncertain=False)
                    raise BrowserRefused("BROWSER_CONTROL_CHANGED")
            dispatch_action = action
            if action.operation == "resize":
                # Fence old coordinates and decoded frames before any layout effect.
                self._epoch += 1
                self._frame = None
                self._viewport = expected
                self._revision += 1
                # The reviewed owner command used the previous viewport epoch.
                # Its private execution/network scope must use the newly fenced
                # epoch. The ledger still settles the original exact command.
                scope = scope.model_copy(update={"control_epoch": self._epoch})
                dispatch_action = action.model_copy(update={"control_epoch": self._epoch})
            # Consume sequence BEFORE dispatch. A lost result cannot be replayed.
            self._sequence = action.sequence
            if actor == "agent":
                self._actions += 1
            try:
                async with asyncio.timeout(scope.remaining(self._wall_clock)):
                    frame = await self._executor.execute(dispatch_action, scope=scope)
                require_frame_geometry(frame, action, expected)
                await self._check()
                self.require_execution_scope(scope)
                if effect:
                    await self._authority.settle_dispatch(self.binding, action, uncertain=False)
                    self.require_execution_scope(scope)
                self._viewport = expected
                self._frame = frame
                self._revision += 1
                return frame
            except BaseException as exc:
                if isinstance(exc, BrowserRefused) and exc.code == "BROWSER_OUTCOME_UNCERTAIN":
                    self._outcome_uncertain = True
                    if self._mode != "stopped":
                        self._mode = "uncertain"
                        self._revision += 1
                if effect:
                    self._outcome_uncertain = True
                    if self._mode != "stopped":
                        self._mode = "uncertain"
                    # Keep the initial journal authoritative if settlement also
                    # fails; do not clear the uncertain fence in either case.
                    try:
                        async with asyncio.timeout(5):
                            await self._authority.settle_dispatch(
                                self.binding, action, uncertain=True
                            )
                    except Exception:
                        # The pending intent remains authoritative. A failed
                        # receipt write must not hang cancellation or permit replay.
                        pass
                raise
            finally:
                # Watching frames is not activity; an unattended preview must
                # not defeat the idle teardown. Model actions remain bounded.
                if action.operation != "observe" or actor == "agent":
                    self._last_activity = self._clock()

    async def take_control(self, *, interrupt: Callable[[], Awaitable[None]] | None = None) -> int:
        await self._check()
        if self._mode == "agent":
            self._active_seconds += max(0.0, self._clock() - self._agent_started)
        # Publish the observation/input fence before joining an active action.
        self._mode = "owner"
        self._epoch += 1
        self._revision += 1
        # Join startup before cancelling the model worker: cancellation closes a
        # partially initialized executor. The owner fence already blocks screens.
        if not self._initialized:
            await self.initialize()
        # Join the model only after the epoch fence, but before waiting for its
        # action lock. A blocked network/review action must be interruptible.
        if interrupt is not None:
            await interrupt()
        async with self._lock:
            await self._check()
            self._last_activity = self._clock()
            return self._epoch

    async def require_model_observation(self, *, expected_epoch: int | None = None) -> int:
        """Recheck before ADK sees a tool frame AND before each provider request."""
        await self._check()
        if self._mode != "agent" or (expected_epoch is not None and self._epoch != expected_epoch):
            raise BrowserRefused("BROWSER_MODEL_OBSERVATION_PAUSED")
        return self._epoch

    async def export_session(self, approved_origins: frozenset[str]) -> RememberedState:
        """Owner-only retention path, excluded from ADK tools and observations."""
        async with self._lock:
            await self._check()
            if self._mode != "owner" or not self._initialized:
                raise BrowserRefused("BROWSER_OWNER_CONTROL_REQUIRED")
            export = getattr(self._executor, "export_session", None)
            if export is None:
                raise BrowserRefused("BROWSER_SESSION_UNAVAILABLE")
            async with asyncio.timeout(30):
                state = await export(approved_origins)
            await self._check()
            if not isinstance(state, RememberedState):
                raise BrowserRefused("BROWSER_SESSION_STATE_REFUSED")
            return state.for_origins(approved_origins)

    async def import_session(
        self, state: RememberedState, approved_origins: frozenset[str]
    ) -> None:
        """Pass as BrowserSessions' guarded installation callback after reuse approval."""
        async with self._lock:
            await self._check()
            if self._mode != "owner" or not self._initialized:
                raise BrowserRefused("BROWSER_OWNER_CONTROL_REQUIRED")
            install = getattr(self._executor, "import_session", None)
            if install is None:
                raise BrowserRefused("BROWSER_SESSION_UNAVAILABLE")
            async with asyncio.timeout(30):
                await install(state.for_origins(approved_origins), approved_origins)
            await self._check()

    async def resume_agent(self) -> BrowserFrame:
        async with self._lock:
            await self._check()
            if self._mode != "owner":
                raise BrowserRefused("BROWSER_CONTROL_CHANGED")
            # Observe under owner control first. No credential-entry frames are
            # delivered to the model until explicit handback succeeds.
            action = BrowserAction(
                operation="observe", sequence=self.next_sequence, control_epoch=self._epoch
            )
            scope = BrowserExecutionScope(
                sequence=action.sequence,
                control_epoch=action.control_epoch,
                actor="owner",
                deadline_at=min(float(self.binding.expires_at), self._wall_clock() + 30),
            )
            await self._authority.authorize_action(self.binding, action, scope=scope)
            async with asyncio.timeout(scope.remaining(self._wall_clock)):
                frame = await self._executor.execute(action, scope=scope)
            require_frame_geometry(frame, action, self.viewport)
            await self._check()
            self._sequence = action.sequence
            self._frame = frame
            self._mode = "agent"
            self._agent_started = self._clock()
            self._epoch += 1
            self._revision += 1
            self._last_activity = self._clock()
            return frame

    async def stop(self) -> None:
        # Fence immediately, before waiting for an outstanding call. The driver
        # close interrupts its network and browser; already delivered effects
        # remain in the owning journal.
        self._mode = "stopped"
        self._epoch += 1
        self._revision += 1
        self._frame = None
        await self._executor.close()
        async with self._lock:
            self._initialized = False

    async def close_if_idle(self) -> bool:
        async with self._lock:
            if self._clock() - self._last_activity < 600:
                return False
            self._mode = "stopped"
            self._epoch += 1
            self._revision += 1
            self._frame = None
            await self._executor.close()
            self._initialized = False
            return True
