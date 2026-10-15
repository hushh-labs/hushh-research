"""Read-only data for the dashboard, bound to its one owner.

Every SQL statement lives in ``STATEMENTS``. Each table it reads carries an alias,
and each owner-scoped table is bound with ``<alias>.user_id=:owner``; the few
tables without an owner column are reached only through a declared join to an
owner-bound alias (``JOIN_SCOPED_TABLES``).
``tests/eval_drive_packets/test_dashboard_sql.py`` checks every statement.
Statements run only through ``OwnerSession``: it injects the owner itself,
refuses an ``owner`` argument, and runs inside a transaction that is set
read-only and then asserted read-only. ``install_guards`` adds an engine-level
fence: a statement that is not one plain read, or that does not carry the owner
id as a bound parameter, is refused before it reaches the database. Session
setting checks (``SESSION_STATEMENTS``) read no table.
"""

from __future__ import annotations

import re
import threading
import time
from collections import Counter
from contextlib import contextmanager
from datetime import date, datetime
from typing import Any
from uuid import UUID

from hushh_eval.drive_packets.dashboard.owner import OWNER_ID
from hushh_eval.drive_packets.sources import ReadOnlyViolation, assert_read_only

SET_READ_ONLY = "SET TRANSACTION READ ONLY"
SESSION_STATEMENTS = frozenset({SET_READ_ONLY, "SELECT current_setting('transaction_read_only')"})
OWNER_SCOPED_TABLES = frozenset(
    {
        "connected_documents",
        "drive_bulk_share_effects",
        "drive_bulk_share_files",
        "drive_bulk_shares",
        "drive_collection_sync",
        "drive_document_extractions",
        "drive_document_facts",
        "drive_owner_search_jobs",
        "drive_owner_search_results",
        "drive_packet_heads",
        "drive_packet_listings",
        "drive_packet_versions",
        "drive_request_payment_orders",
        "drive_share_permission_operations",
        "drive_share_requests",
        "drive_share_reviews",
        "user_external_connector_connections",
    }
)
# Tables without an owner column, reached only by joining this column to the same
# column (or the named one) of an alias that is itself bound to the owner.
JOIN_SCOPED_TABLES = {
    "drive_packet_members": ("packet_id", "packet_id"),
    "drive_request_payment_refunds": ("request_id", "request_id"),
    "drive_request_owner_payouts": ("request_id", "request_id"),
    # The requester's display name only, for requests made to the owner.
    "actor_identity_cache": ("user_id", "recipient_user_id"),
}
IDENTITY_COLUMNS = {"actor_identity_cache": frozenset({"user_id", "display_name"})}
REQUEST_LIMIT = 200

STATEMENTS: dict[str, str] = {
    "connection": """
SELECT c.connection_generation, c.status, c.validation_state
FROM user_external_connector_connections c
WHERE c.user_id=:owner AND c.connector_id='google_drive'
""",
    # The facts policy UAT writes now: the newest facts rows of this owner.
    "serving_policy": """
SELECT f.facts_profile, count(*) AS n, max(f.created_at) AS newest
FROM drive_document_facts f
WHERE f.user_id=:owner
GROUP BY f.facts_profile
ORDER BY newest DESC
LIMIT 5
""",
    "files_found": """
SELECT count(*) AS files_found
FROM connected_documents d
JOIN user_external_connector_connections c
  ON c.user_id=:owner AND c.connector_id='google_drive' AND c.connection_generation=d.connection_generation
WHERE d.user_id=:owner AND d.source_profile='live'
""",
    "document_census": """
SELECT clock_timestamp() AS as_of,
  count(*) AS files_found,
  count(*) FILTER (WHERE d.status='ready' AND d.active_version IS NOT NULL) AS extracted,
  count(*) FILTER (WHERE d.status='ready' AND d.active_version IS NOT NULL
                   AND f.status='complete' AND NOT f.has_gaps) AS facts_complete,
  count(*) FILTER (WHERE d.status='ready' AND d.active_version IS NOT NULL
                   AND (f.status IS NULL OR f.status IN ('pending','running'))) AS facts_waiting,
  count(*) FILTER (WHERE d.status IN ('queued','fetching','parsing','indexing','stale')) AS extraction_waiting
FROM connected_documents d
JOIN user_external_connector_connections c
  ON c.user_id=:owner AND c.connector_id='google_drive' AND c.connection_generation=d.connection_generation
LEFT JOIN drive_document_facts f
  ON f.user_id=:owner AND f.document_id=d.document_id AND f.source_version=d.source_version
 AND f.extraction_version=d.active_version AND f.extraction_profile=:profile AND f.facts_profile=:policy
WHERE d.user_id=:owner AND d.source_profile='live'
""",
    "failure_reasons": """
SELECT CASE
         WHEN d.status IN ('unsupported','needs_reauth','failed_retryable')
           THEN 'document:' || COALESCE(d.last_error_code, d.status)
         WHEN f.status='failed' THEN 'facts:' || COALESCE(f.error_code, 'failed')
         ELSE 'facts:has_gaps'
       END AS reason,
       count(*) AS n
FROM connected_documents d
JOIN user_external_connector_connections c
  ON c.user_id=:owner AND c.connector_id='google_drive' AND c.connection_generation=d.connection_generation
LEFT JOIN drive_document_facts f
  ON f.user_id=:owner AND f.document_id=d.document_id AND f.source_version=d.source_version
 AND f.extraction_version=d.active_version AND f.extraction_profile=:profile AND f.facts_profile=:policy
WHERE d.user_id=:owner AND d.source_profile='live'
  AND (d.status IN ('unsupported','needs_reauth','failed_retryable')
       OR f.status='failed' OR (f.status='complete' AND f.has_gaps))
GROUP BY 1
ORDER BY 2 DESC, 1
""",
    "last_hour": """
SELECT
  (SELECT count(*) FROM drive_document_extractions e
    WHERE e.user_id=:owner AND e.complete AND e.extraction_profile=:profile
      AND e.completed_at>=clock_timestamp()-interval '1 hour') AS extracted_last_hour,
  (SELECT count(*) FROM drive_document_facts f
    WHERE f.user_id=:owner AND f.status='complete' AND f.facts_profile=:policy
      AND f.completed_at>=clock_timestamp()-interval '1 hour') AS facts_last_hour
""",
    "packet_states": """
SELECT h.packet_id, h.current_version, h.dirty, h.error_code, h.updated_at,
       v.version, v.state, v.available, v.policy_version, v.verified_at,
       l.enabled AS listing_enabled,
       (SELECT count(*) FROM drive_packet_members m WHERE m.packet_id=h.packet_id) AS member_rows
FROM drive_packet_heads h
JOIN user_external_connector_connections c
  ON c.user_id=:owner AND c.connector_id='google_drive' AND c.connection_generation=h.connection_generation
LEFT JOIN drive_packet_versions v
  ON v.user_id=:owner AND v.packet_id=h.packet_id AND v.version=h.current_version
LEFT JOIN drive_packet_listings l
  ON l.user_id=:owner AND l.packet_id=h.packet_id AND l.version=h.current_version
WHERE h.user_id=:owner
""",
    "packet_rows": """
SELECT h.packet_id, h.user_id, h.connection_generation, h.key_envelope, h.current_version,
       h.dirty, h.error_code, h.updated_at,
       v.version, v.state, v.available, v.document_count, v.price_cents, v.policy_version,
       v.verified_at, v.manifest_envelope,
       l.enabled AS listing_enabled, l.price_cents AS listing_price_cents,
       (SELECT count(*) FROM drive_packet_members m WHERE m.packet_id=h.packet_id) AS member_rows
FROM drive_packet_heads h
JOIN user_external_connector_connections c
  ON c.user_id=:owner AND c.connector_id='google_drive' AND c.connection_generation=h.connection_generation
LEFT JOIN drive_packet_versions v
  ON v.user_id=:owner AND v.packet_id=h.packet_id AND v.version=h.current_version
LEFT JOIN drive_packet_listings l
  ON l.user_id=:owner AND l.packet_id=h.packet_id AND l.version=h.current_version
WHERE h.user_id=:owner
""",
    "packet_head": """
SELECT h.packet_id, h.current_version
FROM drive_packet_heads h
WHERE h.user_id=:owner AND h.packet_id=CAST(:packet_id AS uuid)
""",
    "packet_detail": """
SELECT h.packet_id, h.user_id, h.connection_generation, h.key_envelope, h.current_version,
       h.dirty, h.awaiting_collection, h.error_code, h.updated_at,
       v.version, v.state, v.available, v.document_count, v.price_cents, v.policy_version,
       v.verified_at, v.digest, v.manifest_envelope,
       l.enabled AS listing_enabled, l.price_cents AS listing_price_cents,
       c.connection_generation AS live_generation
FROM drive_packet_heads h
LEFT JOIN user_external_connector_connections c
  ON c.user_id=:owner AND c.connector_id='google_drive'
LEFT JOIN drive_packet_versions v
  ON v.user_id=:owner AND v.packet_id=h.packet_id AND v.version=h.current_version
LEFT JOIN drive_packet_listings l
  ON l.user_id=:owner AND l.packet_id=h.packet_id AND l.version=h.current_version
WHERE h.user_id=:owner AND h.packet_id=CAST(:packet_id AS uuid)
""",
    "packet_member_rows": """
SELECT m.document_id, m.facts_version
FROM drive_packet_members m
JOIN drive_packet_heads h ON h.user_id=:owner AND h.packet_id=m.packet_id
WHERE m.packet_id=CAST(:packet_id AS uuid)
ORDER BY m.document_id
LIMIT 500
""",
    "member_documents": """
SELECT d.document_id, d.user_id, d.connection_generation, d.metadata_envelope, d.status,
       d.active_version, d.source_version, d.last_error_code,
       f.connection_generation AS facts_generation, f.facts_version, f.facts_envelope,
       f.status AS facts_status, f.has_gaps, f.source_version AS facts_source_version,
       f.extraction_version, f.extraction_profile, f.facts_profile,
       e.total_pages, e.unit_kind
FROM connected_documents d
LEFT JOIN drive_document_facts f
  ON f.user_id=:owner AND f.document_id=d.document_id
 AND f.facts_version=ANY(CAST(:facts_versions AS text[]))
LEFT JOIN drive_document_extractions e
  ON e.user_id=:owner AND e.document_id=d.document_id AND e.extraction_version=f.extraction_version
WHERE d.user_id=:owner AND d.document_id=ANY(CAST(:document_ids AS uuid[]))
""",
    "document_names": """
SELECT d.document_id, d.user_id, d.connection_generation, d.metadata_envelope
FROM connected_documents d
WHERE d.user_id=:owner AND d.document_id=ANY(CAST(:document_ids AS uuid[]))
""",
    # The runtime's freshness and collection-complete fences (DrivePacketStore),
    # with every table bound to the owner.
    "collection_state": """
SELECT
  EXISTS(SELECT 1 FROM drive_collection_sync s
    WHERE s.user_id=:owner AND s.connection_generation=:generation AND s.processing_enabled
      AND s.last_synced_at>=clock_timestamp()-interval '900 seconds'
      AND s.phase='changes' AND NOT s.incomplete_search AND s.last_error_code IS NULL) AS fresh,
  EXISTS(SELECT 1 FROM drive_collection_sync y
    WHERE y.user_id=:owner AND y.connection_generation=:generation AND y.processing_enabled
      AND y.initial_completed_at IS NOT NULL AND y.phase='changes' AND NOT y.incomplete_search
      AND y.last_error_code IS NULL AND y.last_synced_at>=clock_timestamp()-interval '900 seconds'
      AND NOT EXISTS(SELECT 1 FROM connected_documents d
        WHERE d.user_id=:owner AND d.connection_generation=y.connection_generation
          AND d.source_profile='live' AND d.last_error_code IS DISTINCT FROM 'source_unavailable'
          AND (d.status<>'ready' OR d.active_version IS NULL OR NOT EXISTS(
            SELECT 1 FROM drive_document_facts f
            WHERE f.user_id=:owner AND f.document_id=d.document_id
              AND f.source_version=d.source_version AND f.extraction_version=d.active_version
              AND f.status='complete' AND NOT f.has_gaps
              AND f.facts_profile=:policy AND f.extraction_profile=:profile)))) AS complete
""",
    # --- Requests other people made to the owner (the owner is drive_share_requests.user_id).
    "request_list": """
SELECT r.request_id, r.user_id, r.status, r.created_at, r.updated_at, r.expires_at,
       r.request_envelope, r.payment_required, r.quoted_amount_cents, r.settlement_method,
       r.owner_allowed_at, r.bulk_search_started_at, r.agent_package_required,
       r.preparation_error_code, r.access_stop_requested_at, r.reusable_packet_id,
       a.display_name AS requester_display_name,
       o.status AS order_status, o.amount_cents AS order_amount_cents, o.paid_at,
       o.stripe_mode, o.settlement_method AS order_settlement_method,
       f.status AS refund_status, f.amount_cents AS refund_amount_cents,
       (SELECT count(*) FROM drive_bulk_share_files sf
         WHERE sf.user_id=:owner AND sf.origin_request_id=r.request_id) AS shared_files,
       (SELECT count(*) FILTER (WHERE se.state='succeeded') FROM drive_bulk_share_effects se
         JOIN drive_bulk_shares sb ON sb.user_id=:owner AND sb.share_id=se.share_id
         WHERE se.user_id=:owner AND sb.origin_request_id=r.request_id) AS newly_shared,
       (SELECT count(*) FILTER (WHERE se2.state IN ('preexisting','present_unattributed'))
          FROM drive_bulk_share_effects se2
         JOIN drive_bulk_shares sb2 ON sb2.user_id=:owner AND sb2.share_id=se2.share_id
         WHERE se2.user_id=:owner AND sb2.origin_request_id=r.request_id) AS already_had_access,
       (SELECT count(*) FROM drive_share_permission_operations po
         WHERE po.user_id=:owner AND po.request_id=r.request_id AND po.kind=:grant_kind
           AND po.state='succeeded') AS ops_shared,
       (SELECT count(*) FROM drive_share_permission_operations po2
         WHERE po2.user_id=:owner AND po2.request_id=r.request_id AND po2.kind=:grant_kind
           AND po2.state IN ('preexisting','present_unattributed')) AS ops_already_had_access,
       (SELECT count(*) FROM drive_share_permission_operations po3
         WHERE po3.user_id=:owner AND po3.request_id=r.request_id
           AND po3.kind=:grant_kind) AS ops_files
FROM drive_share_requests r
LEFT JOIN actor_identity_cache a ON a.user_id=r.recipient_user_id
LEFT JOIN drive_request_payment_orders o ON o.user_id=:owner AND o.request_id=r.request_id
LEFT JOIN drive_request_payment_refunds f ON f.request_id=o.request_id
WHERE r.user_id=:owner
ORDER BY r.created_at DESC, r.request_id
LIMIT :limit
""",
    "request_exists": """
SELECT r.request_id
FROM drive_share_requests r
WHERE r.user_id=:owner AND r.request_id=CAST(:request_id AS uuid)
""",
    "request_header": """
SELECT r.request_id, r.user_id, r.status, r.revision, r.created_at, r.updated_at, r.expires_at,
       r.request_envelope, r.payment_required, r.quoted_amount_cents, r.initial_quote_cents,
       r.quote_version, r.settlement_method, r.owner_allowed_at, r.bulk_search_started_at,
       r.agent_package_required, r.preparation_error_code, r.preparation_attempts,
       r.access_stop_requested_at, r.review_requested_at, r.reusable_packet_id,
       r.reusable_packet_version, r.approval_invalidated_at,
       a.display_name AS requester_display_name
FROM drive_share_requests r
LEFT JOIN actor_identity_cache a ON a.user_id=r.recipient_user_id
WHERE r.user_id=:owner AND r.request_id=CAST(:request_id AS uuid)
""",
    "request_search_jobs": """
SELECT j.job_id, j.user_id, j.status, j.revision, j.matched, j.pages_scanned,
       j.incomplete_search, j.checkpoint_envelope, j.error_code, j.retry_count, j.created_at,
       j.updated_at, j.expires_at, j.unshareable_count, j.evaluation_status,
       j.evaluation_attempts, j.evaluation_error_code, j.connection_generation
FROM drive_owner_search_jobs j
WHERE j.user_id=:owner AND j.client_request_id=CAST(:request_id AS uuid)
ORDER BY j.created_at, j.job_id
""",
    "request_search_results": """
SELECT x.job_id, x.user_id, x.position, x.metadata_envelope, x.evaluation_envelope, x.evaluated_at
FROM drive_owner_search_results x
JOIN drive_owner_search_jobs j ON j.user_id=:owner AND j.job_id=x.job_id
WHERE x.user_id=:owner AND j.client_request_id=CAST(:request_id AS uuid)
ORDER BY j.created_at, x.job_id, x.position
LIMIT 2000
""",
    "request_reviews": """
SELECT v.request_id, v.revision, v.user_id, v.review_envelope, v.decision, v.created_at,
       v.expires_at, v.decided_at
FROM drive_share_reviews v
WHERE v.user_id=:owner AND v.request_id=CAST(:request_id AS uuid)
ORDER BY v.revision
""",
    "request_shares": """
SELECT b.share_id, b.user_id, b.status, b.file_count, b.approval_source, b.approved_at,
       b.stopped_at, b.created_at, b.updated_at, b.progressive_batch, b.search_job_id
FROM drive_bulk_shares b
WHERE b.user_id=:owner AND b.origin_request_id=CAST(:request_id AS uuid)
ORDER BY b.created_at, b.share_id
""",
    "request_share_files": """
SELECT sf.share_id, sf.user_id, sf.position, sf.source_job_id, sf.source_position,
       sf.metadata_envelope, se.state, se.safe_error_code, se.attempts, se.updated_at
FROM drive_bulk_share_files sf
JOIN drive_bulk_shares sb ON sb.user_id=:owner AND sb.share_id=sf.share_id
LEFT JOIN drive_bulk_share_effects se
  ON se.user_id=:owner AND se.share_id=sf.share_id AND se.position=sf.position
WHERE sf.user_id=:owner AND sb.origin_request_id=CAST(:request_id AS uuid)
ORDER BY sb.created_at, sf.share_id, sf.position
LIMIT 2000
""",
    "request_permission_operations": """
SELECT po.operation_id, po.document_id, po.state, po.safe_error_code, po.review_revision,
       po.created_at, po.dispatched_at, po.settled_at
FROM drive_share_permission_operations po
WHERE po.user_id=:owner AND po.request_id=CAST(:request_id AS uuid) AND po.kind=:grant_kind
ORDER BY po.created_at, po.operation_id
LIMIT 2000
""",
    "request_payment": """
SELECT o.status, o.amount_cents, o.currency, o.stripe_mode, o.settlement_method, o.paid_at,
       o.created_at, o.updated_at, o.reconciliation_required, o.reconciliation_reason,
       o.reconciliation_at,
       f.status AS refund_status, f.amount_cents AS refund_amount_cents,
       f.created_at AS refund_created_at, f.updated_at AS refund_updated_at
FROM drive_request_payment_orders o
LEFT JOIN drive_request_payment_refunds f ON f.request_id=o.request_id
WHERE o.user_id=:owner AND o.request_id=CAST(:request_id AS uuid)
""",
    "request_payout": """
SELECT p.status, p.expected_files, p.confirmed_files, p.gross_amount_cents,
       p.owner_earning_cents, p.refund_amount_cents, p.credited_at, p.settlement_method
FROM drive_share_requests r
JOIN drive_request_owner_payouts p ON p.request_id=r.request_id
WHERE r.user_id=:owner AND r.request_id=CAST(:request_id AS uuid)
""",
}

# --- Guards ------------------------------------------------------------------------
_WRITE_WORDS = re.compile(
    r"\b(?:insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|copy|"
    r"call|lock|vacuum|analyze|cluster|reindex|refresh|notify|listen|prepare|execute|comment|"
    r"security|import|into|nextval|setval|set_config|dblink\w*|lo_\w+|pg_advisory\w*|"
    r"pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile)\b",
    re.IGNORECASE,
)
_LOCKING_READ = re.compile(r"\bfor\s+(?:no\s+key\s+)?(?:update|share|key\s+share)\b", re.I)


def _binds_owner(parameters: Any, owner_id: str) -> bool:
    if isinstance(parameters, dict):
        return any(value == owner_id for value in parameters.values())
    if isinstance(parameters, list | tuple) and parameters:
        if all(isinstance(item, dict) for item in parameters):
            return all(_binds_owner(item, owner_id) for item in parameters)
        return any(value == owner_id for value in parameters)
    return False


def check_statement(statement: str, parameters: Any, owner_id: str) -> None:
    """Refuse anything but one plain read that carries the owner id as a parameter.

    The session setting checks in SESSION_STATEMENTS read no table and pass.
    """
    normalized = " ".join(str(statement).split())
    if normalized in SESSION_STATEMENTS:
        return
    body = normalized.rstrip("; ")
    if ";" in body:
        raise ReadOnlyViolation("statement_not_single")
    head = body.lstrip("( ").split(" ", 1)[0].upper()
    if head not in {"SELECT", "WITH"} or _WRITE_WORDS.search(body) or _LOCKING_READ.search(body):
        raise ReadOnlyViolation("statement_not_read_only")
    if not _binds_owner(parameters, owner_id):
        raise ReadOnlyViolation("statement_not_owner_bound")


def install_guards(engine, owner_id: str) -> None:
    """Fence every statement this engine runs (idempotent; one owner per engine)."""
    from sqlalchemy import event

    current = getattr(engine, "_dashboard_owner", None)
    if current is not None:
        if current != owner_id:
            raise ReadOnlyViolation("engine_bound_to_another_owner")
        return

    def guard(_connection, _cursor, statement, parameters, _context, _executemany):
        check_statement(statement, parameters, owner_id)

    event.listen(engine, "before_cursor_execute", guard)
    engine._dashboard_owner = owner_id


def begin_read_only(connection) -> None:
    """First statements of every session: set the transaction read-only, then check it."""
    connection.exec_driver_sql(SET_READ_ONLY)
    assert_read_only(connection)


class OwnerSession:
    """Runs registered statements only, always bound to the one owner."""

    def __init__(self, connection, owner_id: str):
        self.connection = connection
        self.owner_id = owner_id

    def all(self, name: str, **params) -> list[dict]:
        from sqlalchemy import text

        if name not in STATEMENTS:
            raise ReadOnlyViolation("statement_not_registered")
        if "owner" in params:
            raise ReadOnlyViolation("owner_parameter_reserved")
        result = self.connection.execute(text(STATEMENTS[name]), {**params, "owner": self.owner_id})
        return [dict(row) for row in result.mappings()]

    def one(self, name: str, **params) -> dict | None:
        rows = self.all(name, **params)
        return rows[0] if rows else None


class OwnerScopedReader:
    """The only way the dashboard reads UAT: read-only sessions bound to one owner."""

    def __init__(self, engine, owner_id: str):
        if not isinstance(owner_id, str) or not OWNER_ID.fullmatch(owner_id):
            raise ReadOnlyViolation("owner_id_invalid")
        self.engine = engine
        self.owner_id = owner_id
        install_guards(engine, owner_id)

    @contextmanager
    def session(self):
        with self.engine.connect() as connection:
            try:
                begin_read_only(connection)
                yield OwnerSession(connection, self.owner_id)
            finally:
                connection.rollback()


# --- Shaping -----------------------------------------------------------------------
class PacketNotFound(LookupError):
    """No packet with this id belongs to the dashboard's owner."""


CHECKS = (
    ("correct_subject_and_account", "Right person and account"),
    ("correct_issuer_and_type", "Right issuer and document type"),
    ("correct_record_status", "Right record status"),
    ("correct_standalone_value", "Useful on its own"),
    ("correct_coverage", "Coverage stated correctly"),
    ("no_unrelated_inclusions", "Nothing unrelated included"),
    ("no_unexplained_omissions", "Nothing left out without a reason"),
)
INCOMPLETE_COLLECTION_NOTE = (
    " Covers only its verified documents and stated span. Other Drive files remain unverified;"
    " this is not a complete inventory of matching records."
)
OVER_LIMIT_NOTE = " This packet exceeds the current 120-document purchase limit."
MONTH_NAMES = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _uuid(value: str) -> str | None:
    try:
        return str(UUID(str(value)))
    except ValueError:
        return None


def _iso(value) -> str | None:
    if isinstance(value, datetime | date):
        return value.isoformat()
    return value if isinstance(value, str) else None


def _fact_value(facts: dict | None, key: str) -> str | None:
    value = (facts or {}).get(key)
    if isinstance(value, dict):
        value = value.get("value")
    return value.strip() if isinstance(value, str) and value.strip() else None


def mask_account(value: str | None) -> str | None:
    """Only the last four digits of an account number are ever shown."""
    digits = re.findall(r"\d", value or "")
    return "••••" + "".join(digits[-4:]) if len(digits) >= 4 else None


def _month(value: str) -> str:
    try:
        parsed = date.fromisoformat(value[:10])
    except (TypeError, ValueError):
        return str(value)
    return f"{MONTH_NAMES[parsed.month - 1]} {parsed.year}"


def period_label(assessment: dict | None) -> str:
    assessment = assessment or {}
    periods = [
        item
        for item in assessment.get("periods") or []
        if isinstance(item, dict) and item.get("start") and item.get("end")
    ]
    if periods:
        start = _month(min(item["start"] for item in periods))
        end = _month(max(item["end"] for item in periods))
        return start if start == end else f"{start} – {end}"
    return {
        "as_of_snapshot": "Snapshot (no period)",
        "no_period_claim": "No period claimed",
    }.get(assessment.get("temporal_scope"), "")


def packet_status(row: dict, policy: str) -> str:
    if row.get("version") is None:
        return "building"
    if row.get("policy_version") != policy:
        return "old_policy"
    return row.get("state") or "unknown"


def _quotes(citations) -> list[dict]:
    quotes, seen = [], set()
    for item in citations or []:
        if not isinstance(item, dict) or not item.get("quote"):
            continue
        key = (item.get("page"), item["quote"])
        if key in seen:
            continue
        seen.add(key)
        quotes.append({"text": item["quote"], "page": item.get("page")})
    return quotes[:8]


def member_period(facts: dict | None) -> tuple[str | None, str | None, str, list[dict]]:
    """Content periods first; otherwise dated evidence (as-of, event, ...) with its role."""
    facts = facts or {}
    periods = [p for p in facts.get("periods") or [] if p.get("start") and p.get("end")]
    if periods:
        citations = [c for p in periods for c in p.get("citations") or []]
        return (
            min(p["start"] for p in periods),
            max(p["end"] for p in periods),
            "content_period",
            _quotes(citations),
        )
    dated = [e for e in facts.get("date_evidence") or [] if e.get("start") and e.get("end")]
    if dated:
        role = Counter(e.get("role") or "unknown" for e in dated).most_common(1)[0][0]
        citations = [c for e in dated for c in e.get("citations") or []]
        return (
            min(e["start"] for e in dated),
            max(e["end"] for e in dated),
            role,
            _quotes(citations),
        )
    return None, None, "undated", []


def label_view(record: dict | None, current_version) -> dict | None:
    if not record:
        return None
    return {
        "verdict": record.get("verdict"),
        "reason": record.get("reason"),
        "note": record.get("note") or "",
        "at": record.get("at"),
        "version": record.get("version"),
        "current": record.get("version") == current_version,
    }


AI_VERDICT = {"pass": "correct", "fail": "wrong", "unknown": "undecided"}


def ai_verdict(verdicts: list[dict]) -> str | None:
    """The eval's final word on a packet: a deterministic failure, else the newest
    batch's two-judge consensus. None when no eval batch judged these documents."""
    if any(
        item.get("judge") == "deterministic" and item.get("verdict") == "fail" for item in verdicts
    ):
        return "wrong"
    final = [item for item in verdicts if item.get("judge") in {"consensus", "deterministic"}]
    if not final:
        return None
    newest = max(final, key=lambda item: str(item.get("batch") or ""))
    return AI_VERDICT.get(str(newest.get("verdict")), "undecided")


def _words(value) -> set[str]:
    return {word for word in re.split(r"[^a-z0-9]+", str(value or "").casefold()) if len(word) > 2}


KIND_WORDS = {"statement", "statements", "document", "documents", "record", "records", "the"}


def _overlap_days(start: str | None, end: str | None, ask_start: str | None, ask_end: str | None):
    try:
        lo = max(date.fromisoformat(start[:10]), date.fromisoformat(ask_start[:10]))
        hi = min(date.fromisoformat(end[:10]), date.fromisoformat(ask_end[:10]))
    except (TypeError, ValueError):
        return None
    return (hi - lo).days + 1 if hi >= lo else 0


class DashboardData:
    """Owner summary, index health and packets of the one owner, shaped for the API."""

    def __init__(
        self,
        reader: OwnerScopedReader,
        *,
        owner_label: str,
        labels=None,
        verdicts=None,
        code_policy: str | None = None,
        profile: str | None = None,
        cipher=None,
        cache_seconds: float = 30.0,
        policy_seconds: float = 300.0,
        clock=time.monotonic,
    ):
        self.reader = reader
        self.owner_label = owner_label
        self.labels = labels
        self.verdicts = verdicts
        self._code_policy = code_policy
        self._profile = profile
        self._cipher = cipher
        self._cache_seconds = cache_seconds
        self._policy_seconds = policy_seconds
        self._serving: tuple[float, str] | None = None
        self._clock = clock
        self._cache: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    # Configuration ------------------------------------------------------------------
    @property
    def profile(self) -> str:
        if self._profile is None:
            from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE

            self._profile = EXTRACTION_PROFILE
        return self._profile

    def code_policy(self) -> str:
        if self._code_policy is None:
            from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

            self._code_policy = facts_policy_version()
        return self._code_policy

    def _policy(self, db) -> tuple[str, bool]:
        """UAT's current facts policy (its newest facts rows), else this checkout's.

        It changes only when a deploy changes the policy, so it is re-read every few
        minutes rather than on every page load."""
        code = self.code_policy()
        now = self._clock()
        with self._lock:
            cached = self._serving
        if cached is None or now - cached[0] >= self._policy_seconds:
            rows = db.all("serving_policy")
            cached = (now, rows[0]["facts_profile"] if rows else code)
            with self._lock:
                self._serving = cached
        serving = cached[1]
        return serving, serving == code

    def _store(self):
        from hushh_mcp.services.drive_document_store import DriveDocumentCipher
        from hushh_mcp.services.drive_packet_store import DrivePacketStore

        store = object.__new__(DrivePacketStore)
        store.cipher = self._cipher or DriveDocumentCipher()
        return store

    @staticmethod
    def _open(opener, row) -> dict | None:
        try:
            return opener(row)
        except Exception:  # noqa: BLE001 - an unreadable envelope is shown as unreadable
            return None

    def warm(self) -> None:
        """Fill the caches the first page load needs (errors are left to the routes)."""
        for compute in (self.owner_summary, self.health, self.packets):
            try:
                compute()
            except Exception:  # noqa: BLE001 - a route reports the same failure properly
                return

    def _cached(self, name: str, compute):
        now = self._clock()
        with self._lock:
            hit = self._cache.get(name)
            if hit and now - hit[0] < self._cache_seconds:
                return hit[1]
        value = compute()
        with self._lock:
            self._cache[name] = (now, value)
        return value

    def _labels(self) -> dict:
        return self.labels.packet_labels() if self.labels is not None else {}

    @staticmethod
    def _listed_rows(rows: list[dict]) -> list[dict]:
        return [row for row in rows if row.get("version") is not None or row.get("member_rows")]

    # Probe --------------------------------------------------------------------------
    def probe(self) -> dict:
        with self.reader.session() as db:
            connection = db.one("connection")
        return {
            "read_only": "on",
            "connection": (connection or {}).get("status") or "missing",
        }

    # Owner summary and health -------------------------------------------------------
    def owner_summary(self) -> dict:
        return self._cached("owner", self._owner_summary)

    def _owner_summary(self) -> dict:
        with self.reader.session() as db:
            policy, _ = self._policy(db)
            files = db.one("files_found") or {}
            rows = self._listed_rows(db.all("packet_states"))
        statuses = [packet_status(row, policy) for row in rows]
        return {
            "display_name": self.owner_label,
            "files_found": int(files.get("files_found") or 0),
            "packets": len(rows),
            "ready": statuses.count("ready"),
            "listed": sum(bool(row.get("listing_enabled")) for row in rows),
        }

    def health(self) -> dict:
        return self._cached("health", self._health)

    def _health(self) -> dict:
        with self.reader.session() as db:
            connection = db.one("connection")
            policy, matches = self._policy(db)
            census = db.one("document_census", policy=policy, profile=self.profile) or {}
            failures = db.all("failure_reasons", policy=policy, profile=self.profile)
            hour = db.one("last_hour", policy=policy, profile=self.profile) or {}
            rows = self._listed_rows(db.all("packet_states"))
        statuses = Counter(packet_status(row, policy) for row in rows)
        return {
            "as_of": _iso(census.get("as_of")),
            "files_found": int(census.get("files_found") or 0),
            "extracted": int(census.get("extracted") or 0),
            "facts_complete": int(census.get("facts_complete") or 0),
            "facts_waiting": int(census.get("facts_waiting") or 0),
            "failed_by_reason": {row["reason"]: int(row["n"]) for row in failures},
            "extracted_last_hour": int(hour.get("extracted_last_hour") or 0),
            "facts_last_hour": int(hour.get("facts_last_hour") or 0),
            "packets_by_status": dict(sorted(statuses.items())),
            "extraction_waiting": int(census.get("extraction_waiting") or 0),
            "connection": (connection or {}).get("status") or "missing",
            "policy": {"serving": policy.split(":")[-1][:12], "matches_code": matches},
        }

    # Packets ------------------------------------------------------------------------
    def _packets(self) -> list[dict]:
        with self.reader.session() as db:
            policy, _ = self._policy(db)
            rows = self._listed_rows(db.all("packet_rows"))
        store = self._store()
        result = []
        for row in rows:
            manifest = self._open(store._manifest, row) if row.get("version") is not None else None
            key = self._open(store._key, row) or {}
            assessment = (manifest or {}).get("assessment") or {}
            packet_id = str(row["packet_id"])
            has_version = row.get("version") is not None
            selected = [
                str(item.get("document_id")) for item in (manifest or {}).get("sources") or []
            ]
            verdicts = self._eval_verdicts(selected)
            result.append(
                {
                    "packet_id": packet_id,
                    "version_id": row.get("version"),
                    "title": assessment.get("title") or key.get("title") or "Packet (unreadable)",
                    "status": packet_status(row, policy),
                    "member_count": int(
                        (row.get("document_count") if has_version else row.get("member_rows")) or 0
                    ),
                    "period_label": period_label(assessment),
                    "price_cents": row.get("listing_price_cents") or row.get("price_cents"),
                    "listed": bool(row.get("listing_enabled")),
                    "updated_at": _iso(row.get("verified_at") or row.get("updated_at")),
                    "ai_verdict": ai_verdict(verdicts),
                    "human_label": None,
                    "available": bool(row.get("available")) and not row.get("dirty"),
                    "_assessment": assessment,
                    "_key": key,
                }
            )
        result.sort(key=lambda item: item["updated_at"] or "", reverse=True)
        return result

    def packets(self) -> list[dict]:
        labels = self._labels()
        return [
            {
                **{key: value for key, value in item.items() if not key.startswith("_")},
                "human_label": label_view(labels.get(item["packet_id"]), item["version_id"]),
            }
            for item in self._cached("packets", self._packets)
        ]

    def _eval_verdicts(self, document_ids) -> list[dict]:
        if self.verdicts is None or not document_ids:
            return []
        return self.verdicts.for_documents(document_ids)

    # Helper for the request engine (dashboard.ask) --------------------------------------
    def matching_packets(
        self,
        *,
        kinds=(),
        period_start: str | None = None,
        period_end: str | None = None,
        terms=(),
        limit: int = 20,
    ) -> list[dict]:
        """The owner's packets whose kind and period overlap an ask.

        Kind: every meaningful word of one asked kind ("brokerage statement") appears
        in the packet's title, description or key. Period: the packet's content
        periods overlap the asked window (any packet when the ask has no window).
        Terms ("Schwab") only explain a match; they never make one.
        """
        asked = [
            words - KIND_WORDS or words for words in (_words(kind) for kind in kinds or ()) if words
        ]
        found = []
        for item in self._cached("packets", self._packets):
            if item["version_id"] is None:
                continue
            assessment, key = item["_assessment"], item["_key"]
            text = _words(
                " ".join(
                    str(value or "")
                    for value in (
                        item["title"],
                        assessment.get("description"),
                        key.get("title"),
                        key.get("description"),
                        key.get("key"),
                    )
                )
            )
            matched_kind = next((words for words in asked if words <= text), None)
            if asked and matched_kind is None:
                continue
            periods = [
                period
                for period in assessment.get("periods") or []
                if isinstance(period, dict) and period.get("start") and period.get("end")
            ]
            start = min((period["start"] for period in periods), default=None)
            end = max((period["end"] for period in periods), default=None)
            overlap = None
            if period_start and period_end:
                overlap = _overlap_days(start, end, period_start, period_end)
                if not overlap:
                    continue
            reasons = []
            if matched_kind:
                reasons.append("kind: " + " ".join(sorted(matched_kind)))
            if overlap:
                reasons.append(f"period {item['period_label']} overlaps the ask by {overlap} days")
            elif not (period_start and period_end):
                reasons.append("no period asked")
            hits = sorted({term for term in terms or () if _words(term) and _words(term) <= text})
            if hits:
                reasons.append("mentions " + ", ".join(hits))
            found.append(
                {
                    "packet_id": item["packet_id"],
                    "title": item["title"],
                    "status": item["status"],
                    "period_label": item["period_label"],
                    "member_count": item["member_count"],
                    "listed": item["listed"],
                    "price_cents": item["price_cents"],
                    "why_matched": "; ".join(reasons),
                    "_rank": (item["status"] != "ready", -(overlap or 0), item["title"] or ""),
                }
            )
        found.sort(key=lambda entry: entry.pop("_rank"))
        return found[:limit]

    def packet_identity(self, packet_id: str) -> tuple[str, int | None]:
        """(canonical id, current version) of one of the owner's packets, else PacketNotFound."""
        identity = _uuid(packet_id)
        if identity is None:
            raise PacketNotFound(packet_id)
        with self.reader.session() as db:
            row = db.one("packet_head", packet_id=identity)
        if row is None:
            raise PacketNotFound(packet_id)
        return identity, row.get("current_version") or None

    def packet_version(self, packet_id: str) -> int | None:
        """The current version of one of the owner's packets; PacketNotFound otherwise."""
        identity = _uuid(packet_id)
        if identity is None:
            raise PacketNotFound(packet_id)
        with self.reader.session() as db:
            row = db.one("packet_head", packet_id=identity)
        if row is None:
            raise PacketNotFound(packet_id)
        return row.get("current_version") or None

    def packet_detail(self, packet_id: str) -> dict:
        identity = _uuid(packet_id)
        if identity is None:
            raise PacketNotFound(packet_id)
        store = self._store()
        with self.reader.session() as db:
            row = db.one("packet_detail", packet_id=identity)
            if row is None:
                raise PacketNotFound(packet_id)
            policy, _ = self._policy(db)
            manifest = self._open(store._manifest, row) if row.get("version") is not None else None
            if manifest is not None:
                specs = [
                    {
                        "document_id": str(item.get("document_id")),
                        "facts_version": item.get("facts_version"),
                        "source_version": item.get("source_version"),
                    }
                    for item in manifest.get("sources") or []
                ]
            else:
                specs = [
                    {
                        "document_id": str(item["document_id"]),
                        "facts_version": item["facts_version"],
                        "source_version": None,
                    }
                    for item in db.all("packet_member_rows", packet_id=identity)
                ]
            documents = (
                db.all(
                    "member_documents",
                    document_ids=[spec["document_id"] for spec in specs],
                    facts_versions=sorted(
                        {spec["facts_version"] for spec in specs if spec["facts_version"]}
                    ),
                )
                if specs
                else []
            )
            assessment = (manifest or {}).get("assessment") or {}
            excluded_ids = [
                str(item.get("document_id"))
                for item in assessment.get("excluded_documents") or []
                if _uuid(item.get("document_id")) is not None
            ]
            names = db.all("document_names", document_ids=excluded_ids) if excluded_ids else []
            collection = db.one(
                "collection_state",
                generation=row["connection_generation"],
                policy=policy,
                profile=self.profile,
            ) or {"fresh": False, "complete": False}
        return self._detail_view(store, row, policy, manifest, specs, documents, names, collection)

    def _metadata(self, store, document: dict) -> dict:
        return (
            self._open(
                store.cipher.open,
                {
                    "metadata_envelope": document.get("metadata_envelope"),
                    "user_id": document.get("user_id"),
                    "document_id": document.get("document_id"),
                    "connection_generation": document.get("connection_generation"),
                },
            )
            or {}
        )

    def _member_view(
        self, store, spec: dict, document: dict | None, policy: str, generation
    ) -> dict:
        document = document or {}
        metadata = self._metadata(store, document) if document else {}
        facts = None
        if document.get("facts_envelope"):
            facts = self._open(
                store.facts,
                {
                    "user_id": document.get("user_id"),
                    "document_id": document.get("document_id"),
                    "connection_generation": document.get("facts_generation"),
                    "facts_version": document.get("facts_version"),
                    "facts_envelope": document.get("facts_envelope"),
                },
            )
        start, end, role, quotes = member_period(facts)
        current = bool(
            document
            and document.get("connection_generation") == generation
            and document.get("status") == "ready"
            and document.get("active_version") is not None
            and (spec.get("source_version") in (None, document.get("source_version")))
            and document.get("facts_source_version") == document.get("source_version")
            and document.get("extraction_version") == document.get("active_version")
            and document.get("facts_status") == "complete"
            and not document.get("has_gaps")
            and document.get("facts_profile") == policy
            and document.get("extraction_profile") == self.profile
        )
        record_status = (facts or {}).get("record_status") or {}
        return {
            "document_id": spec["document_id"],
            "file_name": metadata.get("name"),
            "kind": _fact_value(facts, "document_type"),
            "pages": document.get("total_pages"),
            "period_start": start,
            "period_end": end,
            "period_role": role,
            "quotes": quotes,
            "issuer": _fact_value(facts, "issuer"),
            "account_mask": mask_account(_fact_value(facts, "account")),
            "holder_name": _fact_value(facts, "subject"),
            "mime_type": metadata.get("mime_type"),
            "modified_time": metadata.get("modified_time"),
            "record_status": record_status.get("status")
            if isinstance(record_status, dict)
            else None,
            "facts_readable": facts is not None,
            "current": current,
        }

    def _detail_view(self, store, row, policy, manifest, specs, documents, names, collection):
        packet_id = str(row["packet_id"])
        has_version = row.get("version") is not None
        key = self._open(store._key, row) or {}
        assessment = (manifest or {}).get("assessment") or {}
        verification = (manifest or {}).get("verification") or {}
        status = packet_status(row, policy)
        by_document = {str(item["document_id"]): item for item in documents}
        members = [
            self._member_view(
                store,
                spec,
                by_document.get(spec["document_id"]),
                policy,
                row["connection_generation"],
            )
            for spec in specs
        ]
        members.sort(key=lambda item: (item["period_start"] or "9999", item["file_name"] or ""))
        changed = sum(not item["current"] for item in members)
        name_of = {
            str(item["document_id"]): self._metadata(store, item).get("name") for item in names
        }
        excluded = [
            {
                "document_id": str(item.get("document_id")),
                "file_name": name_of.get(str(item.get("document_id"))),
                "reason": item.get("reason"),
                "explanation": item.get("explanation"),
            }
            for item in assessment.get("excluded_documents") or []
        ]
        integrity = None
        if manifest is not None:
            from hushh_mcp.services.drive_packet_contract import evidence_digest

            integrity = evidence_digest(manifest) == row.get("digest")

        availability: list[str] = []
        if has_version:
            if row.get("dirty"):
                availability.append("A rebuild is queued after a source changed")
            if not row.get("available"):
                availability.append("Marked not available")
            if not collection.get("fresh"):
                availability.append("Drive sync is not fresh")
            if changed:
                availability.append(f"{changed} member file(s) changed since this version")
            if row.get("live_generation") != row.get("connection_generation"):
                availability.append("Drive was reconnected since this version")
        available = has_version and status == "ready" and not availability

        gaps = [str(item) for item in assessment.get("gaps") or []]
        issues = [str(item) for item in verification.get("issues") or []]
        if status == "building":
            reason = (
                f"Being built (last error: {row['error_code']})"
                if row.get("error_code")
                else "Being built; no version yet"
            )
        elif status == "old_policy":
            reason = "Built under an older facts policy; a rebuild is pending"
        elif status == "ready":
            reason = "; ".join(availability) or "Ready and current"
        else:
            reason = "; ".join((gaps or issues)[:3]) or status

        checks = []
        if has_version:
            for name, label in CHECKS:
                value = verification.get(name)
                checks.append(
                    {
                        "name": name,
                        "label": label,
                        "ok": value if isinstance(value, bool) else None,
                        "reason": "" if value is not False else "The checker marked this false",
                    }
                )
            checks += [
                {
                    "name": "checker_verdict",
                    "label": "Checker said Ready",
                    "ok": verification.get("state") == "ready",
                    "reason": "; ".join(issues[:5]) or str(verification.get("state") or ""),
                },
                {
                    "name": "builder_verdict",
                    "label": "Builder said Ready",
                    "ok": assessment.get("state") == "ready",
                    "reason": "; ".join(gaps[:5]) or str(assessment.get("state") or ""),
                },
                {
                    "name": "member_batch_checks",
                    "label": "Every member batch passed",
                    "ok": bool((manifest or {}).get("batch_checks_passed")),
                    "reason": "",
                },
                {
                    "name": "collection_complete_at_build",
                    "label": "Whole Drive indexed when built",
                    "ok": bool((manifest or {}).get("collection_complete")),
                    "reason": ""
                    if (manifest or {}).get("collection_complete")
                    else "Other Drive files were still being indexed",
                },
                {
                    "name": "manifest_integrity",
                    "label": "Stored version is intact",
                    "ok": integrity,
                    "reason": "" if integrity else "Digest does not match or manifest unreadable",
                },
                {
                    "name": "sources_current",
                    "label": "Member files unchanged since built",
                    "ok": changed == 0,
                    "reason": f"{changed} changed" if changed else "",
                },
                {
                    "name": "policy_current",
                    "label": "Built under UAT's current facts policy",
                    "ok": row.get("policy_version") == policy,
                    "reason": "" if row.get("policy_version") == policy else "Older policy",
                },
                {
                    "name": "available_now",
                    "label": "Available to list now",
                    "ok": available,
                    "reason": "; ".join(availability),
                },
            ]
            from hushh_mcp.services.drive_packet_intelligence import (
                ACCOUNT_MISMATCH,
                DIFFERENT_PERSON,
                HOLDER_MISMATCH,
                OWNER_UNCONFIRMED,
            )

            for name, label, codes in (
                (
                    "same_account_guard",
                    "Sources name one account",
                    (ACCOUNT_MISMATCH, HOLDER_MISMATCH),
                ),
                (
                    "owner_name_guard",
                    "Sources name the owner",
                    (DIFFERENT_PERSON, OWNER_UNCONFIRMED),
                ),
            ):
                hit = [gap for gap in gaps if gap in codes]
                checks.append(
                    {"name": name, "label": label, "ok": not hit, "reason": "; ".join(hit)}
                )

        title = assessment.get("title") or key.get("title") or "Packet (unreadable)"
        policy_stale = has_version and row.get("policy_version") != policy
        document_count = int(row.get("document_count") or 0)
        if not has_version:
            buyer_title, buyer_summary = None, None
        elif policy_stale:
            buyer_title, buyer_summary = (
                "Packet being checked",
                "Current source evidence is being checked.",
            )
        else:
            buyer_title = assessment.get("title") or key.get("title") or "Document packet"
            buyer_summary = assessment.get("description") or key.get("description") or ""
            if not collection.get("complete"):
                buyer_summary = buyer_summary[:790] + INCOMPLETE_COLLECTION_NOTE
            if document_count > 120:
                buyer_summary = buyer_summary[:930] + OVER_LIMIT_NOTE
        selected = [spec["document_id"] for spec in specs] if manifest is not None else []
        verdicts = self._eval_verdicts(selected)
        labels = self._labels()
        return {
            "packet_id": packet_id,
            "version_id": row.get("version"),
            "title": title,
            "status": status,
            "status_reason": reason,
            "buyer_title": buyer_title,
            "buyer_summary": buyer_summary,
            "price_cents": row.get("listing_price_cents") or row.get("price_cents"),
            "listed": bool(row.get("listing_enabled")),
            "members": members,
            "checks": checks,
            "eval_verdicts": verdicts,
            "ai_verdict": ai_verdict(verdicts),
            "human_label": label_view(labels.get(packet_id), row.get("version")),
            "member_count": document_count if has_version else len(specs),
            "period_label": period_label(assessment),
            "coverage_summary": assessment.get("coverage_summary"),
            "gaps": gaps,
            "periods": [
                {
                    "start": item.get("start"),
                    "end": item.get("end"),
                    "quotes": _quotes(item.get("citations")),
                }
                for item in assessment.get("periods") or []
                if isinstance(item, dict)
            ],
            "excluded": excluded,
            "available": available,
            "verified_at": _iso(row.get("verified_at")),
            "updated_at": _iso(row.get("verified_at") or row.get("updated_at")),
        }
