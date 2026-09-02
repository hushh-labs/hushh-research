# hushh_mcp/services/feed_service.py
"""
Feed Service
============

Read/write access to the ``feed_events`` table backing the One Feed route.

This is presentation-only. Each domain's own audit/event table (consent_audit,
one_location_events, connected_system_audit_events) or completion point (Kai,
KYC, connections) remains the authority for its domain; feed_events exists
only to give the Feed one uniform, paginated shape to read. Rows never carry
ciphertext or vault-protected content, only bounded, non-sensitive metadata a
human-readable line can be rendered from client-side.

Methods here are synchronous (the underlying client is a sync Postgrest-style
query builder). Route handlers in api/routes/one/feed.py are plain ``def``
(not ``async def``), matching api/routes/one/connections.py, so FastAPI's own
threadpool dispatch offloads the blocking call without a manual
``run_in_threadpool`` wrapper.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from db.db_client import get_db

logger = logging.getLogger(__name__)

_MAX_LIMIT = 100
_SOURCE_DOMAINS = frozenset(
    {"consent", "location", "kai", "kyc", "connected_systems", "connections"}
)
_MAX_ACTOR_LABEL_LENGTH = 160
_MAX_METADATA_STRING_LENGTH = 256
_MAX_METADATA_URL_LENGTH = 1024
_MAX_METADATA_NUMBER = 1_000_000_000_000
POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807
_FEED_SELECT_COLUMNS = (
    "id,source_domain,event_type,actor_label,metadata,source_row_id,read_at,created_at"
)
_COUNTERPART_PHOTO_KEY = "counterpart_photo_url"
_LOCATION_GRANT_EVENT_TYPES = frozenset(
    {
        "location_share_created",
        "location_share_revoked",
        "location_share_shortened",
        "location_share_duration_changed",
        "location_share_expired",
    }
)
_LOCATION_REQUEST_EVENT_TYPES = frozenset(
    {
        "location_access_request",
        "location_access_approved",
        "location_access_denied",
        "location_access_request_withdrawn",
    }
)

# Feed is a plaintext presentation projection. Only keys consumed by the
# client renderers may cross this boundary; domain rows can contain richer
# details (coordinates, credentials, account identifiers, or ciphertext)
# that must remain in their owning stores.
_SAFE_METADATA_KEYS = frozenset(
    {
        "scope_description",
        "scope",
        "counterpart_label",
        _COUNTERPART_PHOTO_KEY,
        "display_name",
        "first_name",
        "feed_audience",
        "reason",
        "duration_mode",
        "duration_hours",
        "requested_duration_mode",
        "requested_duration_hours",
        "is_extension",
        "request_id",
        "grant_id",
        "referral_id",
        "direction",
        "owner_label",
        "public_location_view",
        "submission_id",
        "circle_name",
        "circle_id",
        "invite_id",
        "added_by_label",
        "ticker",
        "user_facing_status",
        "new_status",
        "actor_is_self",
        # Which lane a location share belongs to ("sos" vs everything else).
        # Without it the Feed cannot tell an emergency apart from an ordinary
        # share and narrates both as "shared location, then stopped" -- the
        # one row where that distinction matters most. A short, bounded enum
        # written by our own service, carrying nothing about the person.
        "share_kind",
    }
)


def _bounded_text(value: object, *, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned[:limit] if cleaned else None


def _safe_feed_metadata(value: object) -> dict[str, str | int | float | bool]:
    if not isinstance(value, dict):
        return {}

    safe: dict[str, str | int | float | bool] = {}
    for key in _SAFE_METADATA_KEYS:
        raw = value.get(key)
        if isinstance(raw, str):
            cleaned = _bounded_text(
                raw,
                limit=(
                    _MAX_METADATA_URL_LENGTH
                    if key == _COUNTERPART_PHOTO_KEY
                    else _MAX_METADATA_STRING_LENGTH
                ),
            )
            if cleaned is not None:
                safe[key] = cleaned
        elif isinstance(raw, bool):
            safe[key] = raw
        elif isinstance(raw, int) and abs(raw) <= _MAX_METADATA_NUMBER:
            safe[key] = raw
        elif isinstance(raw, float) and math.isfinite(raw) and abs(raw) <= _MAX_METADATA_NUMBER:
            safe[key] = raw
    return safe


class FeedService:
    def __init__(self):
        self._db = None

    def _get_db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    def record_event(
        self,
        *,
        user_id: str,
        source_domain: str,
        event_type: str,
        actor_label: str | None = None,
        metadata: dict[str, Any] | None = None,
        source_row_id: str | None = None,
    ) -> None:
        """Best-effort feed write for domains with no existing durable event
        table to trigger from (Kai completion, KYC status, connections).

        Never raises: the feed is a presentation surface, not part of the
        domain's own transaction, so a feed-write failure must never block or
        roll back the action that produced it.
        """
        if source_domain not in _SOURCE_DOMAINS:
            logger.warning("feed.record_event_unknown_domain domain=%s", source_domain)
            return
        safe_actor_label = _bounded_text(actor_label, limit=_MAX_ACTOR_LABEL_LENGTH)
        safe_metadata = _safe_feed_metadata(metadata)
        try:
            if source_row_id:
                self._get_db().execute_raw(
                    """
                    INSERT INTO feed_events (
                      user_id, source_domain, event_type, actor_label,
                      metadata, source_row_id
                    )
                    VALUES (
                      :user_id, :source_domain, :event_type, :actor_label,
                      CAST(:metadata_json AS JSONB), :source_row_id
                    )
                    ON CONFLICT DO NOTHING
                    """,
                    {
                        "user_id": user_id,
                        "source_domain": source_domain,
                        "event_type": event_type,
                        "actor_label": safe_actor_label,
                        "metadata_json": json.dumps(safe_metadata),
                        "source_row_id": source_row_id,
                    },
                )
            else:
                self._get_db().table("feed_events").insert(
                    {
                        "user_id": user_id,
                        "source_domain": source_domain,
                        "event_type": event_type,
                        "actor_label": safe_actor_label,
                        "metadata": safe_metadata,
                    }
                ).execute()
        except Exception:
            logger.exception(
                "feed.record_event_failed domain=%s event_type=%s", source_domain, event_type
            )

    def list_feed(
        self,
        user_id: str,
        *,
        cursor: int | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Keyset-paginated feed items, newest first.

        ``cursor`` is the ``id`` of the last item the caller already has;
        an append-only, live-growing feed drifts under page-number
        pagination, so this always walks strictly backwards by id.
        """
        bounded_limit = max(1, min(limit, _MAX_LIMIT))
        db = self._get_db()
        query = db.table("feed_events").select(_FEED_SELECT_COLUMNS).eq("user_id", user_id)
        if cursor is not None:
            query = query.lt("id", cursor)
        rows = query.order("id", desc=True).limit(bounded_limit + 1).execute().data or []
        has_more = len(rows) > bounded_limit
        rows = rows[:bounded_limit]
        rows = self._with_counterpart_photos(user_id, rows)
        next_cursor = str(rows[-1]["id"]) if has_more and rows else None
        return {
            "items": [self._to_item(row) for row in rows],
            "next_cursor": next_cursor,
            "unread_count": self.unread_count(user_id),
        }

    def _with_counterpart_photos(
        self, user_id: str, rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Add the same public avatar URL other person surfaces already use.

        ``feed_events`` intentionally avoids storing user ids in metadata. The
        source row id already points back to the owning connection/location
        record, so the read side can resolve a photo without widening the
        browser payload beyond a bounded presentation URL.
        """

        if not rows:
            return rows

        connection_request_ids: set[str] = set()
        grant_ids: set[str] = set()
        request_ids: set[str] = set()
        for row in rows:
            metadata = row.get("metadata")
            if isinstance(metadata, dict) and _bounded_text(
                metadata.get(_COUNTERPART_PHOTO_KEY), limit=1            ):
                continue
            source_row_id = str(row.get("source_row_id") or "").strip()
            if not source_row_id:
                continue
            source_domain = str(row.get("source_domain") or "")
            event_type = str(row.get("event_type") or "")
            if source_domain == "connections":
                connection_request_ids.add(source_row_id)
            elif source_domain == "location" and event_type in _LOCATION_GRANT_EVENT_TYPES:
                grant_id = _uuid_prefix(source_row_id)
                if grant_id:
                    grant_ids.add(grant_id)
            elif source_domain == "location" and event_type in _LOCATION_REQUEST_EVENT_TYPES:
                request_id = _uuid_prefix(source_row_id)
                if request_id:
                    request_ids.add(request_id)

        photo_by_source: dict[tuple[str, str], str] = {}
        photo_by_source.update(
            {
                ("connections", row["source_row_id"]): row["counterpart_photo_url"]
                for row in self._connection_counterpart_photos(
                    user_id=user_id,
                    request_ids=connection_request_ids,
                )
            }
        )
        photo_by_source.update(
            {
                ("location_grant", row["source_row_id"]): row["counterpart_photo_url"]
                for row in self._location_grant_counterpart_photos(
                    user_id=user_id,
                    grant_ids=grant_ids,
                )
            }
        )
        photo_by_source.update(
            {
                ("location_request", row["source_row_id"]): row["counterpart_photo_url"]
                for row in self._location_request_counterpart_photos(
                    user_id=user_id,
                    request_ids=request_ids,
                )
            }
        )
        if not photo_by_source:
            return rows

        enriched: list[dict[str, Any]] = []
        for row in rows:
            source_domain = str(row.get("source_domain") or "")
            event_type = str(row.get("event_type") or "")
            source_row_id = str(row.get("source_row_id") or "").strip()
            lookup_id = source_row_id
            lookup_domain = source_domain
            if source_domain == "location" and event_type in _LOCATION_GRANT_EVENT_TYPES:
                lookup_id = _uuid_prefix(source_row_id) or ""
                lookup_domain = "location_grant"
            elif source_domain == "location" and event_type in _LOCATION_REQUEST_EVENT_TYPES:
                lookup_id = _uuid_prefix(source_row_id) or ""
                lookup_domain = "location_request"
            photo_url = photo_by_source.get((lookup_domain, lookup_id))
            if not photo_url:
                enriched.append(row)
                continue
            metadata = row.get("metadata")
            next_row = dict(row)
            next_row["metadata"] = {
                **(metadata if isinstance(metadata, dict) else {}),
                _COUNTERPART_PHOTO_KEY: photo_url,
            }
            enriched.append(next_row)
        return enriched

    def _photo_rows(self, sql: str, params: dict[str, Any]) -> list[dict[str, str]]:
        try:
            rows = self._get_db().execute_raw(sql, params).data or []
        except Exception:
            logger.exception("feed.counterpart_photo_lookup_failed")
            return []
        results: list[dict[str, str]] = []
        for row in rows:
            source_row_id = str(row.get("source_row_id") or "").strip()
            photo_url = _bounded_text(
                row.get("counterpart_photo_url"),
                limit=_MAX_METADATA_URL_LENGTH,
            )
            if source_row_id and photo_url:
                results.append(
                    {
                        "source_row_id": source_row_id,
                        "counterpart_photo_url": photo_url,
                    }
                )
        return results

    def _connection_counterpart_photos(
        self, *, user_id: str, request_ids: set[str]
    ) -> list[dict[str, str]]:
        if not request_ids:
            return []
        return self._photo_rows(
            """
            WITH requested_ids AS (
              SELECT value AS request_id
              FROM jsonb_array_elements_text(CAST(:request_ids_json AS JSONB))
            )
            SELECT
              req.id::TEXT AS source_row_id,
              CASE
                WHEN req.requester_user_id = :user_id
                  THEN COALESCE(addressee.custom_photo_url, addressee.photo_url)
                WHEN req.addressee_user_id = :user_id
                  THEN COALESCE(requester.custom_photo_url, requester.photo_url)
              END AS counterpart_photo_url
            FROM connection_requests req
            JOIN requested_ids ids ON ids.request_id = req.id::TEXT
            LEFT JOIN actor_identity_cache requester
              ON requester.user_id = req.requester_user_id
            LEFT JOIN actor_identity_cache addressee
              ON addressee.user_id = req.addressee_user_id
            WHERE req.requester_user_id = :user_id OR req.addressee_user_id = :user_id
            """,
            {"user_id": user_id, "request_ids_json": json.dumps(sorted(request_ids))},
        )

    def _location_grant_counterpart_photos(
        self, *, user_id: str, grant_ids: set[str]
    ) -> list[dict[str, str]]:
        if not grant_ids:
            return []
        return self._photo_rows(
            """
            WITH requested_ids AS (
              SELECT value AS grant_id
              FROM jsonb_array_elements_text(CAST(:grant_ids_json AS JSONB))
            )
            SELECT
              grant.id::TEXT AS source_row_id,
              CASE
                WHEN grant.owner_user_id = :user_id
                  THEN COALESCE(recipient.custom_photo_url, recipient.photo_url)
                WHEN grant.recipient_user_id = :user_id
                  THEN COALESCE(owner_identity.custom_photo_url, owner_identity.photo_url)
              END AS counterpart_photo_url
            FROM one_location_share_grants grant
            JOIN requested_ids ids ON ids.grant_id = grant.id::TEXT
            LEFT JOIN actor_identity_cache recipient
              ON recipient.user_id = grant.recipient_user_id
            LEFT JOIN actor_identity_cache owner_identity
              ON owner_identity.user_id = grant.owner_user_id
            WHERE grant.owner_user_id = :user_id OR grant.recipient_user_id = :user_id
            """,
            {"user_id": user_id, "grant_ids_json": json.dumps(sorted(grant_ids))},
        )

    def _location_request_counterpart_photos(
        self, *, user_id: str, request_ids: set[str]
    ) -> list[dict[str, str]]:
        if not request_ids:
            return []
        return self._photo_rows(
            """
            WITH requested_ids AS (
              SELECT value AS request_id
              FROM jsonb_array_elements_text(CAST(:request_ids_json AS JSONB))
            )
            SELECT
              req.id::TEXT AS source_row_id,
              CASE
                WHEN req.owner_user_id = :user_id
                  THEN COALESCE(requester.custom_photo_url, requester.photo_url)
                WHEN req.requester_user_id = :user_id
                  THEN COALESCE(owner_identity.custom_photo_url, owner_identity.photo_url)
              END AS counterpart_photo_url
            FROM one_location_access_requests req
            JOIN requested_ids ids ON ids.request_id = req.id::TEXT
            LEFT JOIN actor_identity_cache requester
              ON requester.user_id = req.requester_user_id
            LEFT JOIN actor_identity_cache owner_identity
              ON owner_identity.user_id = req.owner_user_id
            WHERE req.owner_user_id = :user_id OR req.requester_user_id = :user_id
            """,
            {"user_id": user_id, "request_ids_json": json.dumps(sorted(request_ids))},
        )

    def unread_count(self, user_id: str) -> int:
        db = self._get_db()
        response = (
            db.table("feed_events")
            .select("id", count="exact")
            .eq("user_id", user_id)
            .is_("read_at", None)
            .limit(0)
            .execute()
        )
        return int(response.count or 0)

    def mark_read(self, user_id: str, *, up_to_id: int) -> dict[str, Any]:
        """Mark unread items read, up to and including ``up_to_id``.

        Fired once when the Feed page opens (mirrors Instagram/Twitter's
        "opening the tab clears the badge" convention), not per-item.
        """
        db = self._get_db()
        now_iso = datetime.now(tz=timezone.utc).isoformat()
        query = (
            db.table("feed_events")
            .update({"read_at": now_iso})
            .eq("user_id", user_id)
            .is_("read_at", None)
        )
        query = query.lte("id", up_to_id)
        query.execute()
        return {"status": "ok"}

    @staticmethod
    def _to_item(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": str(row.get("id")),
            "source_domain": row.get("source_domain"),
            "event_type": row.get("event_type"),
            "actor_label": _bounded_text(row.get("actor_label"), limit=_MAX_ACTOR_LABEL_LENGTH),
            "metadata": _safe_feed_metadata(row.get("metadata")),
            "read": row.get("read_at") is not None,
            "created_at": row.get("created_at"),
        }


def _uuid_prefix(value: str) -> str | None:
    candidate = str(value or "").strip().split(":", 1)[0]
    if not candidate:
        return None
    try:
        return str(UUID(candidate))
    except ValueError:
        return None
