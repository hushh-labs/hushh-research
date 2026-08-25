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
    INSERT INTO feed_events (
      user_id, source_domain, event_type, metadata, source_row_id
    )
    VALUES (
      NEW.owner_user_id,
      'location',
      NEW.event_type,
      COALESCE(NEW.metadata, '{}'::jsonb)
        || jsonb_strip_nulls(jsonb_build_object(
             'grant_id', NEW.grant_id::TEXT,
             'request_id', NEW.request_id::TEXT,
             'referral_id', NEW.referral_id::TEXT
           )),
      NEW.id::TEXT
    )
    ON CONFLICT (
      user_id, source_domain, event_type, source_row_id
    ) WHERE source_row_id IS NOT NULL DO NOTHING;
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

  owner_label := NULLIF(
    BTRIM(COALESCE(NEW.metadata ->> 'owner_label', '')),
    ''
  );
  IF owner_label IS NULL THEN
    SELECT NULLIF(BTRIM(COALESCE(display_name, '')), '')
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
    COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
           'grant_id', NEW.grant_id::TEXT,
           'request_id', NEW.request_id::TEXT,
           'referral_id', NEW.referral_id::TEXT
         ))
      || jsonb_build_object(
           'feed_audience', 'recipient',
           'counterpart_label', COALESCE(owner_label, 'A trusted person')
         ),
    NEW.id::TEXT
  )
  ON CONFLICT (
    user_id, source_domain, event_type, source_row_id
  ) WHERE source_row_id IS NOT NULL DO NOTHING;

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

  owner_label := NULLIF(BTRIM(COALESCE(NEW.metadata ->> 'owner_label', '')), '');
  IF owner_label IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO feed_events (
    user_id, source_domain, event_type, metadata, source_row_id
  )
  VALUES (
    NEW.recipient_user_id,
    'location',
    NEW.event_type,
    COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
           'grant_id', NEW.grant_id::TEXT,
           'request_id', NEW.request_id::TEXT,
           'referral_id', NEW.referral_id::TEXT
         ))
      || jsonb_build_object(
           'feed_audience', 'requester',
           'counterpart_label', owner_label
         ),
    NEW.id::TEXT
  )
  ON CONFLICT (
    user_id, source_domain, event_type, source_row_id
  ) WHERE source_row_id IS NOT NULL DO NOTHING;

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
    BTRIM(COALESCE(NEW.metadata ->> 'referring_label', '')),
    ''
  );
  owner_label := NULLIF(
    BTRIM(COALESCE(NEW.metadata ->> 'owner_label', '')),
    ''
  );

  IF referring_label IS NULL AND NEW.actor_user_id IS NOT NULL THEN
    SELECT NULLIF(BTRIM(COALESCE(display_name, '')), '')
      INTO referring_label
      FROM actor_identity_cache
     WHERE user_id = NEW.actor_user_id;
  END IF;
  IF owner_label IS NULL THEN
    SELECT NULLIF(BTRIM(COALESCE(display_name, '')), '')
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
    COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
           'grant_id', NEW.grant_id::TEXT,
           'request_id', NEW.request_id::TEXT,
           'referral_id', NEW.referral_id::TEXT
         ))
      || jsonb_build_object(
           'feed_audience', 'referred',
           'counterpart_label', COALESCE(referring_label, 'A trusted person'),
           'owner_label', COALESCE(owner_label, 'A trusted person')
         ),
    NEW.id::TEXT
  )
  ON CONFLICT (
    user_id, source_domain, event_type, source_row_id
  ) WHERE source_row_id IS NOT NULL DO NOTHING;

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
  ON CONFLICT (
    user_id, source_domain, event_type, source_row_id
  ) WHERE source_row_id IS NOT NULL DO NOTHING;

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
