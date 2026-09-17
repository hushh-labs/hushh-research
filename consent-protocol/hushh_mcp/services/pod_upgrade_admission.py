"""Bounded admission for owner-pod work during an approved image update.

The hub may approve an update while a pod is answering a turn.  A lease on the
hub registry does not prove that the pod has finished that work, so this small
coordinator fences new turns and emits an idle receipt tied to the operation and
the current pod incarnation.  It is deliberately process-local: the pod's
authenticated lifecycle transport is the cross-process boundary, while the
durable turn/memory commit remains the pod log's responsibility.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


class PodUpgradeAdmissionRefused(RuntimeError):
    """A turn arrived after the pod began an upgrade handoff."""


@dataclass
class _State:
    incarnation: str
    operation_id: str | None = None
    draining: bool = False
    active: int = 0
    receipt: dict[str, Any] | None = None


def pod_incarnation() -> str:
    """The deployment incarnation used to bind handoff receipts."""
    return (
        str(
            os.getenv("HUSSH_POD_INCARNATION")
            or os.getenv("K_REVISION")
            or os.getenv("HUSSH_ID")
            or "unknown"
        ).strip()
        or "unknown"
    )[:256]


class TurnPermit:
    def __init__(self, admission: "PodUpgradeAdmission", key: str) -> None:
        self._admission = admission
        self._key = key
        self._released = False

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        await self._admission.release_turn(self._key)


class PodUpgradeAdmission:
    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._states: dict[str, _State] = {}

    async def acquire_turn(self, *, incarnation: str) -> TurnPermit:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            if state.draining:
                raise PodUpgradeAdmissionRefused("pod is preparing an approved update")
            state.active += 1
        return TurnPermit(self, key)

    async def release_turn(self, key: str) -> None:
        async with self._condition:
            state = self._states.get(key)
            if state is None:
                return
            state.active = max(0, state.active - 1)
            if state.active == 0:
                if state.draining and state.receipt is None:
                    state.receipt = self._receipt(state)
                self._condition.notify_all()

    @staticmethod
    def _receipt(state: _State) -> dict[str, Any]:
        operation = state.operation_id or ""
        committed = hashlib.sha256(
            f"{operation}|{state.incarnation}|active=0".encode("utf-8")
        ).hexdigest()
        return {
            "version": 1,
            "operationId": operation,
            "incarnation": state.incarnation,
            "activeWork": 0,
            "committedState": committed,
            "issuedAt": datetime.now(timezone.utc).isoformat(),
        }

    async def prepare(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
        operation = str(operation_id or "").strip()
        key = str(incarnation or "unknown").strip() or "unknown"
        if not operation:
            raise ValueError("operation_id is required")
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            if state.operation_id and state.operation_id != operation:
                raise PodUpgradeAdmissionRefused("another update handoff is active")
            state.operation_id = operation
            state.draining = True
            if state.active == 0:
                state.receipt = self._receipt(state)
            return self._snapshot(state)

    async def status(self, *, incarnation: str) -> dict[str, Any]:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            return self._snapshot(state)

    async def wait_idle(
        self, *, operation_id: str, incarnation: str, timeout: float = 0
    ) -> dict[str, Any]:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.get(key)
            if state is None or state.operation_id != operation_id or not state.draining:
                raise PodUpgradeAdmissionRefused("upgrade handoff is not active")
            if timeout > 0 and state.active:
                await asyncio.wait_for(
                    self._condition.wait_for(lambda: state.active == 0), timeout=timeout
                )
            if state.active == 0 and state.receipt is None:
                state.receipt = self._receipt(state)
            return self._snapshot(state)

    async def release(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.get(key)
            if state is None or state.operation_id != operation_id:
                raise PodUpgradeAdmissionRefused("upgrade handoff does not match this pod")
            if state.active:
                raise PodUpgradeAdmissionRefused("active pod work has not finished")
            state.draining = False
            state.operation_id = None
            state.receipt = None
            state.active = 0
            return self._snapshot(state)

    @staticmethod
    def _snapshot(state: _State) -> dict[str, Any]:
        return {
            "state": "draining"
            if state.draining and state.active
            else ("idle" if state.draining else "accepting"),
            "incarnation": state.incarnation,
            "operationId": state.operation_id,
            "activeWork": state.active,
            "idleReceipt": state.receipt,
        }


ADMISSION = PodUpgradeAdmission()


__all__ = [
    "ADMISSION",
    "PodUpgradeAdmission",
    "PodUpgradeAdmissionRefused",
    "TurnPermit",
    "pod_incarnation",
]
