"""Durable owner-pod task lifecycle over the existing sealed commit log.

This is a projection over the pod's one persistence authority. It does not add a
queue, broker, or second database. A task snapshot is sealed in the same log as
pod memory and custody records; a process replacement leaves a running task
``interrupted`` rather than replaying an uncertain model or external action.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from dataclasses import dataclass, replace
from typing import Any, Literal
from uuid import uuid4

from hushh_mcp.services.pod_commit_log import PodCommitLog

TASK_EVENT_KIND = "pod_agent_task.v1"
TaskState = Literal[
    "queued",
    "running",
    "completed",
    "failed",
    "cancel_requested",
    "cancelled",
    "interrupted",
]

MAX_TASK_ID_CHARS = 64
MAX_IDEMPOTENCY_KEY_CHARS = 128
MAX_MESSAGE_CHARS = 8_000
MAX_RESPONSE_CHARS = 16_000
MAX_CONVERSATION_ID_CHARS = 128
MAX_TIMEZONE_CHARS = 64
MAX_DEVICE_ID_CHARS = 128
_TASK_ID_RE = re.compile(r"^task_[a-f0-9]{32}$")


class PodTaskInvalid(ValueError):
    """A task request or stored snapshot is invalid."""


class PodTaskNotFound(LookupError):
    """The task is not owned by this pod or does not exist."""


class PodTaskConflict(RuntimeError):
    """An idempotency or lifecycle precondition failed."""


@dataclass(frozen=True)
class PodTask:
    task_id: str
    owner_user_id: str
    hushh_id: str
    agent_id: str
    idempotency_key: str
    request_digest: str
    message: str
    conversation_id: str
    timezone: str | None
    runtime_provider: str | None
    puppy_device_id: str | None
    state: TaskState
    result: str | None
    error_code: str | None
    created_at_ms: int
    updated_at_ms: int
    generation: int

    def safe_projection(self) -> dict[str, Any]:
        """Return the external shape without owner identity or task input."""
        return {
            "task_id": self.task_id,
            "state": self.state,
            "conversation_id": self.conversation_id,
            "runtime_provider": self.runtime_provider,
            "puppy_device_id": self.puppy_device_id,
            "result": self.result if self.state == "completed" else None,
            "error_code": self.error_code,
            "created_at_ms": self.created_at_ms,
            "updated_at_ms": self.updated_at_ms,
            "generation": self.generation,
        }


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean_text(value: Any, *, name: str, max_chars: int, required: bool = True) -> str:
    if not isinstance(value, str):
        raise PodTaskInvalid(f"{name} is invalid")
    value = value.strip()
    if required and not value:
        raise PodTaskInvalid(f"{name} is required")
    if len(value) > max_chars:
        raise PodTaskInvalid(f"{name} is too long")
    return value


def task_request_digest(
    *,
    message: str,
    conversation_id: str,
    timezone: str | None,
    runtime_provider: str | None,
    puppy_device_id: str | None,
) -> str:
    payload = {
        "conversation_id": conversation_id,
        "message": message,
        "puppy_device_id": puppy_device_id,
        "runtime_provider": runtime_provider,
        "timezone": timezone,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def validate_task_input(arguments: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise PodTaskInvalid("task arguments must be an object")
    allowed = {
        "message",
        "conversation_id",
        "timezone",
        "runtime_provider",
        "puppy_device_id",
        "idempotency_key",
    }
    unexpected = set(arguments) - allowed
    if unexpected:
        raise PodTaskInvalid("unsupported task fields")
    message = _clean_text(arguments.get("message"), name="message", max_chars=MAX_MESSAGE_CHARS)
    conversation_id = _clean_text(
        arguments.get("conversation_id", "consumer-mcp"),
        name="conversation_id",
        max_chars=MAX_CONVERSATION_ID_CHARS,
    )
    timezone = arguments.get("timezone")
    if timezone is not None:
        timezone = (
            _clean_text(timezone, name="timezone", max_chars=MAX_TIMEZONE_CHARS, required=False)
            or None
        )
    runtime_provider = arguments.get("runtime_provider")
    if runtime_provider is not None:
        runtime_provider = _clean_text(
            runtime_provider, name="runtime_provider", max_chars=32
        ).lower()
        if runtime_provider != "puppy":
            raise PodTaskInvalid("runtime_provider must be puppy when provided")
    puppy_device_id = arguments.get("puppy_device_id")
    if puppy_device_id is not None:
        puppy_device_id = _clean_text(
            puppy_device_id, name="puppy_device_id", max_chars=MAX_DEVICE_ID_CHARS
        )
    if runtime_provider == "puppy" and puppy_device_id is None:
        raise PodTaskInvalid("puppy_device_id is required for Puppy inference")
    if runtime_provider is None and puppy_device_id is not None:
        raise PodTaskInvalid("runtime_provider=puppy is required for a Puppy device")
    idempotency_key = _clean_text(
        arguments.get("idempotency_key", ""),
        name="idempotency_key",
        max_chars=MAX_IDEMPOTENCY_KEY_CHARS,
        required=False,
    )
    return {
        "message": message,
        "conversation_id": conversation_id,
        "timezone": timezone,
        "runtime_provider": runtime_provider,
        "puppy_device_id": puppy_device_id,
        "idempotency_key": idempotency_key,
    }


class PodTaskStore:
    """Owner-bound task snapshots backed by the pod's sealed log."""

    def __init__(self, log: PodCommitLog, *, owner_user_id: str, hushh_id: str, agent_id: str):
        if not owner_user_id.strip() or not hushh_id.strip() or not agent_id.strip():
            raise PodTaskInvalid("task owner binding is required")
        if getattr(log, "_owner_id", None) != hushh_id:
            raise PodTaskInvalid("task owner binding does not match the log")
        self._log = log
        self._owner_user_id = owner_user_id
        self._hushh_id = hushh_id
        self._agent_id = agent_id
        self._lock = asyncio.Lock()

    def _decode(self, payload: Any) -> PodTask:
        if not isinstance(payload, dict):
            raise PodTaskInvalid("task snapshot invalid")
        try:
            task = PodTask(**payload)
        except (TypeError, ValueError):
            raise PodTaskInvalid("task snapshot invalid") from None
        if (
            not _TASK_ID_RE.fullmatch(task.task_id)
            or task.owner_user_id != self._owner_user_id
            or task.hushh_id != self._hushh_id
            or task.agent_id != self._agent_id
            or len(task.message) > MAX_MESSAGE_CHARS
            or len(task.conversation_id) > MAX_CONVERSATION_ID_CHARS
            or task.timezone is not None
            and len(task.timezone) > MAX_TIMEZONE_CHARS
            or task.result is not None
            and len(task.result) > MAX_RESPONSE_CHARS
            or task.generation < 1
            or task.created_at_ms < 1
            or task.updated_at_ms < task.created_at_ms
            or task.state
            not in {
                "queued",
                "running",
                "completed",
                "failed",
                "cancel_requested",
                "cancelled",
                "interrupted",
            }
        ):
            raise PodTaskInvalid("task snapshot binding invalid")
        return task

    async def _latest(self) -> dict[str, PodTask]:
        records = await self._log.replay()
        latest: dict[str, PodTask] = {}
        for record in records:
            if record.get("kind") != TASK_EVENT_KIND:
                continue
            task = self._decode(record.get("payload"))
            previous = latest.get(task.task_id)
            if previous is not None and task.generation != previous.generation + 1:
                raise PodTaskInvalid("task generation is not contiguous")
            latest[task.task_id] = task
        return latest

    async def create(self, *, arguments: dict[str, Any]) -> PodTask:
        values = validate_task_input(arguments)
        digest = task_request_digest(
            **{key: values[key] for key in values if key != "idempotency_key"}
        )
        async with self._lock:
            latest = await self._latest()
            if values["idempotency_key"]:
                for task in latest.values():
                    if task.idempotency_key == values["idempotency_key"]:
                        if task.request_digest != digest:
                            raise PodTaskConflict("idempotency key is bound to another task")
                        return task
            now = _now_ms()
            task = PodTask(
                task_id=f"task_{uuid4().hex}",
                owner_user_id=self._owner_user_id,
                hushh_id=self._hushh_id,
                agent_id=self._agent_id,
                idempotency_key=values["idempotency_key"],
                request_digest=digest,
                message=values["message"],
                conversation_id=values["conversation_id"],
                timezone=values["timezone"],
                runtime_provider=values["runtime_provider"],
                puppy_device_id=values["puppy_device_id"],
                state="queued",
                result=None,
                error_code=None,
                created_at_ms=now,
                updated_at_ms=now,
                generation=1,
            )

            def precondition(records: list[dict[str, Any]]) -> None:
                if not values["idempotency_key"]:
                    return
                for record in records:
                    if record.get("kind") != TASK_EVENT_KIND:
                        continue
                    candidate = self._decode(record.get("payload"))
                    if candidate.idempotency_key == values["idempotency_key"]:
                        raise PodTaskConflict("idempotency key already exists")

            try:
                await self._log.append(TASK_EVENT_KIND, task.__dict__, precondition=precondition)
            except PodTaskConflict:
                latest = await self._latest()
                for candidate in latest.values():
                    if candidate.idempotency_key == values["idempotency_key"]:
                        if candidate.request_digest != digest:
                            raise
                        return candidate
                raise
            return task

    async def get(self, task_id: str) -> PodTask:
        if not _TASK_ID_RE.fullmatch(str(task_id or "")):
            raise PodTaskNotFound("task not found")
        async with self._lock:
            task = (await self._latest()).get(task_id)
        if task is None:
            raise PodTaskNotFound("task not found")
        return task

    async def transition(
        self,
        task_id: str,
        *,
        expected: set[TaskState],
        state: TaskState,
        result: str | None = None,
        error_code: str | None = None,
    ) -> PodTask:
        if state == "completed" and (not isinstance(result, str) or not result.strip()):
            raise PodTaskInvalid("completed task needs a result")
        if result is not None and len(result) > MAX_RESPONSE_CHARS:
            raise PodTaskInvalid("task result is too long")
        async with self._lock:
            latest = await self._latest()
            current = latest.get(task_id)
            if current is None:
                raise PodTaskNotFound("task not found")
            if current.state not in expected:
                raise PodTaskConflict("task state changed")
            updated = replace(
                current,
                state=state,
                result=result if state == "completed" else None,
                error_code=error_code,
                updated_at_ms=max(_now_ms(), current.updated_at_ms),
                generation=current.generation + 1,
            )

            def precondition(records: list[dict[str, Any]]) -> None:
                seen = None
                for record in records:
                    if record.get("kind") == TASK_EVENT_KIND:
                        candidate = self._decode(record.get("payload"))
                        if candidate.task_id == task_id:
                            seen = candidate
                if (
                    seen is None
                    or seen.generation != current.generation
                    or seen.state not in expected
                ):
                    raise PodTaskConflict("task state changed")

            await self._log.append(TASK_EVENT_KIND, updated.__dict__, precondition=precondition)
            return updated

    async def request_cancel(self, task_id: str) -> PodTask:
        current = await self.get(task_id)
        if current.state in {"completed", "failed", "cancelled", "interrupted"}:
            return current
        if current.state == "queued":
            return await self.transition(task_id, expected={"queued"}, state="cancelled")
        if current.state == "running":
            return await self.transition(task_id, expected={"running"}, state="cancel_requested")
        return current

    async def mark_interrupted(self, task_id: str) -> PodTask:
        return await self.transition(
            task_id,
            expected={"running", "cancel_requested"},
            state="interrupted",
            error_code="POD_REPLACED_OR_RESTARTED",
        )


__all__ = [
    "MAX_MESSAGE_CHARS",
    "MAX_RESPONSE_CHARS",
    "PodTask",
    "PodTaskConflict",
    "PodTaskInvalid",
    "PodTaskNotFound",
    "PodTaskStore",
    "TASK_EVENT_KIND",
    "TaskState",
    "task_request_digest",
    "validate_task_input",
]
