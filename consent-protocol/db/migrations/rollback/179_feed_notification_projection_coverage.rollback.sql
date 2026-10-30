BEGIN;

DROP TRIGGER IF EXISTS kai_funding_transfer_events_feed_fanout
  ON kai_funding_transfer_events;
DROP FUNCTION IF EXISTS feed_events_from_kai_funding_transfer_events();

DROP TRIGGER IF EXISTS one_location_events_feed_fanout_referred
  ON one_location_events;
DROP FUNCTION IF EXISTS feed_events_referred_from_one_location_events();

-- Restore migration 151's owner projection.
CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  counterpart_label TEXT;
  reason_value TEXT;
  duration_hours_value TEXT;
  duration_mode_value TEXT;
  requested_duration_hours_value TEXT;
  requested_duration_mode_value TEXT;
  is_extension_value BOOLEAN;
  feed_metadata JSONB;
BEGIN
  IF NEW.event_type = 'location_share_created'
     AND NEW.metadata->>'reason' = 'request_approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type IN (
    'location_share_created',
    'location_share_revoked',
    'location_share_expired',
    'location_access_request',
    'location_access_approved',
    'location_access_denied'
  ) THEN
    counterpart_label := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'counterpart_label') = 'string'
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'counterpart_label'), ''), 160)
    END;
    reason_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'reason') = 'string'
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'reason'), ''), 64)
    END;
    duration_hours_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'duration_hours') IN ('number', 'string')
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'duration_hours'), ''), 32)
    END;
    duration_mode_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'duration_mode') = 'string'
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'duration_mode'), ''), 32)
    END;
    requested_duration_hours_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'requested_duration_hours') IN ('number', 'string')
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'requested_duration_hours'), ''), 32)
    END;
    requested_duration_mode_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'requested_duration_mode') = 'string'
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'requested_duration_mode'), ''), 32)
    END;
    is_extension_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'is_extension') = 'boolean'
      THEN (NEW.metadata ->> 'is_extension')::BOOLEAN
    END;

    feed_metadata := CASE NEW.event_type
      WHEN 'location_share_created' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'duration_hours', duration_hours_value,
        'duration_mode', duration_mode_value
      ))
      WHEN 'location_share_revoked' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'reason', reason_value
      ))
      WHEN 'location_share_expired' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label
      ))
      WHEN 'location_access_request' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'requested_duration_hours', requested_duration_hours_value,
        'requested_duration_mode', requested_duration_mode_value,
        'is_extension', is_extension_value,
        'request_id', NEW.request_id::TEXT
      ))
      WHEN 'location_access_approved' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'duration_hours', duration_hours_value,
        'duration_mode', duration_mode_value,
        'is_extension', is_extension_value
      ))
      WHEN 'location_access_denied' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'is_extension', is_extension_value
      ))
      ELSE '{}'::jsonb
    END;

    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.owner_user_id,
      'location',
      NEW.event_type,
      feed_metadata,
      NEW.id::TEXT
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Restore migration 152's recipient projection.
CREATE OR REPLACE FUNCTION feed_events_recipient_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  owner_label TEXT;
  duration_hours_value TEXT;
  duration_mode_value TEXT;
  feed_metadata JSONB;
BEGIN
  IF NEW.recipient_user_id IS NULL
     OR NEW.recipient_user_id = NEW.owner_user_id THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type NOT IN (
    'location_share_created',
    'location_share_revoked',
    'location_share_expired'
  ) THEN
    RETURN NEW;
  END IF;

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

  duration_hours_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'duration_hours') IN ('number', 'string')
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'duration_hours'), ''), 32)
  END;
  duration_mode_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'duration_mode') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'duration_mode'), ''), 32)
  END;
  feed_metadata := CASE NEW.event_type
    WHEN 'location_share_created' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person'),
      'duration_hours', duration_hours_value,
      'duration_mode', duration_mode_value
    ))
    WHEN 'location_share_revoked' THEN jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person')
    )
    WHEN 'location_share_expired' THEN jsonb_build_object(
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
    NEW.id::TEXT
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Restore migration 154's requester projection.
CREATE OR REPLACE FUNCTION feed_events_requester_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  owner_label TEXT;
  requested_duration_hours_value TEXT;
  requested_duration_mode_value TEXT;
  is_extension_value BOOLEAN;
  feed_metadata JSONB;
BEGIN
  IF NEW.event_type NOT IN (
    'location_access_request',
    'location_access_denied'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.recipient_user_id IS NULL
     OR NEW.recipient_user_id = NEW.owner_user_id THEN
    RETURN NEW;
  END IF;

  owner_label := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'owner_label') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'owner_label'), ''), 160)
  END;
  IF owner_label IS NULL THEN
    RETURN NEW;
  END IF;

  requested_duration_hours_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'requested_duration_hours') IN ('number', 'string')
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'requested_duration_hours'), ''), 32)
  END;
  requested_duration_mode_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'requested_duration_mode') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'requested_duration_mode'), ''), 32)
  END;
  is_extension_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'is_extension') = 'boolean'
    THEN (NEW.metadata ->> 'is_extension')::BOOLEAN
  END;
  feed_metadata := CASE NEW.event_type
    WHEN 'location_access_request' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'requester',
      'counterpart_label', owner_label,
      'requested_duration_hours', requested_duration_hours_value,
      'requested_duration_mode', requested_duration_mode_value,
      'is_extension', is_extension_value,
      'request_id', NEW.request_id::TEXT
    ))
    WHEN 'location_access_denied' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'requester',
      'counterpart_label', owner_label,
      'is_extension', is_extension_value
    ))
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
    NEW.id::TEXT
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS uq_feed_events_source_projection;

COMMIT;
