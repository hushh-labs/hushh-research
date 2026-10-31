BEGIN;

-- Carry the share lane into the Feed's projected metadata.
--
-- `share_kind` is the only field that separates the SMS (Save my Soul)
-- emergency lane from an ordinary location share. It has been allowlisted for
-- the Feed since #5552 and the renderer branches on it, but the two projection
-- functions in migration 179 build their metadata key by key -- deliberately,
-- so nothing from a domain event is copied wholesale into a plaintext row --
-- and neither of them listed this key. So the client asked "was this an
-- emergency?" and the answer was always no.
--
-- The visible result: sending an SMS alert and then stopping it read as "You
-- started sharing location" / "You stopped sharing", the same two lines an
-- ordinary share writes, on the one screen people scan to find out what needs
-- them. It was wrong for BOTH audiences, because both functions omitted it.
--
-- Bounded to 40 characters, matching the `share_kind` column the API accepts,
-- and extracted with the same `jsonb_typeof` guard every other string input
-- here uses. `jsonb_strip_nulls` keeps the key absent rather than null for
-- rows written before the emitters started stamping it, so existing Feed rows
-- keep rendering exactly as they do today.

CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  counterpart_label TEXT;
  reason_value TEXT;
  share_kind_value TEXT;
  duration_hours_value TEXT;
  duration_mode_value TEXT;
  requested_duration_hours_value TEXT;
  requested_duration_mode_value TEXT;
  direction_value TEXT;
  is_extension_value BOOLEAN;
  public_location_view_value BOOLEAN;
  submission_id_value TEXT;
  source_row_id_value TEXT;
  feed_metadata JSONB;
BEGIN
  IF NEW.event_type = 'location_share_created'
     AND NEW.metadata->>'reason' = 'request_approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type IN (
    'location_share_created',
    'location_share_revoked',
    'location_share_shortened',
    'location_share_duration_changed',
    'location_share_expired',
    'location_access_request',
    'location_access_approved',
    'location_access_denied',
    'location_access_request_withdrawn',
    'location_public_invite_submitted',
    'location_one_network_joined'
  ) THEN
    -- Feed is plaintext. Extract only scalar renderer inputs, bound every
    -- string, and choose the keys separately for each event family. Never
    -- copy the domain event's metadata object wholesale.
    counterpart_label := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'counterpart_label') = 'string'
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'counterpart_label'), ''), 160)
    END;
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
    requested_duration_hours_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'requested_duration_hours') IN ('number', 'string')
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'requested_duration_hours'), ''), 32)
    END;
    requested_duration_mode_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'requested_duration_mode') = 'string'
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'requested_duration_mode'), ''), 32)
    END;
    direction_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'direction') = 'string'
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'direction'), ''), 32)
    END;
    is_extension_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'is_extension') = 'boolean'
      THEN (NEW.metadata ->> 'is_extension')::BOOLEAN
    END;
    public_location_view_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'public_location_view') = 'boolean'
      THEN (NEW.metadata ->> 'public_location_view')::BOOLEAN
    END;
    submission_id_value := CASE
      WHEN jsonb_typeof(NEW.metadata -> 'submission_id') = 'string'
      THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'submission_id'), ''), 256)
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
      WHEN 'location_access_request' THEN CONCAT(
        COALESCE(NEW.request_id::TEXT, NEW.id::TEXT),
        ':revision:',
        COALESCE(LEFT(NULLIF(BTRIM(NEW.metadata ->> 'request_revision'), ''), 32), '1')
      )
      WHEN 'location_access_approved' THEN COALESCE(NEW.request_id::TEXT, NEW.id::TEXT)
      WHEN 'location_access_denied' THEN COALESCE(NEW.request_id::TEXT, NEW.id::TEXT)
      WHEN 'location_access_request_withdrawn' THEN COALESCE(
        NEW.request_id::TEXT,
        NEW.id::TEXT
      )
      WHEN 'location_public_invite_submitted' THEN COALESCE(
        submission_id_value,
        NEW.id::TEXT
      )
      WHEN 'location_one_network_joined' THEN COALESCE(
        LEFT(NULLIF(BTRIM(NEW.metadata ->> 'invite_id'), ''), 160),
        LEFT(NULLIF(BTRIM(NEW.metadata ->> 'connection_id'), ''), 160),
        NEW.id::TEXT
      )
      ELSE NEW.id::TEXT
    END;

    feed_metadata := CASE NEW.event_type
      WHEN 'location_share_created' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'duration_hours', duration_hours_value,
        'duration_mode', duration_mode_value,
        'share_kind', share_kind_value
      ))
      WHEN 'location_share_revoked' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'reason', reason_value,
        'share_kind', share_kind_value
      ))
      WHEN 'location_share_shortened' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'reason', reason_value,
        'grant_id', NEW.grant_id::TEXT
      ))
      WHEN 'location_share_duration_changed' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'direction', direction_value,
        'grant_id', NEW.grant_id::TEXT
      ))
      WHEN 'location_share_expired' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'share_kind', share_kind_value
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
      WHEN 'location_access_request_withdrawn' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'request_id', NEW.request_id::TEXT
      ))
      WHEN 'location_public_invite_submitted' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'public_location_view', public_location_view_value,
        'submission_id', submission_id_value,
        'request_id', NEW.request_id::TEXT
      ))
      WHEN 'location_one_network_joined' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label
      ))
      ELSE '{}'::jsonb
    END;

    INSERT INTO feed_events (
      user_id, source_domain, event_type, metadata, source_row_id
    )
    VALUES (
      NEW.owner_user_id,
      'location',
      NEW.event_type,
      feed_metadata,
      source_row_id_value
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION feed_events_from_one_location_events() IS
  'Fans owner-facing One Location transitions into Feed, carrying the share lane so an SMS alert is not narrated as an ordinary share.';

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
