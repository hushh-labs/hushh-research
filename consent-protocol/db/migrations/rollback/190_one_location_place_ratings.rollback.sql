BEGIN;

-- Refuse to drop a table that holds anything.
--
-- A rating is the only durable record that a person was at a venue, and the
-- visit ledger is the only thing that can re-derive one. Dropping either with
-- rows in it is unrecoverable, so the rollback stops rather than guesses.
DO $$
DECLARE
  has_rows BOOLEAN;
BEGIN
  IF to_regclass('public.one_location_place_ratings') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM one_location_place_ratings LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION
        'migration_190_rollback_refused_nonempty_table:one_location_place_ratings';
    END IF;
  END IF;

  IF to_regclass('public.one_location_nearby_visits') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM one_location_nearby_visits LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION
        'migration_190_rollback_refused_nonempty_table:one_location_nearby_visits';
    END IF;
  END IF;

  IF to_regclass('public.one_location_place_rating_aggregates') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM one_location_place_rating_aggregates LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION
        'migration_190_rollback_refused_nonempty_table:one_location_place_rating_aggregates';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS one_location_place_rating_aggregates;
DROP TABLE IF EXISTS one_location_place_ratings;
DROP TABLE IF EXISTS one_location_nearby_visits;

-- Restore 187's event-type list verbatim. Leaving the widened constraint in
-- place would let a rating event be written against a schema that no longer
-- has anywhere to put it.
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

COMMIT;
