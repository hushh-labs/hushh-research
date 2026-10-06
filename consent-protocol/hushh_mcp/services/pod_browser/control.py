"""Exclusive browser control and bounded dispatch; no parallel approval ledger."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Literal

from .contracts import (
    BrowserAction,
    BrowserAuthorityPort,
    BrowserBinding,
    BrowserExecutionPort,
    BrowserFrame,
    BrowserReadiness,
    BrowserRefused,
)
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
        self._active_seconds = 0.0
        self._agent_started = clock()
        self._last_activity = clock()
        self._initialized = False

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
        self, action: BrowserAction, *, actor: Literal["agent", "owner"] = "agent"
    ) -> BrowserFrame:
        async with self._lock:
            await self._check()
            if actor != self._mode or action.control_epoch != self._epoch:
                raise BrowserRefused("BROWSER_CONTROL_CHANGED")
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
            await self._authority.authorize_action(self.binding, action)
            await self._check()
            effect = action.operation not in {"observe", "hover", "scroll"}
            if effect:
                await self._authority.journal_dispatch(self.binding, action)
                await self._check()
            # Consume sequence BEFORE dispatch. A lost result cannot be replayed.
            self._sequence = action.sequence
            if actor == "agent":
                self._actions += 1
            try:
                async with asyncio.timeout(30):
                    frame = await self._executor.execute(action)
                if frame.sequence != action.sequence or (frame.width, frame.height) != (1280, 720):
                    raise BrowserRefused("BROWSER_FRAME_MISMATCH")
                await self._check()
                if effect:
                    await self._authority.settle_dispatch(self.binding, action, uncertain=False)
                return frame
            except BaseException as exc:
                if isinstance(exc, BrowserRefused) and exc.code == "BROWSER_OUTCOME_UNCERTAIN":
                    if self._mode != "stopped":
                        self._mode = "uncertain"
                if effect:
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

    async def take_control(self) -> int:
        async with self._lock:
            await self._check()
            if self._mode == "agent":
                self._active_seconds += max(0.0, self._clock() - self._agent_started)
            self._mode = "owner"
            self._epoch += 1
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
            await self._authority.authorize_action(self.binding, action)
            async with asyncio.timeout(30):
                frame = await self._executor.execute(action)
            if frame.sequence != action.sequence or (frame.width, frame.height) != (1280, 720):
                raise BrowserRefused("BROWSER_FRAME_MISMATCH")
            await self._check()
            self._sequence = action.sequence
            self._mode = "agent"
            self._agent_started = self._clock()
            self._epoch += 1
            self._last_activity = self._clock()
            return frame

    async def stop(self) -> None:
        # Fence immediately, before waiting for an outstanding call. The driver
        # close interrupts its network and browser; already delivered effects
        # remain in the owning journal.
        self._mode = "stopped"
        self._epoch += 1
        await self._executor.close()
        async with self._lock:
            self._initialized = False

    async def close_if_idle(self) -> bool:
        async with self._lock:
            if self._clock() - self._last_activity < 600:
                return False
            self._mode = "stopped"
            self._epoch += 1
            await self._executor.close()
            self._initialized = False
            return True
