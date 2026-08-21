#!/usr/bin/env python3
"""Import checked-in synthetic Hushh Tech shadow records into UAT Cloud SQL.

The importer deliberately has no Supabase connection, URL, key, or export
mode. Its only accepted source is a JSONL file beneath the checked-in
``tests/fixtures/hushh_tech`` directory. Applying records requires the exact
UAT environment and Cloud SQL instance identity; every other invocation is a
write-free dry run.

Each source line is canonicalized and hashed before any database connection is
opened. The fixture-name/hash pair is immutable, each record is applied in its
own transaction, and the migration-run row is checkpointed in that same
transaction together with an append-only outcome event. Start, failure, and
completion events are also appended around each run. A replay verifies existing
target contents and restores a missing row, but refuses changed target content
or an omitted source record. Source deletion is represented explicitly by
``source_deleted=true`` rather than a destructive database delete.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence
from uuid import UUID, uuid4

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[2]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

from hushh_mcp.services.hushh_tech_uat_database_attestation import (  # noqa: E402
    UAT_DATABASE_ATTESTATION_SQL,
    UAT_DATABASE_NAME,
    UAT_DATABASE_ROLE,
    UAT_INSTANCE,
    UAT_POSTGRES_SYSTEM_IDENTIFIER,
    is_attested_hushh_tech_uat_database,
    parse_connected_database_identity,
)

__all__ = [
    "UAT_DATABASE_NAME",
    "UAT_DATABASE_ROLE",
    "UAT_INSTANCE",
    "UAT_POSTGRES_SYSTEM_IDENTIFIER",
]

FIXTURE_ROOT = CONSENT_PROTOCOL_ROOT / "tests" / "fixtures" / "hushh_tech"
DEFAULT_FIXTURE = FIXTURE_ROOT / "synthetic_uat_shadow.jsonl"
APPROVED_FIXTURE_NAME = "synthetic_uat_shadow.jsonl"
APPROVED_FIXTURE_HASH = "3c9c9796b4765b5db9734dc4fc44f072c5043caf1e2561865088272fc4983dd8"

SYNTHETIC_LEGACY_PROJECT = "hushh-tech-uat-synthetic"
MAX_FIXTURE_BYTES = 1_000_000
MAX_RECORDS = 1_000
MAX_PAYLOAD_BYTES = 16_384
MAX_EVENT_METADATA_BYTES = 2_048
MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

ALLOWED_RECORD_TYPES = frozenset({"profile", "onboarding", "access_state", "report_asset"})
_COMMON_KEYS = frozenset(
    {
        "sequence",
        "legacy_project",
        "legacy_user_uuid",
        "record_type",
        "payload",
        "source_deleted",
        "updated_at_ms",
    }
)
_PAYLOAD_FIELDS: dict[str, frozenset[str]] = {
    "profile": frozenset({"display_name", "avatar_asset_id", "locale"}),
    "onboarding": frozenset({"status", "current_step", "completed_steps"}),
    "access_state": frozenset({"state", "reason_code", "last_evaluated_at_ms"}),
    "report_asset": frozenset({"asset_id", "report_type", "storage_state", "generated_at_ms"}),
}
_REQUIRED_PAYLOAD_FIELDS: dict[str, frozenset[str]] = {
    "profile": frozenset({"display_name"}),
    "onboarding": frozenset({"status", "completed_steps"}),
    "access_state": frozenset({"state", "last_evaluated_at_ms"}),
    "report_asset": frozenset({"asset_id", "report_type", "storage_state", "generated_at_ms"}),
}
_FORBIDDEN_KEY_FRAGMENT = re.compile(
    r"(?:email|phone|password|passphrase|secret|token|private.?key|owner.?token|ciphertext)",
    re.IGNORECASE,
)


class SyntheticImportError(RuntimeError):
    """Stable, non-secret importer error."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class ShadowRecord:
    sequence: int
    record_id: str
    legacy_project: str
    legacy_user_uuid: str
    record_type: str
    payload: dict[str, Any]
    source_deleted: bool
    updated_at_ms: int
    source_hash: str

    @property
    def identity(self) -> tuple[str, str, str]:
        return (self.legacy_project, self.legacy_user_uuid, self.record_type)


@dataclass(frozen=True)
class FixtureManifest:
    fixture_name: str
    fixture_hash: str
    run_id: str
    records: tuple[ShadowRecord, ...]


@dataclass(frozen=True)
class ImportResult:
    fixture_name: str
    fixture_hash: str
    run_id: str
    status: str
    record_count: int
    applied_count: int
    skipped_count: int
    dry_run: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "fixture_name": self.fixture_name,
            "fixture_hash": self.fixture_hash,
            "run_id": self.run_id,
            "status": self.status,
            "record_count": self.record_count,
            "applied_count": self.applied_count,
            "skipped_count": self.skipped_count,
            "dry_run": self.dry_run,
        }


class ImportStore(Protocol):
    async def start_run(self, manifest: FixtureManifest, *, now_ms: int) -> None: ...

    async def find_orphans(self, manifest: FixtureManifest) -> list[tuple[str, str, str]]: ...

    async def apply_record(
        self,
        *,
        run_id: str,
        fixture_hash: str,
        record: ShadowRecord,
        now_ms: int,
    ) -> str: ...

    async def complete_run(
        self,
        *,
        manifest: FixtureManifest,
        applied_count: int,
        skipped_count: int,
        now_ms: int,
    ) -> None: ...

    async def fail_run(
        self,
        *,
        manifest: FixtureManifest,
        error_code: str,
        sequence: int,
        now_ms: int,
    ) -> None: ...


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _event_id() -> str:
    return f"htme_{uuid4().hex}"


def _event_metadata(value: Mapping[str, Any]) -> str:
    encoded = _canonical_json(dict(value))
    if len(encoded.encode("utf-8")) > MAX_EVENT_METADATA_BYTES:
        raise SyntheticImportError(
            "EVENT_METADATA_TOO_LARGE",
            f"Migration event metadata exceeds {MAX_EVENT_METADATA_BYTES} bytes.",
        )
    return encoded


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _strict_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non_finite_json_number")


def _required_string(
    value: Any,
    *,
    field: str,
    line_number: int,
    max_length: int,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SyntheticImportError(
            "FIXTURE_INVALID_FIELD", f"Line {line_number}: {field} must be a non-empty string."
        )
    normalized = value.strip()
    if len(normalized) > max_length:
        raise SyntheticImportError(
            "FIXTURE_INVALID_FIELD", f"Line {line_number}: {field} exceeds {max_length} characters."
        )
    return normalized


def _required_nonnegative_int(value: Any, *, field: str, line_number: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SyntheticImportError(
            "FIXTURE_INVALID_FIELD",
            f"Line {line_number}: {field} must be a non-negative integer.",
        )
    return value


def _validate_payload(record_type: str, payload: Any, *, line_number: int) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise SyntheticImportError(
            "FIXTURE_INVALID_PAYLOAD", f"Line {line_number}: payload must be a JSON object."
        )
    allowed = _PAYLOAD_FIELDS[record_type]
    required = _REQUIRED_PAYLOAD_FIELDS[record_type]
    actual = frozenset(str(key) for key in payload)
    unexpected = sorted(actual - allowed)
    missing = sorted(required - actual)
    if unexpected or missing:
        raise SyntheticImportError(
            "FIXTURE_INVALID_PAYLOAD",
            f"Line {line_number}: payload fields invalid; missing={missing}, unexpected={unexpected}.",
        )
    if any(_FORBIDDEN_KEY_FRAGMENT.search(key) for key in actual):
        raise SyntheticImportError(
            "FIXTURE_FORBIDDEN_FIELD",
            f"Line {line_number}: payload contains a forbidden identity or credential field.",
        )
    if len(_canonical_json(payload).encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise SyntheticImportError(
            "FIXTURE_PAYLOAD_TOO_LARGE",
            f"Line {line_number}: payload exceeds {MAX_PAYLOAD_BYTES} bytes.",
        )

    normalized = dict(payload)
    if record_type == "profile":
        _required_string(
            normalized.get("display_name"),
            field="payload.display_name",
            line_number=line_number,
            max_length=120,
        )
        for field, max_length in (("avatar_asset_id", 128), ("locale", 32)):
            if field in normalized:
                _required_string(
                    normalized.get(field),
                    field=f"payload.{field}",
                    line_number=line_number,
                    max_length=max_length,
                )
    elif record_type == "onboarding":
        if normalized.get("status") not in {"not_started", "in_progress", "complete"}:
            raise SyntheticImportError(
                "FIXTURE_INVALID_PAYLOAD",
                f"Line {line_number}: onboarding status is not allowlisted.",
            )
        completed = normalized.get("completed_steps")
        if (
            not isinstance(completed, list)
            or len(completed) > 32
            or any(
                not isinstance(step, str) or not step.strip() or len(step) > 64
                for step in completed
            )
        ):
            raise SyntheticImportError(
                "FIXTURE_INVALID_PAYLOAD",
                f"Line {line_number}: completed_steps must contain at most 32 short strings.",
            )
        if "current_step" in normalized:
            _required_string(
                normalized.get("current_step"),
                field="payload.current_step",
                line_number=line_number,
                max_length=64,
            )
    elif record_type == "access_state":
        if normalized.get("state") not in {"enabled", "blocked", "review_required"}:
            raise SyntheticImportError(
                "FIXTURE_INVALID_PAYLOAD",
                f"Line {line_number}: access state is not allowlisted.",
            )
        _required_nonnegative_int(
            normalized.get("last_evaluated_at_ms"),
            field="payload.last_evaluated_at_ms",
            line_number=line_number,
        )
        if "reason_code" in normalized:
            _required_string(
                normalized.get("reason_code"),
                field="payload.reason_code",
                line_number=line_number,
                max_length=128,
            )
    elif record_type == "report_asset":
        for field in ("asset_id", "report_type"):
            _required_string(
                normalized.get(field),
                field=f"payload.{field}",
                line_number=line_number,
                max_length=128,
            )
        if normalized.get("storage_state") not in {"available", "pending", "unavailable"}:
            raise SyntheticImportError(
                "FIXTURE_INVALID_PAYLOAD",
                f"Line {line_number}: report storage_state is not allowlisted.",
            )
        _required_nonnegative_int(
            normalized.get("generated_at_ms"),
            field="payload.generated_at_ms",
            line_number=line_number,
        )
    return normalized


def _parse_record(raw: Any, *, line_number: int, now_ms: int) -> ShadowRecord:
    if not isinstance(raw, dict):
        raise SyntheticImportError(
            "FIXTURE_INVALID_RECORD", f"Line {line_number}: each JSONL line must be an object."
        )
    actual_keys = frozenset(str(key) for key in raw)
    missing = sorted(_COMMON_KEYS - actual_keys)
    unexpected = sorted(actual_keys - _COMMON_KEYS)
    if missing or unexpected:
        raise SyntheticImportError(
            "FIXTURE_INVALID_RECORD",
            f"Line {line_number}: record fields invalid; missing={missing}, unexpected={unexpected}.",
        )

    sequence = _required_nonnegative_int(
        raw.get("sequence"), field="sequence", line_number=line_number
    )
    if sequence == 0:
        raise SyntheticImportError(
            "FIXTURE_INVALID_SEQUENCE", f"Line {line_number}: sequence starts at 1."
        )
    legacy_project = _required_string(
        raw.get("legacy_project"),
        field="legacy_project",
        line_number=line_number,
        max_length=128,
    )
    if legacy_project != SYNTHETIC_LEGACY_PROJECT:
        raise SyntheticImportError(
            "FIXTURE_PROJECT_DENIED",
            f"Line {line_number}: only the synthetic Hushh Tech UAT project is accepted.",
        )
    legacy_user_uuid = _required_string(
        raw.get("legacy_user_uuid"),
        field="legacy_user_uuid",
        line_number=line_number,
        max_length=36,
    ).lower()
    try:
        parsed_uuid = UUID(legacy_user_uuid)
    except ValueError as exc:
        raise SyntheticImportError(
            "FIXTURE_INVALID_FIELD",
            f"Line {line_number}: legacy_user_uuid must be a canonical UUID.",
        ) from exc
    if str(parsed_uuid) != legacy_user_uuid:
        raise SyntheticImportError(
            "FIXTURE_INVALID_FIELD",
            f"Line {line_number}: legacy_user_uuid must be canonical lowercase UUID text.",
        )
    record_type = _required_string(
        raw.get("record_type"),
        field="record_type",
        line_number=line_number,
        max_length=64,
    )
    if record_type not in ALLOWED_RECORD_TYPES:
        raise SyntheticImportError(
            "FIXTURE_RECORD_TYPE_DENIED",
            f"Line {line_number}: record_type is not allowlisted.",
        )
    if not isinstance(raw.get("source_deleted"), bool):
        raise SyntheticImportError(
            "FIXTURE_INVALID_FIELD",
            f"Line {line_number}: source_deleted must be a boolean.",
        )
    updated_at_ms = _required_nonnegative_int(
        raw.get("updated_at_ms"), field="updated_at_ms", line_number=line_number
    )
    payload = _validate_payload(record_type, raw.get("payload"), line_number=line_number)
    max_allowed_timestamp = now_ms + MAX_FUTURE_SKEW_MS
    if updated_at_ms > max_allowed_timestamp:
        raise SyntheticImportError(
            "FIXTURE_FUTURE_TIMESTAMP",
            f"Line {line_number}: updated_at_ms exceeds the allowed future skew.",
        )
    embedded_timestamp_field = {
        "access_state": "last_evaluated_at_ms",
        "report_asset": "generated_at_ms",
    }.get(record_type)
    if embedded_timestamp_field:
        embedded_timestamp = int(payload[embedded_timestamp_field])
        if (
            embedded_timestamp > max_allowed_timestamp
            or embedded_timestamp > updated_at_ms + MAX_FUTURE_SKEW_MS
        ):
            raise SyntheticImportError(
                "FIXTURE_FUTURE_TIMESTAMP",
                f"Line {line_number}: payload timestamp exceeds the allowed future skew.",
            )
    source_deleted = bool(raw["source_deleted"])
    normalized = {
        "sequence": sequence,
        "legacy_project": legacy_project,
        "legacy_user_uuid": legacy_user_uuid,
        "record_type": record_type,
        "payload": payload,
        "source_deleted": source_deleted,
        "updated_at_ms": updated_at_ms,
    }
    source_hash = _sha256_text(_canonical_json(normalized))
    record_identity = f"{legacy_project}:{legacy_user_uuid}:{record_type}"
    record_id = f"htr_{_sha256_text(record_identity)[:32]}"
    return ShadowRecord(
        sequence=sequence,
        record_id=record_id,
        legacy_project=legacy_project,
        legacy_user_uuid=legacy_user_uuid,
        record_type=record_type,
        payload=payload,
        source_deleted=source_deleted,
        updated_at_ms=updated_at_ms,
        source_hash=source_hash,
    )


def parse_fixture_text(
    text: str,
    *,
    fixture_name: str,
    now_ms: int | None = None,
) -> FixtureManifest:
    if not fixture_name.endswith(".jsonl") or Path(fixture_name).name != fixture_name:
        raise SyntheticImportError(
            "FIXTURE_NAME_DENIED", "Fixture name must be a plain .jsonl filename."
        )
    if len(text.encode("utf-8")) > MAX_FIXTURE_BYTES:
        raise SyntheticImportError(
            "FIXTURE_TOO_LARGE", f"Fixture exceeds {MAX_FIXTURE_BYTES} bytes."
        )
    lines = text.splitlines()
    if not lines:
        raise SyntheticImportError("FIXTURE_EMPTY", "Fixture contains no records.")
    if len(lines) > MAX_RECORDS:
        raise SyntheticImportError(
            "FIXTURE_TOO_MANY_RECORDS", f"Fixture exceeds {MAX_RECORDS} records."
        )

    records: list[ShadowRecord] = []
    canonical_lines: list[str] = []
    seen_identities: set[tuple[str, str, str]] = set()
    current_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            raise SyntheticImportError(
                "FIXTURE_BLANK_LINE", f"Line {line_number}: blank JSONL lines are not accepted."
            )
        try:
            raw = json.loads(
                line,
                object_pairs_hook=_strict_json_object,
                parse_constant=_reject_json_constant,
            )
        except (json.JSONDecodeError, ValueError) as exc:
            raise SyntheticImportError(
                "FIXTURE_INVALID_JSON", f"Line {line_number}: invalid JSON."
            ) from exc
        record = _parse_record(raw, line_number=line_number, now_ms=current_ms)
        if record.sequence != line_number:
            raise SyntheticImportError(
                "FIXTURE_INVALID_SEQUENCE",
                f"Line {line_number}: sequence must be contiguous and match line order.",
            )
        if record.identity in seen_identities:
            raise SyntheticImportError(
                "FIXTURE_DUPLICATE_RECORD",
                f"Line {line_number}: duplicate project/user/type identity.",
            )
        seen_identities.add(record.identity)
        records.append(record)
        canonical_lines.append(
            _canonical_json(
                {
                    "sequence": record.sequence,
                    "legacy_project": record.legacy_project,
                    "legacy_user_uuid": record.legacy_user_uuid,
                    "record_type": record.record_type,
                    "payload": record.payload,
                    "source_deleted": record.source_deleted,
                    "updated_at_ms": record.updated_at_ms,
                }
            )
        )

    fixture_hash = _sha256_text("\n".join(canonical_lines) + "\n")
    run_id = f"htrun_{_sha256_text(f'{fixture_name}:{fixture_hash}')[:32]}"
    return FixtureManifest(
        fixture_name=fixture_name,
        fixture_hash=fixture_hash,
        run_id=run_id,
        records=tuple(records),
    )


def resolve_fixture_path(path_value: str | Path) -> Path:
    candidate = Path(path_value)
    if not candidate.is_absolute():
        candidate = FIXTURE_ROOT / candidate
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as exc:
        raise SyntheticImportError("FIXTURE_NOT_FOUND", "Fixture file does not exist.") from exc
    approved_path = DEFAULT_FIXTURE.resolve(strict=True)
    if resolved != approved_path:
        raise SyntheticImportError(
            "FIXTURE_PATH_DENIED",
            "Only the reviewed checked-in Hushh Tech UAT fixture is accepted.",
        )
    if not resolved.is_file() or resolved.suffix != ".jsonl":
        raise SyntheticImportError("FIXTURE_PATH_DENIED", "Fixture must be a .jsonl file.")
    return resolved


def load_fixture(path_value: str | Path) -> FixtureManifest:
    path = resolve_fixture_path(path_value)
    manifest = parse_fixture_text(path.read_text(encoding="utf-8"), fixture_name=path.name)
    if (
        manifest.fixture_name != APPROVED_FIXTURE_NAME
        or manifest.fixture_hash != APPROVED_FIXTURE_HASH
    ):
        raise SyntheticImportError(
            "FIXTURE_HASH_NOT_APPROVED",
            "The checked-in Hushh Tech UAT fixture does not match its reviewed hash.",
        )
    return manifest


def assert_uat_apply_target(environment: Mapping[str, str] | None = None) -> None:
    values = environment if environment is not None else os.environ
    lane = str(values.get("ENVIRONMENT") or "").strip().lower()
    instance = str(values.get("CLOUDSQL_INSTANCE_CONNECTION_NAME") or "").strip()
    if lane != "uat" or instance != UAT_INSTANCE:
        raise SyntheticImportError(
            "TARGET_NOT_UAT",
            "Apply requires ENVIRONMENT=uat and the canonical hushh-uat-pg Cloud SQL instance.",
        )


async def assert_connected_uat_database(connection: Any) -> None:
    """Prove that ``connection`` terminates on the attested UAT cluster.

    A process can claim the expected environment and instance while a local
    Cloud SQL Auth Proxy is actually aimed at a different server. PostgreSQL's
    system identifier is generated for the database cluster and returned by
    the server itself, so checking it closes that proxy/configuration gap. The
    database name and role are checked too so a valid cluster connection with
    an unintended privilege boundary also fails closed.
    """

    try:
        row = await connection.fetchrow(UAT_DATABASE_ATTESTATION_SQL)
    except Exception as exc:
        raise SyntheticImportError(
            "TARGET_IDENTITY_UNAVAILABLE",
            "Connected database identity could not be verified; no import writes were attempted.",
        ) from exc

    if not row:
        raise SyntheticImportError(
            "TARGET_IDENTITY_UNAVAILABLE",
            "Connected database identity could not be verified; no import writes were attempted.",
        )

    try:
        identity = parse_connected_database_identity(row)
    except ValueError as exc:
        raise SyntheticImportError(
            "TARGET_IDENTITY_UNAVAILABLE",
            "Connected database identity could not be verified; no import writes were attempted.",
        ) from exc

    if not is_attested_hushh_tech_uat_database(identity):
        raise SyntheticImportError(
            "TARGET_IDENTITY_MISMATCH",
            "Connected database is not the attested hushh-uat-pg target; no import writes were attempted.",
        )


async def run_import(
    manifest: FixtureManifest,
    *,
    store: ImportStore | None = None,
    dry_run: bool,
    now_ms: int | None = None,
) -> ImportResult:
    timestamp_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if dry_run:
        return ImportResult(
            fixture_name=manifest.fixture_name,
            fixture_hash=manifest.fixture_hash,
            run_id=manifest.run_id,
            status="dry_run",
            record_count=len(manifest.records),
            applied_count=0,
            skipped_count=0,
            dry_run=True,
        )
    if store is None:
        raise SyntheticImportError("STORE_REQUIRED", "An import store is required for apply mode.")

    applied_count = 0
    skipped_count = 0
    checkpoint_sequence = 0
    try:
        await store.start_run(manifest, now_ms=timestamp_ms)
        orphans = await store.find_orphans(manifest)
        if orphans:
            raise SyntheticImportError(
                "TARGET_ORPHANED_RECORD",
                "Target contains a synthetic cohort record omitted from the immutable fixture; "
                "represent source deletion explicitly instead.",
            )
        for record in manifest.records:
            outcome = await store.apply_record(
                run_id=manifest.run_id,
                fixture_hash=manifest.fixture_hash,
                record=record,
                now_ms=timestamp_ms,
            )
            if outcome == "applied":
                applied_count += 1
            elif outcome == "skipped":
                skipped_count += 1
            else:
                raise SyntheticImportError(
                    "STORE_INVALID_OUTCOME", "Import store returned an invalid record outcome."
                )
            checkpoint_sequence = record.sequence
        await store.complete_run(
            manifest=manifest,
            applied_count=applied_count,
            skipped_count=skipped_count,
            now_ms=timestamp_ms,
        )
    except Exception as exc:
        error_code = exc.code if isinstance(exc, SyntheticImportError) else "IMPORT_FAILED"
        try:
            await store.fail_run(
                manifest=manifest,
                error_code=error_code,
                sequence=checkpoint_sequence,
                now_ms=timestamp_ms,
            )
        except Exception:
            # Preserve the first failure. A disconnected database can make the
            # best-effort status update fail too, but must not replace the
            # actionable record/transaction error returned to the operator.
            pass
        raise

    return ImportResult(
        fixture_name=manifest.fixture_name,
        fixture_hash=manifest.fixture_hash,
        run_id=manifest.run_id,
        status="completed",
        record_count=len(manifest.records),
        applied_count=applied_count,
        skipped_count=skipped_count,
        dry_run=False,
    )


class PostgresImportStore:
    """Transaction/checkpoint adapter over one advisory-locked connection."""

    def __init__(self, connection: Any):
        self._connection = connection
        self._lock_held = False

    async def _insert_event(
        self,
        *,
        run_id: str,
        fixture_hash: str,
        phase: str,
        outcome: str,
        sequence: int,
        event_at_ms: int,
        metadata: Mapping[str, Any],
    ) -> None:
        await self._connection.execute(
            """
            INSERT INTO hushh_tech_migration_events (
              event_id, run_id, fixture_hash, phase, outcome,
              sequence, event_at_ms, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)
            """,
            _event_id(),
            run_id,
            fixture_hash,
            phase,
            outcome,
            sequence,
            event_at_ms,
            _event_metadata(metadata),
        )

    async def acquire_lock(self) -> None:
        await self._connection.execute(
            "SELECT pg_advisory_lock(hashtextextended($1, 0))",
            "hushh-tech-synthetic-shadow-import",
        )
        self._lock_held = True

    async def release_lock(self) -> None:
        if self._lock_held:
            await self._connection.execute(
                "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
                "hushh-tech-synthetic-shadow-import",
            )
            self._lock_held = False

    async def start_run(self, manifest: FixtureManifest, *, now_ms: int) -> None:
        async with self._connection.transaction():
            existing = await self._connection.fetchrow(
                """
                SELECT run_id, fixture_hash
                FROM hushh_tech_migration_runs
                WHERE fixture_name = $1
                FOR UPDATE
                """,
                manifest.fixture_name,
            )
            if existing and str(existing["fixture_hash"]) != manifest.fixture_hash:
                raise SyntheticImportError(
                    "FIXTURE_HASH_CHANGED",
                    "A migration run already owns this fixture name with a different hash.",
                )
            if existing and str(existing["run_id"]) != manifest.run_id:
                raise SyntheticImportError(
                    "FIXTURE_RUN_ID_MISMATCH",
                    "Stored migration-run identity does not match the deterministic fixture identity.",
                )
            if existing:
                await self._connection.execute(
                    """
                    UPDATE hushh_tech_migration_runs
                    SET status = 'running',
                        record_count = $2,
                        applied_count = 0,
                        skipped_count = 0,
                        checkpoint_sequence = 0,
                        started_at_ms = $3,
                        completed_at_ms = NULL,
                        updated_at_ms = $3,
                        error_code = NULL
                    WHERE run_id = $1
                    """,
                    manifest.run_id,
                    len(manifest.records),
                    now_ms,
                )
            else:
                await self._connection.execute(
                    """
                    INSERT INTO hushh_tech_migration_runs (
                      run_id, fixture_name, fixture_hash, status, record_count,
                      applied_count, skipped_count, checkpoint_sequence,
                      started_at_ms, completed_at_ms, updated_at_ms, error_code
                    ) VALUES ($1, $2, $3, 'running', $4, 0, 0, 0, $5, NULL, $5, NULL)
                    """,
                    manifest.run_id,
                    manifest.fixture_name,
                    manifest.fixture_hash,
                    len(manifest.records),
                    now_ms,
                )
            await self._insert_event(
                run_id=manifest.run_id,
                fixture_hash=manifest.fixture_hash,
                phase="start",
                outcome="started",
                sequence=0,
                event_at_ms=now_ms,
                metadata={"record_count": len(manifest.records)},
            )

    async def find_orphans(self, manifest: FixtureManifest) -> list[tuple[str, str, str]]:
        expected = {record.identity for record in manifest.records}
        rows = await self._connection.fetch(
            """
            SELECT legacy_project, legacy_user_uuid, record_type
            FROM hushh_tech_shadow_records
            WHERE legacy_project = $1
            """,
            SYNTHETIC_LEGACY_PROJECT,
        )
        actual = {
            (str(row["legacy_project"]), str(row["legacy_user_uuid"]), str(row["record_type"]))
            for row in rows
        }
        return sorted(actual - expected)

    async def apply_record(
        self,
        *,
        run_id: str,
        fixture_hash: str,
        record: ShadowRecord,
        now_ms: int,
    ) -> str:
        async with self._connection.transaction():
            existing = await self._connection.fetchrow(
                """
                SELECT record_id, payload, source_hash, source_deleted, updated_at_ms
                FROM hushh_tech_shadow_records
                WHERE legacy_project = $1
                  AND legacy_user_uuid = $2
                  AND record_type = $3
                FOR UPDATE
                """,
                record.legacy_project,
                record.legacy_user_uuid,
                record.record_type,
            )
            outcome = "applied"
            if existing:
                matches = (
                    str(existing["record_id"]) == record.record_id
                    and _json_object(existing["payload"]) == record.payload
                    and str(existing["source_hash"]) == record.source_hash
                    and bool(existing["source_deleted"]) == record.source_deleted
                    and int(existing["updated_at_ms"]) == record.updated_at_ms
                )
                if not matches:
                    raise SyntheticImportError(
                        "TARGET_HASH_MISMATCH",
                        "Existing synthetic target content does not match the immutable source record.",
                    )
                outcome = "skipped"
            else:
                await self._connection.execute(
                    """
                    INSERT INTO hushh_tech_shadow_records (
                      record_id, legacy_project, legacy_user_uuid, record_type,
                      payload, source_hash, source_deleted, imported_at_ms, updated_at_ms
                    ) VALUES ($1, $2, $3, $4, $5::JSONB, $6, $7, $8, $9)
                    """,
                    record.record_id,
                    record.legacy_project,
                    record.legacy_user_uuid,
                    record.record_type,
                    _canonical_json(record.payload),
                    record.source_hash,
                    record.source_deleted,
                    now_ms,
                    record.updated_at_ms,
                )

            checkpoint = await self._connection.fetchval(
                """
                UPDATE hushh_tech_migration_runs
                SET applied_count = applied_count + $3,
                    skipped_count = skipped_count + $4,
                    checkpoint_sequence = $2,
                    updated_at_ms = $5
                WHERE run_id = $1
                  AND status = 'running'
                  AND checkpoint_sequence = $2 - 1
                  AND fixture_hash = $6
                RETURNING checkpoint_sequence
                """,
                run_id,
                record.sequence,
                1 if outcome == "applied" else 0,
                1 if outcome == "skipped" else 0,
                now_ms,
                fixture_hash,
            )
            if checkpoint is None:
                raise SyntheticImportError(
                    "CHECKPOINT_CONFLICT",
                    "Migration checkpoint did not advance atomically.",
                )
            await self._insert_event(
                run_id=run_id,
                fixture_hash=fixture_hash,
                phase="record",
                outcome=outcome,
                sequence=record.sequence,
                event_at_ms=now_ms,
                metadata={
                    "record_id": record.record_id,
                    "record_type": record.record_type,
                    "source_deleted": record.source_deleted,
                    "source_hash": record.source_hash,
                },
            )
            return outcome

    async def complete_run(
        self,
        *,
        manifest: FixtureManifest,
        applied_count: int,
        skipped_count: int,
        now_ms: int,
    ) -> None:
        async with self._connection.transaction():
            completed = await self._connection.fetchval(
                """
                UPDATE hushh_tech_migration_runs
                SET status = 'completed', completed_at_ms = $3, updated_at_ms = $3
                WHERE run_id = $1
                  AND fixture_hash = $2
                  AND status = 'running'
                  AND checkpoint_sequence = record_count
                  AND applied_count + skipped_count = record_count
                RETURNING run_id
                """,
                manifest.run_id,
                manifest.fixture_hash,
                now_ms,
            )
            if completed is None:
                raise SyntheticImportError(
                    "CHECKPOINT_INCOMPLETE",
                    "Migration run cannot complete before every record is checked.",
                )
            await self._insert_event(
                run_id=manifest.run_id,
                fixture_hash=manifest.fixture_hash,
                phase="terminal",
                outcome="completed",
                sequence=len(manifest.records),
                event_at_ms=now_ms,
                metadata={
                    "applied_count": applied_count,
                    "record_count": len(manifest.records),
                    "skipped_count": skipped_count,
                },
            )

    async def fail_run(
        self,
        *,
        manifest: FixtureManifest,
        error_code: str,
        sequence: int,
        now_ms: int,
    ) -> None:
        bounded_error_code = error_code[:128]
        async with self._connection.transaction():
            await self._connection.execute(
                """
                UPDATE hushh_tech_migration_runs
                SET status = 'failed', completed_at_ms = NULL,
                    updated_at_ms = $3, error_code = $2
                WHERE run_id = $1
                  AND fixture_hash = $4
                """,
                manifest.run_id,
                bounded_error_code,
                now_ms,
                manifest.fixture_hash,
            )
            await self._insert_event(
                run_id=manifest.run_id,
                fixture_hash=manifest.fixture_hash,
                phase="terminal",
                outcome="failed",
                sequence=sequence,
                event_at_ms=now_ms,
                metadata={"error_code": bounded_error_code},
            )


async def _apply_to_postgres(
    manifest: FixtureManifest,
    *,
    pool: Any | None = None,
) -> ImportResult:
    if pool is None:
        from db.connection import get_pool

        pool = await get_pool()
    async with pool.acquire() as connection:
        # This read-only attestation must stay before the advisory lock, run
        # checkpoint, or shadow-record writes below.
        await assert_connected_uat_database(connection)
        store = PostgresImportStore(connection)
        await store.acquire_lock()
        try:
            return await run_import(manifest, store=store, dry_run=False)
        finally:
            await store.release_lock()


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture",
        default=DEFAULT_FIXTURE.name,
        help="Checked-in JSONL filename under tests/fixtures/hushh_tech.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and hash only. This is the default when --apply is absent.",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Apply to the canonical UAT Cloud SQL instance.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
        manifest = load_fixture(args.fixture)
        if args.apply:
            assert_uat_apply_target()
            result = asyncio.run(_apply_to_postgres(manifest))
        else:
            result = asyncio.run(run_import(manifest, dry_run=True))
        print(json.dumps(result.as_dict(), indent=2, sort_keys=True))
        return 0
    except SyntheticImportError as exc:
        print(
            json.dumps({"status": "error", "error_code": exc.code, "message": exc.message}),
            file=sys.stderr,
        )
        return 2
    except Exception:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error_code": "IMPORT_FAILED",
                    "message": "The synthetic UAT import failed.",
                }
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
