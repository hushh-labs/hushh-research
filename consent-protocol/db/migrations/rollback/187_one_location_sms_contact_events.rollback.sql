BEGIN;

-- Stop projecting SMS Circle membership changes, and restore migration 180's
-- event-type constraint. Rows already written are left alone: deleting them
-- would remove the only record a contact has that they were added.

DROP TRIGGER IF EXISTS one_location_sms_contact_events_feed_fanout
  ON one_location_events;
DROP FUNCTION IF EXISTS feed_events_from_one_location_sms_contact_events();

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
      'location_share_duration_changed',
      'location_share_expired',
      'location_access_request',
      'location_access_approved',
      'location_auto_approve_rule_changed',
      'location_access_denied',
      'location_access_request_withdrawn',
      'location_referral_invite',
      'location_public_invite_created',
      'location_public_invite_revoked',
      'location_public_invite_submitted',
      'location_circle_invite_created',
      'location_circle_invite_claimed',
      'location_circle_invite_revoked',
      'location_one_network_joined',
      'location_circle_code_joined',
      'location_circle_member_invite_accepted',
      'circle_member_added'
    )
  ) NOT VALID;

COMMIT;
