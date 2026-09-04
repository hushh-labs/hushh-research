BEGIN;

-- One durable source transition may be retried, but it must produce at most
-- one Feed row per audience. NULL source ids remain available to legacy
-- best-effort producers that do not yet have an authoritative event id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_events_source_projection
  ON feed_events (user_id, source_domain, event_type, source_row_id)
  WHERE source_row_id IS NOT NULL;

-- Preserve migration 151's approval de-duplication while projecting every
-- owner-facing One Location transition that also emits a notification.
CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  counterpart_label TEXT;
  reason_value TEXT;
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
        'duration_mode', duration_mode_value
      ))
      WHEN 'location_share_revoked' THEN jsonb_strip_nulls(jsonb_build_object(
        'counterpart_label', counterpart_label,
        'reason', reason_value
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
  'Fans owner-facing One Location notification events into Feed while preserving approval-born share de-duplication.';

-- Extend migration 152's recipient projection to duration/shortening/network
-- transitions. The owner is always the counterpart from this audience.
CREATE OR REPLACE FUNCTION feed_events_recipient_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  owner_label TEXT;
  reason_value TEXT;
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
      'duration_mode', duration_mode_value
    ))
    WHEN 'location_share_revoked' THEN jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person')
    )
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
    WHEN 'location_share_expired' THEN jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person')
    )
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
  'Fans recipient-facing share and One Network notification events into Feed, naming the location owner as counterpart.';

-- Migration 154 established requester-side request history. Withdrawal is the
-- same two-party workflow and must retire the ask in both feeds.
CREATE OR REPLACE FUNCTION feed_events_requester_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  owner_label TEXT;
  requested_duration_hours_value TEXT;
  requested_duration_mode_value TEXT;
  is_extension_value BOOLEAN;
  source_row_id_value TEXT;
  feed_metadata JSONB;
BEGIN
  IF NEW.event_type NOT IN (
    'location_access_request',
    'location_access_denied',
    'location_access_request_withdrawn'
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
  source_row_id_value := CASE NEW.event_type
    WHEN 'location_access_request' THEN CONCAT(
      COALESCE(NEW.request_id::TEXT, NEW.id::TEXT),
      ':revision:',
      COALESCE(LEFT(NULLIF(BTRIM(NEW.metadata ->> 'request_revision'), ''), 32), '1')
    )
    ELSE COALESCE(NEW.request_id::TEXT, NEW.id::TEXT)
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
    WHEN 'location_access_request_withdrawn' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'requester',
      'counterpart_label', owner_label,
      'request_id', NEW.request_id::TEXT
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
    source_row_id_value
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION feed_events_requester_from_one_location_events() IS
  'Fans request, denial, and withdrawal events into the requester Feed with the location owner as counterpart.';

-- A referral notification belongs only to the referred person. The location
-- owner already receives the separately authoritative access-request row.
CREATE OR REPLACE FUNCTION feed_events_referred_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  referring_label TEXT;
  owner_label TEXT;
BEGIN
  IF NEW.event_type <> 'location_referral_invite'
     OR NEW.recipient_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  referring_label := NULLIF(
    LEFT(BTRIM(CASE
      WHEN jsonb_typeof(NEW.metadata -> 'referring_label') = 'string'
      THEN NEW.metadata ->> 'referring_label'
    END), 160),
    ''
  );
  owner_label := NULLIF(
    LEFT(BTRIM(CASE
      WHEN jsonb_typeof(NEW.metadata -> 'owner_label') = 'string'
      THEN NEW.metadata ->> 'owner_label'
    END), 160),
    ''
  );

  IF referring_label IS NULL AND NEW.actor_user_id IS NOT NULL THEN
    SELECT CASE
      WHEN NULLIF(BTRIM(display_name), '') IS NOT NULL
       AND BTRIM(display_name) <> NEW.actor_user_id
       AND BTRIM(display_name) !~* '^ria:'
       AND BTRIM(display_name) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND NOT (
         BTRIM(display_name) !~ '[@[:space:]]'
         AND LENGTH(BTRIM(display_name)) >= 20
       )
      THEN LEFT(BTRIM(display_name), 160)
    END
      INTO referring_label
      FROM actor_identity_cache
     WHERE user_id = NEW.actor_user_id;
  END IF;
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

  INSERT INTO feed_events (
    user_id, source_domain, event_type, metadata, source_row_id
  )
  VALUES (
    NEW.recipient_user_id,
    'location',
    NEW.event_type,
    jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'referred',
      'counterpart_label', COALESCE(referring_label, 'A trusted person'),
      'owner_label', COALESCE(owner_label, 'A trusted person'),
      'request_id', NEW.request_id::TEXT,
      'referral_id', NEW.referral_id::TEXT
    )),
    COALESCE(NEW.referral_id::TEXT, NEW.id::TEXT)
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_location_events_feed_fanout_referred
  ON one_location_events;
CREATE TRIGGER one_location_events_feed_fanout_referred
  AFTER INSERT ON one_location_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_referred_from_one_location_events();

COMMENT ON FUNCTION feed_events_referred_from_one_location_events() IS
  'Projects a location referral only to the referred user; the owner already has the access-request event.';

-- Funding already owns a durable event ledger. Project terminal user-facing
-- transitions from that ledger, not from best-effort FCM delivery, and keep
-- financial amount/account/provider/failure details out of plaintext Feed.
CREATE OR REPLACE FUNCTION feed_events_from_kai_funding_transfer_events()
RETURNS TRIGGER AS $$
DECLARE
  normalized_status TEXT;
  transfer_direction TEXT;
BEGIN
  IF NEW.event_type NOT IN ('transfer_created', 'transfer_status_updated') THEN
    RETURN NEW;
  END IF;

  normalized_status := CASE LOWER(COALESCE(NEW.event_status, ''))
    WHEN 'completed' THEN 'completed'
    WHEN 'settled' THEN 'completed'
    WHEN 'canceled' THEN 'canceled'
    WHEN 'failed' THEN 'failed'
    WHEN 'rejected' THEN 'failed'
    WHEN 'error' THEN 'failed'
    WHEN 'returned' THEN 'returned'
    WHEN 'reversed' THEN 'returned'
    ELSE NULL
  END;
  IF normalized_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT direction
    INTO transfer_direction
    FROM kai_funding_transfers
   WHERE transfer_id = NEW.transfer_id;

  INSERT INTO feed_events (
    user_id, source_domain, event_type, metadata, source_row_id
  )
  VALUES (
    NEW.user_id,
    'kai',
    'funding_transfer_status',
    jsonb_build_object(
      'user_facing_status', normalized_status,
      'direction', COALESCE(transfer_direction, '')
    ),
    NEW.transfer_id || ':' || normalized_status
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kai_funding_transfer_events_feed_fanout
  ON kai_funding_transfer_events;
CREATE TRIGGER kai_funding_transfer_events_feed_fanout
  AFTER INSERT ON kai_funding_transfer_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_from_kai_funding_transfer_events();

COMMENT ON FUNCTION feed_events_from_kai_funding_transfer_events() IS
  'Projects one privacy-bounded Feed row per terminal funding transfer status and user.';

COMMIT;
