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
human-readable line can be rendered from client-side. Recipient-only Direct
Message previews are the narrow exception at read time: the service reopens
the encrypted source inside the authenticated Feed query and returns a bounded
transient string. That preview never enters a Feed row, push payload, or
realtime doorbell.

Methods here are synchronous (the underlying client is a sync Postgrest-style
query builder). Route handlers in api/routes/one/feed.py are plain ``def``
(not ``async def``), matching api/routes/one/connections.py, so FastAPI's own
threadpool dispatch offloads the blocking call without a manual
``run_in_threadpool`` wrapper.
"""

from __future__ import annotations

import base64
import json
import logging
import math
import os
import re
from collections.abc import Callable
from datetime import datetime
from typing import Any, Unpack
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from db.connection import get_pool
from db.db_client import get_db
from hushh_mcp.services import feed_calendar_context as calendar_context
from hushh_mcp.services.direct_messages_service import (
    DirectMessageCipher,
    DirectMessagesError,
)
from hushh_mcp.services.feed_activity_dto import (
    activity_fields,
    chat_activity_fields,
    snapshot_fields,
)
from hushh_mcp.services.feed_activity_policy import POLICY_REVISION
from hushh_mcp.services.feed_activity_reader import FeedActivityReader
from hushh_mcp.services.feed_counterpart_projection import (
    COUNTERPART_PHOTO_KEY as _COUNTERPART_PHOTO_KEY,
)
from hushh_mcp.services.feed_counterpart_projection import (
    with_counterpart_identity,
    without_counterpart_identity,
)
from hushh_mcp.services.feed_document_payment_query import DRIVE_DOCUMENT_PAYMENT_QUERY
from hushh_mcp.services.feed_drive_fold import (
    DRIVE_OUTCOME_EVENT,
    drive_rows_revealed_by_removal,
)
from hushh_mcp.services.feed_event_writer import (
    completed_analysis_source,
    mark_analysis_viewed,
    record_saved_analysis,
    write_feed_event,
)
from hushh_mcp.services.feed_group_queries import (
    _GROUPED_FEED_COUNT_SELECT,
    _GROUPED_FEED_CTE,
    _GROUPED_FEED_PAGE_SELECT,
    _SOURCE_EVENTS_SQL,
    protected_dismissal_sql,
)
from hushh_mcp.services.feed_group_queries import (
    _GROUPED_FEED_COUNT_SQL as _GROUPED_FEED_COUNT_SQL,
)
from hushh_mcp.services.feed_group_queries import (
    _GROUPED_FEED_PAGE_SQL as _GROUPED_FEED_PAGE_SQL,
)
from hushh_mcp.services.feed_location_state import active_incident_sql
from hushh_mcp.services.feed_metadata_keys import FEED_METADATA_KEYS
from hushh_mcp.services.feed_payment_projection import (
    DRIVE_DELIVERY_COUNT_FIELDS as _DRIVE_DELIVERY_COUNT_FIELDS,
)
from hushh_mcp.services.feed_payment_projection import (
    project_document_payment_rows,
    requester_payment_projection,
)
from hushh_mcp.services.feed_read_snapshot import (
    SNAPSHOT_FINGERPRINT_SQL,
    guarded_acknowledgment_sql,
    mark_read_snapshot,
)
from hushh_mcp.services.feed_search_contract import FeedSearchCriteria
from hushh_mcp.services.feed_source_context import _uuid as feed_uuid_sql
from hushh_mcp.services.feed_source_context import load_source_columns, source_events_sql
from hushh_mcp.services.requester_identity import label_from_identity_row
from hushh_mcp.services.stripe_mode import configured_stripe_mode

logger = logging.getLogger(__name__)

_MAX_LIMIT = 100
_SOURCE_DOMAINS = frozenset(
    {
        "consent",
        "location",
        "kai",
        "kyc",
        "connected_systems",
        "connections",
        "profile_discovery",
        "pwm",
        "calendar_email_followup",
    }
)
_MAX_ACTOR_LABEL_LENGTH = 160
_MAX_METADATA_STRING_LENGTH = 256
_MAX_METADATA_URL_LENGTH = 1024
_MAX_METADATA_NUMBER = 1_000_000_000_000
_DIRECT_MESSAGE_RECEIVED_EVENT = "direct_message_received"
_DIRECT_MESSAGE_FEED_PREVIEW_MAX_LENGTH = 256
_DIRECT_MESSAGE_PREVIEW_FIELD = "_direct_message_preview"
_DIRECT_MESSAGE_CONVERSATION_FIELD = "_direct_message_conversation_id"
_DIRECT_MESSAGE_COUNTERPART_LABEL_FIELD = "_direct_message_counterpart_label"
POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807
_FEED_SELECT_COLUMNS = (
    "id,source_domain,event_type,actor_label,metadata,source_row_id,read_at,created_at"
)
# These projections carry the opaque ID from a participant-scoped Drive request.
# Drive questions use a different request table and keep their own rows.
# The owner's live rows of the Drive request the target row belongs to. The
# event list is feed_drive_fold.DRIVE_LIFECYCLE_EVENTS.
_DRIVE_REQUEST_ROWS_SQL = """
SELECT item.id, item.source_domain, item.event_type, item.metadata
  FROM feed_events AS item
  JOIN feed_events AS target
    ON target.user_id = item.user_id
   AND target.id = :item_id
   AND target.dismissed_at IS NULL
   AND target.source_domain = 'connected_systems'
   AND target.event_type IN ('document_share_decided', 'document_share_outcome',
     'document_share_payment_ready', 'document_share_payment_confirmed',
     'document_share_payment_refunded')
   AND NULLIF(target.metadata->>'request_id', '') IS NOT NULL
 WHERE item.user_id = :user_id
   AND item.dismissed_at IS NULL
   AND item.source_domain = 'connected_systems'
   AND item.event_type IN ('document_share_decided', 'document_share_outcome',
     'document_share_payment_ready', 'document_share_payment_confirmed',
     'document_share_payment_refunded')
   AND item.metadata->>'request_id' = target.metadata->>'request_id'
"""
# The owner's live rows of each Drive request that has a row above a Clear
# watermark; normally none.
_DRIVE_ROWS_ABOVE_CLEAR_SQL = """
SELECT item.id, item.source_domain, item.event_type, item.metadata
  FROM feed_events AS item
 WHERE item.user_id = :user_id
   AND item.dismissed_at IS NULL
   AND item.source_domain = 'connected_systems'
   AND item.event_type IN ('document_share_decided', 'document_share_outcome',
     'document_share_payment_ready', 'document_share_payment_confirmed',
     'document_share_payment_refunded')
   AND item.metadata->>'request_id' IN (
     SELECT newer.metadata->>'request_id'
       FROM feed_events AS newer
      WHERE newer.user_id = :user_id
        AND newer.id > :up_to_id
        AND newer.dismissed_at IS NULL
        AND newer.source_domain = 'connected_systems'
        AND newer.event_type IN ('document_share_decided', 'document_share_outcome',
          'document_share_payment_ready', 'document_share_payment_confirmed',
          'document_share_payment_refunded')
   )
"""
_WALLET_GROUPED_FEED_CTE = _GROUPED_FEED_CTE.replace(
    "    WHEN f.source_domain = 'connections'",
    "    WHEN wg.id IS NOT NULL THEN 'wallet-access:' || wg.id::text\n    WHEN f.source_domain = 'connections'",
).replace(
    "  WHERE f.user_id = :user_id",
    "  LEFT JOIN wallet_card_access_grants wg ON wg.message_id=m.id "
    "AND wg.recipient_user_id=:user_id AND wg.owner_user_id=m.sender_user_id\n"
    "  WHERE f.user_id = :user_id",
)

_LOCATION_GRANT_EVENT_TYPES = frozenset(
    {
        "location_share_created",
        "location_share_revoked",
        "location_share_shortened",
        "location_share_duration_changed",
        "location_share_expired",
        "location_share_viewed",
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
_SAFE_METADATA_KEYS = (
    FEED_METADATA_KEYS
    | frozenset(calendar_context.CALENDAR_CONTEXT_KEYS)
    | frozenset(_DRIVE_DELIVERY_COUNT_FIELDS)
)


def _bounded_text(value: object, *, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned[:limit] if cleaned else None


def _direct_message_source_id(value: object) -> str | None:
    """Return a canonical UUID only for an opaque direct-message source id."""
    try:
        return str(UUID(str(value or "").strip()))
    except (AttributeError, TypeError, ValueError):
        return None


def _direct_message_preview(value: object) -> str | None:
    """Normalize a private, read-time message preview without retaining it."""
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    if not cleaned:
        return None
    if cleaned.startswith("[wallet-access:") and cleaned.endswith("]"):
        if _direct_message_source_id(cleaned[len("[wallet-access:") : -1]):
            return "Shared payment card"
    if cleaned.startswith("[wallet-request:") and cleaned.endswith("]"):
        if _direct_message_source_id(cleaned[len("[wallet-request:") : -1]):
            return "Card request"
    if len(cleaned) <= _DIRECT_MESSAGE_FEED_PREVIEW_MAX_LENGTH:
        return cleaned
    return f"{cleaned[: _DIRECT_MESSAGE_FEED_PREVIEW_MAX_LENGTH - 1].rstrip()}…"


def _safe_feed_metadata(value: object) -> dict[str, str | int | float | bool]:
    if not isinstance(value, dict):
        return {}

    safe: dict[str, str | int | float | bool] = {}
    for key in _SAFE_METADATA_KEYS:
        raw = value.get(key)
        if key == "pwm_outcome":
            if isinstance(raw, str) and raw in {"ready", "partial", "attention"}:
                safe[key] = raw
            continue
        if key == "viewerRole":
            if isinstance(raw, str) and raw in {"owner", "advisor"}:
                safe[key] = raw
            continue
        if key in {"draft_id", "advisorReviewId"}:
            if isinstance(raw, str) and re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", raw, re.I
            ):
                safe[key] = raw
            continue
        if key == _COUNTERPART_PHOTO_KEY:
            photo = _safe_photo_url(raw)
            if photo is not None:
                safe[key] = photo
            continue
        if isinstance(raw, str):
            cleaned = _bounded_text(raw, limit=_MAX_METADATA_STRING_LENGTH)
            if cleaned is not None:
                safe[key] = cleaned
        elif isinstance(raw, bool):
            safe[key] = raw
        elif isinstance(raw, int) and abs(raw) <= _MAX_METADATA_NUMBER:
            safe[key] = raw
        elif isinstance(raw, float) and math.isfinite(raw) and abs(raw) <= _MAX_METADATA_NUMBER:
            safe[key] = raw
    return safe


def _safe_photo_url(value: object) -> str | None:
    """Preserve complete public photos, never a truncated/unloadable image.

    Uploaded avatars follow account.AvatarUploadRequest's 600k character / 300KiB
    decoded raster contract. Other metadata retains its much smaller limits.
    """
    if not isinstance(value, str):
        return None
    photo = value.strip()
    if photo.startswith("data:"):
        if len(photo) > 600_000:
            return None
        header, separator, encoded = photo.partition(",")
        if not separator or header not in {
            "data:image/png;base64",
            "data:image/jpeg;base64",
            "data:image/jpg;base64",
            "data:image/webp;base64",
        }:
            return None
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            return None
        return photo if 0 < len(decoded) <= 300 * 1024 else None
    if len(photo) > _MAX_METADATA_URL_LENGTH:
        return None
    try:
        url = urlsplit(photo)
        return photo if url.scheme in {"https", "http"} and url.netloc else None
    except ValueError:
        return None


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
        require_confirmation: bool = False,
    ) -> None:
        """Default writes are best effort; explicit saved-result ACKs require persistence."""
        if source_domain not in _SOURCE_DOMAINS:
            if require_confirmation:
                raise ValueError("Unsupported Feed source")
            logger.warning("feed.record_event_unknown_domain domain=%s", source_domain)
            return
        write_feed_event(
            get_db=self._get_db,
            user_id=user_id,
            source_domain=source_domain,
            event_type=event_type,
            actor_label=_bounded_text(actor_label, limit=_MAX_ACTOR_LABEL_LENGTH),
            metadata=_safe_feed_metadata(metadata),
            source_row_id=source_row_id,
            require_confirmation=require_confirmation,
        )

    def completed_analysis_source(self, user_id: str, run_id: str) -> str | None:
        return completed_analysis_source(self._get_db, user_id, run_id)

    async def mark_analysis_viewed(
        self,
        user_id: str,
        run_id: str,
        completed_ticker: str | None = None,
        *,
        connection: Any = None,
    ) -> None:
        await mark_analysis_viewed(
            get_pool, user_id, run_id, completed_ticker, connection=connection
        )

    async def record_saved_analysis(
        self, user_id: str, run_id: str, ticker: str, *, connection: Any = None
    ) -> None:
        await record_saved_analysis(get_pool, user_id, run_id, ticker, connection=connection)

    def dismiss_analysis(self, user_id: str, run_id: str) -> None:
        rows = (
            self._get_db()
            .execute_raw(
                """SELECT id FROM feed_events WHERE user_id=:user_id AND source_domain='kai'
               AND event_type='kai_analysis_saved' AND source_row_id=:run_id ORDER BY id DESC LIMIT 1""",
                {"user_id": user_id, "run_id": run_id},
            )
            .data
            or []
        )
        if rows:
            self.dismiss(user_id, item_id=int(rows[0]["id"]))

    def list_feed(
        self,
        user_id: str,
        *,
        cursor: int | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Keyset-paginated feed items, newest first.

        The opaque owner row cursor anchors meaningful time and ID. Existing
        numeric cursors remain valid when a source updates an older row.
        """
        bounded_limit = max(1, min(limit, _MAX_LIMIT))
        db = self._get_db()
        # Include the visibility policy in the revision so clients drop pages
        # cached before the filter. Read before the page to protect deletions.
        revision_rows = (
            db.execute_raw(
                self._grouped_feed_sql(count=False).removesuffix(_GROUPED_FEED_PAGE_SELECT)
                # Closed source/schema fragments only; values remain in execute_raw parameters.
                + f"""
            SELECT {SNAPSHOT_FINGERPRINT_SQL} AS snapshot_fingerprint, md5(concat_ws(':',:policy_revision,
              count(*) FILTER(WHERE f.dismissed_at IS NOT NULL),max(f.dismissed_at),
              COALESCE(string_agg(concat_ws(':',f.id,f.metadata->>'workflow_id',f.metadata->>'request_id'),
                '|' ORDER BY f.id) FILTER(WHERE NOT f.source_action_required OR
                  (f.source_domain='location' AND f.metadata->>'grant_id' IS NOT NULL AND f.metadata->>'request_id' IS NOT NULL)),''),
              count(*) FILTER(WHERE m.deleted_for_recipient_at IS NOT NULL),max(m.deleted_for_recipient_at),
              count(*) FILTER(WHERE m.deleted_for_everyone_at IS NOT NULL),max(m.deleted_for_everyone_at))) AS history_revision,
              max(f.id) AS snapshot_id, statement_timestamp() AS snapshot_time,
              CAST(EXTRACT(EPOCH FROM max(f.dismissed_at))*1000000 AS BIGINT)::text AS clear_version
            FROM source_events f LEFT JOIN messages m ON f.source_domain='connections'
              AND f.event_type='direct_message_received' AND m.id=CASE
                WHEN f.source_row_id ~* '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$'
                THEN f.source_row_id::uuid END
            """,  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
                {"user_id": user_id, "policy_revision": POLICY_REVISION},
            ).data
            or []
        )
        rows = (
            db.execute_raw(
                self._grouped_feed_sql(count=False),
                {"user_id": user_id, "cursor": cursor, "page_size": bounded_limit + 1},
            ).data
            or []
        )
        has_more = len(rows) > bounded_limit
        rows = rows[:bounded_limit]
        rows = self._present_activity_rows(user_id, rows)
        next_cursor = str(rows[-1]["id"]) if has_more and rows else None
        return {
            "items": [self._to_item(row, user_id) for row in rows],
            "next_cursor": next_cursor,
            "unread_count": self.unread_count(user_id),
            **snapshot_fields(revision_rows),
        }

    def _present_activity_rows(
        self, user_id: str, rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        rows = self._with_counterpart_photos(user_id, rows)
        rows = self._with_direct_message_previews(user_id, rows)
        rows = self._with_wallet_card_grants(user_id, rows)
        rows = self._with_wallet_card_requests(user_id, rows)
        rows = self._with_drive_payment_status(user_id, rows)
        return calendar_context.with_calendar_request_context(self._get_db, user_id, rows)

    def _activity_reader(
        self, *, historical: bool = False, include_dismissed: bool = False
    ) -> FeedActivityReader:
        return FeedActivityReader(
            cte=self._grouped_feed_sql(
                count=False, historical=historical, include_dismissed=include_dismissed
            ).removesuffix(_GROUPED_FEED_PAGE_SELECT),
            db=self._get_db(),
            present=self._present_activity_rows,
            photos=self._with_counterpart_photos,
            item=self._to_item,
            max_limit=_MAX_LIMIT,
            has_counterparts={"feed_event_id", "counterpart_user_id"}
            <= self._feed_source_columns().get("feed_event_counterparts", set()),
        )

    def search_activity(
        self, user_id: str, **criteria: Unpack[FeedSearchCriteria]
    ) -> dict[str, Any]:
        return self._activity_reader(historical=True).search_activity(user_id, **criteria)

    def operation_detail(
        self, user_id: str, *, item_id: int, before_id: int | None = None
    ) -> dict[str, Any] | None:
        return self._activity_reader(historical=True, include_dismissed=True).operation_detail(
            user_id, item_id=item_id, before_id=before_id
        )

    def _with_drive_payment_status(
        self, user_id: str, rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Batch refresh current document payment, refund and owner earning state.

        A Feed page is capped at 100 items. The query is scoped to the
        authenticated participant and opaque request IDs. It returns no owner
        ID, provider link, file, or request content.
        """
        request_ids: set[str] = set()
        for row in rows:
            if not str(row.get("event_type") or "").startswith("document_share_"):
                continue
            metadata = row.get("metadata")
            if not isinstance(metadata, dict):
                continue
            try:
                request_ids.add(str(UUID(str(metadata.get("request_id") or ""))))
            except (TypeError, ValueError, AttributeError):
                continue
        if not request_ids:
            return rows

        from hushh_mcp.services.drive_request_owner_payout_service import payout_enabled

        by_request: dict[str, dict[str, Any]] = {}
        try:
            results = (
                self._get_db()
                .execute_raw(
                    DRIVE_DOCUMENT_PAYMENT_QUERY,
                    {
                        "user_id": user_id,
                        "request_ids_json": json.dumps(sorted(request_ids)),
                        "payout_rollout": payout_enabled(),
                        "stripe_mode": configured_stripe_mode(),
                    },
                )
                .data
                or []
            )
            by_request = {str(item["request_id"]): item for item in results}
        except Exception as exc:  # presentation must not break Feed availability
            logger.warning("feed.drive_payment_status_unavailable error=%s", type(exc).__name__)

        return project_document_payment_rows(rows, by_request, self._requester_payment_projection)

    @staticmethod
    def _requester_payment_projection(event_type: str, current: dict[str, Any]) -> dict[str, Any]:
        return requester_payment_projection(event_type, current)

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

        profile_refs: dict[str, str] = {}
        current_photos = self._durable_counterpart_photos(user_id, rows, profile_refs)
        if current_photos is not None:
            return with_counterpart_identity(rows, current_photos, profile_refs)

        rows = without_counterpart_identity(rows)

        connection_request_ids: set[str] = set()
        grant_ids: set[str] = set()
        request_ids: set[str] = set()
        for row in rows:
            metadata = row.get("metadata")
            source_row_id = str(row.get("source_row_id") or "").strip()
            if not source_row_id:
                continue
            source_domain = str(row.get("source_domain") or "")
            event_type = str(row.get("event_type") or "")
            if source_domain == "connections":
                connection_request_ids.add(source_row_id)
            elif source_domain == "location" and event_type in _LOCATION_GRANT_EVENT_TYPES:
                grant_id = (
                    _uuid_prefix(str((metadata or {}).get("grant_id") or ""))
                    if isinstance(metadata, dict)
                    else None
                )
                grant_id = grant_id or _uuid_prefix(source_row_id)
                if grant_id:
                    grant_ids.add(grant_id)
            elif source_domain == "location" and event_type in _LOCATION_REQUEST_EVENT_TYPES:
                request_id = (
                    _uuid_prefix(str((metadata or {}).get("request_id") or ""))
                    if isinstance(metadata, dict)
                    else None
                )
                request_id = request_id or _uuid_prefix(source_row_id)
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
            metadata = row.get("metadata")
            source_domain = str(row.get("source_domain") or "")
            event_type = str(row.get("event_type") or "")
            source_row_id = str(row.get("source_row_id") or "").strip()
            lookup_id = source_row_id
            lookup_domain = source_domain
            if source_domain == "location" and event_type in _LOCATION_GRANT_EVENT_TYPES:
                lookup_id = (
                    (
                        _uuid_prefix(str(metadata.get("grant_id") or ""))
                        if isinstance(metadata, dict)
                        else None
                    )
                    or _uuid_prefix(source_row_id)
                    or ""
                )
                lookup_domain = "location_grant"
            elif source_domain == "location" and event_type in _LOCATION_REQUEST_EVENT_TYPES:
                lookup_id = (
                    (
                        _uuid_prefix(str(metadata.get("request_id") or ""))
                        if isinstance(metadata, dict)
                        else None
                    )
                    or _uuid_prefix(source_row_id)
                    or ""
                )
                lookup_domain = "location_request"
            photo_url = photo_by_source.get((lookup_domain, lookup_id))
            if not photo_url:
                enriched.append(row)
                continue
            next_row = dict(row)
            next_row["metadata"] = {
                **(metadata if isinstance(metadata, dict) else {}),
                _COUNTERPART_PHOTO_KEY: photo_url,
            }
            enriched.append(next_row)
        return enriched

    def _wallet_card_access_installed(self):
        if os.getenv("WALLET_CARD_ACCESS_ENABLED", "").lower() not in {"1", "true", "yes"}:
            return False
        try:
            rows = (
                self._get_db()
                .execute_raw(
                    "SELECT to_regclass('public.wallet_card_access_grants') IS NOT NULL AS available",
                    {},
                )
                .data
                or []
            )
            return bool(rows and rows[0].get("available") is True)
        except Exception:
            return False

    def _feed_source_columns(self) -> dict[str, set[str]]:
        cached = getattr(self, "_feed_source_shape", None)
        if cached is None:
            cached = load_source_columns(self._get_db().execute_raw)
            self._feed_source_shape = cached
        return cached

    def _grouped_feed_sql(
        self, *, count, historical: bool = False, include_dismissed: bool = False
    ):
        cte = (
            _WALLET_GROUPED_FEED_CTE if self._wallet_card_access_installed() else _GROUPED_FEED_CTE
        )
        if cte == _WALLET_GROUPED_FEED_CTE and self._universal_wallet_installed():
            cte = cte.replace("wallet_card_access_grants", "wallet_all_access_grants")
        if self._wallet_card_requests_installed():
            cte = cte.replace(
                "    WHEN f.source_domain = 'connections'",
                "    WHEN wr.id IS NOT NULL THEN 'wallet-request:' || wr.id::text\n    WHEN f.source_domain = 'connections'",
            ).replace(
                "  WHERE f.user_id = :user_id",
                "  LEFT JOIN wallet_card_requests wr ON wr.message_id=m.id AND wr.target_user_id=:user_id AND wr.requester_user_id=m.sender_user_id AND c.id IS NOT NULL\n  WHERE f.user_id = :user_id",
            )
        cte = cte.replace(
            _SOURCE_EVENTS_SQL,
            source_events_sql(
                self._feed_source_columns(),
                historical=historical,
                include_dismissed=include_dismissed,
            ),
        )
        return cte + (_GROUPED_FEED_COUNT_SELECT if count else _GROUPED_FEED_PAGE_SELECT)

    def _universal_wallet_installed(self):
        try:
            rows = (
                self._get_db()
                .execute_raw(
                    "SELECT to_regclass('public.wallet_all_access_grants') IS NOT NULL AS available",
                    {},
                )
                .data
                or []
            )
            return bool(rows and rows[0].get("available") is True)
        except Exception:
            return False

    def _wallet_card_requests_installed(self):
        if os.getenv("WALLET_CARD_ACCESS_ENABLED", "").lower() not in {"1", "true", "yes"}:
            return False
        try:
            rows = (
                self._get_db()
                .execute_raw(
                    "SELECT to_regclass('public.wallet_card_requests') IS NOT NULL AS available", {}
                )
                .data
                or []
            )
            return bool(rows and rows[0].get("available") is True)
        except Exception:
            return False

    def _with_wallet_card_requests(self, user_id, rows):
        ids = [
            str(row["source_row_id"])
            for row in rows
            if row.get("event_type") == "direct_message_received"
            and _direct_message_source_id(row.get("source_row_id"))
        ]
        if not ids or not self._wallet_card_requests_installed():
            return rows
        try:
            links = (
                self._get_db()
                .execute_raw(
                    """
SELECT r.message_id::text AS source_row_id,r.id::text AS request_id,
 CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END AS status
 FROM wallet_card_requests r JOIN messages m ON m.id=r.message_id
 JOIN conversations c ON c.id=m.conversation_id
 WHERE r.target_user_id=:viewer AND r.requester_user_id=m.sender_user_id
 AND m.deleted_for_everyone_at IS NULL AND m.deleted_for_recipient_at IS NULL
 AND m.id=ANY(CAST(:ids AS uuid[]))
 AND ((c.participant_a_user_id=r.requester_user_id AND c.participant_b_user_id=:viewer)
 OR (c.participant_b_user_id=r.requester_user_id AND c.participant_a_user_id=:viewer))
""",
                    {"viewer": user_id, "ids": ids},
                )
                .data
                or []
            )
        except Exception as exc:
            logger.warning(
                "feed.wallet_card_request_lookup_unavailable error=%s", type(exc).__name__
            )
            return rows
        by_id = {str(link["source_row_id"]): link for link in links}
        return [
            {**row, "_wallet_card_request": by_id.get(str(row.get("source_row_id", "")))}
            for row in rows
        ]

    def _with_wallet_card_grants(self, user_id, rows):
        ids = [
            str(row["source_row_id"])
            for row in rows
            if row.get("event_type") == "direct_message_received"
            and _direct_message_source_id(row.get("source_row_id"))
        ]
        if not ids or not self._wallet_card_access_installed():
            return rows
        grants_table = (
            "wallet_all_access_grants"
            if self._universal_wallet_installed()
            else "wallet_card_access_grants"
        )
        try:
            links = (
                self._get_db()
                .execute_raw(
                    # Only fixed sharing-source identifiers/fragments; request values are bound.
                    (
                        f"SELECT g.message_id::text AS source_row_id,g.id::text AS grant_id\n"  # nosec B608
                        f" FROM {grants_table} g JOIN messages m ON m.id=g.message_id\n"
                        f" JOIN conversations c ON c.id=m.conversation_id\n"
                        f" WHERE g.recipient_user_id=:viewer AND g.owner_user_id=m.sender_user_id\n"
                        f" AND m.deleted_for_everyone_at IS NULL AND m.deleted_for_recipient_at IS NULL\n"
                        f" AND m.id=ANY(CAST(:ids AS uuid[]))\n"
                        f" AND ((c.participant_a_user_id=g.owner_user_id AND c.participant_b_user_id=:viewer)\n"
                        f" OR (c.participant_b_user_id=g.owner_user_id AND c.participant_a_user_id=:viewer))"
                    ),
                    {"viewer": user_id, "ids": ids},
                )
                .data
                or []
            )
        except Exception as exc:
            logger.warning("feed.wallet_card_lookup_unavailable error=%s", type(exc).__name__)
            return rows
        by_id = {str(row["source_row_id"]): str(row["grant_id"]) for row in links}
        return [
            {**row, "_wallet_card_grant_id": by_id.get(str(row.get("source_row_id", "")))}
            for row in rows
        ]

    def _with_direct_message_previews(
        self, user_id: str, rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Attach recipient-authorized DM previews without persisting them.

        A Feed row stores only the source message UUID. This query rechecks
        that the viewer is the non-sender conversation participant before the
        envelope is opened, so a copied or stale Feed row cannot turn into a
        message-content oracle. Any missing, erased, or damaged source remains
        a generic Feed item instead of failing the complete page.
        """
        source_ids = {
            source_id
            for row in rows
            if str(row.get("source_domain") or "") == "connections"
            and str(row.get("event_type") or "") == _DIRECT_MESSAGE_RECEIVED_EVENT
            and (source_id := _direct_message_source_id(row.get("source_row_id"))) is not None
        }
        if not source_ids:
            return rows

        try:
            preview_rows = (
                self._get_db()
                .execute_raw(
                    """
                    WITH requested_messages AS (
                      SELECT value::UUID AS message_id
                      FROM jsonb_array_elements_text(CAST(:message_ids_json AS JSONB))
                    )
                    SELECT
                      message.id::TEXT AS source_row_id,
                      message.id,
                      message.conversation_id,
                      message.sender_user_id,
                      message.content_ciphertext,
                      message.content_iv,
                      message.content_algorithm,
                      identity.user_id,
                      identity.display_name,
                      identity.email
                    FROM requested_messages requested
                    JOIN public.messages AS message
                      ON message.id = requested.message_id
                    JOIN public.conversations AS conversation
                      ON conversation.id = message.conversation_id
                    JOIN public.feed_events AS feed
                      ON feed.user_id = :viewer_user_id
                     AND feed.source_domain = 'connections'
                     AND feed.event_type = 'direct_message_received'
                     AND feed.source_row_id = message.id::TEXT
                    LEFT JOIN public.actor_identity_cache AS identity
                      ON identity.user_id = message.sender_user_id
                    WHERE message.deleted_for_recipient_at IS NULL
                      AND message.deleted_for_everyone_at IS NULL
                      AND ((
                      conversation.participant_a_user_id = message.sender_user_id
                      AND conversation.participant_b_user_id = :viewer_user_id
                    ) OR (
                      conversation.participant_b_user_id = message.sender_user_id
                      AND conversation.participant_a_user_id = :viewer_user_id
                    ))
                    """,
                    {
                        "viewer_user_id": user_id,
                        "message_ids_json": json.dumps(sorted(source_ids)),
                    },
                )
                .data
                or []
            )
        except Exception as exc:  # noqa: BLE001 - a private preview is optional
            logger.warning(
                "feed.direct_message_preview_lookup_failed error=%s",
                type(exc).__name__,
            )
            return rows

        cipher = DirectMessageCipher()
        enrichments: dict[str, dict[str, str]] = {}
        for preview_row in preview_rows:
            source_id = _direct_message_source_id(preview_row.get("source_row_id"))
            if source_id is None:
                continue

            enrichment: dict[str, str] = {}
            conversation_id = _direct_message_source_id(preview_row.get("conversation_id"))
            if conversation_id is not None:
                enrichment[_DIRECT_MESSAGE_CONVERSATION_FIELD] = conversation_id

            counterpart_label = label_from_identity_row(
                preview_row,
                allow_email_handle=True,
                fallback="",
            )
            if counterpart_label:
                enrichment[_DIRECT_MESSAGE_COUNTERPART_LABEL_FIELD] = counterpart_label[
                    :_MAX_ACTOR_LABEL_LENGTH
                ]

            try:
                preview = _direct_message_preview(cipher.open(preview_row))
            except DirectMessagesError as exc:
                logger.warning("feed.direct_message_preview_unavailable code=%s", exc.code)
            except Exception as exc:  # noqa: BLE001 - preserve the generic item
                logger.warning(
                    "feed.direct_message_preview_unavailable error=%s",
                    type(exc).__name__,
                )
            else:
                if preview is not None:
                    enrichment[_DIRECT_MESSAGE_PREVIEW_FIELD] = preview

            if enrichment:
                enrichments[source_id] = enrichment

        if not enrichments:
            return rows
        return [
            {
                **row,
                **enrichments.get(_direct_message_source_id(row.get("source_row_id")) or "", {}),
            }
            for row in rows
        ]

    def _durable_counterpart_photos(
        self,
        user_id: str,
        rows: list[dict[str, Any]],
        profile_refs: dict[str, str] | None = None,
    ) -> dict[str, str | None] | None:
        """Resolve current avatars through the retained Feed identity mapping.

        The query is bounded to this viewer's requested page. Internal user ids
        never enter the public Feed DTO, and rows whose current avatar was
        removed resolve to ``None`` instead of reviving a historical snapshot.
        The source resolver remains only for rolling migration/backfill gaps.
        """
        try:
            results = (
                self._get_db()
                .execute_raw(
                    """
                WITH counterparts AS MATERIALIZED (
                  SELECT f.id, COALESCE(c.counterpart_user_id,
                    public.resolve_feed_counterpart_user_id(
                      f.user_id, f.source_domain, f.event_type, f.source_row_id)) AS actor_id
                  FROM feed_events f
                  JOIN jsonb_array_elements_text(CAST(:feed_ids_json AS JSONB)) ids(value)
                    ON f.id = CAST(ids.value AS BIGINT)
                  LEFT JOIN feed_event_counterparts c ON c.feed_event_id = f.id
                  WHERE f.user_id = :user_id
                )
                SELECT c.id::TEXT AS feed_id,
                  COALESCE(NULLIF(BTRIM(a.custom_photo_url), ''),
                           NULLIF(BTRIM(a.photo_url), '')) AS counterpart_photo_url,
                  to_jsonb(p)->>'public_person_ref' AS counterpart_person_ref
                FROM counterparts c
                LEFT JOIN actor_identity_cache a ON a.user_id = c.actor_id
                LEFT JOIN actor_profiles p ON p.user_id = c.actor_id
                """,
                    {
                        "user_id": user_id,
                        "feed_ids_json": json.dumps([str(row["id"]) for row in rows]),
                    },
                )
                .data
                or []
            )
        except Exception as exc:
            cause: BaseException | None = exc
            while cause is not None:
                if getattr(cause, "pgcode", None) in {"42P01", "42883"}:
                    logger.info("feed.counterpart_identity_schema_pending")
                    return None
                cause = cause.__cause__
            logger.exception("feed.counterpart_identity_lookup_failed")
            return None
        if profile_refs is not None:
            profile_refs.update(
                {
                    str(row["feed_id"]): str(row["counterpart_person_ref"])
                    for row in results
                    if row.get("counterpart_person_ref")
                }
            )
        return {
            str(row["feed_id"]): _safe_photo_url(row.get("counterpart_photo_url"))
            for row in results
        }

    def _photo_rows(self, sql: str, params: dict[str, Any]) -> list[dict[str, str]]:
        try:
            rows = self._get_db().execute_raw(sql, params).data or []
        except Exception:
            logger.exception("feed.counterpart_photo_lookup_failed")
            return []
        results: list[dict[str, str]] = []
        for row in rows:
            source_row_id = str(row.get("source_row_id") or "").strip()
            photo_url = _safe_photo_url(row.get("counterpart_photo_url"))
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
                  THEN COALESCE(NULLIF(BTRIM(addressee.custom_photo_url), ''), NULLIF(BTRIM(addressee.photo_url), ''))
                WHEN req.addressee_user_id = :user_id
                  THEN COALESCE(NULLIF(BTRIM(requester.custom_photo_url), ''), NULLIF(BTRIM(requester.photo_url), ''))
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
              share_grant.id::TEXT AS source_row_id,
              CASE
                WHEN share_grant.owner_user_id = :user_id
                  THEN COALESCE(NULLIF(BTRIM(recipient.custom_photo_url), ''), NULLIF(BTRIM(recipient.photo_url), ''))
                WHEN share_grant.recipient_user_id = :user_id
                  THEN COALESCE(NULLIF(BTRIM(owner_identity.custom_photo_url), ''), NULLIF(BTRIM(owner_identity.photo_url), ''))
              END AS counterpart_photo_url
            FROM one_location_share_grants share_grant
            JOIN requested_ids ids ON ids.grant_id = share_grant.id::TEXT
            LEFT JOIN actor_identity_cache recipient
              ON recipient.user_id = share_grant.recipient_user_id
            LEFT JOIN actor_identity_cache owner_identity
              ON owner_identity.user_id = share_grant.owner_user_id
            WHERE share_grant.owner_user_id = :user_id OR share_grant.recipient_user_id = :user_id
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
                  THEN COALESCE(NULLIF(BTRIM(requester.custom_photo_url), ''), NULLIF(BTRIM(requester.photo_url), ''))
                WHEN req.requester_user_id = :user_id
                  THEN COALESCE(NULLIF(BTRIM(owner_identity.custom_photo_url), ''), NULLIF(BTRIM(owner_identity.photo_url), ''))
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

    def historical_funding(
        self, user_id: str, *, item_id: int | None = None, terms: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """Read retained owner Feed records for the retired transfer service.

        Timestamps describe when One recorded the update. A Feed row is not
        evidence of the provider's original transaction detail or event time.
        """
        rows = (
            self._get_db()
            .execute_raw(
                _GROUPED_FEED_CTE
                # Closed source/schema fragments only; values remain in execute_raw parameters.
                + """
            , matching AS (
              SELECT g.id, g.thread_key, g.metadata, g.created_at
              FROM grouped g
              WHERE substr(g.thread_key, 1, 15) = 'legacy-funding:'
                AND (CAST(:item_id AS bigint) IS NULL OR g.thread_key = (
                  SELECT thread_key FROM keyed WHERE id = :item_id AND dismissed_at IS NULL
                ))
                AND NOT EXISTS (
                  SELECT 1 FROM unnest(CAST(:terms AS text[])) AS q(term)
                  WHERE strpos(lower(concat_ws(' ',
                    'historical transfer funding', g.metadata->>'user_facing_status',
                    CASE upper(g.metadata->>'direction')
                      WHEN 'INCOMING' THEN 'deposit' WHEN 'OUTGOING' THEN 'withdrawal' END,
                    to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD FMMonth DD YYYY')
                  )), q.term) = 0
                )
              ORDER BY g.id DESC
              LIMIT 50
            )
            SELECT g.id AS item_id, g.metadata, g.created_at,
              jsonb_agg(jsonb_build_object(
                'status', k.metadata->>'user_facing_status', 'recordedAt', k.created_at
              ) ORDER BY k.created_at, k.id) AS milestones
            FROM matching g JOIN keyed k ON k.thread_key = g.thread_key
            GROUP BY g.id, g.metadata, g.created_at
            ORDER BY g.id DESC
            """,  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
                {"user_id": user_id, "item_id": item_id, "terms": terms or []},
            )
            .data
            or []
        )
        return [
            {
                "itemId": str(row["item_id"]),
                "status": row["metadata"]["user_facing_status"],
                "direction": {"INCOMING": "deposit", "OUTGOING": "withdrawal"}.get(
                    str(row["metadata"].get("direction") or "").upper(), "transfer"
                ),
                "recordedAt": row["created_at"],
                "milestones": row["milestones"],
            }
            for row in rows
        ]

    def attention_items(self, user_id: str, item_ids: list[int]) -> dict[str, dict[str, Any]]:
        return self._activity_reader().attention_items(user_id, item_ids)

    def unread_count(self, user_id: str) -> int:
        db = self._get_db()
        rows = (
            db.execute_raw(
                self._grouped_feed_sql(count=True),
                {"user_id": user_id},
            ).data
            or []
        )
        return int(rows[0]["unread_count"] or 0) if rows else 0

    def mark_read(
        self,
        user_id: str,
        *,
        up_to_id: int,
        through_time: datetime | None = None,
        snapshot_fingerprint: str | None = None,
    ) -> dict[str, Any]:
        return mark_read_snapshot(
            self._get_db(),
            user_id,
            up_to_id=up_to_id,
            through_time=through_time,
            snapshot_fingerprint=snapshot_fingerprint,
        )

    def _drive_rows_surfaced(
        self,
        user_id: str,
        rows: list[dict[str, Any]],
        removed: Callable[[dict[str, Any]], bool],
    ) -> list[int]:
        """Folded Drive rows that would show once the ``removed`` rows are hidden.

        The fold runs on the same read-time payment status the Feed list sends,
        so the server and the web Feed agree on what is hidden.
        """
        if not rows:
            return []
        items = [
            self._to_item(row, user_id) for row in self._with_drive_payment_status(user_id, rows)
        ]
        removed_ids = {item["id"] for item in items if removed(item)}
        return sorted(int(row_id) for row_id in drive_rows_revealed_by_removal(items, removed_ids))

    def _drive_rows_surfaced_by_dismissal(self, user_id: str, item_id: int) -> list[int]:
        rows = (
            self._get_db()
            .execute_raw(_DRIVE_REQUEST_ROWS_SQL, {"user_id": user_id, "item_id": item_id})
            .data
            or []
        )
        target = next((row for row in rows if int(row["id"]) == item_id), None)
        if target is None:
            return []
        removes_outcomes = target.get("event_type") == DRIVE_OUTCOME_EVENT

        def removed(item: dict[str, Any]) -> bool:
            # Mirrors the dismissal SQL: the row and, for an outcome, older outcomes.
            return int(item["id"]) == item_id or (
                removes_outcomes
                and item["event_type"] == DRIVE_OUTCOME_EVENT
                and int(item["id"]) <= item_id
            )

        return self._drive_rows_surfaced(user_id, rows, removed)

    def _operation_rows_for_dismissal(self, user_id: str, item_id: int) -> list[int]:
        if not self._feed_source_columns():
            return []
        return self._activity_reader()._operation_rows_for_dismissal(user_id, item_id)

    def dismiss(self, user_id: str, *, item_id: int) -> dict[str, Any]:
        """Hide the owner's displayed row and older members of its visual group.

        A Drive request row also takes the rows of that request the Feed was
        folding behind it, so an older row cannot surface in its place on this
        or any other device. ``dismissed_ids`` lists every row hidden.
        """
        token = str(uuid4())
        operation_ids = self._operation_rows_for_dismissal(user_id, item_id)
        surfacing_ids = self._drive_rows_surfaced_by_dismissal(user_id, item_id)
        rows = (
            self._get_db()
            .execute_raw(
                protected_dismissal_sql(
                    active_incident_sql("item", self._feed_source_columns(), feed_uuid_sql)
                ),
                {
                    "user_id": user_id,
                    "item_id": item_id,
                    "dismissal_token": token,
                    "operation_ids": operation_ids,
                    "surfacing_ids": surfacing_ids,
                },
            )
            .data
            or []
        )
        dismissed = any(row.get("id") == item_id for row in rows)
        return {
            "status": "ok",
            "dismissal_token": token if dismissed else None,
            "dismissed_ids": (
                [str(row_id) for row_id in sorted(int(row["id"]) for row in rows)]
                if dismissed
                else []
            ),
        }

    def restore(self, user_id: str, *, item_id: int, dismissal_token: str) -> dict[str, Any]:
        """Undo exactly the rows one dismissal hid; a later Clear supersedes its token."""
        rows = (
            self._get_db()
            .execute_raw(
                """
            WITH target AS (
              SELECT 1 AS found
                FROM feed_events
               WHERE user_id = :user_id AND id = :item_id
                 AND dismissal_token = :dismissal_token
                 AND dismissed_at IS NOT NULL
            )
            UPDATE feed_events AS item
               SET dismissed_at = NULL, dismissal_token = NULL
              FROM target
             WHERE item.user_id = :user_id
               AND item.dismissal_token = :dismissal_token
               AND item.dismissed_at IS NOT NULL
            RETURNING id
            """,
                {"user_id": user_id, "item_id": item_id, "dismissal_token": dismissal_token},
            )
            .data
            or []
        )
        return {"status": "ok", "restored": any(row.get("id") == item_id for row in rows)}

    def clear(
        self,
        user_id: str,
        *,
        up_to_id: int,
        through_time: datetime | None = None,
        snapshot_fingerprint: str | None = None,
    ) -> dict[str, Any]:
        """Dismiss only the owner's current snapshot, leaving later events live.

        A Drive row stored above the watermark that the Feed was folding behind
        a cleared row is part of that snapshot; it is hidden too, so it cannot
        surface once the row hiding it is cleared.
        """
        newer_drive_rows = (
            self._get_db()
            .execute_raw(_DRIVE_ROWS_ABOVE_CLEAR_SQL, {"user_id": user_id, "up_to_id": up_to_id})
            .data
            or []
        )
        surfacing_ids = self._drive_rows_surfaced(
            user_id, newer_drive_rows, lambda item: int(item["id"]) <= up_to_id
        )
        if snapshot_fingerprint is not None:
            rows = (
                self._get_db()
                .execute_raw(
                    guarded_acknowledgment_sql(
                        clear=True,
                        protected_incident=active_incident_sql(
                            "item", self._feed_source_columns(), feed_uuid_sql
                        ),
                    ),
                    {
                        "user_id": user_id,
                        "up_to_id": up_to_id,
                        "through_time": through_time,
                        "snapshot_fingerprint": snapshot_fingerprint,
                        "surfacing_ids": surfacing_ids,
                        "dismissal_token": str(uuid4()),
                    },
                )
                .data
                or []
            )
            return {
                "status": "ok",
                "clear_version": max(
                    (row["clear_version"] for row in rows if row["clear_version"] is not None),
                    key=int,
                    default=None,
                ),
                "snapshot_changed": not bool(rows),
            }
        result = self._get_db().execute_raw(
            # Closed source/schema fragments only; values remain in execute_raw parameters.
            """
            UPDATE feed_events AS item
               SET dismissed_at = now(),
                   dismissal_token = :dismissal_token,
                   read_at = COALESCE(read_at, now())
             WHERE user_id = :user_id AND (id <= :up_to_id
               OR id = ANY(CAST(:surfacing_ids AS BIGINT[])))
            """
            + " AND NOT ("  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
            + active_incident_sql("item", self._feed_source_columns(), feed_uuid_sql)
            + ")"
            + (
                " AND created_at<=:through_time RETURNING CAST(EXTRACT(EPOCH FROM dismissed_at)*1000000 AS BIGINT)::text AS clear_version"
                if through_time
                else ""
            ),
            {
                **({"through_time": through_time} if through_time else {}),
                "user_id": user_id,
                "up_to_id": up_to_id,
                "dismissal_token": str(uuid4()),
                "surfacing_ids": surfacing_ids,
            },
        )
        if through_time is not None:
            rows = result.data or []
            return {"status": "ok", "clear_version": rows[0]["clear_version"] if rows else None}
        return {"status": "ok"}

    @staticmethod
    def _to_item(row: dict[str, Any], viewer_user_id: str | None = None) -> dict[str, Any]:
        metadata = _safe_feed_metadata(row.get("metadata"))
        if row.get("source_domain") == "calendar_email_followup":
            # Only this owner-scoped reminder may expose its opaque Calendar
            # selector. The shared metadata allowlist still excludes account
            # identifiers from every other Feed domain.
            source_metadata = row.get("metadata")
            raw = source_metadata.get("account_id") if isinstance(source_metadata, dict) else None
            if isinstance(raw, str) and re.fullmatch(r"(?:default|[A-Za-z0-9_-]{1,64})", raw):
                metadata["account_id"] = raw
        # A participant-scoped live receipt, never a persisted metadata claim.
        if row.get("_drive_existing_access_nocharge") is True:
            metadata["current_existing_access_nocharge"] = True
        if row.get("_drive_outcome_reason") in {"no_matching_files", "matching_files_unshareable"}:
            metadata["current_outcome_reason"] = row["_drive_outcome_reason"]
        metadata.pop("wallet_card_grant_id", None)
        metadata.pop("wallet_card_request_id", None)
        metadata.pop("wallet_card_request_status", None)
        if str(row.get("thread_key", "")).startswith("legacy-funding:"):
            metadata["retained_funding_history"] = True
        metadata.update(chat_activity_fields(row))
        if row.get("feed_silent") is True:
            metadata["feed_silent"] = True
        if row.get("event_type") == _DIRECT_MESSAGE_RECEIVED_EVENT:
            card_request = row.get("_wallet_card_request")
            if isinstance(card_request, dict) and _direct_message_source_id(
                card_request.get("request_id")
            ):
                metadata["wallet_card_request_id"] = card_request["request_id"]
                if card_request.get("status") in {
                    "pending",
                    "fulfilled",
                    "declined",
                    "cancelled",
                    "expired",
                }:
                    metadata["wallet_card_request_status"] = card_request["status"]
            # These fields originate only from `_with_direct_message_previews`.
            # Do not admit a message preview or conversation id from persisted
            # Feed metadata: that table is intentionally plaintext-free.
            counterpart_label = _bounded_text(
                row.get(_DIRECT_MESSAGE_COUNTERPART_LABEL_FIELD),
                limit=_MAX_ACTOR_LABEL_LENGTH,
            )
            if counterpart_label is not None:
                metadata["counterpart_label"] = counterpart_label

            conversation_id = _direct_message_source_id(row.get(_DIRECT_MESSAGE_CONVERSATION_FIELD))
            if conversation_id is not None:
                metadata["direct_message_conversation_id"] = conversation_id
                if viewer_user_id:
                    from hushh_mcp.services.direct_message_route_cipher import (
                        DirectMessageRouteCipher,
                    )

                    try:
                        metadata["direct_message_route_token"] = DirectMessageRouteCipher().seal(
                            viewer_user_id, "conversation", conversation_id
                        )
                    except DirectMessagesError:
                        pass  # Keep Feed readable; unavailable messaging opens the inbox.

            preview = _direct_message_preview(row.get(_DIRECT_MESSAGE_PREVIEW_FIELD))
            if preview is not None:
                metadata["message_preview"] = preview
            grant_id = _direct_message_source_id(row.get("_wallet_card_grant_id"))
            if grant_id:
                metadata["wallet_card_grant_id"] = grant_id
                actor = _bounded_text(
                    metadata.get("counterpart_label") or row.get("actor_label"),
                    limit=_MAX_ACTOR_LABEL_LENGTH,
                )
                metadata["message_preview"] = f"{actor or 'Someone'} shared their card with you"
        if (
            row.get("event_type") == "document_share_outcome"
            and metadata.get("feed_audience") == "recipient"
            and metadata.get("user_facing_status") == "no_match"
        ):
            metadata["user_facing_status"] = "no_files_shared"
        return {
            **activity_fields(row, metadata),
            "actor_label": _bounded_text(row.get("actor_label"), limit=_MAX_ACTOR_LABEL_LENGTH),
            "metadata": metadata,
        }


def _uuid_prefix(value: str) -> str | None:
    candidate = str(value or "").strip().split(":", 1)[0]
    if not candidate:
        return None
    try:
        return str(UUID(candidate))
    except ValueError:
        return None
