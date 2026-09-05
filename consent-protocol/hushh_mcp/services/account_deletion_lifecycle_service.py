"""Durable account-erasure suppression and Firebase cleanup retry operon."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal, cast

from sqlalchemy import text

from api.utils.firebase_admin import get_firebase_auth_app
from db.db_client import get_db_connection
from hushh_mcp.config import APP_SIGNING_KEY

logger = logging.getLogger(__name__)

FirebaseCleanupOutcome = Literal[
    "deleted",
    "not_found",
    "protected",
    "retry_pending",
    "quarantined",
    "quarantine_incomplete",
]
CleanupIntentKind = Literal["full_account", "phone_orphan"]


class AccountDeletionInProgressError(RuntimeError):
    """The UID lifecycle barrier is exclusively held by a deletion transaction."""


_CONNECTION_GRAPH_LOCK_NAMESPACE = 171
_ACCOUNT_LIFECYCLE_LOCK_NAMESPACE = 198
_FIREBASE_DELETE_MAX_ATTEMPTS = 2
_FIREBASE_DELETE_RETRY_DELAY_SECONDS = 0.1
_FIREBASE_SDK_CALL_TIMEOUT_SECONDS = 3.0
_FIREBASE_CLEANUP_INTENT_TIMEOUT_SECONDS = 12.0
_CLEANUP_DATABASE_TIMEOUT_SECONDS = 5.0
_CLEANUP_CLAIM_STALE_MINUTES = 5
_CLEANUP_LOOP_INTERVAL_SECONDS = 60.0
_PHONE_DIGEST_PREFIX = "hmac-sha256:"
_PHONE_DIGEST_DOMAIN = b"hushh-account-deletion-phone-orphan-v1\x00"
_PHONE_DIGEST_RE = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")

_PHONE_CLASSIFICATION_REVALIDATED = "phone_orphan_revalidated"
_PHONE_CLASSIFICATION_UID_MISMATCH = "firebase_uid_mismatch"
_PHONE_CLASSIFICATION_MISSING = "phone_number_missing"
_PHONE_CLASSIFICATION_DIGEST_MISMATCH = "phone_digest_mismatch"
_PHONE_CLASSIFICATION_ESTABLISHED = "firebase_identity_established"
_PHONE_CLASSIFICATION_REVALIDATION_UNAVAILABLE = "firebase_revalidation_unavailable"
_PHONE_CLASSIFICATION_PROOF_MISSING = "phone_cleanup_proof_missing"
_FIREBASE_CLASSIFICATION_NOT_FOUND = "firebase_user_not_found"


def _postgres_sqlstate(exc: BaseException) -> str | None:
    """Return a driver SQLSTATE without depending on one psycopg generation."""
    pending: list[BaseException] = [exc]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        for attribute in ("sqlstate", "pgcode"):
            value = getattr(current, attribute, None)
            if isinstance(value, str) and value:
                return value
        for related in (
            getattr(current, "orig", None),
            current.__cause__,
            current.__context__,
        ):
            if isinstance(related, BaseException):
                pending.append(related)
    return None


@dataclass(frozen=True, slots=True)
class FirebaseCleanupAttempt:
    outcome: FirebaseCleanupOutcome
    failure_class: str | None = None
    classification: str | None = None


@dataclass(frozen=True, slots=True)
class ClaimedCleanupIntent:
    firebase_uid: str
    claim_token: str
    intent_kind: CleanupIntentKind = "full_account"
    expected_phone_digest: str | None = None


def account_deletion_user_hash(user_id: str) -> str:
    normalized = str(user_id or "").strip()
    if not normalized:
        raise ValueError("user_id is required")
    return "sha256:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def account_deletion_phone_digest(phone_number: str) -> str:
    """Return a domain-separated keyed proof without retaining a phone number."""
    normalized = str(phone_number or "").strip()
    if not normalized:
        raise ValueError("phone_number is required")
    digest = hmac.new(
        APP_SIGNING_KEY.encode("utf-8"),
        _PHONE_DIGEST_DOMAIN + normalized.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return _PHONE_DIGEST_PREFIX + digest


def classify_phone_orphan_cleanup_candidate(
    user_record,
    *,
    expected_uid: str,
    expected_phone_digest: str,
) -> str | None:
    """Return a machine-safe reason when a Firebase identity is no longer disposable."""
    normalized_uid = str(expected_uid or "").strip()
    record_uid = str(getattr(user_record, "uid", normalized_uid) or "").strip()
    if not normalized_uid or record_uid != normalized_uid:
        return _PHONE_CLASSIFICATION_UID_MISMATCH

    phone_number = str(getattr(user_record, "phone_number", "") or "").strip()
    if not phone_number:
        return _PHONE_CLASSIFICATION_MISSING
    if not _PHONE_DIGEST_RE.fullmatch(str(expected_phone_digest or "")):
        return _PHONE_CLASSIFICATION_PROOF_MISSING
    if not hmac.compare_digest(
        account_deletion_phone_digest(phone_number),
        expected_phone_digest,
    ):
        return _PHONE_CLASSIFICATION_DIGEST_MISMATCH

    email = str(getattr(user_record, "email", "") or "").strip()
    provider_ids = {
        provider_id
        for provider in (getattr(user_record, "provider_data", None) or [])
        if (provider_id := str(getattr(provider, "provider_id", "") or "").strip())
    }
    if email or not provider_ids.issubset({"phone"}):
        return _PHONE_CLASSIFICATION_ESTABLISHED
    return None


def _failure_class(exc: BaseException | None) -> str | None:
    if exc is None:
        return None
    sanitized = re.sub(r"[^A-Za-z0-9_.-]", "_", type(exc).__name__)
    return sanitized[:120] or "UnknownError"


def _validated_intent_metadata(
    *,
    intent_kind: CleanupIntentKind,
    expected_phone_digest: str | None,
) -> tuple[CleanupIntentKind, str | None]:
    normalized_digest = str(expected_phone_digest or "").strip() or None
    if intent_kind not in {"full_account", "phone_orphan"}:
        raise ValueError("unsupported cleanup intent kind")
    if intent_kind == "full_account":
        if normalized_digest is not None:
            raise ValueError("full-account cleanup must not carry a phone proof")
        return intent_kind, None
    if normalized_digest is None or not _PHONE_DIGEST_RE.fullmatch(normalized_digest):
        raise ValueError("phone-orphan cleanup requires a valid expected phone digest")
    return intent_kind, normalized_digest


class AccountDeletionLifecycleService:
    """Own the durable tombstone and its external Firebase cleanup intent."""

    @staticmethod
    def _normalize_user_ids(user_ids: Iterable[str]) -> tuple[str, ...]:
        normalized_user_ids = tuple(
            sorted(
                {
                    normalized
                    for candidate in user_ids
                    if (normalized := str(candidate or "").strip())
                }
            )
        )
        if not normalized_user_ids:
            raise ValueError("at least one user_id is required")
        return normalized_user_ids

    @staticmethod
    def _lock_user_ids_in_transaction(conn, *, user_ids: tuple[str, ...]) -> None:
        # Namespace 171 is the established connection-graph writer barrier.
        # Deletion must take it before the lifecycle lock so rolling revisions
        # and migration-201 triggers all share one deadlock-free lock order.
        for lock_namespace in (
            _CONNECTION_GRAPH_LOCK_NAMESPACE,
            _ACCOUNT_LIFECYCLE_LOCK_NAMESPACE,
        ):
            for normalized in user_ids:
                conn.execute(
                    text(
                        """
                        SELECT pg_advisory_xact_lock(
                          hashtextextended(:user_id, :lock_namespace)
                        )
                        """
                    ),
                    {
                        "user_id": normalized,
                        "lock_namespace": lock_namespace,
                    },
                )

    @staticmethod
    def _insert_pending_in_transaction(
        conn,
        *,
        user_ids: tuple[str, ...],
        intent_kind: CleanupIntentKind = "full_account",
        expected_phone_digest: str | None = None,
    ) -> bool:
        intent_kind, expected_phone_digest = _validated_intent_metadata(
            intent_kind=intent_kind,
            expected_phone_digest=expected_phone_digest,
        )
        persisted_all = True
        for normalized in user_ids:
            result = conn.execute(
                text(
                    """
                    INSERT INTO account_deletion_tombstones (
                      user_id_hash,
                      firebase_uid,
                      cleanup_intent_kind,
                      expected_phone_digest,
                      cleanup_status,
                      cleanup_next_attempt_at,
                      deleted_at,
                      updated_at
                    )
                    VALUES (
                      :user_id_hash,
                      :firebase_uid,
                      :cleanup_intent_kind,
                      :expected_phone_digest,
                      'pending',
                      NOW() + INTERVAL '1 minute',
                      NOW(),
                      NOW()
                    )
                    ON CONFLICT (user_id_hash) DO UPDATE
                    SET
                      firebase_uid = EXCLUDED.firebase_uid,
                      cleanup_intent_kind = EXCLUDED.cleanup_intent_kind,
                      expected_phone_digest = EXCLUDED.expected_phone_digest,
                      cleanup_status = 'pending',
                      cleanup_next_attempt_at = EXCLUDED.cleanup_next_attempt_at,
                      cleanup_claimed_at = NULL,
                      cleanup_claim_token = NULL,
                      cleanup_last_outcome = NULL,
                      cleanup_last_failure_class = NULL,
                      cleanup_last_classification = NULL,
                      updated_at = NOW()
                    WHERE account_deletion_tombstones.cleanup_status = 'completed'
                    """
                ),
                {
                    "user_id_hash": account_deletion_user_hash(normalized),
                    "firebase_uid": normalized,
                    "cleanup_intent_kind": intent_kind,
                    "expected_phone_digest": expected_phone_digest,
                },
            )
            persisted_all = result.rowcount == 1 and persisted_all
        return persisted_all

    @staticmethod
    def _guarded_identity_inventory_in_transaction(
        conn,
    ) -> tuple[tuple[str, str, tuple[tuple[str, str], ...]], ...]:
        """Return the live migration-201 UID inventory or fail closed."""
        rows = (
            conn.execute(
                text(
                    """
                    WITH guarded_tables AS (
                      SELECT
                        table_class.oid AS table_oid,
                        table_namespace.nspname AS schema_name,
                        table_class.relname AS table_name,
                        array_agg(
                          table_column.attname
                          ORDER BY table_column.attname::TEXT COLLATE "C"
                        ) AS identity_columns,
                        array_agg(
                          CASE
                            WHEN COALESCE(
                              NULLIF(declared_type.typbasetype, 0),
                              declared_type.oid
                            ) = 'uuid'::regtype
                            THEN 'uuid'
                            ELSE 'text'
                          END
                          ORDER BY table_column.attname::TEXT COLLATE "C"
                        ) AS identity_column_kinds,
                        array_agg(
                          table_column.attnum
                          ORDER BY table_column.attname::TEXT COLLATE "C"
                        ) AS identity_column_attnums
                      FROM pg_class AS table_class
                      JOIN pg_namespace AS table_namespace
                        ON table_namespace.oid = table_class.relnamespace
                      JOIN pg_attribute AS table_column
                        ON table_column.attrelid = table_class.oid
                      JOIN pg_type AS declared_type
                        ON declared_type.oid = table_column.atttypid
                      LEFT JOIN pg_type AS base_type
                        ON base_type.oid = declared_type.typbasetype
                      WHERE table_namespace.nspname = 'public'
                        AND table_class.relkind IN ('r', 'p')
                        AND NOT table_class.relispartition
                        AND table_class.relname <> 'account_deletion_tombstones'
                        AND table_column.attnum > 0
                        AND NOT table_column.attisdropped
                        AND table_column.attgenerated = ''
                        AND (
                          table_column.attname ~
                            '(^user_id$|^firebase_uid$|^user_[a-z0-9]+_id$|_user_id$|_firebase_uid$)'
                          OR (
                            table_class.relname = 'consent_audit_receipts'
                            AND table_column.attname = 'subject_id'
                          )
                        )
                        AND (
                          COALESCE(base_type.typcategory, declared_type.typcategory) = 'S'
                          OR COALESCE(
                            NULLIF(declared_type.typbasetype, 0),
                            declared_type.oid
                          ) = 'uuid'::regtype
                        )
                      GROUP BY
                        table_class.oid,
                        table_namespace.nspname,
                        table_class.relname
                    )
                    SELECT
                      guarded_table.schema_name,
                      guarded_table.table_name,
                      guarded_table.identity_columns,
                      guarded_table.identity_column_kinds,
                      EXISTS (
                        SELECT 1
                        FROM pg_trigger AS insert_guard
                        WHERE insert_guard.tgrelid = guarded_table.table_oid
                          AND insert_guard.tgname =
                            'trg_reject_deleted_account_insert'
                          AND NOT insert_guard.tgisinternal
                          AND insert_guard.tgenabled = 'O'
                          AND insert_guard.tgtype = 7
                          AND insert_guard.tgattr::TEXT = ''
                          AND insert_guard.tgfoid = to_regprocedure(
                            'public.reject_deleted_account_identity_write()'
                          )
                          AND obj_description(insert_guard.oid, 'pg_trigger') =
                            'hushh.account-deletion-guard/v3/insert-presence:' ||
                            array_to_string(guarded_table.identity_columns, ',')
                      ) AS insert_guard_installed,
                      EXISTS (
                        SELECT 1
                        FROM pg_trigger AS update_guard
                        WHERE update_guard.tgrelid = guarded_table.table_oid
                          AND update_guard.tgname =
                            'trg_reject_deleted_account_reference_update'
                          AND NOT update_guard.tgisinternal
                          AND update_guard.tgenabled = 'O'
                          AND update_guard.tgtype = 19
                          AND update_guard.tgattr::TEXT = array_to_string(
                            guarded_table.identity_column_attnums,
                            ' '
                          )
                          AND update_guard.tgfoid = to_regprocedure(
                            'public.reject_deleted_account_identity_write()'
                          )
                          AND obj_description(update_guard.oid, 'pg_trigger') =
                            'hushh.account-deletion-guard/v3/update-bind-immutable:' ||
                            array_to_string(guarded_table.identity_columns, ',')
                      ) AS update_guard_installed
                    FROM guarded_tables AS guarded_table
                    ORDER BY
                      guarded_table.schema_name::TEXT COLLATE "C",
                      guarded_table.table_name::TEXT COLLATE "C"
                    """
                )
            )
            .mappings()
            .all()
        )
        if not rows:
            raise RuntimeError("account identity guard inventory is empty")

        inventory: list[tuple[str, str, tuple[tuple[str, str], ...]]] = []
        for row in rows:
            schema_name = str(row.get("schema_name") or "").strip()
            table_name = str(row.get("table_name") or "").strip()
            raw_columns = row.get("identity_columns")
            raw_column_kinds = row.get("identity_column_kinds")
            identity_column_names = tuple(
                str(column or "").strip()
                for column in (raw_columns if isinstance(raw_columns, (list, tuple)) else ())
                if str(column or "").strip()
            )
            identity_column_kinds = tuple(
                str(column_kind or "").strip()
                for column_kind in (
                    raw_column_kinds if isinstance(raw_column_kinds, (list, tuple)) else ()
                )
                if str(column_kind or "").strip()
            )
            if len(identity_column_names) != len(identity_column_kinds):
                raise RuntimeError("account identity guard inventory is incomplete")
            identity_columns = tuple(zip(identity_column_names, identity_column_kinds, strict=True))
            if (
                not schema_name
                or not table_name
                or not identity_columns
                or any(column_kind not in {"text", "uuid"} for _, column_kind in identity_columns)
                or row.get("insert_guard_installed") is not True
                or row.get("update_guard_installed") is not True
            ):
                raise RuntimeError("account identity guard inventory is incomplete")
            inventory.append((schema_name, table_name, identity_columns))
        return tuple(inventory)

    @staticmethod
    def _has_guarded_account_state_in_transaction(conn, *, user_id: str) -> bool:
        # Validate that every live catalog identity column still has both exact
        # v3 guards before trusting the registry. The installer backfills each
        # table in the same transaction that publishes its v3 trigger
        # signature, and the write guard records all later INSERT/NULL-to-UID
        # bindings. The monotonic hash lookup is therefore complete without a
        # request-time scan across high-growth account/event tables.
        AccountDeletionLifecycleService._guarded_identity_inventory_in_transaction(conn)
        return bool(
            conn.execute(
                text(
                    """
                    SELECT EXISTS (
                      SELECT 1
                      FROM account_identity_presence
                      WHERE user_id_hash = :user_id_hash
                    ) AS has_account_state
                    """
                ),
                {"user_id_hash": account_deletion_user_hash(user_id)},
            ).scalar_one()
        )

    @staticmethod
    def record_pending(*, user_ids: Iterable[str]) -> tuple[str, ...]:
        """Persist cleanup intents in one committed database transaction."""
        with get_db_connection() as conn:
            return AccountDeletionLifecycleService.record_pending_many_in_transaction(
                conn,
                user_ids=user_ids,
            )

    @staticmethod
    def record_pending_in_transaction(conn, *, user_id: str) -> None:
        AccountDeletionLifecycleService.record_pending_many_in_transaction(
            conn,
            user_ids=(user_id,),
        )

    @staticmethod
    def record_pending_many_in_transaction(
        conn,
        *,
        user_ids: Iterable[str],
    ) -> tuple[str, ...]:
        """Lock every cleanup identity deterministically, then persist intents.

        A full deletion can own both the primary Firebase UID and a validated
        phone-only orphan UID. Taking every exclusive lock in one stable order
        prevents two multi-identity operations from acquiring the same lock set
        in opposite order while writer triggers hold shared UID locks.
        """
        normalized_user_ids = AccountDeletionLifecycleService._normalize_user_ids(user_ids)
        AccountDeletionLifecycleService._lock_user_ids_in_transaction(
            conn,
            user_ids=normalized_user_ids,
        )
        AccountDeletionLifecycleService._insert_pending_in_transaction(
            conn,
            user_ids=normalized_user_ids,
        )

        return normalized_user_ids

    @staticmethod
    def record_pending_if_account_state_absent(
        *,
        user_id: str,
        expected_phone_digest: str,
    ) -> bool:
        """Persist an exact-UID cleanup intent only for a DB-empty auth session.

        Firebase phone sign-in can return an established phone-only identity,
        not just a disposable verification session. The connection-graph and
        lifecycle locks make the account-root check and tombstone insert one
        atomic decision relative to migration-201 guarded writers.
        """
        normalized_user_ids = AccountDeletionLifecycleService._normalize_user_ids((user_id,))
        normalized_user_id = normalized_user_ids[0]
        with get_db_connection() as conn:
            # asyncio cancellation cannot stop a synchronous SQLAlchemy call.
            # Server-side limits ensure a timed-out phone claim releases its
            # transaction/locks. The account-state data probe itself is one
            # primary-key lookup; the remaining catalog validation is bounded.
            conn.execute(
                text(
                    """
                    SELECT
                      set_config('statement_timeout', '3500ms', TRUE),
                      set_config('lock_timeout', '1000ms', TRUE)
                    """
                )
            )
            AccountDeletionLifecycleService._lock_user_ids_in_transaction(
                conn,
                user_ids=normalized_user_ids,
            )
            has_account_state = (
                AccountDeletionLifecycleService._has_guarded_account_state_in_transaction(
                    conn,
                    user_id=normalized_user_id,
                )
            )
            if has_account_state:
                return False
            persisted = AccountDeletionLifecycleService._insert_pending_in_transaction(
                conn,
                user_ids=normalized_user_ids,
                intent_kind="phone_orphan",
                expected_phone_digest=expected_phone_digest,
            )
            if persisted:
                return True

            # A client can lose its first claim response after the durable
            # intent commits and then retry with the same still-valid phone
            # credential. Treat that exact UID+proof intent as idempotent;
            # never mislabel it as an established-account collision. A
            # different intent kind, proof, UID, or completed/scrubbed row
            # remains fail closed.
            matching_intent = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM account_deletion_tombstones
                    WHERE user_id_hash = :user_id_hash
                      AND firebase_uid = :firebase_uid
                      AND cleanup_intent_kind = 'phone_orphan'
                      AND expected_phone_digest = :expected_phone_digest
                      AND cleanup_status IN (
                        'pending', 'running', 'quarantined', 'retry_pending'
                      )
                    LIMIT 1
                    """
                ),
                {
                    "user_id_hash": account_deletion_user_hash(normalized_user_id),
                    "firebase_uid": normalized_user_id,
                    "expected_phone_digest": expected_phone_digest,
                },
            ).first()
        return matching_intent is not None

    @staticmethod
    def is_tombstoned(user_id: str) -> bool:
        normalized_user_ids = AccountDeletionLifecycleService._normalize_user_ids((user_id,))
        normalized_user_id = normalized_user_ids[0]
        user_hash = account_deletion_user_hash(normalized_user_id)
        with get_db_connection() as conn:
            # Force a fresh command snapshot after any wait. A plain SELECT can
            # return active while deletion's tombstone is still uncommitted;
            # the shared 171->198 barrier linearizes auth/status reads behind
            # the matching deletion transaction. Bounded DB timeouts propagate
            # to middleware as fail-closed AUTH_ACCOUNT_STATUS_UNAVAILABLE.
            conn.execute(text("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"))
            conn.execute(
                text(
                    """
                    SELECT
                      set_config('statement_timeout', '3500ms', TRUE),
                      set_config('lock_timeout', '3000ms', TRUE)
                    """
                )
            )
            for lock_namespace in (
                _CONNECTION_GRAPH_LOCK_NAMESPACE,
                _ACCOUNT_LIFECYCLE_LOCK_NAMESPACE,
            ):
                try:
                    conn.execute(
                        text(
                            """
                            SELECT pg_advisory_xact_lock_shared(
                              hashtextextended(:user_id, :lock_namespace)
                            )
                            """
                        ),
                        {
                            "user_id": normalized_user_id,
                            "lock_namespace": lock_namespace,
                        },
                    )
                except Exception as exc:
                    # PostgreSQL lock_timeout is SQLSTATE 55P03. Preserve this
                    # state separately from a database outage: an exclusive
                    # UID barrier means deletion may still commit, so clients
                    # must keep their privacy gate closed while re-probing.
                    if _postgres_sqlstate(exc) == "55P03":
                        raise AccountDeletionInProgressError(
                            "account deletion lifecycle barrier is busy"
                        ) from None
                    raise
            row = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM account_deletion_tombstones
                    WHERE user_id_hash = :user_id_hash
                    LIMIT 1
                    """
                ),
                {"user_id_hash": user_hash},
            ).first()
        return row is not None

    @staticmethod
    def record_cleanup_outcome(
        *,
        user_id: str,
        attempt: FirebaseCleanupAttempt,
        claim_token: str | None = None,
        intent_kind: CleanupIntentKind = "full_account",
        expected_phone_digest: str | None = None,
    ) -> bool:
        if intent_kind not in {"full_account", "phone_orphan"}:
            raise ValueError("unsupported cleanup intent kind")
        if attempt.outcome == "protected" and intent_kind != "phone_orphan":
            raise ValueError("only a provisional phone-orphan intent may be protected")
        expected_phone_digest = str(expected_phone_digest or "").strip() or None
        user_hash = account_deletion_user_hash(user_id)
        completed = attempt.outcome in {"deleted", "not_found"}
        cleanup_status = (
            "completed"
            if completed
            else "quarantined"
            if attempt.outcome == "quarantined"
            else "retry_pending"
        )
        with get_db_connection() as conn:
            if attempt.outcome == "protected":
                # This UID was never an authorized full-account deletion. Its
                # provisional phone-only intent is no longer safe to execute.
                # Cancel it under the same barriers as full deletion/writers;
                # an intervening full deletion or newer worker claim must win.
                AccountDeletionLifecycleService._lock_user_ids_in_transaction(
                    conn, user_ids=AccountDeletionLifecycleService._normalize_user_ids((user_id,))
                )
                result = conn.execute(
                    text(
                        """
                        DELETE FROM account_deletion_tombstones
                        WHERE user_id_hash = :user_id_hash
                          AND cleanup_intent_kind = 'phone_orphan'
                          AND expected_phone_digest IS NOT DISTINCT FROM :expected_phone_digest
                          AND cleanup_status <> 'completed'
                          AND (
                            (:cleanup_claim_token IS NULL
                             AND cleanup_claim_token IS NULL
                             AND cleanup_status IN ('pending', 'quarantined', 'retry_pending'))
                            OR
                            (:cleanup_claim_token IS NOT NULL
                             AND cleanup_status = 'running'
                             AND cleanup_claim_token = CAST(:cleanup_claim_token AS UUID))
                          )
                        """
                    ),
                    {
                        "user_id_hash": user_hash,
                        "expected_phone_digest": expected_phone_digest,
                        "cleanup_claim_token": claim_token,
                    },
                )
                return bool(result.rowcount == 1)
            result = conn.execute(
                text(
                    """
                    UPDATE account_deletion_tombstones
                    SET
                      firebase_uid = CASE WHEN :completed THEN NULL ELSE firebase_uid END,
                      expected_phone_digest = CASE
                        WHEN :completed THEN NULL
                        ELSE expected_phone_digest
                      END,
                      cleanup_status = :cleanup_status,
                      cleanup_attempt_count = cleanup_attempt_count + 1,
                      cleanup_next_attempt_at = CASE
                        WHEN :completed THEN NULL
                        ELSE NOW() + make_interval(
                          secs => LEAST(
                            3600,
                            60 * POWER(2, LEAST(cleanup_attempt_count, 6))::INTEGER
                          )
                        )
                      END,
                      cleanup_claimed_at = NULL,
                      cleanup_claim_token = NULL,
                      cleanup_last_attempt_at = NOW(),
                      cleanup_last_outcome = :cleanup_last_outcome,
                      cleanup_last_failure_class = :cleanup_last_failure_class,
                      cleanup_last_classification = :cleanup_last_classification,
                      updated_at = NOW()
                    WHERE user_id_hash = :user_id_hash
                      AND cleanup_status <> 'completed'
                      AND cleanup_intent_kind = :cleanup_intent_kind
                      AND expected_phone_digest IS NOT DISTINCT FROM :expected_phone_digest
                      AND (
                        (
                          :cleanup_claim_token IS NULL
                          AND cleanup_claim_token IS NULL
                          AND cleanup_status IN (
                            'pending', 'quarantined', 'retry_pending'
                          )
                        )
                        OR (
                          :cleanup_claim_token IS NOT NULL
                          AND cleanup_status = 'running'
                          AND cleanup_claim_token = CAST(:cleanup_claim_token AS UUID)
                        )
                      )
                    """
                ),
                {
                    "completed": completed,
                    "cleanup_status": cleanup_status,
                    "cleanup_last_outcome": attempt.outcome,
                    "cleanup_last_failure_class": attempt.failure_class,
                    "cleanup_last_classification": attempt.classification,
                    "cleanup_claim_token": claim_token,
                    "cleanup_intent_kind": intent_kind,
                    "expected_phone_digest": expected_phone_digest,
                    "user_id_hash": user_hash,
                },
            )
            return bool(result.rowcount == 1)

    @staticmethod
    def claim_due_cleanup_intents(*, limit: int = 10) -> list[ClaimedCleanupIntent]:
        bounded_limit = max(1, min(int(limit), 100))
        with get_db_connection() as conn:
            rows = (
                conn.execute(
                    text(
                        """
                        WITH due AS (
                          SELECT user_id_hash
                          FROM account_deletion_tombstones
                          WHERE firebase_uid IS NOT NULL
                            AND (
                              cleanup_status IN ('pending', 'quarantined', 'retry_pending')
                              OR (
                                cleanup_status = 'running'
                                AND cleanup_claimed_at < NOW() - make_interval(
                                  mins => :claim_stale_minutes
                                )
                              )
                            )
                            AND cleanup_next_attempt_at <= NOW()
                          ORDER BY cleanup_next_attempt_at, deleted_at
                          FOR UPDATE SKIP LOCKED
                          LIMIT :limit
                        )
                        UPDATE account_deletion_tombstones AS tombstone
                        SET
                          cleanup_status = 'running',
                          cleanup_claimed_at = NOW(),
                          cleanup_claim_token = gen_random_uuid(),
                          updated_at = NOW()
                        FROM due
                        WHERE tombstone.user_id_hash = due.user_id_hash
                        RETURNING
                          tombstone.firebase_uid,
                          tombstone.cleanup_claim_token::TEXT AS cleanup_claim_token,
                          tombstone.cleanup_intent_kind,
                          tombstone.expected_phone_digest
                        """
                    ),
                    {
                        "claim_stale_minutes": _CLEANUP_CLAIM_STALE_MINUTES,
                        "limit": bounded_limit,
                    },
                )
                .mappings()
                .all()
            )
        return [
            ClaimedCleanupIntent(
                firebase_uid=str(row["firebase_uid"]).strip(),
                claim_token=str(row["cleanup_claim_token"]).strip(),
                intent_kind=cast(
                    CleanupIntentKind,
                    str(row.get("cleanup_intent_kind") or "full_account").strip(),
                ),
                expected_phone_digest=(str(row.get("expected_phone_digest") or "").strip() or None),
            )
            for row in rows
            if str(row.get("firebase_uid") or "").strip()
            and str(row.get("cleanup_claim_token") or "").strip()
        ]

    async def delete_or_quarantine_firebase_identity(
        self,
        user_id: str,
        *,
        intent_kind: CleanupIntentKind = "full_account",
        expected_phone_digest: str | None = None,
    ) -> FirebaseCleanupAttempt:
        try:
            intent_kind, expected_phone_digest = _validated_intent_metadata(
                intent_kind=intent_kind,
                expected_phone_digest=expected_phone_digest,
            )
        except ValueError:
            return FirebaseCleanupAttempt(
                "protected",
                classification=_PHONE_CLASSIFICATION_PROOF_MISSING,
            )
        try:
            return await asyncio.wait_for(
                self._delete_or_quarantine_firebase_identity(
                    user_id,
                    intent_kind=intent_kind,
                    expected_phone_digest=expected_phone_digest,
                ),
                timeout=_FIREBASE_CLEANUP_INTENT_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            logger.error("account_deletion.firebase_cleanup_deadline_exceeded")
            if intent_kind == "phone_orphan":
                return FirebaseCleanupAttempt(
                    "retry_pending",
                    _failure_class(exc),
                    _PHONE_CLASSIFICATION_REVALIDATION_UNAVAILABLE,
                )
            return FirebaseCleanupAttempt("quarantine_incomplete", _failure_class(exc))

    @staticmethod
    async def _revalidate_phone_orphan_cleanup(
        user_id: str,
        *,
        expected_phone_digest: str,
    ) -> FirebaseCleanupAttempt | None:
        """Re-fetch the exact UID and fail safe unless its phone proof still matches."""
        try:
            from firebase_admin import auth as firebase_auth

            firebase_app = get_firebase_auth_app()
            user_record = await asyncio.wait_for(
                asyncio.to_thread(
                    firebase_auth.get_user,
                    user_id,
                    app=firebase_app,
                ),
                timeout=_FIREBASE_SDK_CALL_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            if exc.__class__.__name__ == "UserNotFoundError":
                return FirebaseCleanupAttempt(
                    "not_found",
                    classification=_FIREBASE_CLASSIFICATION_NOT_FOUND,
                )
            logger.warning(
                "account_deletion.firebase_phone_revalidation_failed error=%s",
                type(exc).__name__,
            )
            return FirebaseCleanupAttempt(
                "retry_pending",
                _failure_class(exc),
                _PHONE_CLASSIFICATION_REVALIDATION_UNAVAILABLE,
            )

        classification = classify_phone_orphan_cleanup_candidate(
            user_record,
            expected_uid=user_id,
            expected_phone_digest=expected_phone_digest,
        )
        if classification is not None:
            logger.warning(
                "account_deletion.firebase_phone_cleanup_protected classification=%s",
                classification,
            )
            return FirebaseCleanupAttempt(
                "protected",
                classification=classification,
            )
        return None

    async def _delete_or_quarantine_firebase_identity(
        self,
        user_id: str,
        *,
        intent_kind: CleanupIntentKind,
        expected_phone_digest: str | None,
    ) -> FirebaseCleanupAttempt:
        normalized = str(user_id or "").strip()
        if not normalized:
            return FirebaseCleanupAttempt(
                "not_found",
                classification=_FIREBASE_CLASSIFICATION_NOT_FOUND,
            )

        last_error: BaseException | None = None
        for attempt_number in range(1, _FIREBASE_DELETE_MAX_ATTEMPTS + 1):
            if intent_kind == "phone_orphan":
                if expected_phone_digest is None:
                    return FirebaseCleanupAttempt(
                        "protected",
                        classification=_PHONE_CLASSIFICATION_PROOF_MISSING,
                    )
                validation_result = await self._revalidate_phone_orphan_cleanup(
                    normalized,
                    expected_phone_digest=expected_phone_digest,
                )
                if validation_result is not None:
                    return validation_result
            try:
                from firebase_admin import auth as firebase_auth

                firebase_app = get_firebase_auth_app()
                await asyncio.wait_for(
                    asyncio.to_thread(
                        firebase_auth.delete_user,
                        normalized,
                        app=firebase_app,
                    ),
                    timeout=_FIREBASE_SDK_CALL_TIMEOUT_SECONDS,
                )
                return FirebaseCleanupAttempt(
                    "deleted",
                    classification=(
                        _PHONE_CLASSIFICATION_REVALIDATED if intent_kind == "phone_orphan" else None
                    ),
                )
            except Exception as exc:
                if exc.__class__.__name__ == "UserNotFoundError":
                    return FirebaseCleanupAttempt(
                        "not_found",
                        classification=_FIREBASE_CLASSIFICATION_NOT_FOUND,
                    )
                last_error = exc
                logger.warning(
                    "account_deletion.firebase_delete_failed attempt=%s/%s error=%s",
                    attempt_number,
                    _FIREBASE_DELETE_MAX_ATTEMPTS,
                    type(exc).__name__,
                )
                if attempt_number < _FIREBASE_DELETE_MAX_ATTEMPTS:
                    await asyncio.sleep(_FIREBASE_DELETE_RETRY_DELAY_SECONDS)

        if intent_kind == "phone_orphan":
            if expected_phone_digest is None:
                return FirebaseCleanupAttempt(
                    "protected",
                    classification=_PHONE_CLASSIFICATION_PROOF_MISSING,
                )
            validation_result = await self._revalidate_phone_orphan_cleanup(
                normalized,
                expected_phone_digest=expected_phone_digest,
            )
            if validation_result is not None:
                return validation_result
            # A phone-verification orphan is a provisional identity, not a
            # full-account erase. Never disable/revoke it on a transient delete
            # failure: it may become established before the next revalidation.
            return FirebaseCleanupAttempt(
                "retry_pending",
                _failure_class(last_error) if last_error is not None else None,
                _PHONE_CLASSIFICATION_REVALIDATED,
            )
        quarantine_result = await self._quarantine_firebase_identity(
            normalized,
            last_error=last_error,
        )
        return quarantine_result

    async def _quarantine_firebase_identity(
        self,
        user_id: str,
        *,
        last_error: BaseException | None,
    ) -> FirebaseCleanupAttempt:
        try:
            from firebase_admin import auth as firebase_auth

            firebase_app = get_firebase_auth_app()
        except Exception as exc:
            return FirebaseCleanupAttempt("quarantine_incomplete", _failure_class(exc))

        disabled = False
        revoked = False
        try:
            await asyncio.wait_for(
                asyncio.to_thread(
                    firebase_auth.update_user,
                    user_id,
                    disabled=True,
                    app=firebase_app,
                ),
                timeout=_FIREBASE_SDK_CALL_TIMEOUT_SECONDS,
            )
            disabled = True
        except Exception as exc:
            if exc.__class__.__name__ == "UserNotFoundError":
                return FirebaseCleanupAttempt("not_found")
            last_error = exc
            logger.error(
                "account_deletion.firebase_disable_failed error=%s",
                type(exc).__name__,
            )

        try:
            await asyncio.wait_for(
                asyncio.to_thread(
                    firebase_auth.revoke_refresh_tokens,
                    user_id,
                    app=firebase_app,
                ),
                timeout=_FIREBASE_SDK_CALL_TIMEOUT_SECONDS,
            )
            revoked = True
        except Exception as exc:
            if exc.__class__.__name__ == "UserNotFoundError":
                return FirebaseCleanupAttempt("not_found")
            last_error = exc
            logger.error(
                "account_deletion.firebase_revoke_failed error=%s",
                type(exc).__name__,
            )

        return FirebaseCleanupAttempt(
            "quarantined" if disabled and revoked else "quarantine_incomplete",
            _failure_class(last_error),
        )


async def drain_account_deletion_cleanup_intents(
    *,
    service: AccountDeletionLifecycleService | None = None,
    limit: int = 10,
) -> int:
    lifecycle = service or AccountDeletionLifecycleService()
    intents = await asyncio.wait_for(
        asyncio.to_thread(lifecycle.claim_due_cleanup_intents, limit=limit),
        timeout=_CLEANUP_DATABASE_TIMEOUT_SECONDS,
    )
    settled = 0
    for intent in intents:
        try:
            attempt = await lifecycle.delete_or_quarantine_firebase_identity(
                intent.firebase_uid,
                intent_kind=intent.intent_kind,
                expected_phone_digest=intent.expected_phone_digest,
            )
            updated = await asyncio.wait_for(
                asyncio.to_thread(
                    lifecycle.record_cleanup_outcome,
                    user_id=intent.firebase_uid,
                    attempt=attempt,
                    claim_token=intent.claim_token,
                    intent_kind=intent.intent_kind,
                    expected_phone_digest=intent.expected_phone_digest,
                ),
                timeout=_CLEANUP_DATABASE_TIMEOUT_SECONDS,
            )
            if updated:
                settled += 1
            else:
                logger.info("account_deletion.cleanup_stale_claim_ignored")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("account_deletion.cleanup_intent_failed")
    return settled


async def _account_deletion_cleanup_loop(interval_seconds: float) -> None:
    while True:
        try:
            await drain_account_deletion_cleanup_intents()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("account_deletion.cleanup_loop_failed")
        await asyncio.sleep(interval_seconds)


def start_account_deletion_cleanup_loop(
    *,
    interval_seconds: float = _CLEANUP_LOOP_INTERVAL_SECONDS,
) -> asyncio.Task[None]:
    return asyncio.create_task(
        _account_deletion_cleanup_loop(max(1.0, float(interval_seconds))),
        name="account-deletion-cleanup-worker",
    )
