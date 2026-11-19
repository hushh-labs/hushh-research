"""Canonical grouped Feed query contracts, shared by owner reads and mutations."""

from hushh_mcp.services.feed_activity_policy import (
    GENERAL_OPERATION_KEY_SQL,
    browse_admission_sql,
    policy_case_sql,
)
from hushh_mcp.services.feed_source_context import source_events_sql

_DOCUMENT_GROUP_EVENTS_SQL = """(
  'document_share_request', 'document_share_request_sent', 'document_share_review_ready',
  'document_share_review_requested', 'document_share_decided', 'document_share_outcome',
  'document_share_revoked', 'document_share_revocation_outcome', 'document_share_payment_ready',
  'document_share_payment_confirmed', 'document_share_payment_refunded',
  'document_share_files_sent'
)"""
_DOCUMENT_REQUEST_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
# Keep source event facts intact while read/dismissal are owner preferences.
# Group and filter presentation before pagination and unread counts.
_FINANCE_THREAD_KEY_SQL = """CASE
    WHEN f.source_domain = 'connections' AND f.event_type IN (
      'advisor_review_accepted', 'advisor_review_declined')
      AND f.metadata->>'viewerRole' IN ('owner', 'advisor')
      AND (f.metadata->>'advisorReviewId') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'advisor-review:' || lower(f.metadata->>'advisorReviewId')
    WHEN f.source_domain = 'kai' AND f.event_type IN ('kai_analysis_completed','kai_analysis_saved')
      AND COALESCE(NULLIF(f.metadata->>'run_id',''),NULLIF(f.source_row_id,'')) IS NOT NULL
      THEN 'finance-analysis:' || COALESCE(NULLIF(f.metadata->>'run_id',''),f.source_row_id)
    WHEN f.source_domain = 'kai' AND f.event_type = 'funding_transfer_status'
      AND f.metadata->>'user_facing_status' IN ('pending','queued','processing','canceled','completed','failed','returned')
      AND length(f.source_row_id) > length(f.metadata->>'user_facing_status') + 1
      AND substr(f.source_row_id, length(f.source_row_id) - length(f.metadata->>'user_facing_status'))
        = ':' || (f.metadata->>'user_facing_status')
      THEN 'legacy-funding:' || substr(f.source_row_id, 1,
        length(f.source_row_id) - length(f.metadata->>'user_facing_status') - 1)
  END"""

_SOURCE_EVENTS_SQL = source_events_sql({})
_GROUPED_FEED_CTE = f"""
WITH source_events AS ({_SOURCE_EVENTS_SQL}), keyed AS (
  SELECT f.*, (f.source_domain='location' AND f.event_type IN ('location_share_expired','location_share_revoked')) AS feed_silent,
    CASE WHEN f.source_domain = 'location' AND f.event_type = 'location_circle_message'
      AND NULLIF(f.metadata->>'circle_id', '') IS NOT NULL
      THEN 'circle:' || (f.metadata->>'circle_id')
    WHEN f.source_domain = 'connections' AND f.event_type = 'direct_message_received'
      AND c.id IS NOT NULL THEN 'direct:' || c.id::text
    WHEN f.source_domain = 'connected_systems'
      AND f.event_type IN {_DOCUMENT_GROUP_EVENTS_SQL}
      AND (f.metadata->>'request_id') ~* '{_DOCUMENT_REQUEST_ID_PATTERN}'
      THEN 'document:' || lower(f.metadata->>'request_id')
    ELSE COALESCE({_FINANCE_THREAD_KEY_SQL}, {GENERAL_OPERATION_KEY_SQL}, 'feed:' || f.id::text) END AS thread_key
  FROM source_events f
  LEFT JOIN messages m ON f.source_domain = 'connections'
    AND f.event_type = 'direct_message_received' AND m.id = CASE
      WHEN f.source_row_id ~* '{_DOCUMENT_REQUEST_ID_PATTERN}'
      THEN f.source_row_id::uuid ELSE NULL END
  LEFT JOIN conversations c ON c.id = m.conversation_id AND (
    (c.participant_a_user_id = m.sender_user_id AND c.participant_b_user_id = :user_id)
    OR (c.participant_b_user_id = m.sender_user_id AND c.participant_a_user_id = :user_id))
  WHERE f.user_id = :user_id
    AND (f.source_domain <> 'connections' OR f.event_type <> 'direct_message_received'
      OR (m.id IS NOT NULL AND c.id IS NOT NULL
        AND m.deleted_for_recipient_at IS NULL AND m.deleted_for_everyone_at IS NULL))
    AND (f.source_domain <> 'calendar_email_followup' OR EXISTS (
      SELECT 1 FROM calendar_email_followup_requests r
      JOIN calendar_email_followup_monitors fm
        ON fm.user_id=r.user_id AND fm.account_id=r.account_id
      WHERE r.id::text=f.metadata->>'request_id'
        AND r.user_id=f.user_id AND r.account_id=f.metadata->>'account_id'
        AND r.revision::text=split_part(f.source_row_id, ':', 2)
        AND r.reminder_sent_revision=r.revision
        AND r.state IN ('pending','snoozed') AND r.suppressed_at IS NULL
        AND fm.enabled=TRUE AND fm.notifications_enabled=TRUE
        AND calendar_email_followup_grant_current(fm)
    ))
), classified AS (
  SELECT keyed.*, CASE WHEN left(thread_key,15)='wallet-request:' OR left(thread_key,14)='wallet-access:'
    THEN 'agent_wallet' WHEN metadata->>'workflow_id' IS NOT NULL
      AND event_type IN('mail_information_request_detected','mail_message_sent') THEN 'agent_kyc'
    ELSE {policy_case_sql("agent", "keyed")} END AS subagent_id
  FROM keyed
), eligible AS (
  SELECT f.* FROM classified f WHERE {browse_admission_sql()}
    AND f.source_action_required
    AND NOT (f.event_type IN('advisor_review_accepted','advisor_review_declined') AND left(f.thread_key,15)<>'advisor-review:')
), bounded AS (
  SELECT eligible.*,
    max(id) FILTER (WHERE dismissed_at IS NOT NULL)
      OVER (PARTITION BY thread_key) AS last_dismissed_id,
    min(id) FILTER (WHERE event_type IN ('document_share_outcome', 'document_share_files_sent')
      AND (event_type = 'document_share_files_sent'
        OR metadata->>'user_facing_status' IN ('partial', 'completed')))
      OVER (PARTITION BY thread_key) AS first_delivery_id
  FROM eligible
), ranked AS (
  SELECT bounded.*, row_number() OVER (PARTITION BY thread_key ORDER BY
    CASE WHEN dismissed_at IS NULL AND (last_dismissed_id IS NULL OR id > last_dismissed_id)
      THEN 0 ELSE 1 END,
    CASE WHEN left(thread_key, 9) = 'document:' THEN CASE
      WHEN event_type IN ('document_share_revoked', 'document_share_revocation_outcome',
        'document_share_payment_refunded') THEN 5
      WHEN event_type = 'document_share_outcome'
        AND metadata->>'user_facing_status' IS DISTINCT FROM 'partial' THEN 4
      WHEN event_type IN ('document_share_outcome', 'document_share_files_sent') THEN 3
      WHEN event_type = 'document_share_decided'
        AND metadata->>'user_facing_status' IN ('declined', 'cancelled', 'expired') THEN 3
      WHEN event_type = 'document_share_payment_confirmed' THEN 2
      ELSE 1 END ELSE 0 END DESC,
    CASE WHEN left(thread_key,17)='location-request:' OR left(thread_key,15)='location-grant:' THEN CASE
      WHEN event_type IN('location_share_revoked','location_share_expired') THEN 5
      WHEN event_type IN('location_access_denied','location_access_request_withdrawn') THEN 4
      WHEN event_type IN('location_share_created','location_access_approved','location_share_shortened','location_share_duration_changed') THEN 3
      ELSE 1 END ELSE 0 END DESC,
    CASE WHEN substr(thread_key, 1, 15) = 'legacy-funding:' AND dismissed_at IS NULL
      AND id > COALESCE(last_dismissed_id, 0) THEN
      CASE metadata->>'user_facing_status'
        WHEN 'returned' THEN 3 WHEN 'failed' THEN 2 WHEN 'completed' THEN 1 ELSE 0 END
      ELSE 0 END DESC,
    CASE WHEN left(thread_key,9)='check-in:' THEN CASE WHEN event_type IN('location_check_in_result','location_check_in_attention') THEN 2 ELSE 0 END ELSE 0 END DESC,
    created_at DESC, id DESC) AS thread_rank,
    max(id) OVER (PARTITION BY thread_key) AS thread_revision,
    count(*) FILTER (WHERE dismissed_at IS NULL AND
      (last_dismissed_id IS NULL OR id > last_dismissed_id))
      OVER (PARTITION BY thread_key) AS thread_message_count,
    count(*) FILTER (WHERE read_at IS NULL AND dismissed_at IS NULL AND NOT feed_silent
      AND (last_dismissed_id IS NULL OR id > last_dismissed_id)
      AND (COALESCE(metadata->>'actor_is_self', 'false') <> 'true' OR event_type='location_check_in_attention')
      AND NOT (source_domain = 'connected_systems' AND event_type = 'connector_connected'
        AND split_part(source_row_id, ':', 1) IS NOT DISTINCT FROM 'google_drive')
      AND (left(thread_key, 9) <> 'document:' OR
        event_type IN ('document_share_request', 'document_share_review_ready',
          'document_share_review_requested', 'document_share_payment_ready',
          'document_share_revoked', 'document_share_revocation_outcome',
          'document_share_payment_refunded')
        OR id = first_delivery_id
        OR (event_type = 'document_share_decided'
          AND metadata->>'user_facing_status' IN ('declined', 'expired'))
        OR (event_type = 'document_share_outcome'
          AND metadata->>'user_facing_status' IN ('no_match', 'no_files_shared', 'failed'))))
      OVER (PARTITION BY thread_key) AS thread_unread_count
  FROM bounded
),
grouped AS (
  SELECT ranked.*, CASE WHEN feed_silent THEN 0 WHEN source_domain='location' AND event_type='location_circle_message' THEN 1
    WHEN substr(thread_key, 1, 15) = 'legacy-funding:'
    THEN CASE WHEN metadata->>'user_facing_status' IN ('failed','returned')
      AND read_at IS NULL THEN 1 ELSE 0 END
    ELSE thread_unread_count END AS displayed_unread_count
  FROM ranked WHERE thread_rank = 1 AND dismissed_at IS NULL
  AND (last_dismissed_id IS NULL OR id > last_dismissed_id)
  AND NOT (left(thread_key, 9) = 'document:' AND last_dismissed_id IS NOT NULL
    AND event_type = 'document_share_payment_confirmed')
)
"""
# These query fragments are fixed module constants. Recipient, cursor and page
# size are supplied exclusively through execute_raw's bind-parameter mapping.
_GROUPED_FEED_PAGE_SELECT = """
  SELECT id, source_domain, event_type, actor_label, metadata, source_row_id, created_at,
    CASE WHEN displayed_unread_count > 0 THEN NULL ELSE COALESCE(read_at, created_at) END AS read_at,
    thread_key, thread_revision, thread_message_count, thread_unread_count, displayed_unread_count, feed_silent
  FROM grouped WHERE (CAST(:cursor AS bigint) IS NULL OR (created_at,id) < (
    SELECT created_at,id FROM keyed WHERE id=CAST(:cursor AS bigint)))
  ORDER BY created_at DESC,id DESC LIMIT :page_size
"""
_GROUPED_FEED_COUNT_SELECT = """
  SELECT count(*) AS unread_count FROM grouped WHERE displayed_unread_count > 0
"""
_GROUPED_FEED_PAGE_SQL = _GROUPED_FEED_CTE + _GROUPED_FEED_PAGE_SELECT
_GROUPED_FEED_COUNT_SQL = _GROUPED_FEED_CTE + _GROUPED_FEED_COUNT_SELECT


_DISMISS_SQL = f"""
            WITH target AS (
              SELECT source_domain, event_type,
                     NULLIF(metadata->>'bundle_id', '') AS bundle_id,
                     NULLIF(metadata->>'request_id', '') AS request_id,
                     {_FINANCE_THREAD_KEY_SQL} AS finance_key,
                     {GENERAL_OPERATION_KEY_SQL} AS operation_key
                FROM feed_events f
               WHERE user_id = :user_id AND id = :item_id
                 AND dismissed_at IS NULL
            ), finance_group AS (
              SELECT f.id FROM feed_events f JOIN target
                ON target.finance_key = ({_FINANCE_THREAD_KEY_SQL})
              WHERE f.user_id = :user_id
                AND (substr(target.finance_key, 1, 15) = 'legacy-funding:' OR f.id <= :item_id)
            )
            UPDATE feed_events AS item
               SET dismissed_at = now(),
                   dismissal_token = :dismissal_token,
                   read_at = COALESCE(item.read_at, now())
              FROM target
             WHERE item.user_id = :user_id
               AND item.dismissed_at IS NULL
               AND (item.id = :item_id OR (
                 target.source_domain = 'consent'
                 AND target.event_type IN ('consent_requested', 'consent_granted', 'consent_revoked')
                 AND target.bundle_id IS NOT NULL
                 AND item.source_domain = 'consent'
                 AND item.event_type = target.event_type
                 AND item.metadata->>'bundle_id' = target.bundle_id
                 AND item.id <= :item_id
               ) OR (
                 target.source_domain = 'connected_systems'
                 AND target.event_type IN {_DOCUMENT_GROUP_EVENTS_SQL}
                 AND target.request_id ~* '{_DOCUMENT_REQUEST_ID_PATTERN}'
                 AND item.source_domain = 'connected_systems'
                 AND item.event_type IN {_DOCUMENT_GROUP_EVENTS_SQL}
                 AND lower(item.metadata->>'request_id') = lower(target.request_id)
                 AND item.id <= :item_id
               ) OR item.id = ANY(CAST(:operation_ids AS BIGINT[]))
                 OR item.id = ANY(CAST(:surfacing_ids AS BIGINT[]))
                 OR item.id IN (SELECT id FROM finance_group)
                 OR (target.operation_key IS NOT NULL AND item.id <= :item_id
                   AND item.id IN (SELECT f.id FROM feed_events f
                     WHERE f.user_id = :user_id AND ({GENERAL_OPERATION_KEY_SQL}) = target.operation_key)))
            RETURNING id, dismissal_token
            """
