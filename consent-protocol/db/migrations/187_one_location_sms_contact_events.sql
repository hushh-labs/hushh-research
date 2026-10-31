BEGIN;

-- Tell someone they are (or are no longer) an SMS contact.
--
-- Being on a person's SMS Circle is the most consequential relationship One
-- Location has: it is the list that receives their Save my Soul alert, and
-- membership decides whether an emergency reaches you at all. Until now it was
-- also the only relationship the product changed in complete silence.
-- `add_sms_contact` was a lock plus a bare INSERT and `remove_sms_contact` a
-- bare DELETE -- no event, no Feed row, no notification, on either side. The
-- only feedback anywhere was a toast on the adder's own device.
--
-- So a person could be enrolled as somebody's emergency contact, carry that
-- duty for months, and never be told; and could be dropped from the list
-- without ever learning that the alert they were expecting to receive would
-- not arrive.
--
-- Two new event types, and one projection that writes a row for BOTH sides:
-- the owner sees what they changed, the contact learns what changed about
-- them.

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
      'circle_member_added',
      'location_sms_contact_added',
      'location_sms_contact_removed'
    )
  ) NOT VALID;

-- One function, both audiences, because the two rows are the same transition
-- read from opposite ends and keeping them together is what stops them
-- drifting apart. Feed is plaintext: only bounded scalar renderer inputs are
-- copied, never the domain event's metadata object.
CREATE OR REPLACE FUNCTION feed_events_from_one_location_sms_contact_events()
RETURNS TRIGGER AS $$
DECLARE
  contact_label TEXT;
  owner_label TEXT;
BEGIN
  IF NEW.event_type NOT IN (
    'location_sms_contact_added',
    'location_sms_contact_removed'
  ) THEN
    RETURN NEW;
  END IF;

  contact_label := NULLIF(
    LEFT(BTRIM(COALESCE(NEW.metadata ->> 'counterpart_label', '')), 160),
    ''
  );
  owner_label := NULLIF(
    LEFT(BTRIM(COALESCE(NEW.metadata ->> 'owner_label', '')), 160),
    ''
  );

  -- The owner's row: what they just changed, about whom.
  INSERT INTO feed_events (
    user_id, source_domain, event_type, actor_label, metadata, source_row_id
  )
  VALUES (
    NEW.owner_user_id,
    'location',
    NEW.event_type,
    contact_label,
    jsonb_strip_nulls(jsonb_build_object(
      'counterpart_label', COALESCE(contact_label, 'A trusted person')
    )),
    NEW.id::TEXT
  )
  ON CONFLICT DO NOTHING;

  -- The contact's row: what changed about THEM. `feed_audience` is the same
  -- discriminator migrations 152/179 use, so the renderer reads this side with
  -- the branch it already has.
  IF NEW.recipient_user_id IS NOT NULL
     AND NEW.recipient_user_id <> NEW.owner_user_id THEN
    INSERT INTO feed_events (
      user_id, source_domain, event_type, actor_label, metadata, source_row_id
    )
    VALUES (
      NEW.recipient_user_id,
      'location',
      NEW.event_type,
      owner_label,
      jsonb_strip_nulls(jsonb_build_object(
        'feed_audience', 'recipient',
        'counterpart_label', COALESCE(owner_label, 'A trusted person')
      )),
      CONCAT(NEW.id::TEXT, ':recipient')
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_location_sms_contact_events_feed_fanout
  ON one_location_events;
CREATE TRIGGER one_location_sms_contact_events_feed_fanout
  AFTER INSERT ON one_location_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_from_one_location_sms_contact_events();

COMMENT ON FUNCTION feed_events_from_one_location_sms_contact_events() IS
  'Projects SMS Circle membership changes into Feed for the owner and the contact, so nobody is enrolled as an emergency contact in silence.';

COMMIT;
