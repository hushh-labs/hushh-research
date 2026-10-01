"""Metadata-only Consent Center projection. A row is never sharing authority.

No credential or document key is needed: recorded access remains manageable
after disconnect, a rollout kill switch, or erasure of the private request.
"""

from typing import Any, cast

from sqlalchemy import text

from hushh_mcp.services.drive_live_preferences import LIVE_BACKGROUND_DISCLOSURE
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH

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
      ELSE status END AS state,
    preparation_error_code,
    {owner_search_state} AS owner_search_state,
    {trusted_authority_ready} AS trusted_authority_ready,
    {trusted_batch_seen} AS trusted_batch_seen,
    {trusted_work_active} AS trusted_work_active,
    {trusted_recovery_needed} AS trusted_recovery_needed,
    {payment_status} AS payment_status,
    {payment_amount_cents} AS payment_amount_cents,
    {payment_currency} AS payment_currency,
    {payment_reconciliation_required} AS payment_reconciliation_required
  FROM drive_share_requests WHERE user_id=:user OR recipient_user_id=:user
  UNION ALL
  SELECT request_id,revocation_revision,created_at,'share','incoming','management_only',
    NULL::text,NULL::text,FALSE,FALSE,FALSE,FALSE,NULL::text,NULL::integer,NULL::text,NULL::boolean
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
      OR (bucket='incoming_requests'
        AND preparation_error_code='background_preparation_required'
        AND strpos(lower('Enable background Drive access'),:query)>0)
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
      ELSE status END,
    NULL::text,NULL::text,FALSE,FALSE,FALSE,FALSE,NULL::text,NULL::integer,NULL::text,NULL::boolean
  FROM drive_live_query_requests WHERE user_id=:user OR requester_user_id=:user"""

_OWNER_SEARCH_STATE = """(
  SELECT CASE WHEN j.expires_at<=clock_timestamp() THEN 'expired' ELSE j.status END
  FROM drive_owner_search_jobs j
  WHERE j.user_id=drive_share_requests.user_id
    AND j.client_request_id=drive_share_requests.request_id
)"""

_TRUSTED_AUTHORITY_READY = """EXISTS (
  SELECT 1 FROM user_external_connector_connections c
  LEFT JOIN drive_live_preferences pref ON pref.user_id=c.user_id
  WHERE c.user_id=drive_share_requests.user_id AND c.connector_id='google_drive'
    AND c.status='connected' AND c.validation_state='verified'
    AND c.verified_policy_hash=:live_policy_hash
    AND (pref.user_id IS NULL OR (pref.background_enabled=TRUE
      AND pref.disclosure_version=:background_disclosure))
    AND EXISTS (
      SELECT 1 FROM connections conn
      JOIN connection_origins origin ON origin.connection_id=conn.id
        AND origin.status='active'
        AND origin.origin_kind IN ('direct_request','legacy_invite')
      WHERE conn.status='active'
        AND ((conn.user_a_id=drive_share_requests.user_id
              AND conn.user_b_id=drive_share_requests.recipient_user_id)
          OR (conn.user_b_id=drive_share_requests.user_id
              AND conn.user_a_id=drive_share_requests.recipient_user_id))
        AND EXISTS (
          SELECT 1 FROM one_location_circles circle
          JOIN one_location_circle_memberships member ON member.circle_id=circle.id
          WHERE circle.owner_user_id=drive_share_requests.user_id
            AND circle.system_kind='trusted' AND circle.status='active'
            AND member.user_id=drive_share_requests.recipient_user_id
            AND member.status='active'
        )
    )
)"""

_TRUSTED_BATCH_SEEN = """EXISTS (
  SELECT 1 FROM drive_bulk_shares b
  WHERE b.user_id=drive_share_requests.user_id
    AND b.origin_request_id=drive_share_requests.request_id
    AND b.progressive_batch=TRUE
)"""

_TRUSTED_WORK_ACTIVE = """(
  EXISTS (
    SELECT 1 FROM drive_bulk_shares b
    WHERE b.user_id=drive_share_requests.user_id
      AND b.origin_request_id=drive_share_requests.request_id
      AND b.progressive_batch=TRUE AND b.expires_at>clock_timestamp()
      AND (b.status IN ('review_ready','queued','running')
        OR EXISTS (SELECT 1 FROM drive_bulk_share_effects effect
          WHERE effect.share_id=b.share_id
            AND effect.state IN ('queued','dispatching','unknown')))
  ) OR EXISTS (
    SELECT 1 FROM drive_owner_search_results result
    JOIN drive_owner_search_jobs job ON job.job_id=result.job_id
    WHERE job.user_id=drive_share_requests.user_id
      AND job.client_request_id=drive_share_requests.request_id
      AND NOT EXISTS (
        SELECT 1 FROM drive_bulk_share_files file
        WHERE file.user_id=drive_share_requests.user_id
          AND file.origin_request_id=drive_share_requests.request_id
          AND file.source_position=result.position
      )
  )
)"""

# A skipped automatic effect that requires explicit review is not still "working".
_TRUSTED_RECOVERY_NEEDED = """EXISTS (
  SELECT 1 FROM drive_bulk_shares b
  JOIN drive_bulk_share_files file ON file.share_id=b.share_id
    AND file.origin_request_id=drive_share_requests.request_id
  JOIN drive_bulk_share_effects effect ON effect.share_id=file.share_id
    AND effect.position=file.position
    AND effect.recipient_user_id=drive_share_requests.recipient_user_id
  WHERE b.user_id=drive_share_requests.user_id
    AND b.origin_request_id=drive_share_requests.request_id
    AND b.progressive_batch=TRUE AND b.approval_source='trusted_auto'
    AND effect.state='skipped' AND effect.safe_error_code='recipient_changed'
    AND effect.attempts=0 AND effect.receipt_envelope IS NULL
)"""


def _projection(
    queries: bool, owner_search: bool, bulk: bool, background: bool, payments: bool
) -> str:
    projection = _PROJECTION.replace("{queries}", _QUERIES if queries else "")
    for name, expression in {
        "owner_search_state": _OWNER_SEARCH_STATE if owner_search else "'unavailable'::text",
        "trusted_authority_ready": _TRUSTED_AUTHORITY_READY if background else "FALSE",
        "trusted_batch_seen": _TRUSTED_BATCH_SEEN if bulk else "FALSE",
        "trusted_work_active": _TRUSTED_WORK_ACTIVE if bulk and owner_search else "FALSE",
        "trusted_recovery_needed": _TRUSTED_RECOVERY_NEEDED if bulk else "FALSE",
        "payment_status": """(SELECT pay.status FROM drive_request_payment_orders pay
          WHERE pay.request_id=drive_share_requests.request_id)"""
        if payments
        else "NULL::text",
        "payment_amount_cents": """(SELECT pay.amount_cents FROM drive_request_payment_orders pay
          WHERE pay.request_id=drive_share_requests.request_id
            AND drive_share_requests.recipient_user_id=:user)"""
        if payments
        else "NULL::integer",
        "payment_currency": """(SELECT pay.currency FROM drive_request_payment_orders pay
          WHERE pay.request_id=drive_share_requests.request_id
            AND drive_share_requests.recipient_user_id=:user)"""
        if payments
        else "NULL::text",
        "payment_reconciliation_required": """(SELECT pay.reconciliation_required FROM drive_request_payment_orders pay
          WHERE pay.request_id=drive_share_requests.request_id)"""
        if payments
        else "NULL::boolean",
    }.items():
        projection = projection.replace("{" + name + "}", expression)
    return projection


def entry(row: Any) -> dict[str, Any]:
    """Closed presentation shape; cannot enter the generic PKM grant path."""
    if row.get("source") == "query":
        return _query_entry(row)
    preparation_code = row.get("preparation_error_code")
    search_state = row.get("owner_search_state")
    # Once the first Google grant succeeds, the same still-running request
    # moves to active_grants for access management. Keep its progress metadata.
    request_open = row["state"] == "pending" and row["bucket"] in {
        "incoming_requests",
        "outgoing_requests",
        "active_grants",
    }
    owner_payment_waiting = (
        request_open
        and row["direction"] == "incoming"
        and row.get("payment_status")
        in {
            "awaiting_payment",
            "checkout_open",
        }
    )
    owner_payment_blocked = row["direction"] == "incoming" and (
        row.get("payment_status") in {"awaiting_payment", "checkout_open", "refunded", "expired"}
        or row.get("payment_reconciliation_required") is True
    )
    live_search = search_state in {"queued", "running"} or (
        search_state == "completed" and row.get("trusted_work_active") is True
    )
    automatic_progressing = bool(
        request_open
        and row.get("payment_status")
        not in {"awaiting_payment", "checkout_open", "refunded", "expired"}
        and row.get("payment_reconciliation_required") is not True
        and row.get("trusted_authority_ready") is True
        and row.get("trusted_recovery_needed") is not True
        and (
            preparation_code == "trusted_auto_queued"
            and (search_state is None or live_search)
            or preparation_code == "trusted_auto_active"
            and live_search
        )
    )
    automatic_stage = (
        (
            "sharing"
            if row.get("trusted_batch_seen") is True
            else "finding"
            if search_state in {"queued", "running", "completed"}
            else "preparing"
        )
        if automatic_progressing
        else None
    )
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
        "scope_description": (
            "Enable background Drive access"
            if row["bucket"] == "incoming_requests"
            and preparation_code == "background_preparation_required"
            else "Waiting for requester payment"
            if owner_payment_waiting
            else "Google Drive files"
        ),
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
            "automatic_progress_active": automatic_progressing,
            "automatic_progress_stage": automatic_stage,
            # A Trusted Circle request stays pending while automatic search and
            # sharing run. Only the sharing authority can distinguish that
            # progress from an owner task or a paused/manual recovery.
            "owner_attention_required": row["bucket"] == "incoming_requests"
            and not automatic_progressing
            and not owner_payment_blocked,
            **({"payment_waiting_for_requester": True} if owner_payment_waiting else {}),
            **(
                {
                    "paymentStatus": row["payment_status"],
                    "paymentAmountCents": row["payment_amount_cents"],
                    "paymentCurrency": row["payment_currency"],
                    "paymentReconciliationRequired": row["payment_reconciliation_required"] is True,
                }
                if row["direction"] == "outgoing" and row.get("payment_status") is not None
                else {}
            ),
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
    def _owner_search_installed(connection) -> bool:
        return bool(
            connection.execute(
                text("SELECT to_regclass('drive_owner_search_jobs') IS NOT NULL")
            ).scalar_one()
        )

    @staticmethod
    def _bulk_installed(connection) -> bool:
        return bool(
            connection.execute(
                text("""SELECT EXISTS (
                  SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_bulk_shares')
                    AND attname='progressive_batch' AND NOT attisdropped
                ) AND EXISTS (
                  SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_bulk_share_files')
                    AND attname='origin_request_id' AND NOT attisdropped
                )""")
            ).scalar_one()
        )

    @staticmethod
    def _background_installed(connection) -> bool:
        return bool(
            connection.execute(
                text("SELECT to_regclass('drive_live_preferences') IS NOT NULL")
            ).scalar_one()
        )

    @staticmethod
    def _payments_installed(connection) -> bool:
        return bool(
            connection.execute(
                text("SELECT to_regclass('drive_request_payment_orders') IS NOT NULL")
            ).scalar_one()
        )

    @staticmethod
    def _params(user_id: str, *, query: str = "", bucket: str = "") -> dict[str, Any]:
        return {
            "user": user_id,
            "query": query,
            "bucket": bucket,
            "live_policy_hash": LIVE_POLICY_HASH,
            "background_disclosure": LIVE_BACKGROUND_DISCLOSURE,
        }

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
                    _projection(
                        self._queries_installed(connection),
                        self._owner_search_installed(connection),
                        self._bulk_installed(connection),
                        self._background_installed(connection),
                        self._payments_installed(connection),
                    )  # nosec B608
                    + "SELECT bucket,count(*) AS total FROM filtered GROUP BY bucket"
                ),
                self._params(user_id),
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
                        _projection(
                            self._queries_installed(connection),
                            self._owner_search_installed(connection),
                            self._bulk_installed(connection),
                            self._background_installed(connection),
                            self._payments_installed(connection),
                        )  # nosec B608
                        + """
                        SELECT totals.total,page.* FROM (SELECT count(*) AS total FROM filtered) totals
                        LEFT JOIN LATERAL (
                          SELECT * FROM filtered ORDER BY issued_at DESC,id COLLATE "C" DESC
                          LIMIT :limit OFFSET :offset
                        ) page ON TRUE ORDER BY page.issued_at DESC,page.id COLLATE "C" DESC
                        """
                    ),
                    {
                        **self._params(user_id, query=query.strip().lower(), bucket=bucket),
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
                    _projection(
                        self._queries_installed(connection),
                        self._owner_search_installed(connection),
                        self._bulk_installed(connection),
                        self._background_installed(connection),
                        self._payments_installed(connection),
                    )  # nosec B608
                    + """
                    , ranked AS (
                      SELECT *,count(*) OVER (PARTITION BY bucket) AS total,
                        row_number() OVER (
                          PARTITION BY bucket ORDER BY issued_at DESC,id COLLATE "C" DESC
                        ) AS position FROM filtered
                    ) SELECT * FROM ranked WHERE position<=50 ORDER BY issued_at DESC,id COLLATE "C" DESC
                    """
                ),
                self._params(user_id),
            ).mappings()
            buckets: dict[str, list[dict[str, Any]]] = {key: [] for key in BUCKETS}
            counts = dict.fromkeys(BUCKETS, 0)
            for row in rows:
                buckets[row["bucket"]].append(entry(row))
                counts[row["bucket"]] = row["total"]
            return {"buckets": buckets, "counts": counts, "schema_available": True}

        return cast(dict[str, Any], await self._transaction(operation))
