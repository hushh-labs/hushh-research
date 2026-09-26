"""Bounded admission for owner-pod work during an approved image update.

The hub may approve an update while a pod is answering a turn.  A lease on the
hub registry does not prove that the pod has finished that work, so this small
coordinator fences new turns and emits an idle receipt tied to the operation and
the current pod incarnation.  The fast counter is process-local, while
lifecycle markers and idle receipts are appended to the pod's encrypted
commit log so a restart cannot pretend a previous runtime was idle. Ordinary
turns can run without a configured log, but update handoff requires durable
fence, commit-position and idle-record evidence.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


class PodUpgradeAdmissionRefused(RuntimeError):
    """A turn arrived after the pod began an upgrade handoff."""


@dataclass
class _State:
    incarnation: str
    operation_id: str | None = None
    draining: bool = False
    active: int = 0
    receipt: dict[str, Any] | None = None
    runtime_epoch: str = ""
    fence_record: dict[str, Any] | None = None
    hydrated: bool = False


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
    def __init__(
        self,
        *,
        log_resolver: Callable[[], Any] | None = None,
        runtime_epoch: str | None = None,
    ) -> None:
        self._condition = asyncio.Condition()
        self._states: dict[str, _State] = {}
        self._log_resolver = log_resolver
        # A restart invalidates receipts issued by the previous runtime.
        self._runtime_epoch = str(runtime_epoch or uuid4().hex).strip()[:256]

    def _log(self) -> Any:
        if self._log_resolver is not None:
            return self._log_resolver()
        try:
            from hushh_mcp.services.pod_memory_service import _resolve_log

            return _resolve_log()
        except Exception:  # noqa: BLE001 - an unconfigured pod has no durable log
            return None

    @staticmethod
    def _record_cursor(record: Any) -> dict[str, Any]:
        if (
            not isinstance(record, dict)
            or type(record.get("seq")) is not int
            or record["seq"] < 1
            or not isinstance(record.get("sha"), str)
            or not record["sha"].strip()
        ):
            raise PodUpgradeAdmissionRefused("pod lifecycle durable receipt unavailable")
        return {"seq": record["seq"], "sha": record["sha"]}

    async def _append_marker(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        log = self._log()
        if log is None:
            raise PodUpgradeAdmissionRefused("pod lifecycle durable storage unavailable")
        try:
            record = await log.append(kind, payload)
        except Exception as exc:
            raise PodUpgradeAdmissionRefused(
                f"pod lifecycle durable append unavailable: {type(exc).__name__}"
            ) from exc
        self._record_cursor(record)
        return record

    async def _cursor(self) -> dict[str, Any]:
        log = self._log()
        if log is None:
            raise PodUpgradeAdmissionRefused("pod lifecycle durable storage unavailable")
        try:
            records = await log.replay()
        except Exception as exc:
            raise PodUpgradeAdmissionRefused(
                f"pod lifecycle durable cursor unavailable: {type(exc).__name__}"
            ) from exc
        if not records:
            raise PodUpgradeAdmissionRefused("pod lifecycle durable cursor unavailable")
        return self._record_cursor(records[-1])

    async def _hydrate(self, state: _State) -> None:
        if state.hydrated:
            return
        state.hydrated = True
        log = self._log()
        if log is None:
            return
        try:
            records = await log.replay()
        except Exception as exc:  # noqa: BLE001 - refusing is safer than guessing idle
            state.hydrated = False
            raise PodUpgradeAdmissionRefused(
                f"pod lifecycle recovery unavailable: {type(exc).__name__}"
            ) from exc
        for record in records:
            if record.get("kind") not in {
                "pod_upgrade_fence",
                "pod_upgrade_idle",
                "pod_upgrade_release",
            }:
                continue
            payload = record.get("payload")
            if not isinstance(payload, dict) or payload.get("incarnation") != state.incarnation:
                continue
            if record["kind"] == "pod_upgrade_release":
                state.operation_id = None
                state.draining = False
                state.receipt = None
                state.fence_record = None
                continue
            state.operation_id = str(payload.get("operationId") or "") or None
            state.draining = bool(state.operation_id)
            state.fence_record = record
            if record["kind"] == "pod_upgrade_idle":
                receipt = payload.get("idleReceipt")
                if isinstance(receipt, dict) and receipt.get("runtimeEpoch") == self._runtime_epoch:
                    state.receipt = receipt
                else:
                    state.receipt = None

    async def acquire_turn(self, *, incarnation: str) -> TurnPermit:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            await self._hydrate(state)
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
                    state.receipt = await self._persist_idle(state)
                self._condition.notify_all()

    async def _persist_idle(self, state: _State) -> dict[str, Any]:
        operation = state.operation_id or ""
        self._record_cursor(state.fence_record)
        cursor = await self._cursor()
        committed = hashlib.sha256(
            f"{operation}|{state.incarnation}|{cursor['seq']}|{cursor['sha']}|active=0".encode(
                "utf-8"
            )
        ).hexdigest()
        receipt: dict[str, Any] = {
            "version": 1,
            "operationId": operation,
            "incarnation": state.incarnation,
            "runtimeEpoch": self._runtime_epoch,
            "activeWork": 0,
            "committedState": committed,
            "issuedAt": datetime.now(timezone.utc).isoformat(),
        }
        receipt["committedCursor"] = cursor
        marker = await self._append_marker(
            "pod_upgrade_idle",
            {
                "operationId": operation,
                "incarnation": state.incarnation,
                "runtimeEpoch": self._runtime_epoch,
                "idleReceipt": receipt,
            },
        )
        receipt["idleRecord"] = self._record_cursor(marker)
        return receipt

    async def prepare(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
        operation = str(operation_id or "").strip()
        key = str(incarnation or "unknown").strip() or "unknown"
        if not operation:
            raise ValueError("operation_id is required")
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            await self._hydrate(state)
            if state.operation_id and state.operation_id != operation:
                raise PodUpgradeAdmissionRefused("another update handoff is active")
            state.operation_id = operation
            state.draining = True
            state.runtime_epoch = self._runtime_epoch
            if state.fence_record is None:
                state.fence_record = await self._append_marker(
                    "pod_upgrade_fence",
                    {
                        "operationId": operation,
                        "incarnation": key,
                        "runtimeEpoch": self._runtime_epoch,
                    },
                )
            if state.active == 0:
                state.receipt = await self._persist_idle(state)
            return self._snapshot(state)

    async def status(self, *, incarnation: str) -> dict[str, Any]:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            await self._hydrate(state)
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
                state.receipt = await self._persist_idle(state)
            return self._snapshot(state)

    async def release(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.get(key)
            if state is None or state.operation_id != operation_id:
                raise PodUpgradeAdmissionRefused("upgrade handoff does not match this pod")
            if state.active:
                raise PodUpgradeAdmissionRefused("active pod work has not finished")
            await self._append_marker(
                "pod_upgrade_release",
                {
                    "operationId": operation_id,
                    "incarnation": key,
                    "runtimeEpoch": self._runtime_epoch,
                },
            )
            state.draining = False
            state.operation_id = None
            state.receipt = None
            state.active = 0
            state.fence_record = None
            return self._snapshot(state)

    def _snapshot(self, state: _State) -> dict[str, Any]:
        return {
            "state": (
                "draining"
                if state.draining and (state.active or state.receipt is None)
                else ("idle" if state.draining else "accepting")
            ),
            "incarnation": state.incarnation,
            "operationId": state.operation_id,
            "activeWork": state.active,
            "idleReceipt": state.receipt,
            "runtimeEpoch": state.runtime_epoch or self._runtime_epoch,
            "durable": bool(state.fence_record),
        }


ADMISSION = PodUpgradeAdmission()


__all__ = [
    "ADMISSION",
    "PodUpgradeAdmission",
    "PodUpgradeAdmissionRefused",
    "TurnPermit",
    "pod_incarnation",
]
