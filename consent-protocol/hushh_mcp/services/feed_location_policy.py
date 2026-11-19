"""Presentation rules for Location/Connect. Domain records retain their authority.

All fragments are authored SQL. Runtime values use FeedService's owner bindings.
The durable Feed receipt and counterpart link outlive short-lived Location rows.
"""

_GRANT_KEY = """COALESCE(NULLIF(raw.metadata->>'grant_id',''),
  CASE WHEN split_part(raw.source_row_id, ':', 1) ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(raw.source_row_id, ':', 1) END)"""

# Select the newest creation receipt BEFORE applying dismissal or grant cleanup.
# Later revoke/expiry events of an older incident cannot make it current again.
LATEST_SMS_RECEIPT_SQL = """
SELECT DISTINCT ON (peer.counterpart_user_id)
       peer.counterpart_user_id AS sender_id,
       receipt.source_row_id AS grant_id,
       receipt.id AS receipt_id, receipt.created_at AS confirmed_at
  FROM feed_events receipt
  JOIN feed_event_counterparts peer ON peer.feed_event_id = receipt.id
 WHERE receipt.user_id = :user_id AND receipt.source_domain = 'location'
   AND receipt.event_type = 'location_share_created'
   AND receipt.metadata->>'feed_audience' = 'recipient'
   AND receipt.metadata->>'share_kind' = 'sos'
   AND receipt.metadata->'feed_sms_confirmed' = 'true'::jsonb
 ORDER BY peer.counterpart_user_id, receipt.created_at DESC, receipt.id DESC
"""

_RECEIVED_GRANTS_TEMPLATE = """
SELECT g.*,
  CASE WHEN g.metadata->>'share_kind' = 'sos'
    THEN COALESCE(latest_sms.grant_id = g.id::text, FALSE) END AS feed_latest_sms,
  CASE WHEN latest_sms.grant_id = g.id::text THEN latest_sms.confirmed_at END AS feed_confirmed_at,
  CASE WHEN g.metadata->>'share_kind' = 'sos' THEN
    (COALESCE(latest_sms.grant_id = g.id::text, FALSE) OR g.latest_envelope_id IS NOT NULL)
    END AS feed_sms_confirmed,
  o.display_name AS owner_display_name, o.photo_url AS owner_photo_url,
  o.custom_photo_url AS owner_custom_photo_url, o.phone_number AS owner_phone_number
FROM one_location_share_grants g
LEFT JOIN actor_identity_cache o ON o.user_id = g.owner_user_id
LEFT JOIN ({latest_sms}) latest_sms ON latest_sms.sender_id = g.owner_user_id
WHERE g.recipient_user_id = :user_id
ORDER BY g.created_at DESC, g.id DESC
LIMIT :source_limit
"""
# Compile authored templates once. Request values remain database bindings.
RECEIVED_GRANTS_FEED_SQL = _RECEIVED_GRANTS_TEMPLATE.format(latest_sms=LATEST_SMS_RECEIPT_SQL)

_PRESENTATION_TEMPLATE = """
SELECT raw.*, peer.counterpart_user_id AS feed_peer,
  CASE
    WHEN raw.source_domain = 'location' AND raw.event_type = 'location_share_created'
      AND raw.metadata->>'share_kind' = 'sos' AND peer.counterpart_user_id IS NOT NULL
      AND raw.metadata->'feed_sms_confirmed' = 'true'::jsonb
      THEN 'location-sms:' || peer.counterpart_user_id
    WHEN raw.source_domain = 'location'
      AND raw.event_type IN ('location_share_created','location_share_revoked',
        'location_share_shortened','location_share_duration_changed','location_share_expired')
      AND COALESCE(raw.metadata->>'share_kind', origin.metadata->>'share_kind','') <> 'sos'
      AND {grant_key} IS NOT NULL THEN 'location-share:' || {grant_key}
    WHEN raw.source_domain = 'location'
      AND raw.event_type IN ('circle_member_added','circle_membership_ended','circle_deleted')
      AND COALESCE(NULLIF(raw.metadata->>'circle_id',''),
        CASE WHEN raw.event_type IN ('circle_membership_ended','circle_deleted')
          THEN split_part(raw.source_row_id,':',1) END) IS NOT NULL
      THEN 'circle-membership:' || COALESCE(NULLIF(raw.metadata->>'circle_id',''),
        split_part(raw.source_row_id,':',1))
    WHEN raw.source_domain = 'connections'
      AND raw.event_type IN ('connection_accepted','connection_rejected','connection_revoked')
      AND peer.counterpart_user_id IS NOT NULL
      THEN 'connection-outcome:' || peer.counterpart_user_id
    ELSE NULL
  END AS feed_presentation_key,
  (raw.source_domain = 'location' AND raw.event_type IN
    ('location_share_expired','location_share_revoked')) AS feed_silent,
  CASE
    WHEN raw.source_domain = 'location' THEN (
      (raw.event_type IN ('location_share_created','location_share_revoked',
          'location_share_shortened','location_share_duration_changed','location_share_expired')
        AND raw.metadata->>'feed_audience' = 'recipient'
        AND COALESCE(raw.metadata->>'actor_is_self','false') <> 'true'
        AND (raw.event_type = 'location_share_created' OR
          COALESCE(raw.metadata->>'reason','') NOT IN ('recipient_revoke','recipient_shorten'))
        AND (raw.event_type <> 'location_share_created' OR
          COALESCE(raw.metadata->>'share_kind', origin.metadata->>'share_kind','') <> 'sos' OR
          (raw.metadata->'feed_sms_confirmed' = 'true'::jsonb AND latest.receipt_id = raw.id))
        AND (COALESCE(raw.metadata->>'share_kind', origin.metadata->>'share_kind','') <> 'sos' OR
          raw.event_type = 'location_share_created')
        AND (raw.event_type <> 'location_share_created' OR
          COALESCE(raw.metadata->>'share_kind', origin.metadata->>'share_kind','') <> 'sos' OR grant_row.recipient_cleared_at IS NULL))
      OR (raw.event_type = 'location_access_denied' AND raw.metadata->>'feed_audience' = 'requester')
      OR (raw.event_type IN ('location_sms_contact_added','location_sms_contact_removed')
        AND raw.metadata->>'feed_audience' = 'recipient')
      OR (raw.event_type = 'circle_member_added'
        AND peer.counterpart_user_id IS DISTINCT FROM raw.user_id)
      OR raw.event_type IN ('circle_membership_ended','circle_invite_declined')
      OR (raw.event_type = 'circle_deleted' AND EXISTS (
        SELECT 1 FROM one_location_circles circle
         WHERE circle.id::text = raw.source_row_id AND circle.owner_user_id <> raw.user_id))
    )
    WHEN raw.source_domain = 'connections' THEN (
      raw.event_type IN ('connection_accepted','connection_rejected','connection_revoked')
        AND raw.metadata->>'actor_is_self' = 'false'
    )
    ELSE TRUE
  END AS feed_eligible
FROM feed_events raw
LEFT JOIN feed_event_counterparts peer ON peer.feed_event_id = raw.id
LEFT JOIN ({latest_sms}) latest ON latest.sender_id = peer.counterpart_user_id
LEFT JOIN LATERAL (
  SELECT created.metadata FROM feed_events created
   WHERE raw.source_domain = 'location'
     AND raw.event_type IN ('location_share_created','location_share_revoked',
       'location_share_shortened','location_share_duration_changed','location_share_expired')
     AND created.user_id = raw.user_id AND created.source_domain = 'location'
     AND created.event_type IN ('location_share_created','location_share_unconfirmed')
     AND created.source_row_id = {grant_key}
   ORDER BY created.id DESC LIMIT 1
) origin ON TRUE
LEFT JOIN one_location_share_grants grant_row ON grant_row.id = CASE
  WHEN raw.source_domain = 'location' AND raw.event_type = 'location_share_created'
    AND {grant_key} ~* '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$'
  THEN ({grant_key})::uuid END
WHERE raw.user_id = :user_id
"""
_PRESENTATION_SOURCE = _PRESENTATION_TEMPLATE.format(
    grant_key=_GRANT_KEY, latest_sms=LATEST_SMS_RECEIPT_SQL
)


_CLEARED_RECEIPTS_SQL = """
UPDATE feed_events AS f
   SET dismissed_at = COALESCE(f.dismissed_at, candidate.cleared_at),
       read_at = COALESCE(f.read_at, candidate.cleared_at),
       dismissal_token = gen_random_uuid()
  FROM feed_clear_candidates candidate
 WHERE f.user_id = candidate.recipient_user_id
   AND f.source_domain = 'location' AND f.event_type = 'location_share_created'
   AND f.source_row_id = candidate.grant_id::TEXT
RETURNING f.id
"""


def with_cleared_feed_receipts(template: str) -> str:
    """Compose the fixed recipient preference write into a domain transaction.

    Both callers provide authoritative ended/cleared grant candidates. Rotating
    the token also prevents a stale generic Feed Undo from reversing an SOS Clear.
    """
    marker = "__CLEARED_FEED_RECEIPTS__"
    if template.count(marker) != 1:
        raise ValueError("Expected one authored Feed receipt write")
    return template.replace(marker, _CLEARED_RECEIPTS_SQL)


def apply_location_feed_policy(
    cte: str, *, wallet_access: bool = False, wallet_requests: bool = False
) -> str:
    """Extend the existing projection; preserve other DRIs' wallet message rows."""
    # Callers select capabilities, never supply SQL expressions.
    wallet_message = (
        " OR ".join(
            clause
            for enabled, clause in (
                (wallet_access, "wg.id IS NOT NULL"),
                (wallet_requests, "wr.id IS NOT NULL"),
            )
            if enabled
        )
        or "FALSE"
    )
    cte = cte.replace("  FROM feed_events f\n", f"  FROM ({_PRESENTATION_SOURCE}) f\n", 1)
    cte = cte.replace(
        "  SELECT f.*,",
        f"  SELECT f.*, (f.feed_eligible IS TRUE OR ({wallet_message})) AS feed_present,",
        1,
    )
    cte = cte.replace(
        "    CASE WHEN f.source_domain = 'location'",
        "    CASE WHEN f.feed_presentation_key IS NOT NULL THEN f.feed_presentation_key\n"
        "    WHEN f.source_domain = 'location'",
        1,
    )
    cte = cte.replace(
        "  WHERE f.user_id = :user_id",
        "  WHERE f.user_id = :user_id\n"
        f"    AND (f.feed_eligible IS TRUE OR f.feed_presentation_key IS NOT NULL OR ({wallet_message}))",
        1,
    )
    cte = cte.replace(
        "WHERE read_at IS NULL AND dismissed_at IS NULL AND",
        "WHERE read_at IS NULL AND dismissed_at IS NULL AND feed_present AND NOT feed_silent AND",
    )
    return cte.replace(
        "WHERE thread_rank = 1 AND dismissed_at IS NULL)",
        "WHERE thread_rank = 1 AND dismissed_at IS NULL AND feed_present)",
    )
