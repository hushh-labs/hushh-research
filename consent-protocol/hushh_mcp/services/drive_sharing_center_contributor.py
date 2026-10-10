"""Metadata-only Consent Center projection. A row is never sharing authority.

No credential or document key is needed: recorded access remains manageable
after disconnect, a rollout kill switch, or erasure of the private request.
"""

from typing import Any, cast

from sqlalchemy import text

from hushh_mcp.services.drive_live_preferences import LIVE_BACKGROUND_DISCLOSURE
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH
from hushh_mcp.services.stripe_mode import configured_stripe_mode

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
  SELECT drive_share_requests.request_id,drive_share_requests.revision,
    drive_share_requests.created_at,'share' AS source,
    CASE WHEN drive_share_requests.recipient_user_id=:user THEN 'outgoing' ELSE 'incoming' END AS direction,
    {counterpart_label} AS counterpart_label,
    CASE WHEN drive_share_requests.status IN ('pending','preparing','review_ready')
      AND drive_share_requests.expires_at<=now()
      THEN 'expired'
      WHEN drive_share_requests.recipient_user_id=:user
        AND drive_share_requests.status IN ('preparing','review_ready') THEN 'pending'
      WHEN drive_share_requests.recipient_user_id=:user
        AND drive_share_requests.status='no_match' THEN 'no_files_shared'
      ELSE drive_share_requests.status END AS state,
    drive_share_requests.preparation_error_code,
    {owner_search_state} AS owner_search_state,
    {trusted_authority_ready} AS trusted_authority_ready,
    {trusted_batch_seen} AS trusted_batch_seen,
    {trusted_work_active} AS trusted_work_active,
    {trusted_recovery_needed} AS trusted_recovery_needed,
    {payment_status} AS payment_status,
    {payment_amount_cents} AS payment_amount_cents,
    {payment_currency} AS payment_currency,
    {payment_reconciliation_required} AS payment_reconciliation_required,
    {payment_link_expired} AS payment_link_expired,
    {checkout_expires_at} AS checkout_expires_at,
    drive_share_requests.access_stop_requested_at IS NOT NULL AS access_stopped,
    {owner_decision_ready} AS owner_decision_ready,
    {payment_required} AS payment_required,
    {owner_allowed} AS owner_allowed,
    {quoted_amount_cents} AS quoted_amount_cents,
    {quote_version} AS quote_version,
    {owner_payout_account_ready} AS owner_payout_account_ready,
    {owner_price_ready} AS owner_price_ready
  FROM drive_share_requests
  {identity_joins}
  WHERE drive_share_requests.user_id=:user
    OR drive_share_requests.recipient_user_id=:user
  UNION ALL
  SELECT request_id,revocation_revision,created_at,'share','incoming',NULL::text,'management_only',
    NULL::text,NULL::text,FALSE,FALSE,FALSE,FALSE,NULL::text,NULL::integer,NULL::text,NULL::boolean,FALSE,NULL::timestamptz,FALSE,
    FALSE,FALSE,FALSE,NULL::integer,NULL::integer,NULL::boolean,FALSE
  FROM drive_share_management_contexts
  WHERE user_id=:user AND private_request_erased_at IS NOT NULL{queries}
), classified AS (
  SELECT p.*,
    CASE WHEN p.access_stopped THEN 'history'
    WHEN EXISTS (
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
    CASE WHEN access_stopped THEN 'stopped'
         WHEN bucket='active_grants' THEN 'active'
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
    NULL::text,
    CASE WHEN status='pending' AND expires_at<=now() THEN 'expired'
      -- An abandoned claim (DriveLiveQueryStore.STALE_CLAIM_SECONDS) reads like the view.
      WHEN status='running' AND expires_at<=now()
        AND decided_at < now() - interval '300 seconds' THEN 'expired'
      WHEN status='running' THEN 'pending'
      ELSE status END,
    NULL::text,NULL::text,FALSE,FALSE,FALSE,FALSE,NULL::text,NULL::integer,NULL::text,NULL::boolean,FALSE,NULL::timestamptz,FALSE,
    FALSE,FALSE,FALSE,NULL::integer,NULL::integer,NULL::boolean,FALSE
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
    AND {recipient_authority}
)"""

_TRUSTED_RECIPIENT = """EXISTS (
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
    )"""

_ACTIVE_CONNECTION = """EXISTS (
    SELECT 1 FROM connections conn
    WHERE conn.status='active'
      AND ((conn.user_a_id=drive_share_requests.user_id
            AND conn.user_b_id=drive_share_requests.recipient_user_id)
        OR (conn.user_b_id=drive_share_requests.user_id
            AND conn.user_a_id=drive_share_requests.recipient_user_id))
  )"""

# The owner's Allow is per-request authority over any active connection. The
# timestamp is a plaintext hint; the sealed request marker remains authority.
# A disconnect clears the timestamp, which ends the Allow for good.
_OWNER_ALLOWED_RECIPIENT = (
    "(drive_share_requests.owner_allowed_at IS NOT NULL AND " + _ACTIVE_CONNECTION + ")"
)

# Allow/Deny is offered only for a fresh requester-driven request that no
# automatic, manual or paid flow has claimed, from someone outside the owner's
# Trusted circle, while the pair is connected and the owner's Drive is live. A
# current Trusted member keeps the Trusted path. The Allow route rechecks the
# complete state, including the sealed request.
_OWNER_DECISION_READY = """((drive_share_requests.preparation_error_code IS NULL
  OR drive_share_requests.preparation_error_code IN
    ('owner_price_required','owner_payout_required','payout_unavailable'))
  AND drive_share_requests.owner_allowed_at IS NULL
  AND drive_share_requests.bulk_search_started_at IS NULL
  AND drive_share_requests.preparation_next_at<drive_share_requests.expires_at
  AND {no_payment_order}
  AND {active_connection}
  AND NOT {trusted_recipient}
  AND EXISTS (
    SELECT 1 FROM user_external_connector_connections c
    WHERE c.user_id=drive_share_requests.user_id AND c.connector_id='google_drive'
      AND c.status='connected' AND c.validation_state='verified'
      AND c.verified_policy_hash=:live_policy_hash
  ))"""

_NO_PAYMENT_ORDER = """NOT EXISTS (
    SELECT 1 FROM drive_request_payment_orders pay
    WHERE pay.request_id=drive_share_requests.request_id
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

_COUNTERPART_LABEL = """CASE WHEN drive_share_requests.recipient_user_id=:user
  THEN COALESCE(NULLIF(owner_identity.display_name,''), 'Document request')
  ELSE COALESCE(NULLIF(recipient_identity.display_name,''), 'Document request')
END"""

_IDENTITY_JOINS = """LEFT JOIN actor_identity_cache owner_identity
    ON owner_identity.user_id=drive_share_requests.user_id
  LEFT JOIN actor_identity_cache recipient_identity
    ON recipient_identity.user_id=drive_share_requests.recipient_user_id"""


def _trusted_authority_ready(owner_allowed: bool) -> str:
    recipient = (
        "(" + _TRUSTED_RECIPIENT + " OR " + _OWNER_ALLOWED_RECIPIENT + ")"
        if owner_allowed
        else _TRUSTED_RECIPIENT
    )
    return _TRUSTED_AUTHORITY_READY.replace("{recipient_authority}", recipient)


def _owner_decision_ready(payments: bool) -> str:
    return (
        _OWNER_DECISION_READY.replace(
            "{no_payment_order}", _NO_PAYMENT_ORDER if payments else "TRUE"
        )
        .replace("{active_connection}", _ACTIVE_CONNECTION)
        .replace("{trusted_recipient}", _TRUSTED_RECIPIENT)
    )


def _projection(
    queries: bool,
    owner_search: bool,
    bulk: bool,
    background: bool,
    payments: bool,
    identity_cache: bool,
    owner_allowed: bool,
    pricing: bool = False,
    payout_projection: bool = False,
) -> str:
    projection = _PROJECTION.replace("{queries}", _QUERIES if queries else "")
    projection = projection.replace("{identity_joins}", _IDENTITY_JOINS if identity_cache else "")
    projection = projection.replace(
        "{counterpart_label}",
        _COUNTERPART_LABEL if identity_cache else "'Document request'::text",
    )
    for name, expression in {
        "owner_search_state": _OWNER_SEARCH_STATE if owner_search else "'unavailable'::text",
        "trusted_authority_ready": _trusted_authority_ready(owner_allowed)
        if background
        else "FALSE",
        "trusted_batch_seen": _TRUSTED_BATCH_SEEN if bulk else "FALSE",
        "trusted_work_active": _TRUSTED_WORK_ACTIVE if bulk and owner_search else "FALSE",
        "trusted_recovery_needed": _TRUSTED_RECOVERY_NEEDED if bulk else "FALSE",
        "payment_status": """(SELECT CASE WHEN pay.stripe_mode<>:stripe_mode
          AND pay.status IN ('awaiting_payment','checkout_open') THEN 'expired' ELSE pay.status END
          FROM drive_request_payment_orders pay
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
        "payment_link_expired": """(SELECT (pay.status NOT IN ('paid','refunded')
          AND pay.stripe_checkout_session_id IS NOT NULL
          AND pay.stripe_checkout_expires_at IS NOT NULL
          AND pay.stripe_checkout_expires_at <= clock_timestamp())
          FROM drive_request_payment_orders pay
          WHERE pay.request_id=drive_share_requests.request_id
            AND drive_share_requests.recipient_user_id=:user)"""
        if payments
        else "FALSE",
        "checkout_expires_at": """(SELECT CASE WHEN pay.stripe_checkout_session_id IS NOT NULL
            THEN pay.stripe_checkout_expires_at END
          FROM drive_request_payment_orders pay
          WHERE pay.request_id=drive_share_requests.request_id
            AND drive_share_requests.recipient_user_id=:user)"""
        if payments
        else "NULL::timestamptz",
        # Without migration 291 no request can be allowed, so none is offered.
        "owner_decision_ready": _owner_decision_ready(payments) if owner_allowed else "FALSE",
        "owner_price_ready": "("
        + _ACTIVE_CONNECTION
        + " AND "
        + _TRUSTED_RECIPIENT
        + " AND "
        + _trusted_authority_ready(False)
        + " AND "
        + _NO_PAYMENT_ORDER
        + " AND drive_share_requests.payment_required=TRUE"
        + " AND drive_share_requests.owner_allowed_at IS NULL"
        + " AND (drive_share_requests.quoted_amount_cents IS NULL"
        + " OR drive_share_requests.preparation_error_code IS NULL)"
        + " AND drive_share_requests.bulk_search_started_at IS NULL"
        + " AND drive_share_requests.preparation_lease_id IS NULL"
        + " AND drive_share_requests.preparation_attempts=0"
        + " AND (drive_share_requests.preparation_error_code='owner_price_required'"
        + " OR drive_share_requests.preparation_error_code IS NULL))"
        if payments and pricing and owner_allowed and background
        else "FALSE",
        "payment_required": "drive_share_requests.payment_required" if payments else "FALSE",
        "owner_allowed": "drive_share_requests.owner_allowed_at IS NOT NULL"
        if owner_allowed
        else "FALSE",
        "quoted_amount_cents": "drive_share_requests.quoted_amount_cents"
        if pricing
        else "NULL::integer",
        "quote_version": "drive_share_requests.quote_version" if pricing else "NULL::integer",
        "owner_payout_account_ready": """CASE WHEN
          drive_share_requests.payment_required=TRUE
          AND NOT EXISTS (SELECT 1 FROM drive_request_payment_orders pay
            WHERE pay.request_id=drive_share_requests.request_id
              AND pay.status IN ('paid','refunded'))
          AND ((drive_share_requests.status IN ('pending','preparing','review_ready')
            AND drive_share_requests.expires_at>clock_timestamp()
            AND drive_share_requests.preparation_error_code IN
              ('owner_price_required','owner_payout_required','payout_unavailable'))
            OR (drive_share_requests.user_id=:user
              AND drive_share_requests.quoted_amount_cents IS NOT NULL
              AND ((drive_share_requests.status IN
                ('pending','preparing','review_ready','approved','partial')
                AND drive_share_requests.expires_at>clock_timestamp())
                OR EXISTS (SELECT 1 FROM drive_request_owner_payouts p
                  WHERE p.request_id=drive_share_requests.request_id
                    AND p.status='awaiting_account'))))
          THEN EXISTS (SELECT 1 FROM stripe_owner_payout_accounts account
            WHERE account.user_id=drive_share_requests.user_id
              AND account.account_ready=TRUE AND account.stripe_mode=:stripe_mode)
          ELSE NULL END"""
        if payments and pricing and payout_projection
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
    request_open = (
        not row.get("access_stopped")
        and row["state"] == "pending"
        and row["bucket"]
        in {
            "incoming_requests",
            "outgoing_requests",
            "active_grants",
        }
    )
    setup_waiting = bool(
        request_open
        and row.get("payment_status") not in {"paid", "refunded", "expired"}
        and preparation_code
        in {"owner_price_required", "owner_payout_required", "payout_unavailable"}
    )
    owner_price_required = setup_waiting and row.get("quoted_amount_cents") is None
    payout_setup_required = request_open and row.get("owner_payout_account_ready") is False
    setup_description = (
        ("Link payouts" if row["direction"] == "incoming" else "Waiting for owner setup")
        if payout_setup_required
        else ("Set price" if row["direction"] == "incoming" else "Waiting for price")
        if owner_price_required
        else "Payments unavailable"
        if setup_waiting and preparation_code == "payout_unavailable"
        else None
    )
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
    # Allow/Deny belongs only to the owner's own open request task.
    owner_decision_available = bool(
        row["direction"] == "incoming"
        and row["bucket"] == "incoming_requests"
        and row["state"] == "pending"
        and not row.get("access_stopped")
        and row.get("owner_decision_ready") is True
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
            setup_description
            if setup_description
            else "Enable background Drive access"
            if row["bucket"] == "incoming_requests"
            and preparation_code == "background_preparation_required"
            else "Waiting for requester payment"
            if owner_payment_waiting
            else "Google Drive files"
        ),
        "counterpart_type": "investor",
        "counterpart_id": None,
        "counterpart_label": row.get("counterpart_label") or "Document request",
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
            "accessStopped": row.get("access_stopped") is True,
            # A Trusted Circle request stays pending while automatic search and
            # sharing run. Only the sharing authority can distinguish that
            # progress from an owner task or a paused/manual recovery.
            "owner_attention_required": row["state"] == "pending"
            and row["bucket"] == "incoming_requests"
            and not row.get("access_stopped")
            and not automatic_progressing
            and (not owner_payment_blocked or payout_setup_required or setup_waiting),
            "owner_decision_available": owner_decision_available,
            "owner_price_available": bool(
                row["direction"] == "incoming"
                and row["bucket"] == "incoming_requests"
                and row["state"] == "pending"
                and not row.get("access_stopped")
                and row.get("owner_price_ready") is True
                and row.get("owner_payout_account_ready") is True
            ),
            "owner_allowed": row.get("owner_allowed") is True,
            **(
                {"payment_required": row.get("payment_required") is True}
                if row["direction"] == "incoming"
                else {}
            ),
            **({"payment_waiting_for_requester": True} if owner_payment_waiting else {}),
            **(
                {"ownerPayoutAccountReady": row["owner_payout_account_ready"] is True}
                if row.get("owner_payout_account_ready") is not None
                else {}
            ),
            **(
                {
                    "ownerPriceRequired": owner_price_required,
                    "paymentsReady": preparation_code != "payout_unavailable",
                }
                if setup_waiting
                else {}
            ),
            **(
                {
                    "quotedAmountCents": row["quoted_amount_cents"],
                    "quoteVersion": row["quote_version"],
                    "paymentRequired": True,
                }
                if row["direction"] == "outgoing" and row.get("quoted_amount_cents") is not None
                else {}
            ),
            **(
                {
                    "paymentStatus": row["payment_status"],
                    "paymentAmountCents": row["payment_amount_cents"],
                    "paymentCurrency": row["payment_currency"],
                    "paymentReconciliationRequired": row["payment_reconciliation_required"] is True,
                    "paymentLinkExpired": row["payment_link_expired"] is True,
                    "checkoutExpiresAt": (
                        row["checkout_expires_at"].isoformat()
                        if row.get("checkout_expires_at") is not None
                        else None
                    ),
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
    def _owner_allowed_installed(connection) -> bool:
        return bool(
            connection.execute(
                text("""SELECT EXISTS (
                  SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_share_requests')
                    AND attname='owner_allowed_at' AND NOT attisdropped
                )""")
            ).scalar_one()
        )

    @staticmethod
    def _pricing_installed(connection) -> bool:
        return bool(
            connection.execute(
                text("""SELECT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_share_requests')
                    AND attname='quoted_amount_cents' AND NOT attisdropped)
                  AND EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_share_requests')
                    AND attname='quote_version' AND NOT attisdropped)""")
            ).scalar_one()
        )

    @staticmethod
    def _payout_projection_installed(connection) -> bool:
        return bool(
            connection.execute(
                text("""SELECT to_regclass('drive_request_owner_payouts') IS NOT NULL
                  AND to_regclass('stripe_owner_payout_accounts') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid=to_regclass('stripe_owner_payout_accounts')
                      AND attname='account_ready' AND NOT attisdropped)""")
            ).scalar_one()
        )

    @staticmethod
    def _identity_cache_installed(connection) -> bool:
        # Test fixtures and rolling deployments can predate the optional
        # identity cache. Keep the metadata projection available with its
        # generic label until that table is installed.
        return bool(
            connection.execute(
                text("SELECT to_regclass('actor_identity_cache') IS NOT NULL")
            ).scalar_one()
        )

    @staticmethod
    def _params(user_id: str, *, query: str = "", bucket: str = "") -> dict[str, Any]:
        return {
            "user": user_id,
            "stripe_mode": configured_stripe_mode(),
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
                        self._identity_cache_installed(connection),
                        self._owner_allowed_installed(connection),
                        self._pricing_installed(connection),
                        self._payout_projection_installed(connection),
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
                            self._identity_cache_installed(connection),
                            self._owner_allowed_installed(connection),
                            self._pricing_installed(connection),
                            self._payout_projection_installed(connection),
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
                        self._identity_cache_installed(connection),
                        self._owner_allowed_installed(connection),
                        self._pricing_installed(connection),
                        self._payout_projection_installed(connection),
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
