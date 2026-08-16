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

-- Drop the requester fan-out and its trigger. Crucially this does NOT touch
-- feed_events_from_one_location_events() or 152's recipient function: the
-- forward migration never replaced them, so a rollback that "restored" either
-- would be reverting somebody else's migration, which is the exact failure the
-- separate-function split exists to prevent.
DROP TRIGGER IF EXISTS one_location_events_feed_fanout_requester ON one_location_events;
DROP FUNCTION IF EXISTS feed_events_requester_from_one_location_events();

-- Requester-side rows already written stay. They are presentation-only history,
-- and deleting another person's feed to undo a schema change is the larger harm.

COMMIT;
