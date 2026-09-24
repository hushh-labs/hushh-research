"""Metadata-only Consent Center projection. A row is never sharing authority.

No credential or document key is needed: recorded access remains manageable
after disconnect, a rollout kill switch, or erasure of the private request.
"""

from typing import Any, cast

from sqlalchemy import text

from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore

REQUEST_SOURCE = "drive_document_share_request"
QUERY_REQUEST_SOURCE = "drive_live_query_request"
BUCKETS = ("incoming_requests", "outgoing_requests", "active_grants", "history")
SURFACES = {
    "pending": "incoming_requests",
    "sent": "outgoing_requests",
    "active": "active_grants",
    "previous": "history",
}

# Only participant identifiers and operation state are read. In particular, no
# request/review/plan/receipt envelope participates in search or classification.
_PROJECTION = """
WITH participants AS (
  SELECT request_id,revision,created_at,'share' AS source,
    CASE WHEN recipient_user_id=:user THEN 'outgoing' ELSE 'incoming' END AS direction,
    CASE WHEN status IN ('pending','preparing','review_ready') AND expires_at<=now()
      THEN 'expired'
      WHEN recipient_user_id=:user AND status IN ('preparing','review_ready') THEN 'pending'
      ELSE status END AS state
  FROM drive_share_requests WHERE user_id=:user OR recipient_user_id=:user
  UNION ALL
  SELECT request_id,revocation_revision,created_at,'share','incoming','management_only'
  FROM drive_share_management_contexts
  WHERE user_id=:user AND private_request_erased_at IS NOT NULL{queries}
), classified AS (
  SELECT p.*,
    CASE WHEN EXISTS (
      SELECT 1 FROM drive_share_permission_operations g
      WHERE g.request_id=p.request_id AND g.kind='grant'
        AND g.state IN ('succeeded','preexisting','present_unattributed')
        AND NOT EXISTS (
          SELECT 1 FROM drive_share_permission_operations r
          WHERE r.parent_operation_id=g.operation_id AND r.kind='revoke'
            AND r.state IN ('succeeded','absent')
        )
    ) THEN 'active_grants'
    WHEN p.state IN ('pending','preparing','review_ready') OR (
      p.state='approved' AND EXISTS (
        SELECT 1 FROM drive_share_permission_operations o
        WHERE o.request_id=p.request_id AND o.kind='grant'
          AND o.state IN ('queued','dispatching','unknown')
      )
    ) THEN CASE WHEN p.direction='incoming' THEN 'incoming_requests' ELSE 'outgoing_requests' END
    ELSE 'history' END AS bucket
  FROM participants p
), entries AS (
  SELECT *, floor(extract(epoch FROM created_at)*1000)::bigint AS issued_at,
    CASE WHEN bucket='active_grants' THEN 'active'
         WHEN bucket IN ('incoming_requests','outgoing_requests') THEN 'pending'
         ELSE state END AS status,
    CASE WHEN source='query' THEN 'drive_query_request:' ELSE 'document_share_request:' END
      || request_id::text AS id
  FROM classified
), filtered AS (
  SELECT * FROM entries WHERE (:bucket='' OR bucket=:bucket) AND (
    :query='' OR strpos(lower(status),:query)>0 OR strpos(request_id::text,:query)>0
    OR (source='share' AND (strpos(lower('Document request'),:query)>0
      OR strpos(lower('Google Drive files'),:query)>0
      OR strpos(lower('DOCUMENT_SHARE_REVIEW'),:query)>0))
    OR (source='query' AND (strpos(lower('Drive question'),:query)>0
      OR strpos(lower('Google Drive question'),:query)>0
      OR strpos(lower('DRIVE_QUERY_REVIEW'),:query)>0))
  )
)
"""

# Questions carry no provider operations, so they never classify as active grants.
_QUERIES = """
  UNION ALL
  SELECT request_id,revision,created_at,'query',
    CASE WHEN requester_user_id=:user THEN 'outgoing' ELSE 'incoming' END,
    CASE WHEN status='pending' AND expires_at<=now() THEN 'expired'
      -- An abandoned claim (DriveLiveQueryStore.STALE_CLAIM_SECONDS) reads like the view.
      WHEN status='running' AND expires_at<=now()
        AND decided_at < now() - interval '300 seconds' THEN 'expired'
      WHEN status='running' THEN 'pending'
      ELSE status END
  FROM drive_live_query_requests WHERE user_id=:user OR requester_user_id=:user"""


def _projection(queries: bool) -> str:
    return _PROJECTION.replace("{queries}", _QUERIES if queries else "")


def entry(row: Any) -> dict[str, Any]:
    """Closed presentation shape; cannot enter the generic PKM grant path."""
    if row.get("source") == "query":
        return _query_entry(row)
    return {
        "id": row["id"],
        "request_id": str(row["request_id"]),
        "kind": {
            "incoming_requests": "incoming_request",
            "outgoing_requests": "outgoing_request",
            "active_grants": "active_grant",
            "history": "history",
        }[row["bucket"]],
        "status": row["status"],
        "action": "DOCUMENT_SHARE_REVIEW",
        "scope": None,
        "scope_description": "Google Drive files",
        "counterpart_type": "investor",
        "counterpart_id": None,
        "counterpart_label": "Document request",
        "issued_at": int(row["issued_at"]),
        "metadata": {
            "request_source": REQUEST_SOURCE,
            "request_id": str(row["request_id"]),
            "direction": row["direction"],
            "state": row["state"],
            "revision": row["revision"],
            "recorded_outcome_only": True,
        },
    }


def _query_entry(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "request_id": str(row["request_id"]),
        "kind": {
            "incoming_requests": "incoming_request",
            "outgoing_requests": "outgoing_request",
            "history": "history",
        }[row["bucket"]],
        "status": row["status"],
        "action": "DRIVE_QUERY_REVIEW",
        "scope": None,
        "scope_description": "Google Drive question",
        "counterpart_type": "investor",
        "counterpart_id": None,
        "counterpart_label": "Drive question",
        "issued_at": int(row["issued_at"]),
        "metadata": {
            "request_source": QUERY_REQUEST_SOURCE,
            "request_id": str(row["request_id"]),
            "direction": row["direction"],
            "state": row["state"],
            "revision": row["revision"],
            "recorded_outcome_only": True,
        },
    }


class DriveSharingCenterContributor(ExternalConnectorLifecycleStore):
    def _supports_projection(self) -> bool:
        # Existing SQLite-only callers have no Drive domain. Check the dialect
        # before the lifecycle store issues PostgreSQL transaction settings.
        # Real PostgreSQL SQL/timeout errors still propagate, never become zero.
        return self.db.engine.dialect.name == "postgresql"

    @staticmethod
    def _queries_installed(connection) -> bool:
        return bool(
            connection.execute(
                text("SELECT to_regclass('drive_live_query_requests') IS NOT NULL")
            ).scalar_one()
        )

    @staticmethod
    def _installed(connection) -> bool:
        # Rolling deployments may still be on the pre-sharing schema. This is
        # the only empty compatibility case; SQL/timeouts must remain errors.
        return bool(
            connection.execute(
                text("""
          SELECT to_regclass('drive_share_requests') IS NOT NULL
             AND to_regclass('drive_share_permission_operations') IS NOT NULL
             AND to_regclass('drive_share_management_contexts') IS NOT NULL
        """)
            ).scalar_one()
        )

    async def counts(self, user_id: str) -> dict[str, int]:
        if not self._supports_projection():
            return {**dict.fromkeys(BUCKETS, 0), "schema_available": False}

        def operation(connection):
            if not self._installed(connection):
                return {**dict.fromkeys(BUCKETS, 0), "schema_available": False}
            rows = connection.execute(
                # Both SQL fragments are static; every value is bound below.
                text(
                    _projection(self._queries_installed(connection))  # nosec B608
                    + "SELECT bucket,count(*) AS total FROM filtered GROUP BY bucket"
                ),
                {"user": user_id, "query": "", "bucket": ""},
            ).mappings()
            return {
                **dict.fromkeys(BUCKETS, 0),
                **{r["bucket"]: r["total"] for r in rows},
                "schema_available": True,
            }

        return cast(dict[str, int], await self._transaction(operation))

    async def page(
        self, user_id: str, *, bucket: str, limit: int, offset: int = 0, query: str = ""
    ) -> dict[str, Any]:
        if bucket not in BUCKETS or not 1 <= limit <= 100000 or not 0 <= offset <= 100000:
            raise ValueError("invalid_document_projection_page")
        if not self._supports_projection():
            return {"total": 0, "items": [], "schema_available": False}

        def operation(connection):
            if not self._installed(connection):
                return {"total": 0, "items": [], "schema_available": False}
            rows = list(
                connection.execute(
                    text(
                        # Both SQL fragments are static; every value is bound below.
                        _projection(self._queries_installed(connection))  # nosec B608
                        + """
                        SELECT totals.total,page.* FROM (SELECT count(*) AS total FROM filtered) totals
                        LEFT JOIN LATERAL (
                          SELECT * FROM filtered ORDER BY issued_at DESC,id COLLATE "C" DESC
                          LIMIT :limit OFFSET :offset
                        ) page ON TRUE ORDER BY page.issued_at DESC,page.id COLLATE "C" DESC
                        """
                    ),
                    {
                        "user": user_id,
                        "bucket": bucket,
                        "query": query.strip().lower(),
                        "limit": limit,
                        "offset": offset,
                    },
                ).mappings()
            )
            return {
                "total": rows[0]["total"],
                "items": [entry(row) for row in rows if row["request_id"] is not None],
                "schema_available": True,
            }

        return cast(dict[str, Any], await self._transaction(operation))

    async def preview(self, user_id: str) -> dict[str, Any]:
        """A bounded legacy snapshot with exact totals from the same statement."""
        if not self._supports_projection():
            return {
                "buckets": {key: [] for key in BUCKETS},
                "counts": dict.fromkeys(BUCKETS, 0),
                "schema_available": False,
            }

        def operation(connection):
            if not self._installed(connection):
                return {
                    "buckets": {key: [] for key in BUCKETS},
                    "counts": dict.fromkeys(BUCKETS, 0),
                    "schema_available": False,
                }
            rows = connection.execute(
                text(
                    # Both SQL fragments are static; every value is bound below.
                    _projection(self._queries_installed(connection))  # nosec B608
                    + """
                    , ranked AS (
                      SELECT *,count(*) OVER (PARTITION BY bucket) AS total,
                        row_number() OVER (
                          PARTITION BY bucket ORDER BY issued_at DESC,id COLLATE "C" DESC
                        ) AS position FROM filtered
                    ) SELECT * FROM ranked WHERE position<=50 ORDER BY issued_at DESC,id COLLATE "C" DESC
                    """
                ),
                {"user": user_id, "query": "", "bucket": ""},
            ).mappings()
            buckets: dict[str, list[dict[str, Any]]] = {key: [] for key in BUCKETS}
            counts = dict.fromkeys(BUCKETS, 0)
            for row in rows:
                buckets[row["bucket"]].append(entry(row))
                counts[row["bucket"]] = row["total"]
            return {"buckets": buckets, "counts": counts, "schema_available": True}

        return cast(dict[str, Any], await self._transaction(operation))
