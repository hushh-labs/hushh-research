"""Metadata-only Consent Center projection. A row is never sharing authority.

No credential or document key is needed: recorded access remains manageable
after disconnect, a rollout kill switch, or erasure of the private request.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import text

from hushh_mcp.services.drive_live_preferences import LIVE_BACKGROUND_DISCLOSURE
from hushh_mcp.services.drive_request_payment_view import requester_payment_view
from hushh_mcp.services.drive_request_queue import (
    EVALUATION_WAITING_SINCE_SQL,
    SEARCH_WAITING_SINCE_SQL,
    SHARING_WAITING_SINCE_SQL,
    queue_delayed,
    started_work_waiting_since,
)
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
    {owner_evaluation_state} AS owner_evaluation_state,
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
    {owner_price_ready} AS owner_price_ready,
    {owner_drive_ready} AS owner_drive_ready,
    drive_share_requests.expires_at AS request_expires_at,
    {payment_reconciliation_reason} AS payment_reconciliation_reason,
    {refund_status} AS refund_status,
    {refund_amount_cents} AS refund_amount_cents,
    {payment_owner_payout_ready} AS payment_owner_payout_ready,
    {estimate_known} AS estimate_known,
    {estimate_cents} AS estimate_cents,
    {agent_package} AS agent_package,
    {v1_live_request} AS v1_live_request,
    drive_share_requests.preparation_next_at AS automatic_queued_at,
    {owner_search_waiting_since} AS owner_search_waiting_since,
    {owner_evaluation_waiting_since} AS owner_evaluation_waiting_since,
    {trusted_sharing_waiting_since} AS trusted_sharing_waiting_since
  FROM drive_share_requests
  {identity_joins}
  WHERE drive_share_requests.user_id=:user
    OR drive_share_requests.recipient_user_id=:user
  UNION ALL
  SELECT request_id,revocation_revision,created_at,'share','incoming',NULL::text,'management_only',
    NULL::text,NULL::text,NULL::text,FALSE,FALSE,FALSE,FALSE,NULL::text,NULL::integer,NULL::text,NULL::boolean,FALSE,NULL::timestamptz,FALSE,
    FALSE,FALSE,FALSE,NULL::integer,NULL::integer,NULL::boolean,FALSE,NULL::boolean,
    NULL::timestamptz,NULL::text,NULL::text,NULL::integer,NULL::boolean,FALSE,NULL::integer,FALSE,FALSE,
    NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz
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
      OR (direction='incoming' AND state='pending' AND owner_drive_ready IS FALSE
        AND bucket IN ('incoming_requests','active_grants')
        AND strpos(lower('Connect Google Drive'),:query)>0)
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
    NULL::text,NULL::text,NULL::text,FALSE,FALSE,FALSE,FALSE,NULL::text,NULL::integer,NULL::text,NULL::boolean,FALSE,NULL::timestamptz,FALSE,
    FALSE,FALSE,FALSE,NULL::integer,NULL::integer,NULL::boolean,FALSE,NULL::boolean,
    NULL::timestamptz,NULL::text,NULL::text,NULL::integer,NULL::boolean,FALSE,NULL::integer,FALSE,FALSE,
    NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz
  FROM drive_live_query_requests WHERE user_id=:user OR requester_user_id=:user"""

_OWNER_SEARCH_STATE = """(
  SELECT CASE WHEN j.expires_at<=clock_timestamp() THEN 'expired' ELSE j.status END
  FROM drive_owner_search_jobs j
  WHERE j.user_id=drive_share_requests.user_id
    AND j.client_request_id=drive_share_requests.request_id
)"""

_OWNER_EVALUATION_STATE = """(
  SELECT j.evaluation_status FROM drive_owner_search_jobs j
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

# Allow, the automatic search and sharing all need the owner's live Drive.
_OWNER_DRIVE_READY = """EXISTS (
    SELECT 1 FROM user_external_connector_connections c
    WHERE c.user_id=drive_share_requests.user_id AND c.connector_id='google_drive'
      AND c.status='connected' AND c.validation_state='verified'
      AND c.verified_policy_hash=:live_policy_hash
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
  AND {owner_drive_ready})"""

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


# Requester-only inputs of the shared payment view; the owner's rows get NULL.
_PAYMENT_RECONCILIATION_REASON = """(SELECT pay.reconciliation_reason
  FROM drive_request_payment_orders pay
  WHERE pay.request_id=drive_share_requests.request_id
    AND drive_share_requests.recipient_user_id=:user)"""

_REFUND_STATUS = """(SELECT refund.status FROM drive_request_payment_refunds refund
  WHERE refund.request_id=drive_share_requests.request_id
    AND drive_share_requests.recipient_user_id=:user)"""

_REFUND_AMOUNT_CENTS = """(SELECT refund.amount_cents FROM drive_request_payment_refunds refund
  WHERE refund.request_id=drive_share_requests.request_id
    AND drive_share_requests.recipient_user_id=:user)"""

# An enrolled bank-settled order cannot open Checkout until the owner's payout
# account is ready (the same cached readiness Checkout rechecks live).
_PAYMENT_OWNER_PAYOUT_READY = """CASE WHEN drive_share_requests.recipient_user_id=:user
    AND drive_share_requests.settlement_method<>'hashcoins'
    AND EXISTS (SELECT 1 FROM drive_request_owner_payouts p
      WHERE p.request_id=drive_share_requests.request_id AND p.erased_at IS NULL)
  THEN EXISTS (SELECT 1 FROM stripe_owner_payout_accounts account
    WHERE account.user_id=drive_share_requests.user_id
      AND account.account_ready=TRUE AND account.stripe_mode=:stripe_mode)
  END"""


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
        .replace("{owner_drive_ready}", _OWNER_DRIVE_READY)
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
    estimate: bool = False,
    packages: bool = False,
    v1_live: bool = False,
    evaluations: bool = False,
) -> str:
    projection = _PROJECTION.replace("{queries}", _QUERIES if queries else "")
    projection = projection.replace("{identity_joins}", _IDENTITY_JOINS if identity_cache else "")
    projection = projection.replace(
        "{counterpart_label}",
        _COUNTERPART_LABEL if identity_cache else "'Document request'::text",
    )
    for name, expression in {
        "agent_package": "drive_share_requests.agent_package_required" if packages else "FALSE",
        "v1_live_request": "drive_share_requests.v1_live_request" if v1_live else "FALSE",
        "owner_search_state": _OWNER_SEARCH_STATE if owner_search else "'unavailable'::text",
        "owner_evaluation_state": _OWNER_EVALUATION_STATE
        if owner_search and evaluations
        else "NULL::text",
        "trusted_authority_ready": _trusted_authority_ready(owner_allowed)
        if background
        else "FALSE",
        "trusted_batch_seen": _TRUSTED_BATCH_SEEN if bulk else "FALSE",
        "trusted_work_active": _TRUSTED_WORK_ACTIVE if bulk and owner_search else "FALSE",
        "trusted_recovery_needed": _TRUSTED_RECOVERY_NEEDED if bulk else "FALSE",
        # Started work nobody holds (drive_request_queue); NULL without the table.
        "owner_search_waiting_since": SEARCH_WAITING_SINCE_SQL
        if owner_search
        else "NULL::timestamptz",
        "owner_evaluation_waiting_since": EVALUATION_WAITING_SINCE_SQL
        if owner_search and evaluations
        else "NULL::timestamptz",
        "trusted_sharing_waiting_since": SHARING_WAITING_SINCE_SQL if bulk else "NULL::timestamptz",
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
        "owner_drive_ready": _OWNER_DRIVE_READY,
        "quoted_amount_cents": "drive_share_requests.quoted_amount_cents"
        if pricing
        else "NULL::integer",
        "quote_version": "drive_share_requests.quote_version" if pricing else "NULL::integer",
        "owner_payout_account_ready": """CASE WHEN
          drive_share_requests.payment_required=TRUE
          AND drive_share_requests.settlement_method<>'hashcoins'
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
        # Requester payment view inputs (RequesterPaymentView); requester rows only.
        "payment_reconciliation_reason": _PAYMENT_RECONCILIATION_REASON
        if payments
        else "NULL::text",
        "refund_status": _REFUND_STATUS if payments else "NULL::text",
        "refund_amount_cents": _REFUND_AMOUNT_CENTS
        if payments and payout_projection
        else "NULL::integer",
        "payment_owner_payout_ready": _PAYMENT_OWNER_PAYOUT_READY
        if payments and pricing and payout_projection
        else "NULL::boolean",
        # The estimate the requester saw (migration 320). NULL there means the
        # estimate is unknown; estimate_known says the column exists at all.
        "estimate_known": "TRUE" if pricing and estimate else "FALSE",
        "estimate_cents": "drive_share_requests.initial_quote_cents"
        if pricing and estimate
        else "NULL::integer",
    }.items():
        projection = projection.replace("{" + name + "}", expression)
    return projection


def _waiting_since(row: Any, stage: str, search_state: Any, now: datetime) -> datetime | None:
    """Since when this stage's automatic work has waited; None while it moves."""
    if stage == "preparing":
        queued_at = row.get("automatic_queued_at")
        return min(queued_at, now) if isinstance(queued_at, datetime) else None
    clocks = []
    if stage in {"finding", "checking"} or search_state in {"queued", "running"}:
        clocks.append(row.get("owner_search_waiting_since"))
    if stage == "checking":
        clocks.append(row.get("owner_evaluation_waiting_since"))
    if stage == "sharing":
        clocks.append(row.get("trusted_sharing_waiting_since"))
    return started_work_waiting_since(*clocks, now=now)


def entry(row: Any, *, now: datetime | None = None) -> dict[str, Any]:
    """Closed presentation shape; cannot enter the generic PKM grant path."""
    if row.get("source") == "query":
        return _query_entry(row)
    now = now or datetime.now(UTC)
    preparation_code = row.get("preparation_error_code")
    search_state = row.get("owner_search_state")
    evaluation_state = row.get("owner_evaluation_state")
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
    # The owner's live Drive comes before every other setup step. Only the
    # owner learns its state; the requester's row keeps its existing shape.
    drive_setup_required = bool(
        request_open and row["direction"] == "incoming" and row.get("owner_drive_ready") is False
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
    # The one order Allow itself creates: a still-pending request the owner's
    # lane has already recorded a preparation state for, with no frozen batch
    # and no package behind it, asking for a payment no Checkout session is
    # bound to yet. That ask runs beside the search instead of parking it, and
    # it hides no owner task. Everything else keeps the rule it had, because
    # there an unpaid order still does imply the owner's part is done: a bound
    # Checkout owns the row, a frozen batch or an approved request is the old
    # post-review lane, a request nothing has prepared is one whose payment was
    # opened some other way, and a refund, an expiry or a reconciliation is
    # never progress.
    allow_parallel_payment = bool(
        row["state"] == "pending"
        and preparation_code is not None
        and row.get("agent_package") is not True
        and row.get("trusted_batch_seen") is not True
        and row.get("payment_status") == "awaiting_payment"
    )
    owner_payment_blocked = row["direction"] == "incoming" and (
        row.get("payment_reconciliation_required") is True
        or (
            not allow_parallel_payment
            and row.get("payment_status")
            in {"awaiting_payment", "checkout_open", "refunded", "expired"}
        )
    )
    # Automatic sharing claims a batch as each search page commits. A completed
    # search with results left and no automatic batch had every claim refused,
    # because its plan needs the owner's exact review (document_coverage, as in
    # the planner fallback). That is an owner task, not a search still finding
    # files. A package keeps its own Allow lane.
    review_handoff = bool(
        search_state == "completed"
        and row.get("agent_package") is not True
        and row.get("trusted_batch_seen") is not True
    )
    live_search = search_state in {"queued", "running"} or (
        search_state == "completed"
        and row.get("trusted_work_active") is True
        and not review_handoff
    )
    # V1 checks content before payment for both Trusted and owner-reviewed
    # requests. A running search/evaluation is not yet an owner decision.
    # This is presentation state, never sharing authority.
    v1_checking = bool(
        request_open
        and row.get("v1_live_request") is True
        and row.get("agent_package") is True
        and row.get("owner_allowed") is not True
        and row.get("payment_status")
        not in {"awaiting_payment", "checkout_open", "refunded", "expired"}
        and row.get("payment_reconciliation_required") is not True
        and row.get("trusted_recovery_needed") is not True
        and (
            search_state in {"queued", "running"}
            or search_state == "completed"
            and evaluation_state in {"pending", "running"}
        )
    )
    v1_unavailable = bool(
        request_open
        and row.get("v1_live_request") is True
        and row.get("agent_package") is True
        and row.get("owner_allowed") is not True
        and row.get("payment_status") is None
        and (
            search_state in {"failed", "limited", "stopped", "expired"}
            or search_state == "completed"
            and evaluation_state in {"failed", "obsolete"}
        )
    )
    legacy_progressing = bool(
        request_open
        and (
            allow_parallel_payment
            or row.get("payment_status")
            not in {"awaiting_payment", "checkout_open", "refunded", "expired"}
        )
        and row.get("payment_reconciliation_required") is not True
        and row.get("trusted_authority_ready") is True
        and (row.get("agent_package") is not True or row.get("owner_allowed") is True)
        and row.get("trusted_recovery_needed") is not True
        and (
            preparation_code == "trusted_auto_queued"
            and (search_state is None or live_search)
            or preparation_code == "trusted_auto_active"
            and live_search
        )
    )
    automatic_progressing = v1_checking or legacy_progressing
    automatic_stage = None
    if automatic_progressing:
        automatic_stage = (
            "checking"
            if v1_checking
            else "sharing"
            if row.get("trusted_batch_seen") is True
            else "finding"
            if search_state in {"queued", "running", "completed"}
            else "preparing"
        )
    # "preparing" kept its legacy name, but nothing has started: the request
    # waits in the durable queue for the scheduled drain. Started work that no
    # worker holds waits the same way. Past the threshold either one reads
    # "delayed". Never "paused": the API's drain flag is off in production,
    # where the scheduled drain runs.
    waiting_since = (
        _waiting_since(row, automatic_stage, search_state, now) if automatic_stage else None
    )
    delayed = waiting_since is not None and queue_delayed(waiting_since, now)
    progress_state = (
        "delayed"
        if delayed
        else {
            "checking": "checking",
            "sharing": "sharing",
            "finding": "searching",
            "preparing": "queued",
        }.get(automatic_stage or "")
    )
    # A queued request always says since when; started work once it waits.
    shown_waiting_since = waiting_since if automatic_stage == "preparing" or delayed else None
    # Allow/Deny belongs only to the owner's own open request task.
    owner_decision_available = bool(
        row["direction"] == "incoming"
        and row["bucket"] == "incoming_requests"
        and row["state"] == "pending"
        and not row.get("access_stopped")
        and (
            row.get("owner_decision_ready") is True
            or row.get("agent_package") is True
            and row.get("owner_allowed") is not True
        )
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
            "Connect Google Drive"
            if drive_setup_required
            else setup_description
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
            # Additive and truthful: queued | delayed | searching | sharing | checking.
            "automatic_progress_state": progress_state,
            # Since when a queued or delayed request has waited.
            **(
                {"automatic_queued_at": shown_waiting_since.isoformat()}
                if shown_waiting_since is not None
                else {}
            ),
            "accessStopped": row.get("access_stopped") is True,
            # A Trusted Circle request stays pending while automatic search and
            # sharing run. Only the sharing authority can distinguish that
            # progress from an owner task or a paused/manual recovery.
            "owner_attention_required": drive_setup_required
            or (
                row["state"] == "pending"
                and row["bucket"] == "incoming_requests"
                and not row.get("access_stopped")
                and not automatic_progressing
                and not v1_unavailable
                and (not owner_payment_blocked or payout_setup_required or setup_waiting)
            ),
            "owner_decision_available": owner_decision_available,
            "owner_price_available": bool(
                row["direction"] == "incoming"
                and row["bucket"] == "incoming_requests"
                and row["state"] == "pending"
                and not row.get("access_stopped")
                and row.get("agent_package") is not True
                and row.get("owner_price_ready") is True
                and row.get("owner_payout_account_ready") is True
            ),
            "owner_allowed": row.get("owner_allowed") is True,
            **({"v1_live_request": True} if row.get("v1_live_request") is True else {}),
            **({"v1_evaluation_unavailable": True} if v1_unavailable else {}),
            **({"agent_package": True} if row.get("agent_package") is True else {}),
            **(
                {"payment_required": row.get("payment_required") is True}
                if row["direction"] == "incoming"
                else {}
            ),
            **({"payment_waiting_for_requester": True} if owner_payment_waiting else {}),
            **({"ownerDriveReady": False} if drive_setup_required else {}),
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
                    # Same meaning as RequesterPriceView.estimateCents: null is
                    # an unknown estimate. Omitted while migration 320 is absent.
                    **(
                        {"estimateCents": row.get("estimate_cents")}
                        if row.get("estimate_known") is True
                        else {}
                    ),
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
            **_payment_view_metadata(row),
        },
    }


def _payment_view_metadata(row: Any) -> dict[str, Any]:
    """The requester's RequesterPaymentView, built by the one shared definition."""
    if row["direction"] != "outgoing" or row.get("payment_required") is not True:
        return {}
    state = row["state"]
    checkout_expires_at = row.get("checkout_expires_at")
    order = (
        {
            "status": row["payment_status"],
            "amount_cents": row.get("payment_amount_cents"),
            # Projected only for a bound session (see checkout_expires_at).
            "checkout_bound": checkout_expires_at is not None,
            "checkout_expires_at": checkout_expires_at,
            "reconciliation_reason": row.get("payment_reconciliation_reason"),
        }
        if row.get("payment_status") is not None
        else None
    )
    return {
        "paymentView": requester_payment_view(
            payment_required=True,
            package_disclosure_required=row.get("agent_package") is True,
            # The requester projection renames no_match; the view needs the status.
            request_status="no_match" if state == "no_files_shared" else state,
            request_expires_at=row.get("request_expires_at"),
            now=datetime.now(UTC),
            access_stopped=row.get("access_stopped") is True,
            preparation_error_code=row.get("preparation_error_code"),
            quoted_amount_cents=row.get("quoted_amount_cents"),
            order=order,
            refund=(
                {"status": row["refund_status"], "amount_cents": row.get("refund_amount_cents")}
                if row.get("refund_status") is not None
                else None
            ),
            owner_payout_ready=row.get("payment_owner_payout_ready"),
        )
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


@dataclass(frozen=True)
class _ProjectionCapabilities:
    installed: bool
    queries: bool
    owner_search: bool
    bulk: bool
    background: bool
    payments: bool
    identity_cache: bool
    owner_allowed: bool
    pricing: bool
    payout_projection: bool
    estimate: bool
    packages: bool
    v1_live: bool
    evaluations: bool


_CAPABILITY_SQL = """
SELECT
  (to_regclass('drive_share_requests') IS NOT NULL
             AND to_regclass('drive_share_permission_operations') IS NOT NULL
             AND to_regclass('drive_share_management_contexts') IS NOT NULL) AS installed,
  (to_regclass('drive_live_query_requests') IS NOT NULL) AS queries,
  (to_regclass('drive_owner_search_jobs') IS NOT NULL) AS owner_search,
  (EXISTS (
                  SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_bulk_shares')
                    AND attname='progressive_batch' AND NOT attisdropped
                ) AND EXISTS (
                  SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_bulk_share_files')
                    AND attname='origin_request_id' AND NOT attisdropped
                )) AS bulk,
  (to_regclass('drive_live_preferences') IS NOT NULL) AS background,
  (to_regclass('drive_request_payment_orders') IS NOT NULL) AS payments,
  (to_regclass('actor_identity_cache') IS NOT NULL) AS identity_cache,
  (EXISTS (
                  SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_share_requests')
                    AND attname='owner_allowed_at' AND NOT attisdropped
                )) AS owner_allowed,
  (EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_share_requests')
                    AND attname='quoted_amount_cents' AND NOT attisdropped)
                  AND EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_share_requests')
                    AND attname='quote_version' AND NOT attisdropped)) AS pricing,
  (to_regclass('drive_request_owner_payouts') IS NOT NULL
                  AND to_regclass('stripe_owner_payout_accounts') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid=to_regclass('stripe_owner_payout_accounts')
                      AND attname='account_ready' AND NOT attisdropped)) AS payout_projection,
  (EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid=to_regclass('drive_share_requests')
                    AND attname='initial_quote_cents' AND NOT attisdropped)) AS estimate,
  (EXISTS (SELECT 1 FROM pg_attribute
            WHERE attrelid=to_regclass('drive_share_requests')
              AND attname='agent_package_required' AND NOT attisdropped)) AS packages,
  (EXISTS (SELECT 1 FROM pg_attribute
            WHERE attrelid=to_regclass('drive_share_requests')
              AND attname='v1_live_request' AND NOT attisdropped)) AS v1_live,
  (EXISTS (SELECT 1 FROM pg_attribute
            WHERE attrelid=to_regclass('drive_owner_search_jobs')
              AND attname='evaluation_status' AND NOT attisdropped)) AS evaluations
"""


class DriveSharingCenterContributor(ExternalConnectorLifecycleStore):
    def _supports_projection(self) -> bool:
        # Existing SQLite-only callers have no Drive domain. Check the dialect
        # before the lifecycle store issues PostgreSQL transaction settings.
        # Real PostgreSQL SQL/timeout errors still propagate, never become zero.
        return self.db.engine.dialect.name == "postgresql"

    @staticmethod
    def _capabilities(connection) -> _ProjectionCapabilities:
        # Fresh within this transaction; never cache rolling-schema authority.
        row = connection.execute(text(_CAPABILITY_SQL)).mappings().one()
        return _ProjectionCapabilities(**row)

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

    async def counts(self, user_id: str) -> dict[str, int]:
        if not self._supports_projection():
            return {**dict.fromkeys(BUCKETS, 0), "schema_available": False}

        def operation(connection):
            capabilities = self._capabilities(connection)
            if not capabilities.installed:
                return {**dict.fromkeys(BUCKETS, 0), "schema_available": False}
            rows = connection.execute(
                # Both SQL fragments are static; every value is bound below.
                text(
                    _projection(
                        capabilities.queries,
                        capabilities.owner_search,
                        capabilities.bulk,
                        capabilities.background,
                        capabilities.payments,
                        capabilities.identity_cache,
                        capabilities.owner_allowed,
                        capabilities.pricing,
                        capabilities.payout_projection,
                        packages=capabilities.packages,
                        v1_live=capabilities.v1_live,
                        evaluations=capabilities.evaluations,
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
            capabilities = self._capabilities(connection)
            if not capabilities.installed:
                return {"total": 0, "items": [], "schema_available": False}
            rows = list(
                connection.execute(
                    text(
                        # Both SQL fragments are static; every value is bound below.
                        _projection(
                            capabilities.queries,
                            capabilities.owner_search,
                            capabilities.bulk,
                            capabilities.background,
                            capabilities.payments,
                            capabilities.identity_cache,
                            capabilities.owner_allowed,
                            capabilities.pricing,
                            capabilities.payout_projection,
                            capabilities.estimate,
                            packages=capabilities.packages,
                            v1_live=capabilities.v1_live,
                            evaluations=capabilities.evaluations,
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
            capabilities = self._capabilities(connection)
            if not capabilities.installed:
                return {
                    "buckets": {key: [] for key in BUCKETS},
                    "counts": dict.fromkeys(BUCKETS, 0),
                    "schema_available": False,
                }
            rows = connection.execute(
                text(
                    # Both SQL fragments are static; every value is bound below.
                    _projection(
                        capabilities.queries,
                        capabilities.owner_search,
                        capabilities.bulk,
                        capabilities.background,
                        capabilities.payments,
                        capabilities.identity_cache,
                        capabilities.owner_allowed,
                        capabilities.pricing,
                        capabilities.payout_projection,
                        capabilities.estimate,
                        packages=capabilities.packages,
                        v1_live=capabilities.v1_live,
                        evaluations=capabilities.evaluations,
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
