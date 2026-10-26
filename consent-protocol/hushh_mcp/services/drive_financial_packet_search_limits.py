"""Financial owner discovery capacity after saved origin and current-head authority."""

from __future__ import annotations

import base64
import hashlib

from hushh_mcp.services.drive_financial_packet_query import QUERY_SOURCE, validate_predefined
from hushh_mcp.services.drive_period_packet_contract import PERIOD_PACKET_POLICY
from hushh_mcp.services.drive_request_discovery import DISCOVERY_DELIVERY_POLICY
from hushh_mcp.services.google_drive_adapter import DriveReadError

MAX_STORAGE_POSITION = 2147483647
MAX_TOKEN_HISTORY_BYTES = 64 * 1024
_AUTHORIZED = object()


def legacy_incomplete_packets(connection, *, user_id):
    """Due hints for exact current children, never authority to replay a job.

    Pre-fix incomplete searches had no typed reason and exhausted head retries.
    Compute their existing revision identity in Python, without a second SQL
    implementation of search_client_id or accepting a later stale child.
    """
    from datetime import UTC, datetime

    from sqlalchemy import text

    from hushh_mcp.services.drive_financial_packet_query import QUERY_VERSION
    from hushh_mcp.services.drive_period_packet_contract import current_year_periods
    from hushh_mcp.services.drive_period_packet_preview import search_client_id

    rows = connection.execute(
        text("""SELECT h.packet_id,h.revision,j.client_request_id
        FROM drive_packet_heads h JOIN drive_owner_search_jobs j
          ON j.user_id=h.user_id AND j.period_packet_id=h.packet_id
          AND j.connection_generation=h.connection_generation
        WHERE h.user_id=:user AND h.packet_kind='provider_discovery'
          AND h.category='financial' AND h.predefined_query_version=:template
          AND h.period_start=ANY(CAST(:period_starts AS date[]))
          AND h.dirty AND h.attempts=8 AND h.next_at<=clock_timestamp()
          AND h.error_code='search_incomplete'
          AND j.status='limited' AND j.incomplete_search AND j.error_code IS NULL"""),
        {
            "user": user_id,
            "template": QUERY_VERSION,
            "period_starts": [
                period.start for period in current_year_periods(datetime.now(UTC), "UTC")
            ],
        },
    ).mappings()
    return list(
        {
            str(row["packet_id"])
            for row in rows
            if str(row["client_request_id"]) == search_client_id(row)
        }
    )


def financial_discovery_checkpoint(checkpoint) -> bool:
    """A strict provenance descriptor; this alone grants no larger limit."""
    origin = checkpoint.get("period_packet_origin")
    if (
        not isinstance(origin, dict)
        or origin.get("policy") != PERIOD_PACKET_POLICY
        or not origin.get("packet_id")
        or type(origin.get("revision")) is not int
        or checkpoint.get("query_source") != QUERY_SOURCE
        or checkpoint.get("discovery_delivery_policy") != DISCOVERY_DELIVERY_POLICY
        or checkpoint.get("evidence_route") != "provider"
        or checkpoint.get("authority_mode", "owner") != "owner"
        or checkpoint.get("request_origin_id") is not None
        or checkpoint.get("provider_packet") is not None
        or checkpoint.get("reusable_packet") is not None
        or checkpoint.get("request_direct_originals") is not True
        or checkpoint.get("request_result_limit") is not None
    ):
        return False
    try:
        validate_predefined(checkpoint)
    except (ValueError, TypeError, KeyError):
        return False
    return True


def financial_discovery_bound(store, connection, row, *, checkpoint=None, ordinary_limit=10000):
    """Resolve a saved job and its live financial head, never a client marker."""
    checkpoint = store._checkpoint(row) if checkpoint is None else checkpoint
    if not row.get("period_packet_id") or not financial_discovery_checkpoint(checkpoint):
        return ordinary_limit
    origin = checkpoint["period_packet_origin"]
    if str(row["period_packet_id"]) != origin["packet_id"]:
        raise DriveReadError("search_superseded")
    from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

    packets = DrivePeriodPacketStore(db=store.db)
    head = packets.current_period_head(
        connection,
        user_id=row["user_id"],
        packet_id=origin["packet_id"],
        revision=origin["revision"],
    )
    packets.validate_origin(head, checkpoint)
    if (
        head["category"] != "financial"
        or head["connection_generation"] != row["connection_generation"]
    ):
        raise DriveReadError("search_superseded")
    return MAX_STORAGE_POSITION


def mark_financial_discovery(job, enabled):
    # This ephemeral object cannot arrive through a JSON checkpoint or HTTP request.
    job.pop("_financial_discovery_authority", None)
    if enabled:
        job["_financial_discovery_authority"] = _AUTHORIZED


def financial_discovery_authorized(job) -> bool:
    return job.get("_financial_discovery_authority") is _AUTHORIZED


def append_financial_token(checkpoint, token, current):
    """Retain every full SHA-256 digest; no window eviction or weaker cycle check."""
    saved = checkpoint.get("seen_tokens", [])
    try:
        if isinstance(saved, list):
            if len(saved) > MAX_TOKEN_HISTORY_BYTES // 32 or any(
                not isinstance(value, str) or len(value) != 64 for value in saved
            ):
                raise ValueError
            history = b"".join(bytes.fromhex(value) for value in saved)
        elif (
            isinstance(saved, dict)
            and set(saved) == {"encoding", "digests"}
            and saved["encoding"] == "sha256-packed-v1"
        ):
            if not isinstance(saved["digests"], str) or len(saved["digests"]) > 4 * (
                (MAX_TOKEN_HISTORY_BYTES + 2) // 3
            ):
                raise ValueError
            history = base64.b64decode(saved["digests"], validate=True)
        else:
            raise ValueError
        if len(history) % 32 or len(history) > MAX_TOKEN_HISTORY_BYTES:
            raise ValueError
    except (ValueError, TypeError):
        raise DriveReadError("provider_response_invalid") from None
    digest = hashlib.sha256(token.encode()).digest()
    if token == current or any(history[i : i + 32] == digest for i in range(0, len(history), 32)):
        raise DriveReadError("provider_response_invalid")
    if len(history) + 32 > MAX_TOKEN_HISTORY_BYTES:
        raise DriveReadError("provider_response_invalid")
    checkpoint["seen_tokens"] = {
        "encoding": "sha256-packed-v1",
        "digests": base64.b64encode(history + digest).decode("ascii"),
    }


def result_cursor_after(store, user, identity, cursor, *, connection=None, ordinary_limit=10000):
    """Existing cursor format; larger positions need owned saved financial authority."""
    import hmac

    if cursor is None:
        return 0
    try:
        if not isinstance(cursor, str) or len(cursor) > 1024:
            raise ValueError
        value, signature = (
            base64.b64decode(cursor, altchars=b"-_", validate=True).decode().split(":")
        )
        after = int(value)
        if not 0 <= after <= MAX_STORAGE_POSITION or not hmac.compare_digest(
            signature,
            store.search_cipher.digest("owner-search-result-cursor", [user, identity, after]),
        ):
            raise ValueError
        if after > ordinary_limit:
            if connection is None:
                raise ValueError
            row = store._row(
                connection,
                "SELECT * FROM drive_owner_search_jobs WHERE job_id=:job AND user_id=:user",
                {"job": identity, "user": user},
            )
            if row is None or after > financial_discovery_bound(
                store, connection, row, ordinary_limit=ordinary_limit
            ):
                raise ValueError
        return after
    except (ValueError, UnicodeError):
        raise DriveReadError("invalid_argument") from None


def owned_result_page(store, connection, user, identity, cursor):
    """Resolve the cursor and job under the existing owner/generation read fence."""
    current = store._access(connection, user, read_only=True)
    after = store._after(user, identity, cursor, connection=connection)
    row = store._owned(connection, user, identity)
    if row["connection_generation"] != current["connection_generation"]:
        raise DriveReadError("connection_changed")
    return row, after


def commit_result_batch(store, connection, job, checkpoint, files, count, unshareable, limit):
    """Membership and bounded batch insert under the caller's current job lock."""
    from sqlalchemy import text

    initial = count, unshareable
    digested = [
        (item, store.search_cipher.digest("owner-search-file", [job["job_id"], item["id"]]))
        for item in files
    ]
    existing = set(
        connection.execute(
            text("""SELECT file_digest FROM drive_owner_search_results
      WHERE job_id=:job AND file_digest = ANY(CAST(:digests AS text[]))"""),
            {"job": job["job_id"], "digests": list({digest for _, digest in digested})},
        ).scalars()
    )
    pending = []
    for item, digest in digested:
        if digest in existing:
            if checkpoint.get("coverage_manifest"):
                counts = checkpoint.setdefault("coverage_counts", {})
                counts["deduplicatedCount"] = counts.get("deduplicatedCount", 0) + 1
            continue
        existing.add(digest)
        if count >= limit:
            # Do not commit a partial page or advance its provider cursor.
            return *initial, True
        count += 1
        unshareable += int(item.get("shareable") is False)
        pending.append(
            {
                "job": job["job_id"],
                "user": job["user_id"],
                "position": count,
                "digest": digest,
                "envelope": store._seal(
                    item, job["user_id"], f"{job['job_id']}:{count}", "owner-search-result"
                ),
            }
        )
    if pending:
        connection.execute(
            text("""INSERT INTO drive_owner_search_results
          (job_id,user_id,position,file_digest,metadata_envelope)
          VALUES(:job,:user,:position,:digest,CAST(:envelope AS jsonb))"""),
            pending,
        )
    return count, unshareable, False


def page_token(payload, current, checkpoint, *, financial=False):
    token = payload.get("nextPageToken")
    if token is not None and (not isinstance(token, str) or len(token) > 1024):
        raise DriveReadError("provider_response_invalid")
    if token:
        if financial:
            append_financial_token(checkpoint, token, current)
        else:
            digest = hashlib.sha256(token.encode()).hexdigest()
            seen = checkpoint.setdefault("seen_tokens", [])
            if token == current or digest in seen or len(seen) >= 1000:
                raise DriveReadError("provider_response_invalid")
            seen.append(digest)
    return token or None


def drive_page_token(payload, checkpoint, *, financial=False):
    """Keep shared-drive cycle history separate from each file-scan phase."""
    state = {"seen_tokens": checkpoint["drive_tokens"]}
    token = page_token(payload, checkpoint["drive_page_token"], state, financial=financial)
    checkpoint["drive_tokens"] = state["seen_tokens"]
    checkpoint["drive_page_token"] = token
    return token


def page_work_limit(checkpoint, done, financial, *, page_limit, checkpoint_bytes) -> bool:
    import json

    return bool(checkpoint.get("request_origin_id") or checkpoint.get("period_packet_origin")) and (
        not financial
        and checkpoint["coverage_counts"].get("providerFilePages", 0) >= page_limit
        and not done
        or len(json.dumps(checkpoint, ensure_ascii=False).encode("utf-8")) > checkpoint_bytes
    )
