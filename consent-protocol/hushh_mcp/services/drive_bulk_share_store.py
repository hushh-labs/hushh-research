"""Frozen, owner-reviewed Drive search manifests and idempotent bulk ACL effects.

No model, browser session, or request holds the work. Search-result ciphertext is
copied without changing its authenticated-data context; provider file IDs and
recipient email addresses are never stored in plaintext.
"""

from __future__ import annotations

import base64
import hmac
import json
from collections import Counter
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher, DriveSharingError
from hushh_mcp.services.google_drive_adapter import FILE_ID, DriveReadError

_TERMINAL = frozenset(
    {"succeeded", "preexisting", "skipped", "failed", "present_unattributed", "absent"}
)
_ACTIVE = frozenset({"queued", "running"})
_ROW = "SELECT * FROM drive_bulk_shares WHERE share_id=:share AND user_id=:user"
_SAFE_REASONS = frozenset(
    {
        "source_changed",
        "source_not_shareable",
        "recipient_changed",
        "connection_changed",
        "stopped",
        "sharing_unavailable",
        "retry_limit",
        "provider_unavailable",
        "permission_rejected",
        "permission_outcome_unknown",
        "permission_catalog_incomplete",
        "unavailable",
    }
)


def safe_bulk_reason(value):
    """Release only public reason codes, never provider bodies or diagnostics."""
    return value if value in _SAFE_REASONS else "unavailable"


def bulk_outcome_summary(
    connection, *, share_id, total, recipient_user_id=None, active_request_id=None
):
    """One count source for A and B; B's query is scoped to B's own effects."""
    rows = connection.execute(
        text("""SELECT e.state,e.safe_error_code,count(*) AS n
        FROM drive_bulk_share_effects e
        JOIN drive_bulk_share_files f ON f.share_id=e.share_id AND f.position=e.position
        WHERE e.share_id=:share
          AND (:recipient IS NULL OR e.recipient_user_id=:recipient)
          AND (CAST(:active_request AS uuid) IS NULL
            OR f.origin_request_id=CAST(:active_request AS uuid))
        GROUP BY e.state,e.safe_error_code"""),
        {"share": share_id, "recipient": recipient_user_id, "active_request": active_request_id},
    ).all()
    states, reasons = Counter(), Counter()
    for state, reason, count in rows:
        states[state] += count
        if state in {"skipped", "failed", "present_unattributed", "absent", "unknown"}:
            reasons[safe_bulk_reason(reason)] += count
    processed = sum(states[state] for state in _TERMINAL)
    return {
        "counts": {
            "total": total,
            "processed": processed,
            "shared": states["succeeded"],
            "alreadyShared": states["preexisting"],
            "skipped": states["skipped"],
            "failed": states["failed"],
            "needsReview": states["present_unattributed"] + states["absent"],
            "unknown": states["unknown"],
            "pending": max(0, total - processed - states["unknown"]),
        },
        "issues": [{"reasonCode": code, "count": count} for code, count in sorted(reasons.items())],
    }


def _uuid(value: object) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise DriveSharingError("invalid_argument") from None


def _safe_recipient(item: dict, owner: str) -> dict:
    if not isinstance(item, dict):
        raise DriveSharingError("invalid_argument")
    user_id, email, subject, kind = (
        item.get("userId"),
        item.get("email"),
        item.get("subject"),
        item.get("kind"),
    )
    name = item.get("name")
    if (
        not isinstance(user_id, str)
        or not user_id
        or user_id == owner
        or not isinstance(email, str)
        or not 3 <= len(email) <= 254
        or not isinstance(subject, str)
        or not 1 <= len(subject) <= 255
        or kind not in {"google_provider", "verified_email"}
        or name is not None
        and (not isinstance(name, str) or len(name) > 200)
    ):
        raise DriveSharingError("invalid_argument")
    return {"user_id": user_id, "email": email, "subject": subject, "kind": kind, "name": name}


class DriveBulkShareStore(DriveLivePreferences):
    def __init__(self, db=None, *, cipher=None):
        super().__init__(db)
        self.cipher = cipher or DriveSharingCipher()

    def _require_paid_for_origin(self, connection, request_id):
        if request_id is None:
            return
        from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore

        request = self._row(
            connection,
            "SELECT request_id,payment_required FROM drive_share_requests WHERE request_id=:request",
            {"request": request_id},
        )
        if request is None:
            raise DriveSharingError("request_unavailable")
        DriveRequestPaymentStore.require_paid_if_required(connection, request)

    def _seal(self, value, *, user_id, resource_id, purpose):
        return json.dumps(
            self.cipher.seal(value, user_id=user_id, resource_id=resource_id, purpose=purpose)
        )

    def _open(self, envelope, *, user_id, resource_id, purpose):
        return self.cipher.open(envelope, user_id=user_id, resource_id=resource_id, purpose=purpose)

    def _seal_excluded(self, items, *, user_id, share_id):
        # DriveSharingCipher authenticates object payloads only.
        return self._seal(
            {"items": items},
            user_id=user_id,
            resource_id=share_id,
            purpose="bulk-share-excluded",
        )

    def _open_excluded(self, envelope, *, user_id, share_id):
        payload = self._open(
            envelope,
            user_id=user_id,
            resource_id=share_id,
            purpose="bulk-share-excluded",
        )
        items = payload.get("items")
        if not isinstance(items, list) or any(
            not isinstance(item, dict)
            or not isinstance(item.get("reason"), str)
            or item.get("name") is not None
            and not isinstance(item.get("name"), str)
            for item in items
        ):
            raise DriveSharingError("sharing_storage_unavailable")
        return items

    @staticmethod
    def _owner_grants_enabled(user_id):
        return all(
            connector_feature_enabled(feature, user_id)
            for feature in ("drive_document_sharing", "google_drive_chat_reads")
        )

    def _owned(self, connection, user_id, share_id, *, locked=False, unexpired=True):
        sql = _ROW + (" AND expires_at>clock_timestamp()" if unexpired else "")
        row = self._row(
            connection,
            sql + (" FOR UPDATE" if locked else ""),
            {"share": share_id, "user": user_id},
        )
        if row is None:
            raise DriveSharingError("bulk_not_found")
        return row

    @staticmethod
    def _gate_graph_for_share(connection, *, user_id, share_id):
        """Take identity guards before connector/share locks and Feed writes."""
        from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

        participants = (
            connection.execute(
                text("""SELECT b.user_id,r.recipient_user_id
          FROM drive_bulk_shares b LEFT JOIN drive_bulk_share_recipients r
            ON r.share_id=b.share_id
          WHERE b.share_id=:share AND b.user_id=:user"""),
                {"share": share_id, "user": user_id},
            )
            .mappings()
            .all()
        )
        lock_connection_graph_users(
            connection,
            user_ids=[
                user_id,
                *(item["recipient_user_id"] for item in participants if item["recipient_user_id"]),
            ],
        )

    @staticmethod
    def _gate_graph_for_request(connection, *, user_id, request_id):
        from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

        participant = (
            connection.execute(
                text("""SELECT recipient_user_id FROM drive_share_requests
          WHERE request_id=:request AND user_id=:user"""),
                {"request": request_id, "user": user_id},
            )
            .mappings()
            .first()
        )
        lock_connection_graph_users(
            connection,
            user_ids=[user_id, participant["recipient_user_id"] if participant else None],
        )

    @staticmethod
    def _recipient_current(connection, owner, recipient):
        """The same accepted-connection and Trusted-roster boundary as owner sharing."""
        if not connector_feature_enabled("drive_document_sharing", recipient):
            return False
        return bool(
            connection.execute(
                text("""
                SELECT EXISTS(
                  SELECT 1 FROM connections conn
                  JOIN connection_origins origin ON origin.connection_id=conn.id
                    AND origin.status='active'
                    AND origin.origin_kind IN ('direct_request','legacy_invite')
                  WHERE conn.status='active'
                    AND ((conn.user_a_id=:owner AND conn.user_b_id=:recipient)
                      OR (conn.user_b_id=:owner AND conn.user_a_id=:recipient))
                    AND (
                      EXISTS(
                        SELECT 1 FROM one_location_circles c
                        JOIN one_location_circle_memberships m ON m.circle_id=c.id
                        WHERE c.owner_user_id=:owner AND c.system_kind='trusted'
                          AND c.status='active' AND m.user_id=:recipient
                          AND m.status='active'
                      )
                      OR NOT EXISTS(
                        SELECT 1 FROM one_location_circles c
                        JOIN one_location_circle_memberships m ON m.circle_id=c.id
                        WHERE c.owner_user_id=:owner AND c.system_kind='trusted'
                          AND m.user_id=:recipient
                      )
                    )
                )
                """),
                {"owner": owner, "recipient": recipient},
            ).scalar_one()
        )

    @staticmethod
    def _request_recipient_current(connection, owner, recipient):
        if not connector_feature_enabled("drive_document_sharing", recipient):
            return False
        return bool(
            connection.execute(
                text("""
            SELECT EXISTS(SELECT 1 FROM connections
              WHERE status='active' AND ((user_a_id=:owner AND user_b_id=:recipient)
                OR (user_b_id=:owner AND user_a_id=:recipient)))
        """),
                {"owner": owner, "recipient": recipient},
            ).scalar_one()
        )

    def _share_recipient_current(self, connection, share, owner, recipient):
        if share["origin_request_id"] is None:
            return self._recipient_current(connection, owner, recipient)
        request = self._row(
            connection,
            """SELECT recipient_user_id,status,revision,expires_at,request_envelope,
            preparation_error_code
            FROM drive_share_requests WHERE request_id=:request AND user_id=:owner""",
            {"request": share["origin_request_id"], "owner": owner},
        )
        if not request or request["recipient_user_id"] != recipient:
            return False
        allowed_status = (
            share["progressive_batch"] is True
            and share["approved_at"] is not None
            and request["status"] == "pending"
        ) or (not share["progressive_batch"] and request["status"] == "approved")
        if not allowed_status:
            return False
        private = self._open(
            request["request_envelope"],
            user_id=owner,
            resource_id=str(share["origin_request_id"]),
            purpose="request",
        )
        approval_source = share["approval_source"]
        if approval_source == "trusted_auto":
            # The request marker only records eligibility at creation. The
            # immutable batch approval is the grant authority; an owner may
            # explicitly approve another batch after Trusted access changes.
            if (
                private.get("trusted_auto") is not True
                or not share["progressive_batch"]
                or request["preparation_error_code"] == "manual_search_active"
            ):
                return False
            from hushh_mcp.services.drive_sharing_store import DriveSharingStore

            try:
                self.background_current(
                    connection, user_id=owner, generation=share["connection_generation"]
                )
            except DriveReadError:
                return False
            recipient_current = DriveSharingStore._trusted_recipient_current(
                connection, owner, recipient
            )
        elif approval_source == "owner":
            recipient_current = self._request_recipient_current(connection, owner, recipient)
        else:
            return False
        return bool(
            request["revision"] == share["origin_request_revision"]
            and request["expires_at"]
            > connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            and recipient_current
        )

    def _recipients(self, connection, row):
        recipients = []
        for item in connection.execute(
            text(
                "SELECT * FROM drive_bulk_share_recipients WHERE share_id=:share ORDER BY recipient_user_id"
            ),
            {"share": row["share_id"]},
        ).mappings():
            recipients.append(
                self._open(
                    item["identity_envelope"],
                    user_id=row["user_id"],
                    resource_id=f"{row['share_id']}:{item['recipient_user_id']}",
                    purpose="bulk-share-recipient",
                )
            )
        return recipients

    def _recoverable_claims(
        self, connection, *, user_id, request_id, search_job_id, selected_positions=None, lock=False
    ):
        """Old auto effects that were skipped before any possible provider POST.

        Keep the old batch/effect as an audit record. Only a new explicit owner
        review may release its source-position claim, under the connector lock.
        Matching the current search digest prevents a stale position from
        silently referring to another Drive file after a search refresh.
        """
        query = """SELECT f.share_id,f.position,f.source_position,r.metadata_envelope
                FROM drive_bulk_share_files f
                JOIN drive_bulk_shares b ON b.share_id=f.share_id
                JOIN drive_bulk_share_effects e ON e.share_id=f.share_id
                  AND e.position=f.position
                JOIN drive_owner_search_results r ON r.job_id=:job
                  AND r.user_id=:user AND r.position=f.source_position
                  AND r.file_digest=f.file_digest
                WHERE f.user_id=:user AND f.origin_request_id=:request
                  AND b.origin_request_id=:request AND b.progressive_batch=TRUE
                  AND b.approval_source='trusted_auto' AND b.approved_at IS NOT NULL
                  AND b.recipient_count=1
                  AND e.recipient_user_id=(SELECT recipient_user_id
                    FROM drive_share_requests WHERE request_id=:request)
                  AND e.state='skipped' AND e.safe_error_code='recipient_changed'
                  AND e.attempts=0 AND e.lease_id IS NULL
                  AND e.lease_expires_at IS NULL AND e.receipt_envelope IS NULL
                  AND NOT EXISTS(SELECT 1 FROM drive_bulk_share_effects other
                    WHERE other.share_id=e.share_id AND other.position=e.position
                      AND other.recipient_user_id<>e.recipient_user_id)
                  AND (CAST(:selected AS integer[]) IS NULL
                    OR f.source_position=ANY(CAST(:selected AS integer[])))
                ORDER BY f.source_position
                """
        if lock:
            query += " FOR UPDATE OF f,e"
        rows = connection.execute(
            text(query),
            {
                "job": search_job_id,
                "user": user_id,
                "request": request_id,
                "selected": selected_positions,
            },
        ).mappings()
        return [
            row
            for row in rows
            if self._open(
                row["metadata_envelope"],
                user_id=user_id,
                resource_id=f"{search_job_id}:{row['source_position']}",
                purpose="owner-search-result",
            ).get("shareable")
            is True
        ]

    def _view(self, connection, row):
        # UI hint only. approve() performs the authoritative locked check.
        connection_hint = self._row(
            connection,
            """SELECT connection_generation,status,validation_state
            FROM user_external_connector_connections
            WHERE user_id=:user AND connector_id='google_drive'""",
            {"user": row["user_id"]},
        )
        same_connection = bool(
            connection_hint
            and connection_hint["connection_generation"] == row["connection_generation"]
            and connection_hint["status"] == "connected"
            and connection_hint["validation_state"] == "verified"
        )
        total = row["file_count"] * row["recipient_count"]
        counts = {
            "total": total,
            "processed": 0,
            "shared": 0,
            "alreadyShared": 0,
            "skipped": 0,
            "failed": 0,
            "needsReview": 0,
            "unknown": 0,
            "pending": total,
        }
        issues = []
        if row["approved_at"] is not None:
            summary = bulk_outcome_summary(connection, share_id=row["share_id"], total=total)
            counts, issues = summary["counts"], summary["issues"]
        elif row["status"] == "stopped":
            counts.update(processed=total, skipped=total, pending=0)
            issues = [{"reasonCode": "stopped", "count": total}] if total else []
        retryable_count = (
            connection.execute(
                text("""SELECT count(*) FROM drive_bulk_share_effects
            WHERE share_id=:share AND state='skipped' AND safe_error_code='provider_unavailable'
              AND receipt_envelope IS NULL AND lease_id IS NULL"""),
                {"share": row["share_id"]},
            ).scalar_one()
            if row["status"] in {"partial", "failed"}
            else 0
        )
        retry_origin_current = True
        if retryable_count and row["origin_request_id"] is not None:
            origin = self._row(
                connection,
                """SELECT status,revision,expires_at FROM drive_share_requests
                WHERE request_id=:request AND user_id=:user""",
                {"request": row["origin_request_id"], "user": row["user_id"]},
            )
            retry_origin_current = bool(
                origin
                and origin["status"] == ("pending" if row["progressive_batch"] else "partial")
                and origin["revision"] == row["origin_request_revision"]
                and origin["expires_at"] > datetime.now(UTC)
            )
        recipients = self._recipients(connection, row)
        notice_states = dict(
            connection.execute(
                text(
                    "SELECT state,count(*) AS n FROM drive_bulk_share_notifications WHERE share_id=:share GROUP BY state"
                ),
                {"share": row["share_id"]},
            ).all()
        )
        excluded = self._open_excluded(
            row["excluded_envelope"],
            user_id=row["user_id"],
            share_id=str(row["share_id"]),
        )
        positions = []
        if row["progressive_batch"]:
            positions = [
                position
                for (position,) in connection.execute(
                    text("""SELECT source_position FROM drive_bulk_share_files
                    WHERE share_id=:share ORDER BY source_position"""),
                    {"share": row["share_id"]},
                ).all()
            ]
        return {
            "shareId": str(row["share_id"]),
            "searchJobId": str(row["search_job_id"]),
            "status": row["status"],
            "revision": row["revision"],
            "reviewDigest": row["review_digest"],
            "fileCount": row["file_count"],
            "positions": positions,
            "progressiveBatch": row["progressive_batch"],
            "recipientCount": row["recipient_count"],
            "recipients": [{"name": item["name"], "email": item["email"]} for item in recipients],
            "excluded": excluded,
            "counts": counts,
            "issues": issues,
            "retryableCount": retryable_count,
            "canRetry": retryable_count > 0
            and retry_origin_current
            and same_connection
            and self._owner_grants_enabled(row["user_id"])
            and row["expires_at"] > datetime.now(UTC),
            "notifications": {
                "settled": notice_states.get("settled", 0),
                "pending": notice_states.get("queued", 0) + notice_states.get("dispatching", 0),
                "unavailable": notice_states.get("unavailable", 0),
            },
            "canApprove": self._owner_grants_enabled(row["user_id"])
            and same_connection
            and row["status"] == "review_ready"
            and row["recipient_count"] > 0
            and row["expires_at"] > datetime.now(UTC),
            "canStop": row["status"] in {"review_ready", "queued", "running"},
            "createdAt": row["created_at"].isoformat(),
            "updatedAt": row["updated_at"].isoformat(),
            "expiresAt": row["expires_at"].isoformat(),
        }

    async def create_review(
        self,
        *,
        user_id,
        search_job_id,
        client_request_id,
        recipients,
        excluded,
        origin_request_id=None,
        excluded_positions=None,
        selected_positions=None,
    ):
        search = _uuid(search_job_id)
        client = _uuid(client_request_id)
        origin = _uuid(origin_request_id) if origin_request_id is not None else None
        positions = excluded_positions if excluded_positions is not None else []
        progressive = selected_positions is not None
        if progressive and (
            origin is None
            or not isinstance(selected_positions, list)
            or not 1 <= len(selected_positions) <= 25
            or any(type(item) is not int or not 1 <= item <= 10000 for item in selected_positions)
            or len(selected_positions) != len(set(selected_positions))
            or positions
        ):
            raise DriveSharingError("invalid_argument")
        selected_positions = sorted(selected_positions) if progressive else None
        if (
            not isinstance(positions, list)
            or len(positions) > 10000
            or any(type(item) is not int or not 1 <= item <= 10000 for item in positions)
            or len(positions) != len(set(positions))
            or positions
            and origin is None
        ):
            raise DriveSharingError("invalid_argument")
        positions = sorted(positions)
        if not isinstance(recipients, list) or len(recipients) > 10:
            raise DriveSharingError("invalid_argument")
        cleaned = [_safe_recipient(item, user_id) for item in recipients]
        if len({item["user_id"] for item in cleaned}) != len(cleaned):
            raise DriveSharingError("invalid_argument")
        if not isinstance(excluded, list) or len(excluded) > 100:
            raise DriveSharingError("invalid_argument")
        safe_excluded = []
        for item in excluded:
            if (
                not isinstance(item, dict)
                or item.get("name") is not None
                and (not isinstance(item["name"], str) or len(item["name"]) > 200)
                or not isinstance(item.get("reason"), str)
                or len(item["reason"]) > 64
            ):
                raise DriveSharingError("invalid_argument")
            safe_excluded.append({"name": item.get("name"), "reason": item["reason"]})
        digest = self.cipher.digest(
            "bulk-share-request",
            [user_id, search]
            if origin is None
            else [user_id, search, origin, positions, selected_positions],
        )
        share = str(uuid4())

        def operation(connection):
            from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

            lock_connection_graph_users(
                connection, user_ids=[user_id, *(recipient["user_id"] for recipient in cleaned)]
            )
            if progressive:
                # Serializes position claims with another tab and with the
                # search page commit without holding a lock over provider I/O.
                self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            current = self.live_active(connection, user_id=user_id)
            if origin is not None and not progressive:
                connection.execute(
                    text("""DELETE FROM drive_bulk_shares
                    WHERE user_id=:user AND origin_request_id=:request
                      AND status='review_ready' AND expires_at<=clock_timestamp()"""),
                    {"user": user_id, "request": origin},
                )
            existing = self._row(
                connection,
                "SELECT * FROM drive_bulk_shares WHERE user_id=:user AND client_request_id=:client",
                {"user": user_id, "client": client},
            )
            if existing:
                if existing["request_digest"] != digest:
                    raise DriveSharingError("bulk_conflict")
                if (
                    existing["status"] == "review_ready"
                    and existing["connection_generation"] != current["connection_generation"]
                ):
                    raise DriveSharingError("connection_changed")
                return self._view(connection, existing)
            # A second chat or a duplicate tap must attach to the same
            # frozen review, even if it supplied a different client UUID.
            prior_search = (
                None
                if progressive
                else self._row(
                    connection,
                    "SELECT * FROM drive_bulk_shares WHERE user_id=:user AND search_job_id=:search",
                    {"user": user_id, "search": search},
                )
            )
            if prior_search:
                if prior_search["request_digest"] != digest:
                    raise DriveSharingError("bulk_conflict")
                if (
                    prior_search["status"] == "review_ready"
                    and prior_search["connection_generation"] != current["connection_generation"]
                ):
                    raise DriveSharingError("connection_changed")
                return self._view(connection, prior_search)
            source = self._row(
                connection,
                "SELECT * FROM drive_owner_search_jobs WHERE job_id=:job AND user_id=:user AND expires_at>clock_timestamp() FOR SHARE",
                {"job": search, "user": user_id},
            )
            if source is None:
                raise DriveSharingError("search_not_found")
            if not progressive and source["status"] in {"queued", "running"}:
                raise DriveSharingError("search_in_progress")
            if (
                source["status"]
                not in ({"queued", "running", "completed"} if progressive else {"completed"})
                or source["incomplete_search"]
            ):
                raise DriveSharingError("search_incomplete")
            if source["connection_generation"] != current["connection_generation"]:
                raise DriveSharingError("connection_changed")
            request_row = None
            if origin is not None:
                if str(source["client_request_id"]) != origin:
                    raise DriveSharingError("request_changed")
                request_row = self._row(
                    connection,
                    "SELECT * FROM drive_share_requests WHERE request_id=:request AND user_id=:user FOR UPDATE",
                    {"request": origin, "user": user_id},
                )
                if (
                    request_row is None
                    or request_row["bulk_search_started_at"] is None
                    or request_row["status"] != "pending"
                    or request_row["expires_at"]
                    <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
                    or len(cleaned) != 1
                    or cleaned[0]["user_id"] != request_row["recipient_user_id"]
                ):
                    raise DriveSharingError("request_changed")
                private = self._open(
                    request_row["request_envelope"],
                    user_id=user_id,
                    resource_id=origin,
                    purpose="request",
                )
                frozen = private.get("recipient") if isinstance(private, dict) else None
                if (
                    not isinstance(frozen, dict)
                    or any(cleaned[0][key] != frozen.get(key) for key in ("email", "subject"))
                    or cleaned[0]["kind"] != frozen.get("kind", "google_provider")
                    or not self._request_recipient_current(
                        connection, user_id, cleaned[0]["user_id"]
                    )
                ):
                    raise DriveSharingError("recipient_changed")
            if not 1 <= source["matched"] <= 10000:
                raise DriveSharingError("invalid_argument")
            if progressive:
                checkpoint = self._open(
                    source["checkpoint_envelope"],
                    user_id=user_id,
                    resource_id=search,
                    purpose="owner-search-checkpoint",
                )
                if (
                    checkpoint.get("request_origin_id") != origin
                    or checkpoint.get("request_revision") != request_row["revision"]
                    or checkpoint.get("request_shareability_version") != 1
                ):
                    raise DriveSharingError("search_incomplete")
            for recipient in cleaned:
                if not (
                    self._request_recipient_current(connection, user_id, recipient["user_id"])
                    if origin is not None
                    else self._recipient_current(connection, user_id, recipient["user_id"])
                ):
                    raise DriveSharingError("bulk_changed")
            files = list(
                connection.execute(
                    text("""SELECT position,file_digest,metadata_envelope
                FROM drive_owner_search_results WHERE job_id=:job AND user_id=:user
                  AND (:progressive=FALSE OR position=ANY(CAST(:selected AS integer[])))
                ORDER BY position"""),
                    {
                        "job": search,
                        "user": user_id,
                        "progressive": progressive,
                        "selected": selected_positions or [],
                    },
                ).mappings()
            )
            if progressive:
                if (
                    source["matched"] < selected_positions[-1]
                    or [item["position"] for item in files] != selected_positions
                ):
                    raise DriveSharingError("search_incomplete")
            elif len(files) != source["matched"] or [item["position"] for item in files] != list(
                range(1, len(files) + 1)
            ):
                raise DriveSharingError("search_incomplete")
            if positions and any(item > len(files) for item in positions):
                raise DriveSharingError("invalid_argument")
            excluded_set = set(positions)
            if origin is not None:
                for item in files:
                    metadata = self._open(
                        item["metadata_envelope"],
                        user_id=user_id,
                        resource_id=f"{search}:{item['position']}",
                        purpose="owner-search-result",
                    )
                    # Request search is a discovery step, not grant authority.
                    # Only an explicit Drive canShare preflight may enter the
                    # owner review; missing/legacy evidence must fail closed.
                    if metadata.get("shareable") is not True:
                        excluded_set.add(item["position"])
            if progressive and any(item in excluded_set for item in selected_positions):
                raise DriveSharingError("source_not_shareable")
            chosen_files = (
                [item for item in files if item["position"] in selected_positions]
                if progressive
                else [item for item in files if item["position"] not in excluded_set]
            )
            if not chosen_files:
                raise DriveSharingError("no_files")
            if progressive:
                claimed = list(
                    connection.execute(
                        text("""
                    SELECT b.*, f.source_position FROM drive_bulk_share_files f
                    JOIN drive_bulk_shares b ON b.share_id=f.share_id
                    WHERE f.user_id=:user AND f.origin_request_id=:request
                      AND f.source_position=ANY(CAST(:positions AS integer[]))
                    ORDER BY f.source_position
                """),
                        {"user": user_id, "request": origin, "positions": selected_positions},
                    ).mappings()
                )
                if claimed:
                    shares = {item["share_id"] for item in claimed}
                    if len(claimed) == len(selected_positions) and len(shares) == 1:
                        existing_batch = self._row(
                            connection, _ROW, {"share": next(iter(shares)), "user": user_id}
                        )
                        if (
                            existing_batch
                            and existing_batch["request_digest"] == digest
                            and not (
                                existing_batch["approval_source"] == "trusted_auto"
                                and request_row["preparation_error_code"] == "manual_search_active"
                            )
                        ):
                            return self._view(connection, existing_batch)
                    recoverable = (
                        self._recoverable_claims(
                            connection,
                            user_id=user_id,
                            request_id=origin,
                            search_job_id=search,
                            selected_positions=[item["source_position"] for item in claimed],
                            lock=True,
                        )
                        if request_row["preparation_error_code"] == "manual_search_active"
                        else []
                    )
                    if len(recoverable) != len(claimed):
                        raise DriveSharingError("bulk_conflict")
                    for item in recoverable:
                        connection.execute(
                            text("""UPDATE drive_bulk_share_files
                            SET origin_request_id=NULL
                            WHERE share_id=:share AND position=:position
                              AND origin_request_id=:request"""),
                            {
                                "share": item["share_id"],
                                "position": item["position"],
                                "request": origin,
                            },
                        )
                if connection.execute(
                    text("""SELECT EXISTS(
                    SELECT 1 FROM drive_bulk_shares WHERE user_id=:user
                      AND origin_request_id=:request AND progressive_batch=FALSE)"""),
                    {"user": user_id, "request": origin},
                ).scalar_one():
                    raise DriveSharingError("bulk_conflict")
                if self._row(
                    connection,
                    """SELECT share_id FROM drive_bulk_shares
                    WHERE user_id=:user AND origin_request_id=:request
                      AND progressive_batch=TRUE AND status='review_ready'
                      AND expires_at>clock_timestamp() LIMIT 1""",
                    {"user": user_id, "request": origin},
                ):
                    raise DriveSharingError("bulk_conflict")
            review_digest = self.cipher.digest(
                "bulk-share-review-v1",
                [
                    user_id,
                    share,
                    search,
                    source["revision"],
                    current["connection_generation"],
                    [item["file_digest"] for item in chosen_files],
                    [
                        (item["user_id"], item["email"], item["subject"], item["kind"])
                        for item in cleaned
                    ],
                    1,
                ],
            )
            row = self._row(
                connection,
                """INSERT INTO drive_bulk_shares(
                  share_id,user_id,search_job_id,client_request_id,request_digest,
                  connection_generation,search_revision,review_digest,file_count,
                  recipient_count,excluded_envelope,origin_request_id,origin_request_revision,
                  progressive_batch,
                  expires_at)
                  VALUES(:share,:user,:search,:client,:digest,:generation,:revision,:review,
                    :files,:recipients,CAST(:excluded AS jsonb),:origin,:origin_revision,:progressive,
                    COALESCE(:expires,clock_timestamp()+INTERVAL '24 hours')) RETURNING *""",
                {
                    "share": share,
                    "user": user_id,
                    "search": search,
                    "client": client,
                    "digest": digest,
                    "generation": current["connection_generation"],
                    "revision": source["revision"],
                    "review": review_digest,
                    "files": len(chosen_files),
                    "recipients": len(cleaned),
                    "excluded": self._seal_excluded(safe_excluded, user_id=user_id, share_id=share),
                    "origin": origin,
                    "origin_revision": request_row["revision"] if request_row else None,
                    "progressive": progressive,
                    "expires": request_row["expires_at"] if request_row else None,
                },
            )
            connection.execute(
                text("""
                INSERT INTO drive_bulk_share_files(
                  share_id,user_id,position,source_job_id,source_position,file_digest,metadata_envelope,origin_request_id)
                SELECT :share,user_id,
                  CASE WHEN :progressive THEN row_number() OVER (ORDER BY position) ELSE position END,
                  job_id,position,file_digest,metadata_envelope,:origin
                  FROM drive_owner_search_results
                  WHERE job_id=:search AND user_id=:user
                    AND (:progressive=FALSE AND position <> ALL(CAST(:excluded_positions AS integer[]))
                      OR :progressive=TRUE AND position=ANY(CAST(:selected_positions AS integer[])))
                """),
                {
                    "share": share,
                    "search": search,
                    "user": user_id,
                    "excluded_positions": sorted(excluded_set),
                    "selected_positions": selected_positions or [],
                    "progressive": progressive,
                    "origin": origin,
                },
            )
            for recipient in cleaned:
                connection.execute(
                    text("""INSERT INTO drive_bulk_share_recipients(
                      share_id,user_id,recipient_user_id,identity_envelope)
                      VALUES(:share,:user,:recipient,CAST(:envelope AS jsonb))"""),
                    {
                        "share": share,
                        "user": user_id,
                        "recipient": recipient["user_id"],
                        "envelope": self._seal(
                            recipient,
                            user_id=user_id,
                            resource_id=f"{share}:{recipient['user_id']}",
                            purpose="bulk-share-recipient",
                        ),
                    },
                )
            return self._view(connection, row)

        return await self._transaction(operation)

    async def review(self, *, user_id, share_id):
        share = _uuid(share_id)
        return await self._transaction(
            lambda connection: self._view(connection, self._owned(connection, user_id, share))
        )

    async def list(self, *, user_id, search_job_id=None):
        search = _uuid(search_job_id) if search_job_id is not None else None

        def operation(connection):
            rows = connection.execute(
                text("""SELECT * FROM drive_bulk_shares WHERE user_id=:user
                  AND expires_at>clock_timestamp()
                  AND (:search IS NULL OR search_job_id=:search)
                  ORDER BY created_at DESC,share_id DESC LIMIT 20"""),
                {"user": user_id, "search": search},
            ).mappings()
            return {"shares": [self._view(connection, dict(row)) for row in rows]}

        return await self._transaction(operation)

    async def by_request(self, *, user_id, request_id):
        request = _uuid(request_id)

        def operation(connection):
            row = self._row(
                connection,
                """SELECT * FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request
                  AND expires_at>clock_timestamp()
                ORDER BY created_at DESC,share_id DESC LIMIT 1""",
                {"user": user_id, "request": request},
            )
            return self._view(connection, row) if row else None

        return await self._transaction(operation)

    async def batches_by_request(self, *, user_id, request_id):
        request = _uuid(request_id)

        def operation(connection):
            count = connection.execute(
                text("""SELECT count(*) FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request
                  AND expires_at>clock_timestamp()"""),
                {"user": user_id, "request": request},
            ).scalar_one()
            rows = (
                connection.execute(
                    text("""SELECT * FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request
                  AND expires_at>clock_timestamp()
                ORDER BY created_at DESC,share_id DESC LIMIT 25"""),
                    {"user": user_id, "request": request},
                )
                .mappings()
                .all()
            )
            legacy = connection.execute(
                text("""SELECT EXISTS(
                SELECT 1 FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request
                  AND progressive_batch=FALSE)"""),
                {"user": user_id, "request": request},
            ).scalar_one()
            claimed = [
                item
                for (item,) in connection.execute(
                    text("""
                SELECT DISTINCT f.source_position FROM drive_bulk_share_files f
                JOIN drive_bulk_shares b ON b.share_id=f.share_id
                WHERE b.user_id=:user AND b.origin_request_id=:request
                ORDER BY f.source_position LIMIT 10000
            """),
                    {"user": user_id, "request": request},
                ).all()
            ]
            context = self._row(
                connection,
                """SELECT q.preparation_error_code,s.job_id
                FROM drive_share_requests q
                LEFT JOIN drive_owner_search_jobs s ON s.user_id=q.user_id
                  AND s.client_request_id=q.request_id
                WHERE q.user_id=:user AND q.request_id=:request""",
                {"user": user_id, "request": request},
            )
            recoverable = (
                [
                    item["source_position"]
                    for item in self._recoverable_claims(
                        connection,
                        user_id=user_id,
                        request_id=request,
                        search_job_id=context["job_id"],
                    )
                ]
                if context
                and context["preparation_error_code"] == "manual_search_active"
                and context["job_id"] is not None
                else []
            )
            total = connection.execute(
                text("""SELECT count(*) FROM drive_bulk_share_files f
                JOIN drive_bulk_shares b ON b.share_id=f.share_id
                WHERE b.user_id=:user AND b.origin_request_id=:request
                  AND b.expires_at>clock_timestamp()
                  AND (b.progressive_batch=FALSE OR f.origin_request_id=:request)"""),
                {"user": user_id, "request": request},
            ).scalar_one()
            states = dict(
                connection.execute(
                    text("""SELECT e.state,count(*)
                FROM drive_bulk_share_effects e
                JOIN drive_bulk_shares b ON b.share_id=e.share_id
                JOIN drive_bulk_share_files f ON f.share_id=e.share_id
                  AND f.position=e.position
                WHERE b.user_id=:user AND b.origin_request_id=:request
                  AND (b.progressive_batch=FALSE OR f.origin_request_id=:request)
                GROUP BY e.state"""),
                    {"user": user_id, "request": request},
                ).all()
            )
            processed = sum(states.get(state, 0) for state in _TERMINAL)
            aggregate = {
                "total": total,
                "processed": processed,
                "shared": states.get("succeeded", 0),
                "alreadyShared": states.get("preexisting", 0),
                "skipped": states.get("skipped", 0),
                "failed": states.get("failed", 0),
                "needsReview": states.get("present_unattributed", 0) + states.get("absent", 0),
                "unknown": states.get("unknown", 0),
                "pending": max(0, total - processed - states.get("unknown", 0)),
            }
            return {
                "batches": [self._view(connection, dict(row)) for row in rows],
                "batchCount": count,
                "claimedPositions": claimed,
                "recoverablePositions": recoverable,
                "aggregateCounts": aggregate,
                "progressiveAllowed": not legacy,
            }

        return await self._transaction(operation)

    async def unclaimed_positions(self, *, user_id, request_id, limit=25):
        request = _uuid(request_id)
        if type(limit) is not int or not 1 <= limit <= 25:
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            self.live_active(connection, user_id=user_id)
            origin = self._row(
                connection,
                """SELECT * FROM drive_share_requests
                WHERE request_id=:request AND user_id=:user
                  AND expires_at>clock_timestamp()""",
                {"request": request, "user": user_id},
            )
            if origin is None or origin["status"] != "pending":
                raise DriveSharingError("request_changed")
            source = self._row(
                connection,
                """SELECT * FROM drive_owner_search_jobs
                WHERE user_id=:user AND client_request_id=:request
                  AND expires_at>clock_timestamp()""",
                {"request": request, "user": user_id},
            )
            if (
                source is None
                or source["status"] not in {"queued", "running", "completed"}
                or source["incomplete_search"]
            ):
                return []
            checkpoint = self._open(
                source["checkpoint_envelope"],
                user_id=user_id,
                resource_id=str(source["job_id"]),
                purpose="owner-search-checkpoint",
            )
            if (
                checkpoint.get("request_origin_id") != request
                or checkpoint.get("request_revision") != origin["revision"]
                or checkpoint.get("request_shareability_version") != 1
            ):
                raise DriveSharingError("search_incomplete")
            rows = connection.execute(
                text("""SELECT r.position,r.metadata_envelope
                FROM drive_owner_search_results r
                WHERE r.job_id=:job AND r.user_id=:user
                  AND NOT EXISTS (SELECT 1 FROM drive_bulk_share_files f
                    WHERE f.user_id=:user AND f.origin_request_id=:request
                      AND f.source_position=r.position)
                ORDER BY r.position LIMIT 10000"""),
                {"job": source["job_id"], "user": user_id, "request": request},
            ).mappings()
            result = []
            for row in rows:
                metadata = self._open(
                    row["metadata_envelope"],
                    user_id=user_id,
                    resource_id=f"{source['job_id']}:{row['position']}",
                    purpose="owner-search-result",
                )
                if metadata.get("shareable") is True:
                    result.append(row["position"])
                    if len(result) == limit:
                        break
            return result

        return await self._transaction(operation)

    async def pending_request_reviews(self, *, user_id, request_id, limit=8):
        request = _uuid(request_id)
        if type(limit) is not int or not 1 <= limit <= 25:
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            owner = self._row(
                connection,
                """SELECT status FROM drive_share_requests
                WHERE request_id=:request AND user_id=:user
                  AND expires_at>clock_timestamp()""",
                {"request": request, "user": user_id},
            )
            if owner is None or owner["status"] != "pending":
                raise DriveSharingError("request_changed")
            rows = connection.execute(
                text("""SELECT share_id,revision,review_digest
                FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request
                  AND progressive_batch=TRUE AND status='review_ready'
                  AND approved_at IS NULL AND expires_at>clock_timestamp()
                ORDER BY created_at,share_id LIMIT :limit"""),
                {"user": user_id, "request": request, "limit": limit},
            ).mappings()
            return [
                {
                    "shareId": str(row["share_id"]),
                    "revision": row["revision"],
                    "reviewDigest": row["review_digest"],
                }
                for row in rows
            ]

        return await self._transaction(operation)

    def _cursor(self, user_id, share_id, position):
        proof = self.cipher.digest("bulk-share-file-cursor", [user_id, share_id, position])
        return base64.urlsafe_b64encode(f"{position}:{proof}".encode()).decode()

    def _after(self, user_id, share_id, cursor):
        if cursor is None:
            return 0
        try:
            if not isinstance(cursor, str) or len(cursor) > 1024:
                raise ValueError()
            position, proof = (
                base64.b64decode(cursor, altchars=b"-_", validate=True).decode().split(":")
            )
            after = int(position)
            if not 0 <= after <= 10000 or not hmac.compare_digest(
                proof, self.cipher.digest("bulk-share-file-cursor", [user_id, share_id, after])
            ):
                raise ValueError()
            return after
        except (ValueError, UnicodeError):
            raise DriveSharingError("invalid_argument") from None

    def _file(self, row, owner):
        return self._open(
            row["metadata_envelope"],
            user_id=owner,
            resource_id=f"{row['source_job_id']}:{row['source_position']}",
            purpose="owner-search-result",
        )

    async def files(self, *, user_id, share_id, cursor=None, limit=25):
        share = _uuid(share_id)
        if type(limit) is not int or not 1 <= limit <= 25:
            raise DriveSharingError("invalid_argument")
        after = self._after(user_id, share, cursor)

        def operation(connection):
            row = self._owned(connection, user_id, share)
            self.live_active(connection, user_id=user_id, generation=row["connection_generation"])
            items = list(
                connection.execute(
                    text("""SELECT * FROM drive_bulk_share_files
                    WHERE share_id=:share AND user_id=:user AND position>:after
                    ORDER BY position LIMIT :limit"""),
                    {"share": share, "user": user_id, "after": after, "limit": limit + 1},
                ).mappings()
            )
            files = []
            outcomes = {}
            if row["approved_at"] is not None and items:
                for effect in connection.execute(
                    text("""SELECT position,state,safe_error_code
                    FROM drive_bulk_share_effects
                    WHERE share_id=:share AND position>:after AND position<=:last
                    ORDER BY position,recipient_user_id"""),
                    {
                        "share": share,
                        "after": after,
                        "last": items[min(limit, len(items)) - 1]["position"],
                    },
                ).mappings():
                    outcomes.setdefault(effect["position"], []).append(
                        {
                            "status": effect["state"],
                            "reasonCode": safe_bulk_reason(effect["safe_error_code"])
                            if effect["safe_error_code"]
                            and effect["state"] not in {"succeeded", "preexisting"}
                            else None,
                        }
                    )
            for item in items[:limit]:
                metadata = self._file(item, user_id)
                files.append(
                    {
                        "position": item["position"],
                        "name": metadata["name"],
                        "mimeType": metadata["mimeType"],
                        "modifiedTime": metadata.get("modifiedTime"),
                        "openUrl": metadata.get("openUrl"),
                        "outcomes": outcomes.get(item["position"], []),
                    }
                )
            return {
                "shareId": share,
                "files": files,
                "nextCursor": self._cursor(user_id, share, items[limit - 1]["position"])
                if len(items) > limit
                else None,
            }

        return await self._transaction(operation)

    def _assert_no_overlapping_share(self, connection, *, user_id, share, origin=None):
        overlapping = connection.execute(
            text("""
            SELECT EXISTS(
              SELECT 1 FROM drive_bulk_shares other
              WHERE other.user_id=:user AND other.share_id<>:share
                AND other.approved_at IS NOT NULL
                AND NOT (:origin IS NOT NULL AND other.progressive_batch=TRUE
                  AND other.origin_request_id=:origin)
                AND (
                  (other.expires_at>clock_timestamp() AND (
                    other.status IN ('queued','running')
                    OR EXISTS(
                      SELECT 1 FROM drive_bulk_share_effects effect
                      WHERE effect.share_id=other.share_id
                        AND effect.state IN ('queued','dispatching','unknown')
                    )
                  ))
                  OR EXISTS(
                    SELECT 1 FROM drive_bulk_share_effects effect
                    WHERE effect.share_id=other.share_id
                      AND effect.state='dispatching'
                      AND effect.lease_expires_at>clock_timestamp()
                  )
                )
            )
            """),
            {"user": user_id, "share": share, "origin": origin},
        ).scalar_one()
        if overlapping:
            raise DriveSharingError("drive_share_in_progress")

    async def approve(self, *, user_id, share_id, revision, review_digest, approval_source="owner"):
        share = _uuid(share_id)
        if (
            type(revision) is not int
            or revision < 1
            or not isinstance(review_digest, str)
            or not isinstance(approval_source, str)
            or approval_source not in {"owner", "trusted_auto"}
        ):
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            self._gate_graph_for_share(connection, user_id=user_id, share_id=share)
            if not self._owner_grants_enabled(user_id):
                raise DriveSharingError("sharing_unavailable")
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            row = self._owned(connection, user_id, share, locked=True)
            if row["status"] != "review_ready":
                if row["approved_at"] and row["review_digest"] == review_digest:
                    return self._view(connection, row)
                raise DriveSharingError("bulk_changed")
            if row["recipient_count"] == 0:
                raise DriveSharingError("no_recipients")
            if row["revision"] != revision or not hmac.compare_digest(
                row["review_digest"], review_digest
            ):
                raise DriveSharingError("bulk_changed")
            self.live_active(connection, user_id=user_id, generation=row["connection_generation"])
            recipients = self._recipients(connection, row)
            origin = None
            if row["origin_request_id"] is not None:
                origin = self._row(
                    connection,
                    """SELECT * FROM drive_share_requests
                    WHERE request_id=:request AND user_id=:user FOR UPDATE""",
                    {"request": row["origin_request_id"], "user": user_id},
                )
                if (
                    origin is None
                    or origin["status"] != "pending"
                    or origin["revision"] != row["origin_request_revision"]
                    or origin["expires_at"]
                    <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
                ):
                    raise DriveSharingError("request_changed")
                self._require_paid_for_origin(connection, origin["request_id"])
                search = self._row(
                    connection,
                    """SELECT job_id,status,revision,incomplete_search,checkpoint_envelope
                    FROM drive_owner_search_jobs
                    WHERE job_id=:job AND user_id=:user FOR SHARE""",
                    {"job": row["search_job_id"], "user": user_id},
                )
                if (
                    search is None
                    or search["status"]
                    not in (
                        {"queued", "running", "completed"}
                        if row["progressive_batch"]
                        else {"completed"}
                    )
                    or search["incomplete_search"]
                    or (
                        search["revision"] < row["search_revision"]
                        if row["progressive_batch"]
                        else search["revision"] != row["search_revision"]
                    )
                ):
                    raise DriveSharingError("search_incomplete")
                checkpoint = self._open(
                    search["checkpoint_envelope"],
                    user_id=user_id,
                    resource_id=str(search["job_id"]),
                    purpose="owner-search-checkpoint",
                )
                if (
                    checkpoint.get("request_origin_id") != str(origin["request_id"])
                    or checkpoint.get("request_revision") != origin["revision"]
                    or checkpoint.get("request_shareability_version") != 1
                ):
                    raise DriveSharingError("search_incomplete")
            if len(recipients) != row["recipient_count"] or any(
                not (
                    self._request_recipient_current(connection, user_id, item["user_id"])
                    if origin is not None
                    else self._recipient_current(connection, user_id, item["user_id"])
                )
                for item in recipients
            ):
                raise DriveSharingError("bulk_changed")
            if origin is not None and (
                len(recipients) != 1 or recipients[0]["user_id"] != origin["recipient_user_id"]
            ):
                raise DriveSharingError("recipient_changed")
            if approval_source == "trusted_auto":
                if (
                    origin is None
                    or row["progressive_batch"] is not True
                    or origin["preparation_error_code"] == "manual_search_active"
                ):
                    raise DriveSharingError("trusted_request_unavailable")
                private = self._open(
                    origin["request_envelope"],
                    user_id=user_id,
                    resource_id=str(origin["request_id"]),
                    purpose="request",
                )
                if private.get("trusted_auto") is not True:
                    raise DriveSharingError("trusted_request_unavailable")
                from hushh_mcp.services.drive_sharing_store import DriveSharingStore

                try:
                    self.background_current(
                        connection, user_id=user_id, generation=row["connection_generation"]
                    )
                except DriveReadError as error:
                    raise DriveSharingError("trusted_request_unavailable") from error
                if not DriveSharingStore._trusted_recipient_current(
                    connection, user_id, recipients[0]["user_id"]
                ):
                    raise DriveSharingError("trusted_request_unavailable")
            self._assert_no_overlapping_share(
                connection,
                user_id=user_id,
                share=share,
                origin=row["origin_request_id"] if row["progressive_batch"] else None,
            )
            connection.execute(
                text("""
                INSERT INTO drive_bulk_share_effects(
                  share_id,user_id,position,recipient_user_id)
                SELECT :share,:user,f.position,r.recipient_user_id
                  FROM drive_bulk_share_files f
                  CROSS JOIN drive_bulk_share_recipients r
                  WHERE f.share_id=:share AND f.user_id=:user
                    AND r.share_id=:share AND r.user_id=:user
                ON CONFLICT DO NOTHING
                """),
                {"share": share, "user": user_id},
            )
            updated = self._row(
                connection,
                """UPDATE drive_bulk_shares SET status='queued',approved_at=clock_timestamp(),
                approval_source=:approval_source,
                expires_at=GREATEST(expires_at,clock_timestamp()+INTERVAL '7 days'),revision=revision+1,
                updated_at=clock_timestamp() WHERE share_id=:share RETURNING *""",
                {"share": share, "approval_source": approval_source},
            )
            if origin is not None and not row["progressive_batch"]:
                request = origin
                request = self._row(
                    connection,
                    """UPDATE drive_share_requests
                    SET status='approved',updated_at=clock_timestamp()
                    WHERE request_id=:request RETURNING *""",
                    {"request": origin["request_id"]},
                )
                connection.execute(
                    text("""INSERT INTO drive_share_events(
                    event_id,request_id,user_id,revision,event_type)
                    VALUES(:id,:request,:user,:revision,'document_share_decided')
                    ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING"""),
                    {
                        "id": str(uuid4()),
                        "request": origin["request_id"],
                        "user": origin["recipient_user_id"],
                        "revision": request["revision"],
                    },
                )
            return self._view(connection, updated)

        return await self._transaction(operation)

    async def retry(self, *, user_id, share_id, revision, review_digest):
        """Explicitly retry only frozen effects that never reached a provider POST."""
        share = _uuid(share_id)
        if type(revision) is not int or revision < 1 or not isinstance(review_digest, str):
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            self._gate_graph_for_share(connection, user_id=user_id, share_id=share)
            if not self._owner_grants_enabled(user_id):
                raise DriveSharingError("sharing_unavailable")
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            row = self._owned(connection, user_id, share, locked=True)
            if (
                row["status"] not in {"partial", "failed"}
                or row["approved_at"] is None
                or row["revision"] != revision
                or not hmac.compare_digest(row["review_digest"], review_digest)
            ):
                raise DriveSharingError("bulk_changed")
            self.live_active(connection, user_id=user_id, generation=row["connection_generation"])
            self._assert_no_overlapping_share(
                connection,
                user_id=user_id,
                share=share,
                origin=row["origin_request_id"] if row["progressive_batch"] else None,
            )
            origin = None
            if row["origin_request_id"] is not None:
                origin = self._row(
                    connection,
                    """SELECT * FROM drive_share_requests
                WHERE request_id=:request AND user_id=:user FOR UPDATE""",
                    {"request": row["origin_request_id"], "user": user_id},
                )
                if (
                    origin is None
                    or origin["status"] != ("pending" if row["progressive_batch"] else "partial")
                    or origin["revision"] != row["origin_request_revision"]
                    or origin["expires_at"]
                    <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
                ):
                    raise DriveSharingError("request_changed")
            recipients = self._recipients(connection, row)
            if len(recipients) != row["recipient_count"] or any(
                not (
                    self._request_recipient_current(connection, user_id, item["user_id"])
                    if origin is not None
                    else self._recipient_current(connection, user_id, item["user_id"])
                )
                for item in recipients
            ):
                raise DriveSharingError("recipient_changed")
            if origin is not None and (
                len(recipients) != 1 or recipients[0]["user_id"] != origin["recipient_user_id"]
            ):
                raise DriveSharingError("recipient_changed")
            changed = connection.execute(
                text("""UPDATE drive_bulk_share_effects
            SET state='queued',safe_error_code=NULL,attempts=0,next_at=clock_timestamp(),
                updated_at=clock_timestamp()
            WHERE share_id=:share AND state='skipped' AND safe_error_code='provider_unavailable'
              AND receipt_envelope IS NULL AND lease_id IS NULL"""),
                {"share": share},
            ).rowcount
            if not changed:
                raise DriveSharingError("bulk_changed")
            if origin is not None and not row["progressive_batch"]:
                origin = self._row(
                    connection,
                    """UPDATE drive_share_requests
                SET status='approved',revision=revision+1,updated_at=clock_timestamp()
                WHERE request_id=:request RETURNING *""",
                    {"request": origin["request_id"]},
                )
                connection.execute(
                    text("""INSERT INTO drive_share_events(
                event_id,request_id,user_id,revision,event_type)
                VALUES(:id,:request,:user,:revision,'document_share_decided')
                ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING"""),
                    {
                        "id": str(uuid4()),
                        "request": origin["request_id"],
                        "user": origin["recipient_user_id"],
                        "revision": origin["revision"],
                    },
                )
            updated = self._row(
                connection,
                """UPDATE drive_bulk_shares
            SET status='queued',revision=revision+1,origin_request_revision=:origin_revision,
                updated_at=clock_timestamp()
            WHERE share_id=:share RETURNING *""",
                {
                    "share": share,
                    "origin_revision": origin["revision"]
                    if origin
                    else row["origin_request_revision"],
                },
            )
            return self._view(connection, updated)

        return await self._transaction(operation)

    async def stop(self, *, user_id, share_id):
        share = _uuid(share_id)

        def operation(connection):
            self._gate_graph_for_share(connection, user_id=user_id, share_id=share)
            row = self._owned(connection, user_id, share, locked=True)
            if row["status"] in {"stopped", "completed", "partial", "failed"}:
                return self._view(connection, row)
            # An in-flight POST may still settle. Never erase its lease or claim
            # success; only queued effects are suppressed immediately.
            connection.execute(
                text("""UPDATE drive_bulk_share_effects SET state='skipped',
                  safe_error_code='stopped',updated_at=clock_timestamp()
                  WHERE share_id=:share AND state='queued'"""),
                {"share": share},
            )
            updated = self._row(
                connection,
                """UPDATE drive_bulk_shares SET status='stopped',stopped_at=clock_timestamp(),
                  revision=revision+1,updated_at=clock_timestamp()
                  WHERE share_id=:share RETURNING *""",
                {"share": share},
            )
            self._finalize(connection, share)
            return self._view(connection, updated)

        return await self._transaction(operation)

    def _queue_notices(self, connection, share):
        # A recipient receives one generic notification only after all their
        # effects are terminal and at least one file is confirmed accessible.
        parent = self._row(
            connection,
            """SELECT user_id,origin_request_id,progressive_batch
            FROM drive_bulk_shares WHERE share_id=:share""",
            {"share": share},
        )
        if parent and parent["progressive_batch"] and parent["origin_request_id"] is not None:
            # The existing request event is both the Feed row and push outbox.
            # It is emitted only once Google has confirmed access, never when
            # a batch is merely queued. No second per-batch push is created.
            confirmed = connection.execute(
                text("""SELECT EXISTS(
                SELECT 1 FROM drive_bulk_share_effects
                WHERE share_id=:share AND state IN ('succeeded','preexisting'))"""),
                {"share": share},
            ).scalar_one()
            if confirmed:
                request = self._row(
                    connection,
                    """SELECT request_id,recipient_user_id,revision
                    FROM drive_share_requests WHERE request_id=:request FOR UPDATE""",
                    {"request": parent["origin_request_id"]},
                )
                if request:
                    connection.execute(
                        text("""INSERT INTO drive_share_events(
                        event_id,request_id,user_id,revision,event_type)
                        VALUES(:id,:request,:user,:revision,'document_share_decided')
                        ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING"""),
                        {
                            "id": str(uuid4()),
                            "request": request["request_id"],
                            "user": request["recipient_user_id"],
                            "revision": request["revision"],
                        },
                    )
            return
        connection.execute(
            text("""
            INSERT INTO drive_bulk_share_notifications(share_id,user_id,recipient_user_id)
            SELECT r.share_id,r.user_id,r.recipient_user_id
            FROM drive_bulk_share_recipients r
            WHERE r.share_id=:share
              AND EXISTS(SELECT 1 FROM drive_bulk_share_effects e
                WHERE e.share_id=r.share_id AND e.recipient_user_id=r.recipient_user_id
                  AND e.state IN ('succeeded','preexisting'))
              AND NOT EXISTS(SELECT 1 FROM drive_bulk_share_effects e
                WHERE e.share_id=r.share_id AND e.recipient_user_id=r.recipient_user_id
                  AND e.state IN ('queued','dispatching','unknown'))
            ON CONFLICT DO NOTHING
            """),
            {"share": share},
        )

    def _finalize(self, connection, share):
        self._queue_notices(connection, share)
        row = self._row(
            connection,
            "SELECT status FROM drive_bulk_shares WHERE share_id=:share FOR UPDATE",
            {"share": share},
        )
        if not row or row["status"] in {
            "review_ready",
            "completed",
            "partial",
            "failed",
        }:
            return
        states = dict(
            connection.execute(
                text(
                    "SELECT state,count(*) AS n FROM drive_bulk_share_effects WHERE share_id=:share GROUP BY state"
                ),
                {"share": share},
            ).all()
        )
        if any(states.get(state, 0) for state in ("queued", "dispatching", "unknown")):
            return
        successes = states.get("succeeded", 0) + states.get("preexisting", 0)
        errors = sum(
            states.get(state, 0)
            for state in ("failed", "skipped", "present_unattributed", "absent")
        )
        status = "partial" if successes and errors else "failed" if errors else "completed"
        if row["status"] != "stopped":
            connection.execute(
                text("""UPDATE drive_bulk_shares SET status=:status,revision=revision+1,
                  updated_at=clock_timestamp(),expires_at=GREATEST(expires_at,clock_timestamp()+INTERVAL '7 days')
                  WHERE share_id=:share"""),
                {"share": share, "status": status},
            )
        # Stop suppresses queued writes, but in-flight effects still settle.
        # Once all effects are terminal, the originating request must leave
        # approved and emit its final outcome even when the bulk job is stopped.
        origin = self._row(
            connection,
            "SELECT origin_request_id,progressive_batch FROM drive_bulk_shares WHERE share_id=:share",
            {"share": share},
        )
        if origin and origin["origin_request_id"] is not None:
            if origin["progressive_batch"]:
                self._finalize_progressive_request(connection, origin["origin_request_id"])
                return
            request_status = "completed" if status == "completed" else "partial"
            updated_request = self._row(
                connection,
                """UPDATE drive_share_requests
                SET status=:status,updated_at=clock_timestamp()
                WHERE request_id=:request AND status='approved' RETURNING *""",
                {"status": request_status, "request": origin["origin_request_id"]},
            )
            if updated_request:
                for audience in (updated_request["user_id"], updated_request["recipient_user_id"]):
                    connection.execute(
                        text("""INSERT INTO drive_share_events(
                      event_id,request_id,user_id,revision,event_type)
                      VALUES(:id,:request,:user,:revision,'document_share_outcome')
                      ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING"""),
                        {
                            "id": str(uuid4()),
                            "request": updated_request["request_id"],
                            "user": audience,
                            "revision": updated_request["revision"],
                        },
                    )

    def _finalize_progressive_request(self, connection, request_id):
        """Keep an unfinished search or unreviewed file visible and actionable."""
        request = self._row(
            connection,
            """SELECT * FROM drive_share_requests
            WHERE request_id=:request FOR UPDATE""",
            {"request": request_id},
        )
        if request is None or request["status"] != "pending":
            return
        source = self._row(
            connection,
            """SELECT * FROM drive_owner_search_jobs
            WHERE user_id=:user AND client_request_id=:request""",
            {"user": request["user_id"], "request": request_id},
        )
        if source is None or source["status"] != "completed" or source["incomplete_search"]:
            return
        legacy = connection.execute(
            text("""SELECT EXISTS(SELECT 1 FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request
                  AND progressive_batch=FALSE)"""),
            {"user": request["user_id"], "request": request_id},
        ).scalar_one()
        if legacy:
            # A frozen pre-upgrade review retains its original approval path.
            return
        unfinished = connection.execute(
            text("""SELECT EXISTS(
            SELECT 1 FROM drive_bulk_shares b
            WHERE b.origin_request_id=:request AND b.user_id=:user
              AND b.progressive_batch=TRUE
              AND (b.status='review_ready' OR b.status IN ('queued','running')
                OR EXISTS(SELECT 1 FROM drive_bulk_share_effects e
                  WHERE e.share_id=b.share_id AND e.state IN ('queued','dispatching','unknown')))
        )"""),
            {"request": request_id, "user": request["user_id"]},
        ).scalar_one()
        if unfinished:
            return
        if self._recoverable_claims(
            connection,
            user_id=request["user_id"],
            request_id=request_id,
            search_job_id=source["job_id"],
        ):
            # An auto batch was skipped before any provider POST. Keep the
            # request actionable so the owner can explicitly review it.
            return
        remaining = connection.execute(
            text("""SELECT r.position,r.metadata_envelope
            FROM drive_owner_search_results r
            WHERE r.job_id=:job AND r.user_id=:user
              AND NOT EXISTS(SELECT 1 FROM drive_bulk_share_files f
                WHERE f.user_id=:user AND f.origin_request_id=:request
                  AND f.source_position=r.position)
            ORDER BY r.position LIMIT 10000"""),
            {"job": source["job_id"], "user": request["user_id"], "request": request_id},
        ).mappings()
        for file in remaining:
            metadata = self._open(
                file["metadata_envelope"],
                user_id=request["user_id"],
                resource_id=f"{source['job_id']}:{file['position']}",
                purpose="owner-search-result",
            )
            if metadata.get("shareable") is True:
                return
        states = dict(
            connection.execute(
                text("""SELECT e.state,count(*)
            FROM drive_bulk_share_effects e
            JOIN drive_bulk_shares b ON b.share_id=e.share_id
            JOIN drive_bulk_share_files f ON f.share_id=e.share_id
              AND f.position=e.position AND f.origin_request_id=:request
            WHERE b.origin_request_id=:request AND b.user_id=:user
              AND b.progressive_batch=TRUE AND b.approved_at IS NOT NULL
            GROUP BY e.state"""),
                {"request": request_id, "user": request["user_id"]},
            ).all()
        )
        successes = states.get("succeeded", 0) + states.get("preexisting", 0)
        errors = sum(
            states.get(state, 0)
            for state in ("failed", "skipped", "present_unattributed", "absent")
        )
        outcome = "completed" if successes and not errors else "partial"
        updated = self._row(
            connection,
            """UPDATE drive_share_requests
            SET status=:status,updated_at=clock_timestamp()
            WHERE request_id=:request AND status='pending' RETURNING *""",
            {"status": outcome, "request": request_id},
        )
        if updated:
            for audience in (updated["user_id"], updated["recipient_user_id"]):
                connection.execute(
                    text("""INSERT INTO drive_share_events(
                    event_id,request_id,user_id,revision,event_type)
                    VALUES(:id,:request,:user,:revision,'document_share_outcome')
                    ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING"""),
                    {
                        "id": str(uuid4()),
                        "request": request_id,
                        "user": audience,
                        "revision": updated["revision"],
                    },
                )

    async def refresh_request(self, *, user_id, request_id):
        request = _uuid(request_id)

        def operation(connection):
            self._gate_graph_for_request(connection, user_id=user_id, request_id=request)
            owner = self._row(
                connection,
                """SELECT user_id FROM drive_share_requests
                WHERE request_id=:request AND user_id=:user""",
                {"request": request, "user": user_id},
            )
            if owner is None:
                raise DriveSharingError("request_unavailable")
            self._finalize_progressive_request(connection, request)

        await self._transaction(operation)

    async def due(self, limit=400):
        if type(limit) is not int or not 1 <= limit <= 500:
            raise ValueError("invalid bulk worker bound")

        def operation(connection):
            return [
                dict(item)
                for item in connection.execute(
                    text("""
                    WITH due AS (
                      SELECT e.share_id,e.position,e.recipient_user_id
                      FROM drive_bulk_share_effects e
                      JOIN drive_bulk_shares b ON b.share_id=e.share_id
                      WHERE e.state IN ('queued','dispatching','unknown')
                        AND (e.state<>'queued' OR b.status IN ('queued','running'))
                        AND e.next_at<=clock_timestamp()
                        AND (e.lease_id IS NULL OR e.lease_expires_at<=clock_timestamp())
                        AND b.expires_at>clock_timestamp()
                      ORDER BY e.inspected_at,e.share_id,e.position,e.recipient_user_id
                      LIMIT :limit FOR UPDATE OF e SKIP LOCKED
                    )
                    UPDATE drive_bulk_share_effects e SET inspected_at=clock_timestamp()
                    FROM due WHERE e.share_id=due.share_id AND e.position=due.position
                      AND e.recipient_user_id=due.recipient_user_id
                    RETURNING e.share_id,e.user_id,e.position,e.recipient_user_id,e.state
                    """),
                    {"limit": limit},
                ).mappings()
            ]

        return await self._transaction(operation)

    async def claim(self, *, user_id, share_id, position, recipient_user_id):
        share = _uuid(share_id)
        if type(position) is not int or not 1 <= position <= 10000:
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            self._gate_graph_for_share(connection, user_id=user_id, share_id=share)
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            row = self._owned(connection, user_id, share, locked=True, unexpired=False)
            if row["origin_request_id"] is not None:
                # A dispatcher takes the order before the effect. Claims must
                # follow that order too, including reconciliation claims, so a
                # concurrent webhook or account erasure cannot form a cycle.
                origin = self._row(
                    connection,
                    "SELECT request_id FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
                    {"request": row["origin_request_id"]},
                )
                if origin is None:
                    raise DriveSharingError("request_unavailable")
                connection.execute(
                    text(
                        "SELECT request_id FROM drive_request_payment_orders "
                        "WHERE request_id=:request FOR SHARE"
                    ),
                    {"request": row["origin_request_id"]},
                )
            effect = self._row(
                connection,
                """SELECT * FROM drive_bulk_share_effects WHERE share_id=:share
                  AND position=:position AND recipient_user_id=:recipient FOR UPDATE""",
                {"share": share, "position": position, "recipient": recipient_user_id},
            )
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                not effect
                or effect["state"] not in {"queued", "dispatching", "unknown"}
                or effect["next_at"] > now
                or effect["lease_expires_at"] is not None
                and effect["lease_expires_at"] > now
            ):
                return None
            if effect["state"] == "queued" and (
                row["status"] not in _ACTIVE or row["expires_at"] <= now
            ):
                connection.execute(
                    text("""UPDATE drive_bulk_share_effects SET state='skipped',
                    safe_error_code='stopped',updated_at=clock_timestamp()
                    WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                    {"share": share, "position": position, "recipient": recipient_user_id},
                )
                self._finalize(connection, share)
                return None
            if effect["state"] == "queued" and not self._owner_grants_enabled(user_id):
                connection.execute(
                    text("""UPDATE drive_bulk_share_effects SET state='skipped',
                    safe_error_code='sharing_unavailable',updated_at=clock_timestamp()
                    WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                    {"share": share, "position": position, "recipient": recipient_user_id},
                )
                self._finalize(connection, share)
                return None
            if effect["state"] == "queued":
                self._require_paid_for_origin(connection, row["origin_request_id"])
            try:
                self.live_active(
                    connection, user_id=user_id, generation=row["connection_generation"]
                )
            except DriveReadError:
                connection.execute(
                    text("""UPDATE drive_bulk_share_effects SET state=:state,
                    safe_error_code='connection_changed',lease_id=NULL,lease_expires_at=NULL,
                    updated_at=clock_timestamp()
                    WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                    {
                        "share": share,
                        "position": position,
                        "recipient": recipient_user_id,
                        "state": "failed" if effect["state"] != "queued" else "skipped",
                    },
                )
                self._finalize(connection, share)
                return None
            if effect["state"] == "queued" and not self._share_recipient_current(
                connection, row, user_id, recipient_user_id
            ):
                connection.execute(
                    text("""UPDATE drive_bulk_share_effects SET state='skipped',
                    safe_error_code='recipient_changed',updated_at=clock_timestamp()
                    WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                    {"share": share, "position": position, "recipient": recipient_user_id},
                )
                self._finalize(connection, share)
                return None
            if effect["state"] == "queued" and effect["attempts"] >= 5:
                connection.execute(
                    text("""UPDATE drive_bulk_share_effects SET state='failed',
                    safe_error_code='retry_limit',updated_at=clock_timestamp()
                    WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                    {"share": share, "position": position, "recipient": recipient_user_id},
                )
                self._finalize(connection, share)
                return None
            lease = str(uuid4())
            connection.execute(
                text("""UPDATE drive_bulk_share_effects
                  SET lease_id=:lease,lease_expires_at=clock_timestamp()+INTERVAL '120 seconds',
                    attempts=LEAST(attempts+1,5),updated_at=clock_timestamp()
                  WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                {
                    "lease": lease,
                    "share": share,
                    "position": position,
                    "recipient": recipient_user_id,
                },
            )
            if row["status"] == "queued":
                connection.execute(
                    text("""UPDATE drive_bulk_shares SET status='running',revision=revision+1,
                    updated_at=clock_timestamp() WHERE share_id=:share"""),
                    {"share": share},
                )
            file_row = self._row(
                connection,
                "SELECT * FROM drive_bulk_share_files WHERE share_id=:share AND position=:position",
                {"share": share, "position": position},
            )
            recipient_row = self._row(
                connection,
                "SELECT * FROM drive_bulk_share_recipients WHERE share_id=:share AND recipient_user_id=:recipient",
                {"share": share, "recipient": recipient_user_id},
            )
            if file_row is None or recipient_row is None:
                raise DriveSharingError("bulk_changed")
            return {
                "share_id": share,
                "user_id": user_id,
                "position": position,
                "recipient_user_id": recipient_user_id,
                "generation": row["connection_generation"],
                "state": effect["state"],
                "lease_id": lease,
                "attempts": effect["attempts"] + 1,
                "file": self._file(file_row, user_id),
                "recipient": self._open(
                    recipient_row["identity_envelope"],
                    user_id=user_id,
                    resource_id=f"{share}:{recipient_user_id}",
                    purpose="bulk-share-recipient",
                ),
            }

        return await self._transaction(operation)

    def _effect_current(self, connection, job, *, reconcile=False):
        if not reconcile and not self._owner_grants_enabled(job["user_id"]):
            raise DriveSharingError("sharing_unavailable")
        self.live_active(connection, user_id=job["user_id"], generation=job["generation"])
        share = self._owned(connection, job["user_id"], job["share_id"], unexpired=False)
        if not reconcile:
            self._require_paid_for_origin(connection, share["origin_request_id"])
        effect = self._row(
            connection,
            """SELECT * FROM drive_bulk_share_effects WHERE share_id=:share
            AND position=:position AND recipient_user_id=:recipient""",
            {
                "share": job["share_id"],
                "position": job["position"],
                "recipient": job["recipient_user_id"],
            },
        )
        if (
            effect is None
            or str(effect["lease_id"]) != job["lease_id"]
            or effect["lease_expires_at"] is None
            or effect["lease_expires_at"] <= datetime.now(UTC)
            or effect["state"]
            not in ({"dispatching", "unknown"} if reconcile else {"queued", "dispatching"})
            or not reconcile
            and (
                share["status"] not in _ACTIVE
                or share["expires_at"] <= datetime.now(UTC)
                or not self._share_recipient_current(
                    connection, share, job["user_id"], job["recipient_user_id"]
                )
            )
        ):
            raise DriveSharingError("bulk_changed")
        return effect

    async def require_current(self, job):
        await self._transaction(lambda connection: self._effect_current(connection, job))

    async def require_reconciliation_current(self, job):
        await self._transaction(
            lambda connection: self._effect_current(connection, job, reconcile=True)
        )

    async def mark_dispatching(self, job):
        def operation(connection):
            # Stop/settle hold the share before touching an effect. A payment
            # webhook or refund holds request then order. Take share→request
            # first so all three paths serialize before a provider POST.
            self._lock(connection, {"user_id": job["user_id"], "connector_id": "google_drive"})
            share = self._owned(
                connection, job["user_id"], job["share_id"], locked=True, unexpired=False
            )
            if share["origin_request_id"] is not None:
                origin = self._row(
                    connection,
                    "SELECT request_id FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
                    {"request": share["origin_request_id"]},
                )
                if origin is None:
                    raise DriveSharingError("request_unavailable")
            self._effect_current(connection, job)
            connection.execute(
                text("""UPDATE drive_bulk_share_effects SET state='dispatching',
                updated_at=clock_timestamp() WHERE share_id=:share AND position=:position
                AND recipient_user_id=:recipient AND lease_id=:lease"""),
                {
                    "share": job["share_id"],
                    "position": job["position"],
                    "recipient": job["recipient_user_id"],
                    "lease": job["lease_id"],
                },
            )

        await self._transaction(operation)

    async def settle(self, job, *, state, safe_error_code=None, receipt=None):
        if state not in _TERMINAL:
            raise ValueError("invalid bulk effect state")

        def operation(connection):
            self._gate_graph_for_share(connection, user_id=job["user_id"], share_id=job["share_id"])
            # Parent-before-effect matches Stop/claim/retry and prevents an
            # effect receipt racing Stop from forming a lock cycle.
            self._owned(connection, job["user_id"], job["share_id"], locked=True, unexpired=False)
            effect = self._row(
                connection,
                """SELECT * FROM drive_bulk_share_effects WHERE share_id=:share
                AND position=:position AND recipient_user_id=:recipient FOR UPDATE""",
                {
                    "share": job["share_id"],
                    "position": job["position"],
                    "recipient": job["recipient_user_id"],
                },
            )
            if effect is None or str(effect["lease_id"]) != job["lease_id"]:
                return False
            envelope = (
                self._seal(
                    receipt,
                    user_id=job["user_id"],
                    resource_id=f"{job['share_id']}:{job['position']}:{job['recipient_user_id']}",
                    purpose="bulk-share-receipt",
                )
                if receipt is not None
                else None
            )
            connection.execute(
                text("""UPDATE drive_bulk_share_effects SET state=:state,
                  safe_error_code=:code,receipt_envelope=CAST(:receipt AS jsonb),
                  lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
                  WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                {
                    "share": job["share_id"],
                    "position": job["position"],
                    "recipient": job["recipient_user_id"],
                    "state": state,
                    "code": safe_error_code,
                    "receipt": envelope,
                },
            )
            connection.execute(
                text("""UPDATE drive_bulk_shares SET revision=revision+1,
                  updated_at=clock_timestamp(),
                  expires_at=GREATEST(expires_at,clock_timestamp()+INTERVAL '7 days')
                  WHERE share_id=:share"""),
                {"share": job["share_id"]},
            )
            self._finalize(connection, job["share_id"])
            return True

        return await self._transaction(operation)

    async def release(self, job, *, error, retryable=False, uncertain=False):
        """A possible POST is reconciled by GET and is never automatically retried."""
        if error not in {
            "provider_unavailable",
            "permission_rejected",
            "source_changed",
            "source_not_shareable",
            "recipient_changed",
            "connection_changed",
            "stopped",
            "permission_outcome_unknown",
            "permission_catalog_incomplete",
        }:
            error = "provider_unavailable"

        def operation(connection):
            self._gate_graph_for_share(connection, user_id=job["user_id"], share_id=job["share_id"])
            parent = self._owned(
                connection, job["user_id"], job["share_id"], locked=True, unexpired=False
            )
            effect = self._row(
                connection,
                """SELECT * FROM drive_bulk_share_effects WHERE share_id=:share
                AND position=:position AND recipient_user_id=:recipient FOR UPDATE""",
                {
                    "share": job["share_id"],
                    "position": job["position"],
                    "recipient": job["recipient_user_id"],
                },
            )
            if effect is None or str(effect["lease_id"]) != job["lease_id"]:
                return "superseded"
            if (
                uncertain
                or effect["state"] == "dispatching"
                and error == "permission_outcome_unknown"
            ):
                state = "unknown" if effect["attempts"] < 5 else "failed"
            elif retryable and effect["attempts"] < 5 and parent["status"] in _ACTIVE:
                state = "queued"
            else:
                state = "failed" if effect["state"] != "queued" else "skipped"
            delay = (
                min(120, 2 ** max(1, effect["attempts"]))
                if state == "queued"
                else 30
                if state == "unknown"
                else 0
            )
            connection.execute(
                text("""UPDATE drive_bulk_share_effects SET state=:state,
                  safe_error_code=:code,next_at=clock_timestamp()+(:delay * INTERVAL '1 second'),
                  lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
                  WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                {
                    "share": job["share_id"],
                    "position": job["position"],
                    "recipient": job["recipient_user_id"],
                    "state": state,
                    "code": error,
                    "delay": delay,
                },
            )
            connection.execute(
                text("""UPDATE drive_bulk_shares SET revision=revision+1,
                  updated_at=clock_timestamp(),expires_at=GREATEST(
                    expires_at,clock_timestamp()+INTERVAL '7 days')
                  WHERE share_id=:share"""),
                {"share": job["share_id"]},
            )
            self._finalize(connection, job["share_id"])
            return state

        return await self._transaction(operation)

    def _recipient_identity_current(
        self, connection, *, share_id, recipient_user_id, recipient_subject, recipient_email
    ):
        item = self._row(
            connection,
            """SELECT b.user_id,r.identity_envelope FROM drive_bulk_shares b
            JOIN drive_bulk_share_recipients r ON r.share_id=b.share_id
            WHERE b.share_id=:share AND r.recipient_user_id=:recipient
              AND b.expires_at>clock_timestamp()""",
            {"share": share_id, "recipient": recipient_user_id},
        )
        if item is None:
            raise DriveSharingError("bulk_not_found")
        identity = self._open(
            item["identity_envelope"],
            user_id=item["user_id"],
            resource_id=f"{share_id}:{recipient_user_id}",
            purpose="bulk-share-recipient",
        )
        if (
            identity["user_id"] != recipient_user_id
            or not hmac.compare_digest(identity["subject"], recipient_subject)
            or not hmac.compare_digest(identity["email"].casefold(), recipient_email.casefold())
        ):
            raise DriveSharingError("recipient_changed")
        return item["user_id"]

    async def inbox(self, *, recipient_user_id, recipient_subject, recipient_email):
        def operation(connection):
            rows = list(
                connection.execute(
                    text("""
                    SELECT DISTINCT b.* FROM drive_bulk_shares b
                    JOIN drive_bulk_share_recipients r ON r.share_id=b.share_id
                    WHERE r.recipient_user_id=:recipient
                      AND b.expires_at>clock_timestamp()
                      AND EXISTS(SELECT 1 FROM drive_bulk_share_effects e
                        WHERE e.share_id=b.share_id
                          AND e.recipient_user_id=:recipient
                          AND e.state IN ('succeeded','preexisting'))
                    ORDER BY b.created_at DESC,b.share_id DESC LIMIT 20
                    """),
                    {"recipient": recipient_user_id},
                ).mappings()
            )
            shares = []
            for row in rows:
                try:
                    self._require_paid_for_origin(connection, row["origin_request_id"])
                except DriveSharingError as error:
                    if str(error) != "payment_required":
                        raise
                    continue
                try:
                    self._recipient_identity_current(
                        connection,
                        share_id=str(row["share_id"]),
                        recipient_user_id=recipient_user_id,
                        recipient_subject=recipient_subject,
                        recipient_email=recipient_email,
                    )
                except DriveSharingError as error:
                    # One stale identity must not hide other collections;
                    # every other authority/decryption failure stays visible.
                    if str(error) != "recipient_changed":
                        raise
                    continue
                count = connection.execute(
                    text("""SELECT count(*) FROM drive_bulk_share_effects
                    WHERE share_id=:share AND recipient_user_id=:recipient
                      AND state IN ('succeeded','preexisting')"""),
                    {"share": row["share_id"], "recipient": recipient_user_id},
                ).scalar_one()
                shares.append(
                    {
                        "shareId": str(row["share_id"]),
                        "status": row["status"],
                        "sharedCount": count,
                        "createdAt": row["created_at"].isoformat(),
                        "updatedAt": row["updated_at"].isoformat(),
                    }
                )
            return {"shares": shares}

        return await self._transaction(operation)

    async def recipient_files(
        self,
        *,
        recipient_user_id,
        recipient_subject,
        recipient_email,
        share_id,
        cursor=None,
        limit=25,
    ):
        share = _uuid(share_id)
        if type(limit) is not int or not 1 <= limit <= 25:
            raise DriveSharingError("invalid_argument")
        after = self._after(recipient_user_id, share, cursor)

        def operation(connection):
            owner = self._recipient_identity_current(
                connection,
                share_id=share,
                recipient_user_id=recipient_user_id,
                recipient_subject=recipient_subject,
                recipient_email=recipient_email,
            )
            origin = self._row(
                connection,
                "SELECT origin_request_id FROM drive_bulk_shares WHERE share_id=:share",
                {"share": share},
            )
            self._require_paid_for_origin(
                connection, origin["origin_request_id"] if origin else None
            )
            count = connection.execute(
                text("""SELECT count(*) FROM drive_bulk_share_effects
                WHERE share_id=:share AND recipient_user_id=:recipient
                  AND state IN ('succeeded','preexisting')"""),
                {"share": share, "recipient": recipient_user_id},
            ).scalar_one()
            if count == 0:
                request_share = self._row(
                    connection,
                    "SELECT origin_request_id,approved_at FROM drive_bulk_shares WHERE share_id=:share",
                    {"share": share},
                )
                if (
                    request_share
                    and request_share["origin_request_id"] is not None
                    and request_share["approved_at"] is not None
                ):
                    return {"shareId": share, "files": [], "sharedCount": 0, "nextCursor": None}
                raise DriveSharingError("bulk_not_found")
            rows = list(
                connection.execute(
                    text("""
                    SELECT f.*,e.state AS grant_state FROM drive_bulk_share_files f
                    JOIN drive_bulk_share_effects e
                      ON e.share_id=f.share_id AND e.position=f.position
                    WHERE f.share_id=:share AND e.recipient_user_id=:recipient
                      AND e.state IN ('succeeded','preexisting') AND f.position>:after
                    ORDER BY f.position LIMIT :limit
                    """),
                    {
                        "share": share,
                        "recipient": recipient_user_id,
                        "after": after,
                        "limit": limit + 1,
                    },
                ).mappings()
            )
            files = []
            for row in rows[:limit]:
                metadata = self._file(row, owner)
                file_id = metadata.get("id")
                if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
                    raise DriveSharingError("sharing_storage_unavailable")
                files.append(
                    {
                        "name": metadata["name"],
                        "status": row["grant_state"],
                        "openUrl": f"https://drive.google.com/file/d/{file_id}/view",
                        "modifiedTime": metadata.get("modifiedTime"),
                    }
                )
            return {
                "shareId": share,
                "files": files,
                "sharedCount": count,
                "nextCursor": self._cursor(recipient_user_id, share, rows[limit - 1]["position"])
                if len(rows) > limit
                else None,
            }

        return await self._transaction(operation)

    def _request_file_cursor(self, recipient, request, row):
        stamp = row["settled_at"].isoformat()
        share = str(row["share_id"])
        position = row["position"]
        proof = self.cipher.digest(
            "bulk-request-file-cursor", [recipient, request, stamp, share, position]
        )
        return base64.urlsafe_b64encode(f"{stamp}|{share}|{position}|{proof}".encode()).decode()

    def _request_file_after(self, recipient, request, cursor):
        if cursor is None:
            return None
        try:
            if not isinstance(cursor, str) or len(cursor) > 1024:
                raise ValueError()
            stamp, share, position_text, proof = (
                base64.b64decode(cursor, altchars=b"-_", validate=True).decode().split("|")
            )
            timestamp = datetime.fromisoformat(stamp)
            position = int(position_text)
            if (
                timestamp.tzinfo is None
                or str(UUID(share)) != share
                or not 1 <= position <= 10000
                or not hmac.compare_digest(
                    proof,
                    self.cipher.digest(
                        "bulk-request-file-cursor", [recipient, request, stamp, share, position]
                    ),
                )
            ):
                raise ValueError()
            return timestamp, share, position
        except (ValueError, UnicodeError):
            raise DriveSharingError("invalid_argument") from None

    async def recipient_request_files(
        self,
        *,
        recipient_user_id,
        recipient_subject,
        recipient_email,
        request_id,
        cursor=None,
        limit=25,
    ):
        request = _uuid(request_id)
        if type(limit) is not int or not 1 <= limit <= 25:
            raise DriveSharingError("invalid_argument")
        after = self._request_file_after(recipient_user_id, request, cursor)

        def operation(connection):
            latest = self._row(
                connection,
                """SELECT b.share_id FROM drive_bulk_shares b
                JOIN drive_share_requests q ON q.request_id=b.origin_request_id
                WHERE b.origin_request_id=:request AND q.recipient_user_id=:recipient
                  AND b.approved_at IS NOT NULL AND b.expires_at>clock_timestamp()
                ORDER BY b.created_at DESC,b.share_id DESC LIMIT 1""",
                {"request": request, "recipient": recipient_user_id},
            )
            if latest is None:
                raise DriveSharingError("bulk_not_found")
            self._require_paid_for_origin(connection, request)
            count = connection.execute(
                text("""SELECT count(*)
                FROM drive_bulk_share_effects e
                JOIN drive_bulk_shares b ON b.share_id=e.share_id
                WHERE b.origin_request_id=:request AND b.approved_at IS NOT NULL
                  AND b.expires_at>clock_timestamp()
                  AND e.recipient_user_id=:recipient
                  AND e.state IN ('succeeded','preexisting')"""),
                {"request": request, "recipient": recipient_user_id},
            ).scalar_one()
            rows = (
                connection.execute(
                    text("""SELECT f.*,e.state AS grant_state,
                    e.updated_at AS settled_at,b.user_id AS owner_user_id,
                    r.identity_envelope
                FROM drive_bulk_share_files f
                JOIN drive_bulk_shares b ON b.share_id=f.share_id
                JOIN drive_bulk_share_effects e
                  ON e.share_id=f.share_id AND e.position=f.position
                JOIN drive_bulk_share_recipients r
                  ON r.share_id=f.share_id AND r.recipient_user_id=e.recipient_user_id
                WHERE b.origin_request_id=:request AND b.approved_at IS NOT NULL
                  AND b.expires_at>clock_timestamp()
                  AND e.recipient_user_id=:recipient
                  AND e.state IN ('succeeded','preexisting')
                  AND (CAST(:after_at AS timestamptz) IS NULL OR (e.updated_at,b.share_id,f.position)
                    > (CAST(:after_at AS timestamptz),CAST(:after_share AS uuid),:after_position))
                ORDER BY e.updated_at,b.share_id,f.position LIMIT :limit"""),
                    {
                        "request": request,
                        "recipient": recipient_user_id,
                        "after_at": after[0] if after else None,
                        "after_share": after[1] if after else None,
                        "after_position": after[2] if after else None,
                        "limit": limit + 1,
                    },
                )
                .mappings()
                .all()
            )
            files = []
            for row in rows[:limit]:
                identity = self._open(
                    row["identity_envelope"],
                    user_id=row["owner_user_id"],
                    resource_id=f"{row['share_id']}:{recipient_user_id}",
                    purpose="bulk-share-recipient",
                )
                if (
                    identity.get("user_id") != recipient_user_id
                    or not hmac.compare_digest(identity.get("subject", ""), recipient_subject)
                    or not hmac.compare_digest(
                        identity.get("email", "").casefold(), recipient_email.casefold()
                    )
                ):
                    raise DriveSharingError("recipient_changed")
                metadata = self._file(row, row["owner_user_id"])
                file_id = metadata.get("id")
                if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
                    raise DriveSharingError("sharing_storage_unavailable")
                files.append(
                    {
                        "name": metadata["name"],
                        "status": row["grant_state"],
                        "openUrl": f"https://drive.google.com/file/d/{file_id}/view",
                        "modifiedTime": metadata.get("modifiedTime"),
                    }
                )
            return {
                "shareId": str(latest["share_id"]),
                "files": files,
                "sharedCount": count,
                "nextCursor": self._request_file_cursor(recipient_user_id, request, rows[limit - 1])
                if len(rows) > limit
                else None,
            }

        return await self._transaction(operation)

    async def due_notifications(self, limit=20):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("invalid notification bound")

        def operation(connection):
            return [
                dict(row)
                for row in connection.execute(
                    text("""
                    SELECT n.share_id,n.user_id,n.recipient_user_id,n.state
                      FROM drive_bulk_share_notifications n
                    JOIN drive_bulk_shares b ON b.share_id=n.share_id
                    WHERE n.state IN ('queued','dispatching')
                      AND n.next_at<=clock_timestamp()
                      AND (n.lease_id IS NULL OR n.lease_expires_at<=clock_timestamp())
                      AND b.expires_at>clock_timestamp()
                    ORDER BY n.next_at,n.share_id,n.recipient_user_id
                    LIMIT :limit FOR UPDATE OF n SKIP LOCKED
                    """),
                    {"limit": limit},
                ).mappings()
            ]

        return await self._transaction(operation)

    async def claim_notification(self, *, share_id, recipient_user_id):
        share = _uuid(share_id)

        def operation(connection):
            row = self._row(
                connection,
                """SELECT n.*,b.origin_request_id,b.progressive_batch
                FROM drive_bulk_share_notifications n
                JOIN drive_bulk_shares b ON b.share_id=n.share_id
                WHERE n.share_id=:share AND n.recipient_user_id=:recipient
                  AND b.expires_at>clock_timestamp() FOR UPDATE OF n""",
                {"share": share, "recipient": recipient_user_id},
            )
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row is None
                or row["state"] != "queued"
                or row["next_at"] > now
                or row["lease_expires_at"] is not None
                and row["lease_expires_at"] > now
            ):
                # An expired dispatch may already have reached FCM; do not
                # deliver twice merely because a worker crashed.
                if (
                    row is not None
                    and row["state"] == "dispatching"
                    and (row["lease_expires_at"] is None or row["lease_expires_at"] <= now)
                ):
                    connection.execute(
                        text("""UPDATE drive_bulk_share_notifications
                        SET state='unavailable',lease_id=NULL,lease_expires_at=NULL,
                        updated_at=clock_timestamp()
                        WHERE share_id=:share AND recipient_user_id=:recipient"""),
                        {"share": share, "recipient": recipient_user_id},
                    )
                return None
            lease = str(uuid4())
            connection.execute(
                text("""UPDATE drive_bulk_share_notifications SET state='dispatching',
                lease_id=:lease,lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',
                attempts=attempts+1,updated_at=clock_timestamp()
                WHERE share_id=:share AND recipient_user_id=:recipient"""),
                {"share": share, "recipient": recipient_user_id, "lease": lease},
            )
            return {
                "share_id": share,
                "recipient_user_id": recipient_user_id,
                "user_id": row["user_id"],
                "origin_request_id": str(row["origin_request_id"])
                if row["progressive_batch"] and row["origin_request_id"]
                else None,
                "lease_id": lease,
                "attempts": row["attempts"] + 1,
            }

        return await self._transaction(operation)

    async def settle_notification(self, job, *, delivered):
        def operation(connection):
            row = self._row(
                connection,
                """SELECT * FROM drive_bulk_share_notifications
                WHERE share_id=:share AND recipient_user_id=:recipient FOR UPDATE""",
                {"share": job["share_id"], "recipient": job["recipient_user_id"]},
            )
            if row is None or str(row["lease_id"]) != job["lease_id"]:
                return "superseded"
            state = (
                "settled"
                if delivered is True
                else "unavailable"
                if delivered is None
                else "queued"
                if row["attempts"] < 3
                else "unavailable"
            )
            connection.execute(
                text("""UPDATE drive_bulk_share_notifications SET state=:state,
                lease_id=NULL,lease_expires_at=NULL,
                next_at=clock_timestamp()+(:delay * INTERVAL '1 second'),
                updated_at=clock_timestamp()
                WHERE share_id=:share AND recipient_user_id=:recipient"""),
                {
                    "share": job["share_id"],
                    "recipient": job["recipient_user_id"],
                    "state": state,
                    "delay": 30 * row["attempts"] if state == "queued" else 0,
                },
            )
            return state

        return await self._transaction(operation)
