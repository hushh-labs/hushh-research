BEGIN;

-- Completed Circle transitions already have an authoritative One Location
-- transaction. Record them in the same audit ledger as the membership change
-- so a push can never be delivered without its durable Feed projection.
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

CREATE OR REPLACE FUNCTION feed_events_from_one_location_circle_events()
RETURNS TRIGGER AS $$
DECLARE
  safe_actor_label TEXT;
  safe_metadata JSONB;
  source_row_id_value TEXT;
BEGIN
  IF NEW.event_type NOT IN (
    'location_circle_code_joined',
    'location_circle_member_invite_accepted',
    'circle_member_added'
  ) THEN
    RETURN NEW;
  END IF;

  safe_actor_label := NULLIF(
    LEFT(
      BTRIM(
        COALESCE(
          NEW.metadata->>'counterpart_label',
          NEW.metadata->>'added_by_label',
          ''
        )
      ),
      256
    ),
    ''
  );

  safe_metadata := CASE NEW.event_type
    WHEN 'circle_member_added' THEN
      jsonb_strip_nulls(
        jsonb_build_object(
          'circle_id', NULLIF(LEFT(BTRIM(NEW.metadata->>'circle_id'), 64), ''),
          'circle_name', NULLIF(LEFT(BTRIM(NEW.metadata->>'circle_name'), 80), ''),
          'added_by_label', NULLIF(
            LEFT(BTRIM(NEW.metadata->>'added_by_label'), 256),
            ''
          ),
          'counterpart_label', NULLIF(
            LEFT(BTRIM(NEW.metadata->>'counterpart_label'), 256),
            ''
          )
        )
      )
    ELSE
      jsonb_strip_nulls(
        jsonb_build_object(
          'invite_id', NULLIF(LEFT(BTRIM(NEW.metadata->>'invite_id'), 64), ''),
          'circle_id', NULLIF(LEFT(BTRIM(NEW.metadata->>'circle_id'), 64), ''),
          'circle_name', NULLIF(LEFT(BTRIM(NEW.metadata->>'circle_name'), 80), ''),
          'counterpart_label', NULLIF(
            LEFT(BTRIM(NEW.metadata->>'counterpart_label'), 256),
            ''
          )
        )
      )
  END;
  source_row_id_value := CASE NEW.event_type
    WHEN 'location_circle_code_joined' THEN CONCAT(
      COALESCE(NULLIF(BTRIM(NEW.metadata->>'invite_id'), ''), NEW.id::TEXT),
      ':member:',
      COALESCE(NEW.actor_user_id, NEW.id::TEXT)
    )
    WHEN 'location_circle_member_invite_accepted' THEN CONCAT(
      COALESCE(NULLIF(BTRIM(NEW.metadata->>'invite_id'), ''), NEW.id::TEXT),
      ':member:',
      COALESCE(NEW.actor_user_id, NEW.id::TEXT)
    )
    -- Direct-add can be repeated after a member leaves and is later added
    -- again. No authored operation/membership revision exists in this event,
    -- so its atomic audit-row id is the only collision-safe transition id.
    ELSE NEW.id::TEXT
  END;

  INSERT INTO feed_events (
    user_id,
    source_domain,
    event_type,
    actor_label,
    metadata,
    source_row_id
  )
  VALUES (
    NEW.owner_user_id,
    'location',
    NEW.event_type,
    safe_actor_label,
    safe_metadata,
    source_row_id_value
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_location_circle_events_feed_fanout
  ON one_location_events;
CREATE TRIGGER one_location_circle_events_feed_fanout
  AFTER INSERT ON one_location_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_from_one_location_circle_events();

COMMENT ON FUNCTION feed_events_from_one_location_circle_events() IS
  'Projects completed Circle audit transitions into bounded, source-idempotent Feed history.';

COMMIT;
