BEGIN;

-- Roll back migration 153: stop allowing `location_share_duration_changed` in
-- one_location_events.event_type.
--
-- Rows already written with that value are LEFT IN PLACE, and this is the part
-- that has to be got right. Re-adding the constraint validating would fail on
-- them and take the rollback down with it, which is exactly the outage
-- migration 153 exists downstream of. So the constraint comes back NOT VALID:
-- new writes are refused, existing history is kept and never re-checked.
--
-- That history is a true record of end times people really changed. Deleting
-- it to make a constraint pass would remove real consent events from the
-- ledger, which is a worse outcome than a narrower constraint carrying a few
-- older values.
--
-- Roll the service back with this, or the first duration change after it
-- writes a row the constraint now refuses.

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
      'location_share_shortened',
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

COMMIT;
