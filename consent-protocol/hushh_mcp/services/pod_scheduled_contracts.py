"""Typed scheduled-task requests, recovery records and bounded calendar calculation.

These are pod-local contracts, not a second persistence or approval authority.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal, Protocol
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ScheduleRefused(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class ScheduleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    request_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{8,128}$")
    title: str = Field(min_length=1, max_length=80, repr=False)
    capability: str = Field(pattern=r"^agent_[a-z_]+\.[a-z_]+\.v[1-9][0-9]*$")
    parameters: dict = Field(repr=False)
    first_run_at: int = Field(gt=0)
    timezone: str = Field(min_length=1, max_length=64)
    repeat: Literal["once", "daily", "weekly"] = "once"
    authorization_expires_at: int = Field(gt=0)
    confirmed: Literal[True]

    @model_validator(mode="after")
    def bounded_terms(self):
        try:
            ZoneInfo(self.timezone)
            encoded = json.dumps(self.parameters, allow_nan=False)
        except (ValueError, TypeError, ZoneInfoNotFoundError):
            raise ValueError("Invalid schedule terms") from None
        if len(encoded.encode()) > 4096 or self.first_run_at >= self.authorization_expires_at:
            raise ValueError("Invalid schedule terms")
        return self


@dataclass(frozen=True)
class ScheduleAccess:
    owner_id: str
    pod_id: str
    incarnation: str
    check: Callable[[], Awaitable[None]] = field(repr=False)


class ScheduledCapability(Protocol):
    # Trusted adapter limit, never a model/request-supplied authority extension.
    max_active_seconds: int
    required_scopes: tuple[str, ...]

    async def prepare(self, parameters: dict) -> dict:
        """Exact current capability terms. No model/client assertion of authority."""
        ...

    async def run(
        self, terms: dict, occurrence_id: str, check: Callable[[], Awaitable[None]]
    ) -> str:
        """Execute through the effect owner; stop all work before returning/raising."""
        ...


class ScheduledDelivery(Protocol):
    def require_ready(self) -> None: ...

    async def offer(self, schedule_id: str, revision: int, occurrence_id: str, due_at: int) -> None:
        """Identifier-only, named/deduplicated due-time delivery."""
        ...


def capability_scopes(capability: ScheduledCapability) -> list[str]:
    scopes = capability.required_scopes
    if (
        not isinstance(scopes, tuple)
        or not 1 <= len(scopes) <= 32
        or any(not isinstance(s, str) or not s or len(s) > 64 for s in scopes)
        or len(set(scopes)) != len(scopes)
        or "pod.act" not in scopes
    ):
        raise ScheduleRefused("SCHEDULE_CAPABILITY_GRANT_INVALID")
    return list(scopes)


def next_run_after(
    due_at: int, repeat: str, timezone: str, now: int, *, anchor_at: int | None = None
) -> int | None:
    if repeat == "once":
        return None
    days = 1 if repeat == "daily" else 7
    local = datetime.fromtimestamp(due_at, UTC).astimezone(ZoneInfo(timezone))
    anchor = datetime.fromtimestamp(anchor_at or due_at, UTC).astimezone(ZoneInfo(timezone))
    # Coalesce missed occurrences; never catch up by issuing a burst of effects.
    for _ in range(367):
        local += timedelta(days=days)
        local = local.replace(
            hour=anchor.hour, minute=anchor.minute, second=anchor.second, fold=anchor.fold
        )
        candidate = int(local.timestamp())
        # Resolve nonexistent DST times forward; retain the chosen fold for
        # an ambiguous time and deliver one occurrence, not both folds.
        if candidate > now:
            return candidate
    raise ScheduleRefused("SCHEDULE_CLOCK_RANGE_REFUSED")


def occurrence_id(schedule_id: str, revision: int, due_at: int) -> str:
    return uuid5(NAMESPACE_URL, f"{schedule_id}:{revision}:{due_at}").hex


class _RunReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    state: Literal[
        "running", "completed", "failed", "needs_review", "cancelled", "outcome_uncertain"
    ]
    started_at: int = Field(gt=0)
    lease_until: int = Field(gt=0)
    claim_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    deadline_at: int | None = Field(default=None, gt=0)
    finished_at: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def bounded_lease(self):
        if (self.claim_id is None) != (self.deadline_at is None):
            raise ValueError("Invalid recovered lease")
        if self.deadline_at is not None and not (
            self.started_at < self.deadline_at <= self.started_at + 900
            and self.lease_until <= self.deadline_at
        ):
            raise ValueError("Invalid recovered lease")
        return self


class _ScheduleRecord(BaseModel):
    """Validate recovered state before it can select an effect or delivery."""

    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    id: str = Field(pattern=r"^schedule_[a-f0-9]{32}$")
    owner_id: str = Field(min_length=1, max_length=256)
    pod_id: str = Field(min_length=1, max_length=256)
    incarnation: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=80, repr=False)
    capability: str = Field(pattern=r"^agent_[a-z_]+\.[a-z_]+\.v[1-9][0-9]*$")
    terms: dict = Field(repr=False)
    grant: dict = Field(repr=False)
    repeat: Literal["once", "daily", "weekly"]
    timezone: str = Field(min_length=1, max_length=64)
    first_run_at: int = Field(gt=0)
    next_run_at: int = Field(gt=0)
    authorization_expires_at: int = Field(gt=0)
    request_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    revision: int = Field(ge=1)
    delivery_revision: int = Field(ge=1)
    state: Literal[
        "pending_delivery",
        "scheduled",
        "running",
        "cancelling",
        "paused",
        "cancelled",
        "completed",
        "needs_review",
    ]
    last_run: _RunReceipt | None

    @model_validator(mode="after")
    def bounded(self):
        ZoneInfo(self.timezone)
        scopes = self.grant.get("scopes")
        if (
            self.delivery_revision > self.revision
            or len(json.dumps({"terms": self.terms, "grant": self.grant}, allow_nan=False).encode())
            > 8192
            or (
                scopes is not None
                and (
                    not isinstance(scopes, list)
                    or not 1 <= len(scopes) <= 32
                    or any(not isinstance(s, str) or not s or len(s) > 64 for s in scopes)
                    or len(set(scopes)) != len(scopes)
                    or "pod.act" not in scopes
                )
            )
        ):
            raise ValueError("Invalid recovered schedule")
        if self.state == "running" and (self.last_run is None or self.last_run.state != "running"):
            raise ValueError("Invalid recovered claim")
        if (
            self.last_run is not None
            and self.last_run.deadline_at is not None
            and self.last_run.deadline_at > self.authorization_expires_at
        ):
            raise ValueError("Invalid recovered lease")
        return self


class ExistingSchedule(Exception):
    def __init__(self, row: dict):
        self.row = row
