"""Pending-only Postgres migration authority.

The production-safe default remains ``replay`` until an environment has been
reconciled and explicitly baselined. UAT can first use ``observe`` to inspect
the ledger and immutable checksums without executing migration bodies, then
move to ``ledger`` only after preservation evidence has been accepted.

This module never reads application rows and never logs SQL or credentials.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterable

_MIGRATION_ID_RE = re.compile(r"^(?P<id>[0-9]{8,}_[0-9A-Za-z]+|[0-9]{3,})_")
_ADVISORY_LOCK_KEY = 0x485553534844424D  # "HUSSHDBM", within signed BIGINT.
_ALLOWED_BASELINE_ENVIRONMENTS = {"uat", "test", "local", "development", "dev"}


class MigrationAuthorityError(RuntimeError):
    """Fail-closed migration authority error."""


class MigrationMode(str, Enum):
    REPLAY = "replay"
    OBSERVE = "observe"
    LEDGER = "ledger"

    @classmethod
    def parse(cls, value: str | None) -> "MigrationMode":
        normalized = str(value or cls.REPLAY.value).strip().lower()
        try:
            return cls(normalized)
        except ValueError as exc:
            allowed = ", ".join(item.value for item in cls)
            raise MigrationAuthorityError(
                f"Unsupported migration mode {normalized!r}; expected one of: {allowed}"
            ) from exc


@dataclass(frozen=True, slots=True)
class MigrationManifestEntryV2:
    migration_id: str
    filename: str
    checksum_sha256: str
    sql: str
    transactional: bool = True
    lock_timeout_ms: int = 5_000
    statement_timeout_ms: int = 120_000

    @property
    def numeric_version(self) -> int | None:
        prefix = self.migration_id.split("_", 1)[0]
        return int(prefix) if prefix.isdigit() else None


_LEDGER_SCHEMA_PATH = Path(__file__).resolve().parent / "foundations" / "schema_migrations_v2.sql"


def _ledger_ddl() -> str:
    return _LEDGER_SCHEMA_PATH.read_text(encoding="utf-8")


def _migration_id(filename: str) -> str:
    match = _MIGRATION_ID_RE.match(filename)
    if not match:
        raise MigrationAuthorityError(
            f"Migration filename must start with a numeric or timestamp/ULID id: {filename}"
        )
    return match.group("id")


def build_manifest_entries(
    migrations_dir: Path,
    filenames: Iterable[str],
) -> tuple[MigrationManifestEntryV2, ...]:
    entries: list[MigrationManifestEntryV2] = []
    seen_ids: set[str] = set()
    seen_filenames: set[str] = set()
    for raw_filename in filenames:
        filename = str(raw_filename).strip()
        if not filename or filename in seen_filenames:
            raise MigrationAuthorityError(f"Duplicate or empty migration filename: {filename!r}")
        path = migrations_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"Migration file missing: {path}")
        sql = path.read_text(encoding="utf-8")
        migration_id = _migration_id(filename)
        if migration_id in seen_ids:
            raise MigrationAuthorityError(f"Duplicate migration id: {migration_id}")
        seen_ids.add(migration_id)
        seen_filenames.add(filename)
        entries.append(
            MigrationManifestEntryV2(
                migration_id=migration_id,
                filename=filename,
                checksum_sha256=hashlib.sha256(sql.encode("utf-8")).hexdigest(),
                sql=sql,
            )
        )
    return tuple(entries)


def manifest_checksum(entries: Iterable[MigrationManifestEntryV2]) -> str:
    digest = hashlib.sha256()
    for entry in entries:
        digest.update(entry.filename.encode("utf-8"))
        digest.update(b"\0")
        digest.update(entry.checksum_sha256.encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _stable_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


async def _database_identity_hash(conn: Any) -> str:
    row = await conn.fetchrow(
        "SELECT current_database() AS database_name, "
        "current_setting('server_version_num') AS version"
    )
    return "sha256:" + _stable_hash(dict(row))


def _sanitize_failure_class(exc: BaseException) -> str:
    name = type(exc).__name__
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:120] or "MigrationError"


async def _try_lock(conn: Any) -> None:
    acquired = await conn.fetchval("SELECT pg_try_advisory_lock($1)", _ADVISORY_LOCK_KEY)
    if not acquired:
        raise MigrationAuthorityError("Another migration runner owns the database advisory lock")


async def _unlock(conn: Any) -> None:
    await conn.fetchval("SELECT pg_advisory_unlock($1)", _ADVISORY_LOCK_KEY)


async def _ledger_rows(conn: Any) -> dict[str, dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT migration_id, filename, checksum_sha256, status, baseline_through
        FROM schema_migrations
        """
    )
    return {str(row["migration_id"]): dict(row) for row in rows}


def _baseline_through(rows: dict[str, dict[str, Any]]) -> int | None:
    values = [
        int(row["baseline_through"])
        for row in rows.values()
        if row.get("status") == "baseline" and row.get("baseline_through") is not None
    ]
    return max(values) if values else None


def _assert_baseline_manifest(
    entries: tuple[MigrationManifestEntryV2, ...],
    rows: dict[str, dict[str, Any]],
    baseline_through: int | None,
) -> None:
    if baseline_through is None:
        return
    baseline = rows.get(f"baseline:{baseline_through}")
    if not baseline:
        raise MigrationAuthorityError("Migration baseline ledger row is missing")
    covered = tuple(
        entry
        for entry in entries
        if entry.numeric_version is not None and entry.numeric_version <= baseline_through
    )
    if manifest_checksum(covered) != str(baseline.get("checksum_sha256") or ""):
        raise MigrationAuthorityError("Baselined migration manifest checksum changed")


def _assert_checksum(entry: MigrationManifestEntryV2, row: dict[str, Any] | None) -> None:
    if row is None:
        return
    stored = str(row.get("checksum_sha256") or "")
    if stored != entry.checksum_sha256:
        raise MigrationAuthorityError(f"Applied migration checksum changed: {entry.filename}")


async def _record_result(
    conn: Any,
    *,
    entry: MigrationManifestEntryV2,
    status: str,
    duration_ms: int,
    deploy_sha: str,
    failure_class: str | None,
) -> None:
    await conn.execute(
        """
        INSERT INTO schema_migrations (
            migration_id, filename, checksum_sha256, status, applied_at,
            duration_ms, deploy_sha, failure_class, baseline_through, updated_at
        ) VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'applied' THEN NOW() ELSE NULL END,
                  $5, NULLIF($6, ''), $7, NULL, NOW())
        ON CONFLICT (migration_id) DO UPDATE SET
            filename = EXCLUDED.filename,
            checksum_sha256 = EXCLUDED.checksum_sha256,
            status = EXCLUDED.status,
            applied_at = EXCLUDED.applied_at,
            duration_ms = EXCLUDED.duration_ms,
            deploy_sha = EXCLUDED.deploy_sha,
            failure_class = EXCLUDED.failure_class,
            baseline_through = NULL,
            updated_at = NOW()
        """,
        entry.migration_id,
        entry.filename,
        entry.checksum_sha256,
        status,
        max(0, duration_ms),
        deploy_sha,
        failure_class,
    )


async def _rollback_failed_transaction(conn: Any) -> None:
    """Return a connection to a usable state after explicit migration SQL fails."""
    is_in_transaction = getattr(conn, "is_in_transaction", None)
    if callable(is_in_transaction) and is_in_transaction():
        await conn.execute("ROLLBACK")


async def apply_manifest_entries(
    conn: Any,
    entries: tuple[MigrationManifestEntryV2, ...],
    *,
    mode: MigrationMode,
    deploy_sha: str = "",
) -> tuple[str, ...]:
    """Apply one manifest under a session advisory lock.

    ``replay`` preserves the historical behavior and does not create ledger
    rows. ``observe`` inspects ledger/checksum state but executes no migration
    bodies. ``ledger`` executes only entries not covered by an applied row or
    a required verified baseline.
    """

    await _try_lock(conn)
    applied: list[str] = []
    try:
        rows: dict[str, dict[str, Any]] = {}
        baseline_through: int | None = None
        if mode is not MigrationMode.REPLAY:
            await conn.execute(_ledger_ddl())
            rows = await _ledger_rows(conn)
            baseline_through = _baseline_through(rows)
            if mode is MigrationMode.LEDGER:
                if baseline_through is None:
                    raise MigrationAuthorityError(
                        "Ledger mode requires an established migration baseline"
                    )
                _assert_baseline_manifest(entries, rows, baseline_through)

        for entry in entries:
            existing = rows.get(entry.migration_id)
            _assert_checksum(entry, existing)
            if mode is MigrationMode.OBSERVE:
                continue
            if mode is MigrationMode.LEDGER:
                covered_by_baseline = (
                    baseline_through is not None
                    and entry.numeric_version is not None
                    and entry.numeric_version <= baseline_through
                )
                if covered_by_baseline or (existing and existing.get("status") == "applied"):
                    continue

            started = time.perf_counter()
            recorded_applied = False
            try:
                if mode is MigrationMode.LEDGER and entry.transactional:
                    async with conn.transaction():
                        await conn.execute(f"SET LOCAL lock_timeout = '{entry.lock_timeout_ms}ms'")
                        await conn.execute(
                            f"SET LOCAL statement_timeout = '{entry.statement_timeout_ms}ms'"
                        )
                        await conn.execute(entry.sql)
                        duration_ms = round((time.perf_counter() - started) * 1000)
                        await _record_result(
                            conn,
                            entry=entry,
                            status="applied",
                            duration_ms=duration_ms,
                            deploy_sha=deploy_sha,
                            failure_class=None,
                        )
                        recorded_applied = True
                else:
                    await conn.execute(f"SET lock_timeout = '{entry.lock_timeout_ms}ms'")
                    await conn.execute(f"SET statement_timeout = '{entry.statement_timeout_ms}ms'")
                    await conn.execute(entry.sql)
            except Exception as exc:
                if mode is not MigrationMode.REPLAY:
                    await _rollback_failed_transaction(conn)
                    duration_ms = round((time.perf_counter() - started) * 1000)
                    await _record_result(
                        conn,
                        entry=entry,
                        status="failed",
                        duration_ms=duration_ms,
                        deploy_sha=deploy_sha,
                        failure_class=_sanitize_failure_class(exc),
                    )
                raise
            duration_ms = round((time.perf_counter() - started) * 1000)
            applied.append(entry.filename)
            if mode is not MigrationMode.REPLAY and not recorded_applied:
                await _record_result(
                    conn,
                    entry=entry,
                    status="applied",
                    duration_ms=duration_ms,
                    deploy_sha=deploy_sha,
                    failure_class=None,
                )
                rows[entry.migration_id] = {
                    "migration_id": entry.migration_id,
                    "filename": entry.filename,
                    "checksum_sha256": entry.checksum_sha256,
                    "status": "applied",
                    "baseline_through": None,
                }
        return tuple(applied)
    finally:
        await _unlock(conn)


def load_preservation_evidence(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        raise MigrationAuthorityError("Preservation evidence must have status=ok")
    if payload.get("schema_status") != "ok" or payload.get("preservation_status") != "ok":
        raise MigrationAuthorityError("Schema and preservation evidence must both be ok")
    if payload.get("restore_status") != "ok":
        raise MigrationAuthorityError("Isolated restore evidence must be ok")
    if payload.get("evidence_kind") != "baseline_authorization":
        raise MigrationAuthorityError("Preservation evidence is not baseline authorization")
    backup_checksum = str(payload.get("backup_checksum_sha256") or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", backup_checksum):
        raise MigrationAuthorityError("Preservation evidence lacks a verified backup checksum")
    for key in ("preservation_manifest_id", "database_identity_hash", "catalog_sha256"):
        value = str(payload.get(key) or "").strip()
        if not value:
            raise MigrationAuthorityError(f"Preservation evidence lacks {key}")
        if key == "catalog_sha256" and not re.fullmatch(r"[0-9a-f]{64}", value):
            raise MigrationAuthorityError("Preservation evidence catalog_sha256 is invalid")
    created_at_epoch = int(payload.get("created_at_epoch") or 0)
    max_age_seconds = int(os.getenv("HUSHH_BASELINE_EVIDENCE_MAX_AGE_SECONDS", "3600"))
    if created_at_epoch <= 0 or abs(int(time.time()) - created_at_epoch) > max_age_seconds:
        raise MigrationAuthorityError("Preservation evidence is stale")
    return payload


async def establish_baseline(
    conn: Any,
    entries: tuple[MigrationManifestEntryV2, ...],
    *,
    evidence: dict[str, Any],
    deploy_sha: str = "",
) -> str:
    required_evidence = (
        "preservation_manifest_id",
        "database_identity_hash",
        "catalog_sha256",
        "backup_checksum_sha256",
    )
    if any(not str(evidence.get(key) or "").strip() for key in required_evidence):
        raise MigrationAuthorityError("Baseline requires complete preservation evidence")
    if (
        evidence.get("status") != "ok"
        or evidence.get("schema_status") != "ok"
        or evidence.get("preservation_status") != "ok"
        or evidence.get("restore_status") != "ok"
        or evidence.get("evidence_kind") != "baseline_authorization"
    ):
        raise MigrationAuthorityError("Baseline requires successful restore evidence")
    if not re.fullmatch(
        r"[0-9a-f]{64}",
        str(evidence.get("backup_checksum_sha256") or "").strip().lower(),
    ):
        raise MigrationAuthorityError("Baseline requires a verified backup checksum")
    environment = (
        str(os.getenv("HUSSH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or "").strip().lower()
    )
    if environment not in _ALLOWED_BASELINE_ENVIRONMENTS:
        raise MigrationAuthorityError(
            "Baseline establishment is prohibited outside local/test/UAT environments"
        )
    versions = [entry.numeric_version for entry in entries if entry.numeric_version is not None]
    if not versions:
        raise MigrationAuthorityError("Cannot establish a baseline without numeric migrations")
    through = max(versions)
    checksum = manifest_checksum(entries)
    migration_id = f"baseline:{through}"
    filename = f"release_migration_manifest.json@{through}"

    await _try_lock(conn)
    try:
        if await _database_identity_hash(conn) != str(evidence["database_identity_hash"]):
            raise MigrationAuthorityError("Preservation evidence belongs to a different database")
        await conn.execute(_ledger_ddl())
        existing = await conn.fetchrow(
            """
            SELECT checksum_sha256, status, preservation_manifest_id,
                   database_identity_hash, catalog_sha256, backup_checksum_sha256
            FROM schema_migrations WHERE migration_id = $1
            """,
            migration_id,
        )
        if existing:
            if str(existing["checksum_sha256"]) != checksum:
                raise MigrationAuthorityError("Baseline manifest checksum changed")
            if str(existing["status"]) != "baseline":
                raise MigrationAuthorityError("Baseline ledger row has an invalid status")
            expected_evidence = {
                "preservation_manifest_id": str(evidence["preservation_manifest_id"]),
                "database_identity_hash": str(evidence["database_identity_hash"]),
                "catalog_sha256": str(evidence["catalog_sha256"]),
                "backup_checksum_sha256": str(evidence["backup_checksum_sha256"]),
            }
            if any(str(existing[key] or "") != value for key, value in expected_evidence.items()):
                raise MigrationAuthorityError("Baseline preservation evidence changed")
            return migration_id
        await conn.execute(
            """
            INSERT INTO schema_migrations (
                migration_id, filename, checksum_sha256, status, applied_at,
                duration_ms, deploy_sha, failure_class, baseline_through,
                preservation_manifest_id, database_identity_hash, catalog_sha256,
                backup_checksum_sha256
            ) VALUES ($1, $2, $3, 'baseline', NOW(), 0, NULLIF($4, ''), NULL, $5,
                      $6, $7, $8, $9)
            """,
            migration_id,
            filename,
            checksum,
            deploy_sha,
            through,
            str(evidence["preservation_manifest_id"]),
            str(evidence["database_identity_hash"]),
            str(evidence["catalog_sha256"]),
            str(evidence["backup_checksum_sha256"]),
        )
        return migration_id
    finally:
        await _unlock(conn)
