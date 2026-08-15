-- Reverse 151.
--
-- Dropping the columns drops the requested durations with them. That is the
-- correct loss rather than a lossy one: a requested duration only ever informs
-- an approval decision that has not been made yet, and the grants those
-- approvals produced carry their own duration on the grant row. Nothing that
-- already holds access loses time here.
--
-- The event_type CHECK goes back to exactly what migration 068 left, including
-- its omission of location_share_shortened -- a rollback restores the prior
-- schema, it does not keep the half of this migration it liked.

BEGIN;

DROP INDEX IF EXISTS idx_one_location_access_requests_extends_grant_pending;

ALTER TABLE one_location_access_requests
  DROP CONSTRAINT IF EXISTS one_location_access_requests_requested_duration_contract;

ALTER TABLE one_location_access_requests
  DROP CONSTRAINT IF EXISTS one_location_access_requests_revision_positive;

ALTER TABLE one_location_access_requests
  DROP COLUMN IF EXISTS requested_duration_hours;

ALTER TABLE one_location_access_requests
  DROP COLUMN IF EXISTS requested_duration_mode;

ALTER TABLE one_location_access_requests
  DROP COLUMN IF EXISTS extends_grant_id;

ALTER TABLE one_location_access_requests
  DROP COLUMN IF EXISTS request_revision;

ALTER TABLE one_location_events
  DROP CONSTRAINT IF EXISTS one_location_events_event_type_check;

ALTER TABLE one_location_events
  ADD CONSTRAINT one_location_events_event_type_check CHECK (
    event_type IN (
      'location_recipient_key_registered',
      'location_share_created',
      'location_envelope_updated',
      'location_share_viewed',
      'location_share_revoked',
      'location_share_expired',
      'location_access_request',
      'location_access_approved',
      'location_access_denied',
      'location_referral_invite',
      'location_public_invite_created',
      'location_public_invite_revoked',
      'location_public_invite_submitted',
      'location_circle_invite_created',
      'location_circle_invite_claimed',
      'location_circle_invite_revoked',
      'location_one_network_joined'
    )
  ) NOT VALID;

-- Back to the owner-scoped fan-out exactly as migration 117 defined it.
CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()
RETURNS TRIGGER AS $$
BEGIN
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

COMMENT ON FUNCTION feed_events_from_one_location_events() IS
  'Fans out feed-worthy one_location_events inserts into feed_events, owner-scoped.';

COMMIT;
