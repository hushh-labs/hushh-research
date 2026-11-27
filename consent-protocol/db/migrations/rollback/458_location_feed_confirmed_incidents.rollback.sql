BEGIN;

-- Receipt confirmation facts are retained; restore only projection behavior.
CREATE OR REPLACE FUNCTION feed_events_recipient_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  owner_label TEXT;
  reason_value TEXT;
  share_kind_value TEXT;
  duration_hours_value TEXT;
  duration_mode_value TEXT;
  direction_value TEXT;
  source_row_id_value TEXT;
  feed_metadata JSONB;
BEGIN
  IF NEW.recipient_user_id IS NULL
     OR NEW.recipient_user_id = NEW.owner_user_id THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type NOT IN (
    'location_share_created',
    'location_share_revoked',
    'location_share_shortened',
    'location_share_duration_changed',
    'location_share_expired',
    'location_one_network_joined'
  ) THEN
    RETURN NEW;
  END IF;

  owner_label := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'owner_label') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'owner_label'), ''), 160)
  END;
  IF owner_label IS NULL THEN
    SELECT CASE
      WHEN NULLIF(BTRIM(display_name), '') IS NOT NULL
       AND BTRIM(display_name) <> NEW.owner_user_id
       AND BTRIM(display_name) !~* '^ria:'
       AND BTRIM(display_name) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND NOT (
         BTRIM(display_name) !~ '[@[:space:]]'
         AND LENGTH(BTRIM(display_name)) >= 20
       )
      THEN LEFT(BTRIM(display_name), 160)
    END
      INTO owner_label
      FROM actor_identity_cache
     WHERE user_id = NEW.owner_user_id;
  END IF;

  reason_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'reason') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'reason'), ''), 64)
  END;
  share_kind_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'share_kind') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'share_kind'), ''), 40)
  END;
  duration_hours_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'duration_hours') IN ('number', 'string')
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'duration_hours'), ''), 32)
  END;
  duration_mode_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'duration_mode') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'duration_mode'), ''), 32)
  END;
  direction_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'direction') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'direction'), ''), 32)
  END;
  source_row_id_value := CASE NEW.event_type
    WHEN 'location_share_created' THEN COALESCE(NEW.grant_id::TEXT, NEW.id::TEXT)
    WHEN 'location_share_revoked' THEN COALESCE(NEW.grant_id::TEXT, NEW.id::TEXT)
    WHEN 'location_share_shortened' THEN CASE
      WHEN NULLIF(BTRIM(NEW.metadata ->> 'client_operation_id'), '') IS NOT NULL THEN CONCAT(
        COALESCE(NEW.grant_id::TEXT, 'unknown-grant'),
        ':operation:',
        LEFT(BTRIM(NEW.metadata ->> 'client_operation_id'), 160)
      )
      ELSE NEW.id::TEXT
    END
    WHEN 'location_share_duration_changed' THEN CASE
      WHEN NULLIF(BTRIM(NEW.metadata ->> 'client_operation_id'), '') IS NOT NULL THEN CONCAT(
        COALESCE(NEW.grant_id::TEXT, 'unknown-grant'),
        ':operation:',
        LEFT(BTRIM(NEW.metadata ->> 'client_operation_id'), 160)
      )
      ELSE NEW.id::TEXT
    END
    WHEN 'location_share_expired' THEN COALESCE(NEW.grant_id::TEXT, NEW.id::TEXT)
    WHEN 'location_one_network_joined' THEN COALESCE(
      LEFT(NULLIF(BTRIM(NEW.metadata ->> 'invite_id'), ''), 160),
      LEFT(NULLIF(BTRIM(NEW.metadata ->> 'connection_id'), ''), 160),
      NEW.id::TEXT
    )
    ELSE NEW.id::TEXT
  END;

  feed_metadata := CASE NEW.event_type
    WHEN 'location_share_created' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person'),
      'duration_hours', duration_hours_value,
      'duration_mode', duration_mode_value,
      'share_kind', share_kind_value
    ))
    WHEN 'location_share_revoked' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person'),
      'share_kind', share_kind_value
    ))
    WHEN 'location_share_shortened' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person'),
      'reason', reason_value,
      'grant_id', NEW.grant_id::TEXT
    ))
    WHEN 'location_share_duration_changed' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person'),
      'direction', direction_value,
      'grant_id', NEW.grant_id::TEXT
    ))
    WHEN 'location_share_expired' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person'),
      'share_kind', share_kind_value
    ))
    WHEN 'location_one_network_joined' THEN jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person')
    )
    ELSE '{}'::jsonb
  END;

  INSERT INTO feed_events (
    user_id, source_domain, event_type, metadata, source_row_id
  )
  VALUES (
    NEW.recipient_user_id,
    'location',
    NEW.event_type,
    feed_metadata,
    source_row_id_value
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION feed_events_recipient_from_one_location_events() IS
  'Fans recipient-facing One Location transitions into Feed, carrying the share lane so an SMS alert is not narrated as an ordinary share.';


COMMIT;
