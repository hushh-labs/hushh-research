"""Per-incident confirmed publication. Never reduce active incidents by sender."""

RECEIVED_GRANTS_SQL = """SELECT g.*,receipt.confirmed_at AS feed_confirmed_at,receipt.item_id AS feed_item_id,
  (receipt.confirmed_at IS NOT NULL) AS feed_sms_confirmed,
  o.display_name AS owner_display_name,o.photo_url AS owner_photo_url,
  o.custom_photo_url AS owner_custom_photo_url,o.phone_number AS owner_phone_number
  FROM one_location_share_grants g LEFT JOIN actor_identity_cache o ON o.user_id=g.owner_user_id
  LEFT JOIN LATERAL (SELECT min(f.created_at) AS confirmed_at,min(f.id) AS item_id FROM feed_events f
    WHERE f.user_id=g.recipient_user_id AND f.source_domain='location'
      AND f.event_type='location_share_created' AND f.source_row_id=g.id::text
      AND f.metadata->>'feed_audience'='recipient' AND f.metadata->>'share_kind'='sos'
      AND f.metadata->'feed_sms_confirmed'='true'::jsonb) receipt ON TRUE
  WHERE g.recipient_user_id = :user_id AND (
    g.status='active' OR g.id IN (SELECT old.id FROM one_location_share_grants old
      WHERE old.recipient_user_id=:user_id AND old.status<>'active'
      ORDER BY old.created_at DESC,old.id DESC LIMIT :source_limit))
  ORDER BY g.created_at DESC,g.id DESC"""
