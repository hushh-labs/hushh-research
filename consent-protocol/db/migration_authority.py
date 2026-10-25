"""Pending-only Postgres migration authority.

The production-safe default remains ``replay`` until an environment has been
reconciled and explicitly baselined. UAT can first use ``observe`` to inspect
the ledger and immutable checksums without executing migration bodies, then
move to ``ledger`` only after preservation evidence has been accepted.

This module never reads application rows and never logs SQL or credentials.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterable

from db.referral_prize_activation import (
    REFERRAL_POLICY_V5_SHA256 as _REFERRAL_POLICY_V5_SHA256,
)
from db.referral_prize_activation import (
    policy_fingerprint_sql as _referral_policy_fingerprint_sql,
)
from db.referral_prize_activation import (
    reviewed_prize_successor_sql,
)

_MIGRATION_ID_RE = re.compile(r"^(?P<id>[0-9]{8,}_[0-9A-Za-z]+|[0-9]{3,})_")
_ADVISORY_LOCK_KEY = 0x485553534844424D  # "HUSSHDBM", within signed BIGINT.
_ALLOWED_BASELINE_ENVIRONMENTS = {"uat", "test", "local", "development", "dev"}
# Anything slower than this is named in the deploy log. Lock contention shows
# up here first, as a migration that used to be instant and now is not.
_SLOW_MIGRATION_MS = 1_000

# Lock contention is not a broken migration -- it is a busy database. Postgres
# queues lock requests, so a pending ACCESS EXCLUSIVE request blocks every
# later reader of that table too: raising ``lock_timeout`` would make a deploy
# hold the environment down for longer, not succeed more often. The safe shape
# is the opposite -- keep the timeout short, let go, and try again once the
# queue has drained.
#
# 55P03 lock_not_available   -- our own ``lock_timeout`` fired
# 40P01 deadlock_detected    -- two transactions crossed
# 40001 serialization_failure-- lost a concurrency race, retryable by definition
_LOCK_CONTENTION_SQLSTATES = frozenset({"55P03", "40P01", "40001"})
_LOCK_RETRY_ATTEMPTS = 4
_LOCK_RETRY_BASE_DELAY_S = 1.0
# Bound what the RUN may spend retrying, not only what one migration may.
# The UAT lane is 174 entries; at 4 attempts each that is
# 174 x (4 x 5s lock wait + 7s backoff) = ~78 minutes, and deploy-uat.yml sets
# no `timeout-minutes` (GitHub default 360). Unbounded, retry would turn a
# 3-minute red deploy into a 78-minute hung one holding the advisory lock with
# the account-deletion release fence installed -- worse than the bug it fixes.
# Past the budget the next contention failure is reported instead of retried.
_LOCK_RETRY_RUN_BUDGET_S = 300.0


def _is_lock_contention(exc: BaseException) -> bool:
    """True only for "the database was busy", never for a broken migration.

    A constraint violation, a syntax error or a missing relation must fail on
    the first attempt: retrying those just burns the deploy window and reports
    the same error later. Only a contention SQLSTATE is worth a second try.
    """
    sqlstate = getattr(exc, "sqlstate", None)
    return isinstance(sqlstate, str) and sqlstate in _LOCK_CONTENTION_SQLSTATES


async def _reset_connection(conn: Any, failure: BaseException) -> bool:
    """Clear the aborted transaction. Returns False when the connection is gone.

    R28 again, on the new path: this cleanup runs on a connection that has just
    failed, so it can fail too -- and its failure must never become the reported
    error. The lock timeout stays the diagnosis; a reset failure becomes a note
    on it and ends the retrying, because there is nothing left to retry with.
    """
    try:
        await _rollback_failed_transaction(conn)
        return True
    except Exception as reset_error:  # noqa: BLE001 - diagnostic only
        failure.add_note(f"connection reset failed [{_failure_signature(reset_error)}]")
        print(
            f"  connection reset failed [{_failure_signature(reset_error)}]",
            file=sys.stderr,
            flush=True,
        )
        return False


def _lock_retry_delay_seconds(attempt: int) -> float:
    """Exponential backoff: 1s, 2s, 4s. Bounded, and short enough to stay
    inside a deploy window even if several migrations each need a retry."""
    return float(_LOCK_RETRY_BASE_DELAY_S * (2 ** (attempt - 1)))


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
                # A concurrent index must be its own top-level SQL statement.
                # Keep this opt-in in the checksummed migration, so replay and
                # ledger use the same authored execution contract.
                transactional=not sql.startswith("-- migration: transactional=false\n"),
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


def _failure_signature(exc: BaseException) -> str:
    """Identify a failure without quoting the database's message.

    A Postgres error string can carry application data -- a unique violation
    names the offending key and its value -- and this module does not log
    application rows. The exception class and its SQLSTATE are enough to tell
    a lock timeout (55P03) from a duplicate object (42710) from a syntax
    error, which is the whole question an operator is asking.
    """
    sqlstate = getattr(exc, "sqlstate", None)
    signature = _sanitize_failure_class(exc)
    if isinstance(sqlstate, str) and sqlstate.isalnum():
        signature = f"{signature} sqlstate={sqlstate}"
    return signature


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


def _replay_drive_feed_sql(entry: MigrationManifestEntryV2) -> str:
    # 288's exact allowlist test narrowed later document_share_* vocabulary on
    # replay. Preserve the immutable file and ledger/baseline hash; adapt only
    # the published body, retaining installed vocabulary and rows.
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        checksum != "b13a15ee0d27a4c78efd99718adb1996ecb8c54254dbf1377a250d8791424ee6"
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("Legacy Drive Feed replay source checksum changed")
    start = entry.sql.index("DO $$")
    end = entry.sql.index("END $$;", start) + len("END $$;")
    repair = """DO $$
DECLARE
  installed TEXT[];
  allowed TEXT;
  required TEXT[] := ARRAY[
    'document_share_decided','document_share_outcome',
    'document_share_payment_confirmed','document_share_payment_ready',
    'document_share_payment_refunded','document_share_request',
    'document_share_request_sent','document_share_review_ready',
    'document_share_revocation_outcome','document_share_revoked'];
BEGIN
  SELECT ARRAY(SELECT DISTINCT hit[1] FROM regexp_matches(
    pg_get_constraintdef(c.oid), '''(document_share_[^'']+)''', 'g') AS hit
    ORDER BY hit[1]) INTO installed
  FROM pg_constraint c
  WHERE c.conrelid='drive_share_events'::regclass
    AND c.conname='drive_share_events_event_type_check';
  IF NOT COALESCE(installed @> required, FALSE) THEN
    SELECT string_agg(DISTINCT quote_literal(value), ',' ORDER BY quote_literal(value)) INTO allowed
      FROM unnest(COALESCE(installed, ARRAY[]::TEXT[]) || required) AS value;
    ALTER TABLE drive_share_events DROP CONSTRAINT IF EXISTS drive_share_events_event_type_check;
    EXECUTE format(
      'ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_events_event_type_check CHECK (event_type IN (%s))',
      allowed);
  END IF;
END $$;"""
    return entry.sql[:start] + repair + entry.sql[end:]


_BANK_PAYOUT_EVENT_REPLAY_CHECKSUMS = {
    ("298", "298_stripe_mode_isolation.sql"): (
        "edcfe4260fef678bdf3ae759fae46fc725b7dedef5d884f9a2c8627a6d64eb99"
    ),
    ("304", "304_connect_bank_payout_reconciliation.sql"): (
        "e622469054a16a1cfc52171529aa1e3814bedece8712d32d2616fbc704c54de8"
    ),
}

_REFERRAL_POLICY_V2_REPLAY_CHECKSUM = (
    "52a25acc61327f6b7f3b69c905fae9425844c934ac7a1000e040d7f5b2737c65"
)
_REFERRAL_POLICY_V3_OBSERVED_UAT_SHA256 = (
    "ed26dc5ad4a88eaa0564200a139ded13b52e1783755c7fef569b37429138f27a"
)
_REFERRAL_POLICY_V4_SHA256 = "11cd7d8c9eb83a6d24f25814d3ab7b8a21182f21a98594657d6721a6dcdf5b19"


def _replay_referral_policy_v2_sql(entry: MigrationManifestEntryV2) -> str:
    """Accept reviewed v3 through v6 successors without rewriting policy rows.

    The published 289 body requires v2 to remain active forever. A later
    versioned policy retires v2. Replay recognizes only the reviewed v3 catalogue,
    migration 347's v4 lifecycle policy and migration 349's v5 catalogue, after
    verifying the entire lineage and every authored v2 value. Unknown successors
    fail closed.
    Keep it out of ledger/observe mode and pin the original file's checksum.
    """
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if checksum != _REFERRAL_POLICY_V2_REPLAY_CHECKSUM or entry.checksum_sha256 != checksum:
        raise MigrationAuthorityError("Referral policy v2 replay source checksum changed")

    sql = entry.sql

    def replace_once(old: str, new: str) -> None:
        nonlocal sql
        if sql.count(old) != 1:
            raise MigrationAuthorityError("Referral policy v2 replay source shape changed")
        sql = sql.replace(old, new, 1)

    replace_once(
        "  active_count INTEGER;\nBEGIN\n",
        "  active_count INTEGER;\n"
        "  successor_row RECORD;\n"
        "  expected_successor_version INTEGER := 3;\n"
        "  previous_retirement TIMESTAMPTZ;\n"
        "  successor_count INTEGER := 0;\n"
        "  successor_policy_hash TEXT;\nBEGIN\n",
    )
    replace_once(
        "  PERFORM 1 FROM one_referral_program_settings WHERE version IN (1, 2) FOR UPDATE;",
        "  LOCK TABLE one_referral_program_settings IN SHARE ROW EXCLUSIVE MODE;\n"
        "  PERFORM 1 FROM one_referral_program_settings WHERE version IN (1, 2);",
    )
    replace_once(
        "  -- Serialize: lock both candidate rows before reading either, so a second\n"
        "  -- concurrent replay of this migration blocks here rather than racing this\n"
        "  -- one on the read.",
        "  -- Serialize policy writes with a table lock before reading the\n"
        "  -- lineage. Do not also lock v1/v2 rows: a writer holding a row lock\n"
        "  -- before its UPDATE would deadlock against the table lock.",
    )
    replace_once(
        "    IF v2_row.activated_at IS NULL OR v2_row.retired_at IS NOT NULL THEN\n"
        "      RAISE EXCEPTION 'migration 289: version 2 exists but is not the active settings version (activated_at=%, retired_at=%); refusing to guess intent; version 1 left untouched',\n"
        "        v2_row.activated_at, v2_row.retired_at;\n"
        "    END IF;",
        "    IF v2_row.activated_at IS NULL THEN\n"
        "      RAISE EXCEPTION 'migration 289: version 2 exists but was never activated';\n"
        "    END IF;",
    )
    replace_once(
        "migration 289: version 2 exists and is active, but its configuration does not match",
        "migration 289: version 2 exists, but its configuration does not match",
    )
    replace_once(
        "    RAISE NOTICE 'migration 289: version 2 already active with matching configuration; idempotent no-op';",
        f"""    IF v2_row.retired_at IS NULL THEN
      RAISE NOTICE 'migration 289: version 2 already active with matching configuration; idempotent no-op';
    ELSE
      -- A later policy may supersede v2. Require an unbroken, ordered
      -- activation/retirement chain and leave every historical row untouched.
      SELECT * INTO v1_row FROM one_referral_program_settings WHERE version = 1;
      IF NOT FOUND OR v1_row.activated_at IS NULL
         OR v1_row.retired_at IS DISTINCT FROM v2_row.activated_at THEN
        RAISE EXCEPTION 'migration 289: version 1 to 2 policy lineage is invalid';
      END IF;
      previous_retirement := v2_row.retired_at;
      FOR successor_row IN
        SELECT version, activated_at, retired_at
          FROM one_referral_program_settings
         WHERE version > 2
         ORDER BY version
      LOOP
        IF successor_row.version <> expected_successor_version
           OR successor_row.activated_at IS DISTINCT FROM previous_retirement
           OR (successor_row.retired_at IS NOT NULL
               AND successor_row.retired_at <= successor_row.activated_at) THEN
          RAISE EXCEPTION 'migration 289: later policy lineage is incomplete or out of order at version %',
            successor_row.version;
        END IF;
        previous_retirement := successor_row.retired_at;
        expected_successor_version := expected_successor_version + 1;
        successor_count := successor_count + 1;
      END LOOP;
      IF successor_count NOT IN (1, 2, 3, 4) OR previous_retirement IS NOT NULL THEN
        RAISE EXCEPTION 'migration 289: retired version 2 requires reviewed version 3, 4, 5 or 6 successors ending in one active policy';
      END IF;
      SELECT ({_referral_policy_fingerprint_sql(3)}) INTO successor_policy_hash;
      IF successor_policy_hash IS DISTINCT FROM '{_REFERRAL_POLICY_V3_OBSERVED_UAT_SHA256}' THEN
        RAISE EXCEPTION 'migration 289: version 3 contents differ from the reviewed policy fingerprint';
      END IF;
      IF successor_count >= 2 THEN
        SELECT ({_referral_policy_fingerprint_sql(4)}) INTO successor_policy_hash;
        IF successor_policy_hash IS DISTINCT FROM '{_REFERRAL_POLICY_V4_SHA256}' THEN
          RAISE EXCEPTION 'migration 289: version 4 contents differ from the reviewed policy fingerprint';
        END IF;
      END IF;
      IF successor_count >= 3 THEN
        SELECT ({_referral_policy_fingerprint_sql(5)}) INTO successor_policy_hash;
        IF successor_policy_hash IS DISTINCT FROM '{_REFERRAL_POLICY_V5_SHA256}' THEN
          RAISE EXCEPTION 'migration 289: version 5 contents differ from the reviewed policy fingerprint';
        END IF;
      END IF;
      IF successor_count = 4 AND NOT ({reviewed_prize_successor_sql()}) THEN
        RAISE EXCEPTION 'migration 289: unreviewed weekly-prize activation successor';
      END IF;
      RAISE NOTICE 'migration 289: exact historical version 2 superseded by reviewed policy; idempotent no-op';
    END IF;""",
    )
    return sql


def _replay_referral_policy_v3_sql(entry: MigrationManifestEntryV2) -> str:
    """Preserve retired v3 only under the exact, active lifecycle successor."""
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        checksum != "8dc499738dc5d0e7d5b1d2e7d664c66381b885bf90e9563371f8259ac304fb98"
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("Referral policy v3 replay source checksum changed")
    old = "IF current_row.activated_at IS NULL OR current_row.retired_at IS NOT NULL"
    if entry.sql.count(old) != 1:
        raise MigrationAuthorityError("Referral policy v3 replay source shape changed")
    return entry.sql.replace(
        old,
        f"""IF current_row.activated_at IS NULL
       OR prior.retired_at IS DISTINCT FROM current_row.activated_at
       OR (current_row.retired_at IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM one_referral_program_settings successor
          WHERE successor.version = 4
            AND (successor.retired_at IS NULL OR EXISTS (
              SELECT 1 FROM one_referral_program_settings v5 WHERE v5.version=5
                AND v5.activated_at=successor.retired_at
                AND (v5.retired_at IS NULL OR {reviewed_prize_successor_sql()})
                AND v5.activated_at>successor.activated_at
                AND ({_referral_policy_fingerprint_sql(5)}) = '{_REFERRAL_POLICY_V5_SHA256}'
            ))
            AND successor.activated_at = current_row.retired_at
            AND successor.activated_at > current_row.activated_at
            AND ({_referral_policy_fingerprint_sql(3)}) = '{_REFERRAL_POLICY_V3_OBSERVED_UAT_SHA256}'
            AND ({_referral_policy_fingerprint_sql(4)}) = '{_REFERRAL_POLICY_V4_SHA256}'
            AND (NOT EXISTS (SELECT 1 FROM one_referral_program_settings WHERE version > 5)
              OR {reviewed_prize_successor_sql()})
       ))""",
        1,
    )


def _replay_referral_policy_v4_sql(entry: MigrationManifestEntryV2) -> str:
    """Accept only the exact reviewed v5 successor, preserving immutable 347."""
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        checksum != "2036301cdae30b7786a568b41635d5b331e542bb132677dafb4f3227bfe11279"
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("Referral policy v4 replay source checksum changed")
    old = "s.version=4\n    AND s.activated_at IS NOT NULL AND s.retired_at IS NULL"
    if entry.sql.count(old) != 1:
        raise MigrationAuthorityError("Referral policy v4 replay source shape changed")
    return entry.sql.replace(
        old,
        f"""s.version=4
    AND s.activated_at IS NOT NULL AND (s.retired_at IS NULL OR EXISTS (
      SELECT 1 FROM one_referral_program_settings v5 WHERE v5.version=5
        AND v5.activated_at=s.retired_at AND v5.activated_at>s.activated_at
        AND (v5.retired_at IS NULL OR {reviewed_prize_successor_sql()})
        AND ({_referral_policy_fingerprint_sql(4)})='{_REFERRAL_POLICY_V4_SHA256}'
        AND ({_referral_policy_fingerprint_sql(5)})='{_REFERRAL_POLICY_V5_SHA256}'
        AND (NOT EXISTS(SELECT 1 FROM one_referral_program_settings WHERE version>5)
          OR {reviewed_prize_successor_sql()})
    ))""",
        1,
    )


def _replay_referral_policy_v5_sql(entry: MigrationManifestEntryV2) -> str:
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        checksum != "3d160ef807200eb1a2b9ac7aa385199919a92967ab665e46d46d25f175388459"
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("Referral policy v5 replay source checksum changed")
    old = "IF current_row.activated_at IS NULL OR current_row.retired_at IS NOT NULL"
    if entry.sql.count(old) != 1:
        raise MigrationAuthorityError("Referral policy v5 replay source shape changed")
    return entry.sql.replace(
        old,
        f"IF current_row.activated_at IS NULL OR (current_row.retired_at IS NOT NULL AND NOT ({reviewed_prize_successor_sql()}))",
        1,
    )


def _replay_bank_payout_event_sql(entry: MigrationManifestEntryV2, pinned: str) -> str:
    # 298 and 304 re-add an exact Connect event CHECK on replay, which rejects
    # rows of event types added later and locks the table on every deploy.
    # Preserve the immutable file and ledger/baseline hash; adapt only the
    # published body to widen, retaining installed vocabulary and rows.
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if checksum != pinned or entry.checksum_sha256 != checksum:
        raise MigrationAuthorityError("Legacy bank payout event replay source checksum changed")
    start = entry.sql.index("ALTER TABLE stripe_connect_bank_payout_events\n  DROP CONSTRAINT")
    end = entry.sql.index(
        "ADD CONSTRAINT stripe_connect_bank_payout_events_event_type_check", start
    )
    end = entry.sql.index("));", end) + len("));")
    repair = """DO $$
DECLARE
  installed TEXT[];
  allowed TEXT;
  required TEXT[] := ARRAY[
    'account.external_account.created','account.external_account.deleted',
    'account.external_account.updated','account.updated','payout.canceled',
    'payout.created','payout.failed','payout.paid','payout.updated'];
BEGIN
  SELECT ARRAY(SELECT DISTINCT hit[1] FROM regexp_matches(
    pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') AS hit
    ORDER BY hit[1]) INTO installed
  FROM pg_constraint c
  WHERE c.conrelid='stripe_connect_bank_payout_events'::regclass
    AND c.conname='stripe_connect_bank_payout_events_event_type_check';
  IF NOT COALESCE(installed @> required, FALSE) THEN
    SELECT string_agg(DISTINCT quote_literal(value), ',' ORDER BY quote_literal(value)) INTO allowed
      FROM unnest(COALESCE(installed, ARRAY[]::TEXT[]) || required) AS value;
    ALTER TABLE stripe_connect_bank_payout_events
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payout_events_event_type_check;
    EXECUTE format(
      'ALTER TABLE stripe_connect_bank_payout_events ADD CONSTRAINT '
      'stripe_connect_bank_payout_events_event_type_check CHECK (event_type IN (%s))',
      allowed);
  END IF;
END $$;"""
    return entry.sql[:start] + repair + entry.sql[end:]


def _replay_system_push_outbox_sql(entry: MigrationManifestEntryV2) -> str:
    """Replay published 361 without replacing delivery history or live triggers."""
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        checksum != "41bb1bf983b3a79df83ddb2ae2106ff8132ee2f73d666183cd9b7b8bb5f94608"
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("System push replay source checksum changed")
    # Preserve the immutable file and ledger/baseline hashes. Only replay mode
    # adapts its original bare DDL; pending leases and accepted-device rows stay.
    replay = entry.sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
    replay = replay.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ")
    replay = replay.replace(
        "CREATE FUNCTION queue_system_push()", "CREATE OR REPLACE FUNCTION queue_system_push()"
    )
    start = replay.index("CREATE TRIGGER system_push_share ")
    end = replay.index("\n\nALTER TABLE system_push_outbox", start)
    # Match migration 313's hot-table policy: retain installed trigger objects,
    # reject drift, and create only missing ones. The source checksum bounds
    # these fixed identifiers/event clauses; no historical source rows are read.
    triggers = """DO $$
DECLARE spec RECORD; installed RECORD; relation REGCLASS; expected_attribute TEXT;
BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('system_push_share','one_location_share_grants','INSERT OR UPDATE OF latest_envelope_id',21,'latest_envelope_id'),
  ('system_push_location_request','one_location_access_requests','INSERT OR UPDATE',21,NULL),
  ('system_push_connection_request','connection_requests','INSERT',5,NULL),
  ('system_push_circle_member','one_location_circle_memberships','INSERT OR UPDATE OF status',21,'status')
 ) AS definitions(name,table_name,events,trigger_type,column_name) LOOP
  relation := format('public.%I',spec.table_name)::REGCLASS;
  expected_attribute := '';
  IF spec.column_name IS NOT NULL THEN
   SELECT attnum::TEXT INTO expected_attribute FROM pg_attribute
    WHERE attrelid=relation AND attname=spec.column_name AND NOT attisdropped;
   IF expected_attribute IS NULL THEN
    RAISE EXCEPTION 'System push trigger column is missing: %',spec.name;
   END IF;
  END IF;
  SELECT * INTO installed FROM pg_trigger
   WHERE tgrelid=relation AND tgname=spec.name AND NOT tgisinternal;
  IF NOT FOUND THEN
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.%I '
    'FOR EACH ROW EXECUTE FUNCTION public.queue_system_push()',
    spec.name,spec.events,spec.table_name);
  ELSIF installed.tgfoid <> 'public.queue_system_push()'::REGPROCEDURE::OID
   OR installed.tgtype <> spec.trigger_type OR installed.tgenabled <> 'O'
   OR installed.tgqual IS NOT NULL OR installed.tgnargs <> 0
   OR installed.tgattr::TEXT <> expected_attribute OR installed.tgconstraint <> 0
   OR installed.tgoldtable IS NOT NULL OR installed.tgnewtable IS NOT NULL THEN
   RAISE EXCEPTION 'System push trigger has unexpected definition: %',spec.name;
  END IF;
 END LOOP;
END $$;"""
    return replay[:start] + triggers + replay[end:]


def _replay_drive_cent_prices_sql(entry: MigrationManifestEntryV2) -> str:
    from db.drive_packet_replay import cent_prices_replay_sql

    try:
        return cent_prices_replay_sql(entry)
    except ValueError as exc:
        raise MigrationAuthorityError(str(exc)) from None


def _replay_sql(entry: MigrationManifestEntryV2) -> str:
    from db.account_cleanup_replay import SOURCES as ACCOUNT_SOURCES
    from db.account_cleanup_replay import account_cleanup_replay_sql
    from db.private_action_replay import SOURCES, private_action_replay_sql

    if (entry.migration_id, entry.filename) in ACCOUNT_SOURCES:
        try:
            return account_cleanup_replay_sql(
                entry,
                qualified_referral_sql=_replay_referral_policy_v4_sql(entry)
                if entry.migration_id == "347"
                else None,
            )
        except ValueError as exc:
            raise MigrationAuthorityError(str(exc)) from None
    if (entry.migration_id, entry.filename) in SOURCES:
        try:
            return private_action_replay_sql(entry)
        except ValueError as exc:
            raise MigrationAuthorityError(str(exc)) from None
    if entry.migration_id == "329" and entry.filename == "329_drive_request_cent_prices.sql":
        return _replay_drive_cent_prices_sql(entry)
    if entry.migration_id == "360" and entry.filename == "360_uat_drive_collection_retirement.sql":
        from db.drive_packet_replay import retirement_replay_sql

        try:
            return retirement_replay_sql(entry)
        except ValueError as exc:
            raise MigrationAuthorityError(str(exc)) from None
    if entry.migration_id == "361" and entry.filename == "361_system_push_outbox.sql":
        return _replay_system_push_outbox_sql(entry)
    if entry.migration_id == "289" and entry.filename == "289_one_referral_program_settings_v2.sql":
        return _replay_referral_policy_v2_sql(entry)
    if entry.migration_id == "338" and entry.filename == "338_one_referral_usd_catalogue.sql":
        return _replay_referral_policy_v3_sql(entry)
    if entry.migration_id == "349" and entry.filename == "349_one_referral_dashboard_truth.sql":
        return _replay_referral_policy_v5_sql(entry)
    if entry.migration_id == "288" and entry.filename == "288_drive_request_feed_stream.sql":
        return _replay_drive_feed_sql(entry)
    pinned = _BANK_PAYOUT_EVENT_REPLAY_CHECKSUMS.get((entry.migration_id, entry.filename))
    if pinned:
        return _replay_bank_payout_event_sql(entry, pinned)
    # Migration 295 shipped a bare CREATE POLICY. Preserve its immutable source
    # and ledger/baseline hashes, while making its known body replayable inside
    # the original transaction. Never adapt other or drifted migration bodies.
    if entry.migration_id != "295" or entry.filename != "295_direct_message_attachments.sql":
        return entry.sql
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        checksum != "f76a5e6e71d1979dbcd71d2e3c5ad390c1aa9f018742946bee2dcea3831d4edc"
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("Legacy attachment replay source checksum changed")
    policy = (
        "CREATE POLICY direct_message_attachments_deny_all ON public.direct_message_attachments"
    )
    return entry.sql.replace(
        policy,
        "DROP POLICY IF EXISTS direct_message_attachments_deny_all ON public.direct_message_attachments;\n"
        + policy,
        1,
    )


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


# Who is the migration waiting on? Read-only, and deliberately never selects
# ``query``: another session's SQL text can carry personal information. The
# pid, application_name, state, wait event and ages are enough to find it.
_WAITING_ON_SQL = """
SELECT waiting.relation::regclass::text AS relation, waiting.mode
FROM pg_locks AS waiting
WHERE waiting.pid = $1 AND NOT waiting.granted
LIMIT 1
"""
_BLOCKERS_SQL = """
SELECT blocker.pid,
       blocker.application_name,
       blocker.state,
       blocker.wait_event_type,
       blocker.wait_event,
       EXTRACT(EPOCH FROM clock_timestamp() - blocker.xact_start)::bigint AS xact_age_s,
       EXTRACT(EPOCH FROM clock_timestamp() - blocker.query_start)::bigint AS query_age_s
FROM pg_stat_activity AS blocker
WHERE blocker.pid = ANY (pg_blocking_pids($1))
ORDER BY blocker.xact_start NULLS LAST
LIMIT 5
"""
_LOCK_PROBE_MAX_INTERVAL_S = 1.0


def _probe_label(value: Any) -> str:
    """A catalog value made safe for one log line: bounded, no free text."""
    if value is None:
        return "-"
    return re.sub(r"[^A-Za-z0-9_.:/@-]", "_", str(value))[:64] or "-"


async def _describe_lock_wait(probe_conn: Any, pid: int) -> str | None:
    """Name the relation ``pid`` is waiting for and the sessions holding it."""
    blockers = await probe_conn.fetch(_BLOCKERS_SQL, pid)
    if not blockers:
        return None
    waiting = await probe_conn.fetchrow(_WAITING_ON_SQL, pid)
    target = (
        f"waiting for {_probe_label(waiting['mode'])} on {_probe_label(waiting['relation'])}"
        if waiting
        else "waiting for a lock"
    )
    held_by = "; ".join(
        f"pid={int(row['pid'])} app={_probe_label(row['application_name'])} "
        f"state={_probe_label(row['state'])} "
        f"wait={_probe_label(row['wait_event_type'])}/{_probe_label(row['wait_event'])} "
        f"xact_age={_probe_label(row['xact_age_s'])}s query_age={_probe_label(row['query_age_s'])}s"
        for row in blockers
    )
    return f"{target}, blocked by {held_by}"


class _LockWaitProbe:
    """Samples, from a second connection, who is blocking a running migration.

    Postgres cannot answer this after the fact: once ``lock_timeout`` fires the
    migration is no longer waiting, so ``pg_blocking_pids`` has nothing to say.
    The probe therefore samples WHILE the statement runs, and keeps the last
    non-empty answer. It starts only after the first interval, so the ordinary
    millisecond migration never touches the second connection. A probe failure
    only changes what the lock-contention log line says, never the migration.
    """

    def __init__(self, pool: Any, lock_timeout_ms: int) -> None:
        self._pool = pool
        self._interval_s = min(_LOCK_PROBE_MAX_INTERVAL_S, max(lock_timeout_ms, 1) / 5_000)
        self.observed: str | None = None

    async def watch(self, pid: int) -> None:
        try:
            await asyncio.sleep(self._interval_s)
            # Opening the second connection can be slow over the Cloud SQL proxy;
            # it must still land before the default 5s lock_timeout fires.
            async with self._pool.acquire(timeout=self._interval_s * 3) as probe_conn:
                while True:
                    observed = await _describe_lock_wait(probe_conn, pid)
                    if observed:
                        self.observed = observed
                    await asyncio.sleep(self._interval_s)
        except asyncio.CancelledError:
            raise
        except Exception as probe_error:  # noqa: BLE001 - diagnostic only
            self.observed = self.observed or (
                f"blocker probe unavailable [{_failure_signature(probe_error)}]"
            )


async def _execute_observed(conn: Any, sql: str, probe: _LockWaitProbe | None) -> None:
    """Run ``sql`` on ``conn`` while ``probe`` (if any) watches its lock waits."""
    get_pid = getattr(conn, "get_server_pid", None)
    if probe is None or not callable(get_pid):
        await conn.execute(sql)
        return
    watcher = asyncio.create_task(probe.watch(int(get_pid())))
    try:
        await conn.execute(sql)
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)


def _lock_wait_detail(probe: _LockWaitProbe | None) -> str:
    if probe is None:
        return ""
    return f"; {probe.observed or 'no blocking session observed'}"


async def apply_manifest_entries(
    conn: Any,
    entries: tuple[MigrationManifestEntryV2, ...],
    *,
    mode: MigrationMode,
    deploy_sha: str = "",
    lock_probe_pool: Any | None = None,
) -> tuple[str, ...]:
    """Apply one manifest under a session advisory lock.

    ``replay`` preserves the historical behavior and does not create ledger
    rows. ``observe`` inspects ledger/checksum state but executes no migration
    bodies. ``ledger`` executes only entries not covered by an applied row or
    a required verified baseline.

    ``lock_probe_pool``, when given, supplies a second connection used only to
    name the session blocking a migration that is waiting on a lock.
    """

    await _try_lock(conn)
    applied: list[str] = []
    retry_spent_s = 0.0
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

            sql = _replay_sql(entry) if mode is MigrationMode.REPLAY else entry.sql
            for attempt in range(1, _LOCK_RETRY_ATTEMPTS + 1):
                started = time.perf_counter()
                recorded_applied = False
                probe = (
                    _LockWaitProbe(lock_probe_pool, entry.lock_timeout_ms)
                    if lock_probe_pool is not None
                    else None
                )
                try:
                    if mode is MigrationMode.LEDGER and entry.transactional:
                        async with conn.transaction():
                            await conn.execute(
                                f"SET LOCAL lock_timeout = '{entry.lock_timeout_ms}ms'"
                            )
                            await conn.execute(
                                f"SET LOCAL statement_timeout = '{entry.statement_timeout_ms}ms'"
                            )
                            await _execute_observed(conn, sql, probe)
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
                        await conn.execute(
                            f"SET statement_timeout = '{entry.statement_timeout_ms}ms'"
                        )
                        await _execute_observed(conn, sql, probe)
                except Exception as exc:
                    duration_ms = round((time.perf_counter() - started) * 1000)
                    # A busy database is not a broken migration. Roll back first
                    # so the connection is usable again, then wait for the lock
                    # queue to drain and try the same body once more. Only a
                    # contention SQLSTATE gets this; a constraint violation or a
                    # syntax error still fails on the first attempt.
                    delay = _lock_retry_delay_seconds(attempt)
                    if _is_lock_contention(exc):
                        retry_spent_s += time.perf_counter() - started
                    if (
                        _is_lock_contention(exc)
                        and attempt < _LOCK_RETRY_ATTEMPTS
                        and retry_spent_s + delay <= _LOCK_RETRY_RUN_BUDGET_S
                        # The next attempt runs on the connection this one left
                        # behind, so clearing it is part of the decision: if the
                        # reset fails there is nothing to retry with, and the
                        # lock error -- not the reset -- stays the diagnosis.
                        and await _reset_connection(conn, exc)
                    ):
                        retry_spent_s += delay
                        print(
                            f"  lock contention on {entry.filename} after {duration_ms}ms "
                            f"[{_failure_signature(exc)}]{_lock_wait_detail(probe)}; "
                            f"retry {attempt}/{_LOCK_RETRY_ATTEMPTS - 1} in {delay:.0f}s",
                            file=sys.stderr,
                            flush=True,
                        )
                        await asyncio.sleep(delay)
                        continue
                    # Say which migration failed, and say it before anything else can
                    # go wrong. Nothing in this function named the entry, so six UAT
                    # deploys failed against a 173-file replay with no way to tell
                    # which file stopped it.
                    print(
                        f"MIGRATION FAILED: {entry.filename} after {duration_ms}ms "
                        f"[{_failure_signature(exc)}]"
                        + (
                            f" (gave up after {attempt} lock attempts{_lock_wait_detail(probe)})"
                            if _is_lock_contention(exc)
                            else ""
                        ),
                        file=sys.stderr,
                        flush=True,
                    )
                    # Return the connection to a usable state in EVERY mode. This
                    # used to be inside the `if` below, so a REPLAY failure left the
                    # transaction aborted and the `finally: await _unlock(conn)` at
                    # the end of this function then raised InFailedSQLTransactionError
                    # -- which replaced the real error in the traceback. The UAT
                    # workflow reported "current transaction is aborted" when the
                    # actual failure was "canceling statement due to lock timeout".
                    # Guarded for the same reason the unlock below is: this reset
                    # runs on a just-failed connection and can fail itself, and
                    # its exception must not replace the migration's (R28).
                    await _reset_connection(conn, exc)
                    if mode is not MigrationMode.REPLAY:
                        await _record_result(
                            conn,
                            entry=entry,
                            status="failed",
                            duration_ms=duration_ms,
                            deploy_sha=deploy_sha,
                            failure_class=_sanitize_failure_class(exc),
                        )
                    exc.add_note(f"while applying migration {entry.filename} ({duration_ms}ms)")
                    raise
                break
            duration_ms = round((time.perf_counter() - started) * 1000)
            if duration_ms >= _SLOW_MIGRATION_MS:
                print(
                    f"  slow migration: {entry.filename} took {duration_ms}ms",
                    file=sys.stderr,
                    flush=True,
                )
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
        preserving_error = sys.exc_info()[0] is not None
        # Releasing the advisory lock must never replace the error that brought
        # us here. On an aborted connection this call itself raises, and that
        # exception would propagate instead of the migration's own.
        try:
            await _unlock(conn)
        except Exception as unlock_exc:  # noqa: BLE001 - diagnostic only
            if not preserving_error:
                raise
            print(
                f"advisory unlock failed [{_failure_signature(unlock_exc)}]",
                file=sys.stderr,
                flush=True,
            )


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
            "Baseline establishment is prohibited outside local/test/Dev/UAT environments"
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
