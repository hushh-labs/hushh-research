"""Owner-scoped writer leases in the existing sealed log and head CAS.

Lease expiry permits a competing CAS, never deletion or a claim that a process is
terminated. Uncertain external effects retain their existing action journals.
"""

from __future__ import annotations

import asyncio
import time
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.services.pod_commit_log import (
    PodCommitLog,
    PodLogConflict,
    PodLogFenced,
    PodLogTampered,
)

KIND = "pod_runtime_writer"
LEASE_MS = 30_000
RENEW_SECONDS = 10


@dataclass
class RuntimeWriter:
    owner: str
    epoch: str
    incarnation: str
    operation: str
    clock: Any = lambda: int(time.time() * 1000)
    cursor: Any = None
    lease: dict | None = None
    handoff: dict | None = None
    held_once: bool = False
    lost: bool = False
    active: int = 0
    task: asyncio.Task | None = field(default=None, repr=False)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    async def refresh(self, log: PodCommitLog) -> int:
        if log._owner_id != self.owner:
            raise PodLogFenced("Runtime writer owner does not match its sealed log")
        records, cursor = await PodCommitLog.replay_since(log, self.cursor)
        for record in records:
            self.project(record)
        self.cursor = cursor
        if self.held_once and self.lease and self.lease["runtimeEpoch"] != self.epoch:
            self.lost = True
        return cursor.seq if cursor else 0

    def project(self, record: dict) -> None:
        kind, value = record.get("kind"), record.get("payload")
        if kind == KIND:
            validate_lease(value, self.owner, self.lease)
            if self.lease and value["runtimeEpoch"] != self.lease["runtimeEpoch"]:
                if self.handoff and (
                    self.handoff["phase"] != "idle"
                    or value["operationId"] != self.handoff["operationId"]
                ):
                    raise PodLogTampered("Writer succession lacks approved idle authority")
                if not self.handoff and value["issuedAtMs"] < self.lease["expiresAtMs"]:
                    raise PodLogTampered("Writer takeover preceded lease expiry")
                self.handoff = None
            elif self.handoff and self.handoff["phase"] == "idle":
                raise PodLogTampered("Idle writer cannot renew before cancellation")
            self.lease = dict(value)
            if value["runtimeEpoch"] == self.epoch:
                self.held_once = True
            return
        if kind not in {"pod_upgrade_fence", "pod_upgrade_idle", "pod_upgrade_release"}:
            return
        if (
            not self.lease
            or not isinstance(value, dict)
            or (value.get("runtimeEpoch"), value.get("incarnation"))
            != (self.lease["runtimeEpoch"], self.lease["incarnation"])
        ):
            raise PodLogTampered("Writer handoff identity changed")
        operation = value.get("operationId")
        if not isinstance(operation, str) or not 1 <= len(operation) <= 256:
            raise PodLogTampered("Writer handoff operation is invalid")
        if kind == "pod_upgrade_fence":
            self.handoff = {"operationId": operation, "phase": "draining"}
        elif not self.handoff or self.handoff["operationId"] != operation:
            raise PodLogTampered("Writer handoff has no matching fence")
        elif kind == "pod_upgrade_idle":
            self.handoff["phase"] = "idle"
        else:
            self.handoff = None

    async def ensure(self, log: PodCommitLog, *, snapshot: int | None = None) -> int:
        seq = await self.refresh(log)
        if snapshot is not None and snapshot != seq:
            raise PodLogConflict("The caller's writer snapshot changed")
        if self.lost:
            raise PodLogFenced("This runtime lost writer ownership")
        own = self.lease and self.lease["runtimeEpoch"] == self.epoch
        now = self.clock()
        if own and self.handoff and self.handoff["phase"] == "idle":
            raise PodLogFenced("Approved handoff closed this writer")
        if not own and self.lease:
            if self.handoff:
                if self.handoff != {"phase": "idle", "operationId": self.operation}:
                    raise PodLogFenced("Writer succession requires its approved handoff")
            elif self.lease["expiresAtMs"] > now:
                raise PodLogFenced("Another runtime holds the writer lease")
        if self.lease is None and seq != 0:
            raise PodLogFenced("Existing history needs explicit writer activation")
        if not own or self.lease["expiresAtMs"] <= now + LEASE_MS // 3:
            if snapshot is not None:
                raise PodLogConflict("Renew writer authority before taking a mutation snapshot")
            await self.claim(log, seq)
            seq = await self.refresh(log)
        self.held_once = True
        return seq

    async def claim(self, log: PodCommitLog, seq: int) -> None:
        now = self.clock()
        receipt = {
            "version": 1,
            "ownerId": self.owner,
            "runtimeEpoch": self.epoch,
            "incarnation": self.incarnation,
            "generation": (self.lease or {}).get("generation", 0) + 1,
            "issuedAtMs": now,
            "expiresAtMs": now + LEASE_MS,
            "operationId": self.operation,
        }
        try:
            await PodCommitLog.append(log, KIND, receipt, expected_seq=seq)
        except BaseException as error:
            # Retain observed ownership, but cancellation still ends its task.
            await self.refresh(log)
            if isinstance(error, asyncio.CancelledError) or self.lease != receipt:
                raise
        self.held_once = True

    async def append(
        self, log: PodCommitLog, kind: str, payload: Any, snapshot: int | None
    ) -> dict:
        if kind == KIND:
            raise PodLogFenced("Writer claims are internal lifecycle operations")
        async with self.lock:
            for _ in range(log._max_retries):
                # Cancellation is permitted only by the old writer before succession.
                await self.refresh(log)
                cancelling = bool(
                    self.lease
                    and self.lease["runtimeEpoch"] == self.epoch
                    and self.handoff
                    and kind == "pod_upgrade_release"
                    and isinstance(payload, dict)
                    and payload.get("operationId") == self.handoff["operationId"]
                    and payload.get("runtimeEpoch") == self.epoch
                )
                if cancelling:
                    seq = self.cursor.seq
                    if self.lost or (snapshot is not None and snapshot != seq):
                        raise PodLogFenced("Writer cancellation lost authority")
                else:
                    seq = await self.ensure(log, snapshot=snapshot)
                self.validate_control(kind, payload)
                try:
                    record = await PodCommitLog.append(log, kind, payload, expected_seq=seq)
                    await self.refresh(log)
                    return record
                except PodLogConflict:
                    if snapshot is not None:
                        raise
            raise PodLogConflict("Writer ownership kept changing")

    def validate_control(self, kind: str, payload: Any) -> None:
        if kind not in {"pod_upgrade_fence", "pod_upgrade_idle", "pod_upgrade_release"}:
            return
        before_lease, before_handoff = deepcopy(self.lease), deepcopy(self.handoff)
        try:
            self.project({"kind": kind, "payload": payload})
        finally:
            self.lease, self.handoff = before_lease, before_handoff

    async def hold(self, log: Any) -> None:
        async with self.lock:
            await self.ensure(log)
            self.active += 1
            if self.task is None:
                self.task = asyncio.create_task(
                    self.heartbeat(log), name="pod-runtime-writer-renewal"
                )

    async def release(self) -> None:
        self.active = max(0, self.active - 1)
        if self.active == 0 and self.task is not None:
            task, self.task = self.task, None
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def heartbeat(self, log: Any) -> None:
        try:
            while self.active:
                await asyncio.sleep(RENEW_SECONDS)
                async with self.lock:
                    # Preserve the existing placement-role gate for renewal too.
                    role = await log.read_role(fresh=True)
                    if role.is_standby:
                        raise PodLogFenced("A standby cannot renew primary writer authority")
                    await self.ensure(log)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.lost = True


def validate_lease(value: Any, owner: str, previous: dict | None) -> None:
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "version",
            "ownerId",
            "runtimeEpoch",
            "incarnation",
            "generation",
            "issuedAtMs",
            "expiresAtMs",
            "operationId",
        }
        or value["version"] != 1
        or isinstance(value["version"], bool)
        or value["ownerId"] != owner
        or any(
            not isinstance(value[k], str) or not 1 <= len(value[k]) <= 256
            for k in ("runtimeEpoch", "incarnation", "operationId")
        )
        or any(type(value[k]) is not int for k in ("generation", "issuedAtMs", "expiresAtMs"))
        or value["generation"] != (previous or {}).get("generation", 0) + 1
        or value["issuedAtMs"] < 0
        or value["expiresAtMs"] - value["issuedAtMs"] != LEASE_MS
    ):
        raise PodLogTampered("Runtime writer lease is malformed")


_WRITERS: dict[tuple[str, str], RuntimeWriter] = {}


def runtime_writer() -> RuntimeWriter | None:
    from hushh_mcp.services.private_gcp_deployment import hosted_runtime_deployment

    deployment = hosted_runtime_deployment()
    if deployment is None:
        return None
    import os

    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    if os.getenv("HUSSH_POD_WRITER_PROTOCOL") != "1":
        raise PodLogFenced("Managed writer protocol is not qualified")
    operation = os.getenv("HUSSH_POD_WRITER_OPERATION", "")
    if not 1 <= len(operation) <= 256 or operation == "unassigned":
        raise PodLogFenced("Managed writer activation is unavailable")
    key = (deployment.project, deployment.owner)
    writer = _WRITERS.get(key)
    if writer is None:
        writer = RuntimeWriter(
            deployment.owner, ADMISSION._runtime_epoch, pod_incarnation(), operation
        )
        _WRITERS[key] = writer
    elif writer.epoch != ADMISSION._runtime_epoch:
        raise PodLogFenced("Runtime identity changed within this process")
    return writer
