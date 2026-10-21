"""Bounded continuation projection inside the existing sealed schedule record."""

from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_CHECKPOINT_BYTES = 256 * 1024


def checkpoint_binding(row: dict) -> str:
    fields = (
        "id",
        "owner_id",
        "pod_id",
        "incarnation",
        "capability",
        "terms",
        "grant",
        "authorization_expires_at",
        "request_fingerprint",
        "delivery_revision",
    )
    run = row.get("last_run") or {}
    value = {**{key: row[key] for key in fields}, "occurrence_id": run.get("id")}
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


class ScheduledOneResult(BaseModel):
    """Model-authored answer, never an effect receipt or approval authority."""

    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    outcome: Literal["completed", "blocked"]
    summary: str = Field(min_length=1, max_length=2000)


class ScheduledModelBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)
    provider: Literal["gemini", "openai", "azure_openai", "puppy"]
    model: str = Field(min_length=1, max_length=256)
    runtime_mode: str = Field(min_length=1, max_length=64)
    # Durable sealed selection replay floor; never the process-local cache counter.
    selection_revision: int = Field(ge=0)
    selection_id: str | None = Field(default=None, min_length=1, max_length=128)
    selection_issued_at_ms: int | None = Field(default=None, gt=0)
    destination: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def bounded_destination(self):
        if set(self.destination) - {
            "endpoint",
            "project",
            "location",
            "service_account",
            "workload_client_id",
            "transport",
        } or any(not value or len(value) > 512 for value in self.destination.values()):
            raise ValueError("Invalid scheduled model destination")
        return self


class ScheduledCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    kind: Literal["scheduled_one_checkpoint_v1"] = "scheduled_one_checkpoint_v1"
    binding_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    claim_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    revision: int = Field(ge=1)
    phase: Literal["running", "needs_review", "dispatching", "outcome_uncertain", "completed"]
    session: dict | None = Field(default=None, repr=False)
    pending: dict[str, dict] = Field(default_factory=dict, repr=False)
    dispatch_handle: str | None = Field(default=None, pattern=r"^one_secret_ref:[A-Za-z0-9_-]{32}$")

    @model_validator(mode="after")
    def bounded(self):
        if len(self.pending) > 8:
            raise ValueError("Too many pending task calls")
        if (self.phase == "dispatching" and self.dispatch_handle not in self.pending) or (
            self.dispatch_handle is not None
            and self.phase not in {"dispatching", "outcome_uncertain"}
        ):
            raise ValueError("Task dispatch binding changed")
        if self.session is not None and (
            not isinstance(self.session.get("events"), list) or len(self.session["events"]) > 128
        ):
            raise ValueError("Task session exceeds its bound")
        if len(json.dumps(self.model_dump(), allow_nan=False).encode()) > MAX_CHECKPOINT_BYTES:
            raise ValueError("Task checkpoint exceeds its bound")
        return self


def validate_schedule_checkpoint(row: dict, checkpoint: ScheduledCheckpoint) -> None:
    run = row.get("last_run") or {}
    if (
        row["capability"] != "agent_one.execute_task.v1"
        or checkpoint.binding_sha256 != checkpoint_binding(row)
        or checkpoint.claim_id != run.get("claim_id")
        or not isinstance(row["terms"].get("agent_version"), str)
        or not row["terms"]["agent_version"]
    ):
        raise ValueError("Task checkpoint binding changed")
    ScheduledModelBinding.model_validate(row["terms"].get("model_binding"))
    if checkpoint.session is not None and (
        checkpoint.session.get("id") != "scheduled_" + run["id"]
        or checkpoint.session.get("userId") != row["owner_id"]
        or checkpoint.session.get("appName") != "hussh_one"
    ):
        raise ValueError("Task session identity changed")
