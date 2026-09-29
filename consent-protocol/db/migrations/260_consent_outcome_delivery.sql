-- Consent outcome delivery: one side effect per event, one Feed item per request.
--
-- 1. consent_event_deliveries. Every backend worker on every instance LISTENs
--    on consent_audit_new, and PostgreSQL broadcasts each NOTIFY to all of
--    them. Measured on UAT 2026-09-28: one consent_audit row produced eight
--    NOTIFICATION_SENT rows and eight pushes. A worker now claims an event by
--    inserting its key here; only the worker whose INSERT returns a row sends
--    the push, writes the delivery record, or rings the requester. Rows hold a
--    key and a time, nothing about the request, and are pruned after 14 days.
--
-- 2. consent_audit_notify() adds the row id (audit_id) to the NOTIFY payload so
--    the claim key is the consent_audit id, not a reconstruction of it.
--
-- 3. feed_events_from_consent_audit() writes ONE owner Feed row per
--    person-to-person request bundle (a REQUESTED row that carries a bundle_id)
--    instead of one per field, carrying who asked, why, and the human labels of
--    what they asked for. Every other action keeps its per-row behaviour.
--
-- Replay-safe: CREATE ... IF NOT EXISTS, CREATE OR REPLACE FUNCTION, and an
-- index created only when absent, so re-running on each deploy takes no lock on
-- a populated table and changes nothing. Nothing here deletes or rewrites rows.

BEGIN;

CREATE TABLE IF NOT EXISTS consent_event_deliveries (
  delivery_key TEXT PRIMARY KEY CHECK (char_length(delivery_key) BETWEEN 1 AND 200),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF to_regclass('public.idx_consent_event_deliveries_claimed_at') IS NULL THEN
    CREATE INDEX idx_consent_event_deliveries_claimed_at
      ON consent_event_deliveries (claimed_at);
  END IF;
END
$$;

COMMENT ON TABLE consent_event_deliveries IS
  'Exactly-once claim per consent event side effect (push, delivery record, requester doorbell) across workers and instances. Key and time only.';

CREATE OR REPLACE FUNCTION consent_audit_notify()
RETURNS TRIGGER AS $$
DECLARE
  payload TEXT;
BEGIN
  payload := json_build_object(
    'audit_id', NEW.id,
    'user_id', NEW.user_id,
    'request_id', COALESCE(NEW.request_id, ''),
    'action', NEW.action,
    'scope', COALESCE(NEW.scope, ''),
    'agent_id', COALESCE(NEW.agent_id, ''),
    'scope_description', COALESCE(NEW.scope_description, ''),
    'issued_at', NEW.issued_at,
    'bundle_id', COALESCE(NEW.metadata->>'bundle_id', ''),
    'bundle_label', COALESCE(NEW.metadata->>'bundle_label', ''),
    'bundle_scope_count', COALESCE(NEW.metadata->>'bundle_scope_count', '1')
  )::TEXT;
  PERFORM pg_notify('consent_audit_new', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- One owner Feed row per request bundle. Legacy rows never carried bundle_id,
-- so this unique index covers no existing row and cannot fail on old data.
DO $$
BEGIN
  IF to_regclass('public.uq_feed_events_consent_request_bundle') IS NULL THEN
    CREATE UNIQUE INDEX uq_feed_events_consent_request_bundle
      ON feed_events (user_id, (metadata->>'bundle_id'))
      WHERE source_domain = 'consent'
        AND event_type = 'consent_requested'
        AND metadata ? 'bundle_id';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION feed_events_from_consent_audit()
RETURNS TRIGGER AS $$
DECLARE
  v_bundle_id TEXT := NULLIF(BTRIM(COALESCE(NEW.metadata->>'bundle_id', '')), '');
  v_label TEXT := LEFT(
    COALESCE(
      NULLIF(BTRIM(COALESCE(NEW.metadata->>'human_label', '')), ''),
      NULLIF(BTRIM(COALESCE(NEW.scope_description, '')), ''),
      'Information'
    ),
    80
  );
  v_requester TEXT := LEFT(
    NULLIF(BTRIM(COALESCE(NEW.metadata->>'requester_label', '')), ''),
    160
  );
BEGIN
  IF NEW.action = 'REQUESTED' AND v_bundle_id IS NOT NULL THEN
    INSERT INTO feed_events (
      user_id, source_domain, event_type, actor_label, metadata, source_row_id
    )
    VALUES (
      NEW.user_id,
      'consent',
      'consent_requested',
      v_requester,
      jsonb_strip_nulls(jsonb_build_object(
        'bundle_id', v_bundle_id,
        'request_id', NEW.request_id,
        'scope', NEW.scope,
        'agent_id', NEW.agent_id,
        'scope_description', COALESCE(NEW.scope_description, ''),
        'counterpart_label', v_requester,
        'counterpart_photo_url', NULLIF(NEW.metadata->>'requester_image_url', ''),
        'reason', LEFT(NULLIF(BTRIM(COALESCE(NEW.metadata->>'reason', '')), ''), 256),
        'requested_labels', v_label,
        'requested_count', 1
      )),
      NEW.id::TEXT
    )
    ON CONFLICT (user_id, (metadata->>'bundle_id'))
      WHERE source_domain = 'consent'
        AND event_type = 'consent_requested'
        AND metadata ? 'bundle_id'
    DO UPDATE SET metadata = feed_events.metadata || jsonb_build_object(
      'requested_labels',
      CASE
        WHEN position(
          ', ' || v_label || ', '
          IN ', ' || COALESCE(feed_events.metadata->>'requested_labels', '') || ', '
        ) > 0
          THEN feed_events.metadata->>'requested_labels'
        ELSE LEFT(
          COALESCE(NULLIF(feed_events.metadata->>'requested_labels', '') || ', ', '')
            || v_label,
          256
        )
      END,
      'requested_count',
      COALESCE((feed_events.metadata->>'requested_count')::INT, 1) + 1
    );
  ELSIF NEW.action IN ('REQUESTED', 'CONSENT_GRANTED', 'REVOKED') THEN
    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.user_id,
      'consent',
      CASE NEW.action
        WHEN 'REQUESTED' THEN 'consent_requested'
        WHEN 'CONSENT_GRANTED' THEN 'consent_granted'
        WHEN 'REVOKED' THEN 'consent_revoked'
      END,
      jsonb_build_object(
        'scope', NEW.scope,
        'agent_id', NEW.agent_id,
        'scope_description', COALESCE(NEW.scope_description, '')
      ),
      NEW.id::TEXT
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION feed_events_from_consent_audit() IS
  'Fans out feed-worthy consent_audit inserts into feed_events: one row per person-to-person request bundle, one row per event otherwise.';

COMMIT;
