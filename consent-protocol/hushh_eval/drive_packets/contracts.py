"""Strict JSONL row contracts (schema ``dpe.<kind>.v1``) and append-only storage.

Every row rejects unknown fields. Appends are idempotent by row identity, so a
resumed run never duplicates a case, packet or judgment. A case without an
observation is scored as a failed attempt by ``metrics``; it is never dropped.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field

Partition = Literal["dev", "heldout", "pending"]
Mode = Literal["replay", "served"]
Stage = Literal["extraction", "facts", "packet", "request"]
AttemptStatus = Literal["completed", "error", "timeout", "budget_exhausted", "missing", "skipped"]
PacketState = Literal["ready", "incomplete", "unable_to_verify", "failed"]
Verdict = Literal["pass", "fail", "unknown"]
Severity = Literal["S1", "S2", "S3"]
LabelSource = Literal["deterministic", "prelabel", "human", "legacy", "silver"]
SystemStage = Literal["indexed", "extracted", "failed", "pending", "not_in_system"]


class Row(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FrameRow(Row):
    schema_version: Literal["dpe.frame.v1"] = "dpe.frame.v1"
    frame_id: str
    file_key: str = Field(pattern=r"^[0-9a-f]{32}$")
    mime_family: str
    size_bucket: str
    age_bucket: str
    modified_year: int | None
    created_year: int | None
    folder_key: str | None
    top_folder_key: str | None
    system_stage: SystemStage
    in_system: bool
    in_independent_listing: bool


class SampledItem(Row):
    file_key: str
    design_stratum: str
    cluster_key: str | None
    stage: Literal["cluster", "loose", "anchor"]
    design_weight: float = Field(ge=0)


class PlanRow(Row):
    schema_version: Literal["dpe.plan.v1"] = "dpe.plan.v1"
    batch_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")
    frame_id: str
    frame_sha256: str
    strata_version: str
    seed: int
    design: dict[str, Any]
    allocation: dict[str, int]
    sample: list[SampledItem]
    anchor_keys: list[str]
    excluded_prior: int
    request_set_version: str
    label_version: str
    judge: dict[str, Any]
    runtime: dict[str, Any]
    budget_usd: float = Field(gt=0, le=100)
    plan_sha256: str = ""


class CaseRow(Row):
    schema_version: Literal["dpe.case.v1"] = "dpe.case.v1"
    batch_id: str
    case_id: str
    file_key: str
    document_uuid: str
    partition: Partition
    family_key: str | None
    content_sha256: str | None
    source_revision: str | None
    stratum: str
    design_stratum: str
    cluster_key: str | None
    design_weight: float = Field(ge=0)
    anchor: bool
    burned: bool


class ObservationRow(Row):
    schema_version: Literal["dpe.observation.v1"] = "dpe.observation.v1"
    batch_id: str
    case_id: str
    mode: Mode
    stage: Stage
    status: AttemptStatus
    error_code: str | None = None
    output: dict[str, Any] = Field(default_factory=dict)
    runtime: dict[str, Any] = Field(default_factory=dict)
    usage: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = None


class PacketRow(Row):
    schema_version: Literal["dpe.packet.v1"] = "dpe.packet.v1"
    batch_id: str
    packet_key: str
    mode: Mode
    state: PacketState
    member_case_ids: list[str]
    selected_case_ids: list[str]
    excluded: list[dict[str, Any]]
    periods: list[list[str]]
    temporal_scope: str | None
    gaps_count: int
    pricing: dict[str, Any]
    price_cents: int | None
    assessment_score: int | None
    importance: int | None
    standalone_value: str | None
    visible: dict[str, Any]
    record_statuses: list[str | None]
    verification: dict[str, Any] | None
    digest: str
    error_code: str | None = None


class LabelRow(Row):
    schema_version: Literal["dpe.label.v1"] = "dpe.label.v1"
    subject: str
    field: str
    value: Any
    source: LabelSource
    labeler: str
    label_version: str


class JudgmentRow(Row):
    schema_version: Literal["dpe.judgment.v1"] = "dpe.judgment.v1"
    batch_id: str
    packet_key: str
    judge_id: Literal["deterministic", "J1", "J2", "consensus", "human"]
    model_version: str | None
    prompt_sha256: str | None
    seed: int | None
    variant: Literal["primary", "rerun", "shuffled", "consensus"]
    verdict: Verdict
    failed_checks: list[str]
    severity: Severity | None
    citations_valid: bool | None
    error_code: str | None = None


class ScoreRow(Row):
    schema_version: Literal["dpe.score.v1"] = "dpe.score.v1"
    metric: str
    successes: int = Field(ge=0)
    trials: int = Field(ge=0)
    rate: float | None
    cp_lower_95: float | None
    wilson_lower_95: float | None
    unit: str
    independence: str
    n_unknown: int = Field(ge=0)
    label_version: str
    extra: dict[str, Any] = Field(default_factory=dict)


class GateRow(Row):
    schema_version: Literal["dpe.gate.v1"] = "dpe.gate.v1"
    gate: Literal["deploy", "listing", "ready"]
    status: Literal["pass", "fail", "insufficient"]
    reasons: list[str]
    thresholds_version: str
    exit_code: Literal[0, 1, 2]


class QueueRow(Row):
    schema_version: Literal["dpe.queue.v1"] = "dpe.queue.v1"
    batch_id: str
    subject: str
    reason: Literal["random", "disagreement", "high_risk_ready"]


RowT = TypeVar("RowT", bound=Row)

IDENTITY: dict[type[Row], Callable[[Any], tuple]] = {
    FrameRow: lambda row: (row.frame_id, row.file_key),
    CaseRow: lambda row: (row.batch_id, row.case_id),
    ObservationRow: lambda row: (row.batch_id, row.case_id, row.mode, row.stage),
    PacketRow: lambda row: (row.batch_id, row.packet_key, row.mode),
    LabelRow: lambda row: (row.subject, row.field, row.source, row.label_version),
    JudgmentRow: lambda row: (row.batch_id, row.packet_key, row.judge_id, row.variant),
    QueueRow: lambda row: (row.batch_id, row.subject),
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_rows(path: Path, model: type[RowT]) -> list[RowT]:
    if not path.exists():
        return []
    rows = []
    for number, line in enumerate(path.read_text().splitlines(), start=1):
        if line.strip():
            try:
                rows.append(model.model_validate_json(line))
            except ValueError as error:
                raise ValueError(f"invalid_row:{path.name}:{number}") from error
    return rows


def append_rows(path: Path, rows: Iterable[RowT]) -> int:
    """Idempotent append: a row whose identity already exists is skipped."""
    rows = list(rows)
    if not rows:
        return 0
    model = type(rows[0])
    identity = IDENTITY[model]
    seen = {identity(row) for row in read_rows(path, model)}
    written = 0
    descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    with os.fdopen(descriptor, "a") as handle:
        for row in rows:
            if type(row) is not model:
                raise ValueError("mixed_row_types")
            key = identity(row)
            if key in seen:
                continue
            seen.add(key)
            handle.write(row.model_dump_json() + "\n")
            written += 1
    return written


def replace_rows(path: Path, rows: Iterable[Row]) -> None:
    """Rewrite a derived file atomically (scores, queues); never raw observations."""
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        for row in rows:
            handle.write(row.model_dump_json() + "\n")
    temporary.replace(path)


def latest_by_identity(rows: list[RowT]) -> dict[tuple, RowT]:
    if not rows:
        return {}
    identity = IDENTITY[type(rows[0])]
    return {identity(row): row for row in rows}
