BEGIN;

-- Wait for old publishers before taking the repair snapshot, and hold incoming
-- audit writes until the confirmed publisher is installed atomically.
SET LOCAL lock_timeout = '10s';
LOCK TABLE one_location_events IN SHARE ROW EXCLUSIVE MODE;

-- Stamp legacy receipts once from authoritative stored publication evidence.
-- Explicit false is a draft marker; a later upload creates a new receipt.
UPDATE feed_events f SET metadata = f.metadata || jsonb_build_object(
  'feed_sms_confirmed', EXISTS (
    SELECT 1 FROM one_location_share_grants g JOIN one_location_envelopes e
      ON e.id=g.latest_envelope_id AND e.grant_id=g.id
      AND e.owner_user_id=g.owner_user_id AND e.recipient_user_id=g.recipient_user_id
    WHERE g.id=CASE WHEN split_part(f.source_row_id,':',1) ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN split_part(f.source_row_id,':',1)::uuid END
      AND g.recipient_user_id=f.user_id AND g.metadata->>'share_kind'='sos'))
WHERE f.source_domain='location' AND f.event_type='location_share_created'
  AND f.metadata->>'feed_audience'='recipient' AND f.metadata->>'share_kind'='sos'
  AND NOT (f.metadata ? 'feed_sms_confirmed');

-- Repair only misclassified legacy drafts in the presentation log. Keep their
-- ids, event times and authoritative Location audit intact; they were never
-- confirmed shares. The kind change frees the canonical grant publication key
-- and keeps pre458 readers from ranking a dismissed draft as the latest SOS.
UPDATE feed_events f SET event_type='location_share_unconfirmed',
  source_row_id=CASE WHEN EXISTS (
    SELECT 1 FROM feed_events prior WHERE prior.user_id=f.user_id
      AND prior.source_domain=f.source_domain AND prior.event_type='location_share_unconfirmed'
      AND prior.source_row_id=f.source_row_id)
    THEN f.source_row_id || ':draft:' || f.id::text ELSE f.source_row_id END,
  dismissed_at=COALESCE(f.dismissed_at,NOW()), read_at=COALESCE(f.read_at,NOW()),
  dismissal_token=gen_random_uuid()::text
WHERE f.source_domain='location' AND f.event_type='location_share_created'
  AND f.metadata->>'feed_audience'='recipient' AND f.metadata->>'share_kind'='sos'
  AND f.metadata->'feed_sms_confirmed'='false'::jsonb;

UPDATE feed_events f SET metadata=f.metadata || jsonb_build_object('actor_is_self',
  COALESCE((SELECT e.actor_user_id=f.user_id FROM one_location_events e
    WHERE e.recipient_user_id=f.user_id AND e.event_type=f.event_type
      AND (e.id=CASE WHEN f.source_row_id ~ '^[0-9]{1,18}$' THEN f.source_row_id::bigint END
        OR e.grant_id=CASE WHEN split_part(f.source_row_id,':',1) ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN split_part(f.source_row_id,':',1)::uuid END)
    ORDER BY e.id LIMIT 1),TRUE))
WHERE f.source_domain='location' AND f.event_type='location_share_revoked'
  AND f.metadata->>'feed_audience'='recipient' AND NOT (f.metadata ? 'actor_is_self');

CREATE OR REPLACE FUNCTION feed_events_recipient_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  owner_label TEXT;
  reason_value TEXT;
  share_kind_value TEXT;
  duration_hours_value TEXT;
  duration_mode_value TEXT;
  direction_value TEXT;
  source_row_id_value TEXT;
  feed_metadata JSONB;
  published_id BIGINT;
  authoritative_kind TEXT;
BEGIN
  IF NEW.recipient_user_id IS NULL
     OR NEW.recipient_user_id = NEW.owner_user_id THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type NOT IN (
    'location_envelope_updated',
    'location_share_created',
    'location_share_revoked',
    'location_share_shortened',
    'location_share_duration_changed',
    'location_share_expired',
    'location_one_network_joined'
  ) THEN
    RETURN NEW;
  END IF;

  -- Routine GPS points neither resolve display identities nor re-publish an
  -- existing incident. Both guards use canonical primary/idempotency keys.
  IF NEW.event_type = 'location_envelope_updated' THEN
    IF NOT EXISTS (SELECT 1 FROM one_location_share_grants g
      WHERE g.id=NEW.grant_id AND g.owner_user_id=NEW.owner_user_id
        AND g.recipient_user_id=NEW.recipient_user_id AND g.metadata->>'share_kind'='sos')
      OR EXISTS (SELECT 1 FROM feed_events f
        WHERE f.user_id=NEW.recipient_user_id AND f.source_domain='location'
          AND f.event_type='location_share_created' AND f.source_row_id=NEW.grant_id::text
          AND f.metadata->'feed_sms_confirmed'='true'::jsonb)
    THEN RETURN NEW; END IF;
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
  share_kind_value := CASE
    WHEN jsonb_typeof(NEW.metadata -> 'share_kind') = 'string'
    THEN LEFT(NULLIF(BTRIM(NEW.metadata ->> 'share_kind'), ''), 40)
  END;
  -- A grant is only an SOS draft until an encrypted envelope is stored.
  -- Publish once at first confirmed upload, in the writer's transaction.
  SELECT g.metadata->>'share_kind' INTO authoritative_kind
    FROM one_location_share_grants g
   WHERE g.id = NEW.grant_id AND g.owner_user_id = NEW.owner_user_id
     AND g.recipient_user_id = NEW.recipient_user_id;
  IF NEW.event_type = 'location_envelope_updated'
     OR (NEW.event_type = 'location_share_created'
       AND COALESCE(authoritative_kind, share_kind_value) = 'sos') THEN
    IF authoritative_kind IS DISTINCT FROM 'sos' OR NOT EXISTS (
      SELECT 1 FROM one_location_share_grants g
      JOIN one_location_envelopes e ON e.id = g.latest_envelope_id
       AND e.grant_id = g.id AND e.owner_user_id = g.owner_user_id
       AND e.recipient_user_id = g.recipient_user_id
      WHERE g.id = NEW.grant_id AND g.owner_user_id = NEW.owner_user_id
        AND g.recipient_user_id = NEW.recipient_user_id
        AND (NEW.event_type = 'location_share_created' OR e.id = NEW.envelope_id)
    ) THEN RETURN NEW; END IF;
    -- Confirmed legacy receipts already represent this incident. Explicitly
    -- unconfirmed legacy drafts retain their id/timestamp as quarantined presentation;
    -- publication gets a fresh receipt at the canonical grant key.
    IF EXISTS (SELECT 1 FROM feed_events f
      WHERE f.user_id = NEW.recipient_user_id AND f.source_domain = 'location'
        AND f.event_type = 'location_share_created'
        AND f.source_row_id = NEW.grant_id::text
        AND f.metadata->'feed_sms_confirmed' = 'true'::jsonb)
    THEN RETURN NEW; END IF;
    INSERT INTO feed_events(user_id,source_domain,event_type,metadata,source_row_id,created_at)
    VALUES (NEW.recipient_user_id,'location','location_share_created',
      jsonb_build_object('feed_audience','recipient','share_kind','sos',
        'grant_id',NEW.grant_id::text,'feed_sms_confirmed',true,'actor_is_self',false,
        'counterpart_label',COALESCE(owner_label,'A trusted person')),
      NEW.grant_id::text,NEW.created_at)
    ON CONFLICT DO NOTHING RETURNING id INTO published_id;
    IF published_id IS NOT NULL THEN
      -- Resolve the publication identity directly from the authoritative sender.
      -- This also covers a first-envelope audit following legacy source cleanup.
      INSERT INTO feed_event_counterparts(feed_event_id,counterpart_user_id)
      SELECT published_id, p.user_id FROM actor_profiles p WHERE p.user_id = NEW.owner_user_id
      ON CONFLICT (feed_event_id) DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

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
      'duration_mode', duration_mode_value,
      'share_kind', share_kind_value
    ))
    WHEN 'location_share_revoked' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person'),
      'share_kind', share_kind_value
    ))
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
    WHEN 'location_share_expired' THEN jsonb_strip_nulls(jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person'),
      'share_kind', share_kind_value
    ))
    WHEN 'location_one_network_joined' THEN jsonb_build_object(
      'feed_audience', 'recipient',
      'counterpart_label', COALESCE(owner_label, 'A trusted person')
    )
    ELSE '{}'::jsonb
  END;

  feed_metadata := feed_metadata || jsonb_strip_nulls(jsonb_build_object(
    'actor_is_self', COALESCE(NEW.actor_user_id = NEW.recipient_user_id, FALSE),
    'share_kind', COALESCE(authoritative_kind, share_kind_value)));

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
  'Fans recipient-facing One Location transitions into Feed, carrying the share lane so an SMS alert is not narrated as an ordinary share.';


COMMIT;
