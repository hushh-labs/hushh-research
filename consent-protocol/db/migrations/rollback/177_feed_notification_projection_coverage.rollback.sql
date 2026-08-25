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
    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.owner_user_id,
      'location',
      NEW.event_type,
      NEW.metadata,
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

  SELECT NULLIF(BTRIM(COALESCE(display_name, '')), '')
    INTO owner_label
    FROM actor_identity_cache
   WHERE user_id = NEW.owner_user_id;

  INSERT INTO feed_events (
    user_id, source_domain, event_type, metadata, source_row_id
  )
  VALUES (
    NEW.recipient_user_id,
    'location',
    NEW.event_type,
    COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object(
           'feed_audience', 'recipient',
           'counterpart_label', COALESCE(owner_label, 'A trusted person')
         ),
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
      || jsonb_build_object(
           'feed_audience', 'requester',
           'counterpart_label', owner_label
         ),
    NEW.id::TEXT
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS uq_feed_events_source_projection;

COMMIT;
