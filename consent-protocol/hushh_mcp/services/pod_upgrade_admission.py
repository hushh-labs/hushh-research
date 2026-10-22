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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from hushh_mcp.services.pod_platform import pod_revision_name


class PodUpgradeAdmissionRefused(RuntimeError):
    """A turn arrived after the pod began an upgrade handoff."""


class PodUpgradeInProgress(PodUpgradeAdmissionRefused):
    """An approved update fences new work; other recovery refusals stay distinct."""


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
    drain_hooks_complete: bool = True
    retained_idle_record: dict[str, Any] | None = None
    release_receipt: dict[str, Any] | None = None


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


def _restore_lifecycle(state: _State, records: list[dict], runtime_epoch: str) -> None:
    """Project sealed markers without treating an old runtime's idle as current."""
    for record in records:
        kind, payload = record.get("kind"), record.get("payload")
        if kind not in {"pod_upgrade_fence", "pod_upgrade_idle", "pod_upgrade_release"}:
            continue
        if not isinstance(payload, dict) or payload.get("incarnation") != state.incarnation:
            continue
        if kind == "pod_upgrade_release":
            state.release_receipt = {
                "operationId": payload["operationId"],
                "incarnation": payload["incarnation"],
                "runtimeEpoch": payload["runtimeEpoch"],
                "releaseRecord": _record_cursor(record),
                "retainedIdleRecord": payload.get("retainedIdleRecord"),
                "expectedIdleRecord": payload.get("expectedIdleRecord"),
            }
            state.operation_id, state.draining = None, False
            state.receipt, state.fence_record, state.retained_idle_record = None, None, None
            continue
        operation = str(payload.get("operationId") or "") or None
        if operation != state.operation_id:
            state.retained_idle_record, state.receipt = None, None
        state.operation_id, state.draining = operation, bool(operation)
        state.fence_record, state.release_receipt = record, None
        if kind == "pod_upgrade_idle":
            receipt = payload.get("idleReceipt")
            if (
                not isinstance(receipt, dict)
                or receipt.get("operationId") != operation
                or receipt.get("incarnation") != state.incarnation
                or receipt.get("runtimeEpoch") != payload.get("runtimeEpoch")
            ):
                raise PodUpgradeAdmissionRefused("pod lifecycle idle binding is invalid")
            cursor = _record_cursor(record)
            if state.retained_idle_record is None:
                state.retained_idle_record = cursor
            state.receipt = (
                {**receipt, "idleRecord": cursor}
                if receipt.get("runtimeEpoch") == runtime_epoch
                else None
            )


def _snapshot(state: _State, runtime_epoch: str) -> dict[str, Any]:
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
        "runtimeEpoch": state.runtime_epoch or runtime_epoch,
        "durable": bool(state.fence_record),
        "retainedIdleRecord": state.retained_idle_record,
        "releaseReceipt": state.release_receipt,
    }


def pod_incarnation() -> str:
    """The deployment incarnation used to bind handoff receipts."""
    from hushh_mcp.services.pod_azure_vm_identity import active_vm_installation

    vm = active_vm_installation()
    if vm is not None:
        return vm.generation
    return (
        str(
            os.getenv("HUSSH_POD_INCARNATION")
            or pod_revision_name()
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
        self._drain_hooks: dict[str, dict[str, Callable[[], Awaitable[None]]]] = {}

    def register_drain(
        self, *, incarnation: str, name: str, callback: Callable[[], Awaitable[None]]
    ) -> None:
        """Trusted runtime lifecycle hook, invoked after the durable update fence.

        Hooks close resource-backed work; its existing turn permits remain held
        until close and sealed state commit both succeed. Registration is not
        caller-provided authority and cannot replace a live runtime's hook.
        """
        hooks = self._drain_hooks.setdefault(incarnation, {})
        if name in hooks and hooks[name] != callback:
            raise PodUpgradeAdmissionRefused("pod lifecycle hook already registered")
        hooks[name] = callback

    def _log(self) -> Any:
        if self._log_resolver is not None:
            return self._log_resolver()
        try:
            from hushh_mcp.services.pod_memory_service import _resolve_log

            return _resolve_log()
        except Exception:  # noqa: BLE001 - an unconfigured pod has no durable log
            return None

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
        _record_cursor(record)
        return dict(record)

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
        return _record_cursor(records[-1])

    async def _hydrate(self, state: _State) -> None:
        if state.hydrated:
            return
        log = self._log()
        if log is None:
            state.hydrated = True
            return
        try:
            from hushh_mcp.services.pod_recovery_projection import replay_owner_records

            records = await replay_owner_records(log)
        except Exception as exc:  # noqa: BLE001 - refusing is safer than guessing idle
            state.hydrated = False
            raise PodUpgradeAdmissionRefused(
                f"pod lifecycle recovery unavailable: {type(exc).__name__}"
            ) from exc
        _restore_lifecycle(state, records, self._runtime_epoch)
        state.hydrated = True

    async def acquire_turn(self, *, incarnation: str) -> TurnPermit:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            await self._hydrate(state)
            if state.draining:
                raise PodUpgradeInProgress("pod is preparing an approved update")
            state.active += 1
        return TurnPermit(self, key)

    async def release_turn(self, key: str) -> None:
        async with self._condition:
            state = self._states.get(key)
            if state is None:
                return
            state.active = max(0, state.active - 1)
            if state.active == 0:
                if state.draining and state.drain_hooks_complete and state.receipt is None:
                    state.receipt = await self._persist_idle(state)
                self._condition.notify_all()

    async def _persist_idle(self, state: _State) -> dict[str, Any]:
        operation = state.operation_id or ""
        _record_cursor(state.fence_record)
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
        try:
            marker = await self._append_marker(
                "pod_upgrade_idle",
                {
                    "operationId": operation,
                    "incarnation": state.incarnation,
                    "runtimeEpoch": self._runtime_epoch,
                    "idleReceipt": receipt,
                },
            )
        except (Exception, asyncio.CancelledError):
            state.hydrated = False
            raise
        receipt["idleRecord"] = _record_cursor(marker)
        if state.retained_idle_record is None:
            state.retained_idle_record = receipt["idleRecord"]
        return receipt

    async def prepare(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
        operation = str(operation_id or "").strip()
        key = str(incarnation or "unknown").strip() or "unknown"
        if not operation:
            raise ValueError("operation_id is required")
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            await self._hydrate(state)
            released = state.release_receipt or {}
            if released.get("operationId") == operation and released.get("expectedIdleRecord"):
                raise PodUpgradeAdmissionRefused("this handoff was already released")
            if state.operation_id and state.operation_id != operation:
                raise PodUpgradeAdmissionRefused("another update handoff is active")
            state.operation_id = operation
            state.draining = True
            state.runtime_epoch = self._runtime_epoch
            callbacks = tuple(self._drain_hooks.get(key, {}).values())
            if callbacks:
                state.drain_hooks_complete = False
                state.receipt = None
            if state.fence_record is None:
                state.release_receipt = None
                state.retained_idle_record = None
                state.fence_record = await self._append_marker(
                    "pod_upgrade_fence",
                    {
                        "operationId": operation,
                        "incarnation": key,
                        "runtimeEpoch": self._runtime_epoch,
                    },
                )
            if state.active == 0 and state.drain_hooks_complete and state.receipt is None:
                state.receipt = await self._persist_idle(state)
        # A browser close releases a turn permit; running under _condition
        # would deadlock release_turn and could hide an unconfirmed shutdown.
        for callback in callbacks:
            await callback()
        async with self._condition:
            state.drain_hooks_complete = True
            if state.active == 0 and state.receipt is None:
                state.receipt = await self._persist_idle(state)
            self._condition.notify_all()
            return _snapshot(state, self._runtime_epoch)

    async def status(self, *, incarnation: str) -> dict[str, Any]:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            await self._hydrate(state)
            return _snapshot(state, self._runtime_epoch)

    async def wait_idle(
        self, *, operation_id: str, incarnation: str, timeout: float = 0
    ) -> dict[str, Any]:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.get(key)
            if state is not None:
                await self._hydrate(state)
            if state is None or state.operation_id != operation_id or not state.draining:
                raise PodUpgradeAdmissionRefused("upgrade handoff is not active")
            if timeout > 0 and (state.active or not state.drain_hooks_complete):
                await asyncio.wait_for(
                    self._condition.wait_for(
                        lambda: state.active == 0 and state.drain_hooks_complete
                    ),
                    timeout=timeout,
                )
            if state.active == 0 and state.drain_hooks_complete and state.receipt is None:
                state.receipt = await self._persist_idle(state)
            return _snapshot(state, self._runtime_epoch)

    async def release(
        self,
        *,
        operation_id: str,
        incarnation: str,
        expected_idle_record: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        key = str(incarnation or "unknown").strip() or "unknown"
        async with self._condition:
            state = self._states.setdefault(key, _State(incarnation=key))
            await self._hydrate(state)
            released = state.release_receipt
            if (
                state.operation_id is None
                and released
                and released.get("operationId") == operation_id
            ):
                if expected_idle_record is not None and (
                    released.get("retainedIdleRecord") != expected_idle_record
                    or released.get("expectedIdleRecord") != expected_idle_record
                ):
                    raise PodUpgradeAdmissionRefused("retained idle record does not match")
                return _snapshot(state, self._runtime_epoch)
            if state.operation_id != operation_id:
                raise PodUpgradeAdmissionRefused("upgrade handoff does not match this pod")
            if (
                expected_idle_record is not None
                and state.retained_idle_record != expected_idle_record
            ):
                raise PodUpgradeAdmissionRefused("retained idle record does not match")
            if state.active or not state.drain_hooks_complete:
                raise PodUpgradeAdmissionRefused("active pod work has not finished")
            payload = {
                "operationId": operation_id,
                "incarnation": key,
                "runtimeEpoch": self._runtime_epoch,
                "retainedIdleRecord": state.retained_idle_record,
                "expectedIdleRecord": expected_idle_record,
            }
            try:
                marker = await self._append_marker("pod_upgrade_release", payload)
            except (Exception, asyncio.CancelledError):
                # The append may have committed before its response was lost.
                # Re-read the sealed log before admitting work or retrying release.
                state.hydrated = False
                raise
            state.release_receipt = {**payload, "releaseRecord": _record_cursor(marker)}
            state.draining = False
            state.operation_id = None
            state.receipt = None
            state.active = 0
            state.fence_record = None
            state.retained_idle_record = None
            state.drain_hooks_complete = True
            return _snapshot(state, self._runtime_epoch)


ADMISSION = PodUpgradeAdmission()


__all__ = [
    "ADMISSION",
    "PodUpgradeAdmission",
    "PodUpgradeAdmissionRefused",
    "TurnPermit",
    "pod_incarnation",
]
