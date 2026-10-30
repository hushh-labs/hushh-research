-- Roll back code first: the previous backend neither claims deliveries nor reads
-- audit_id. This restores the migration 025 NOTIFY payload and the migration 117
-- per-row Feed fan-out. Bundle Feed rows already written stay (they are ordinary
-- feed_events rows); only the unique index that grouped them is removed.
-- consent_event_deliveries holds claim keys and times only, so dropping it loses
-- nothing a person can see; it is refused while claims are younger than a day so
-- a rollback during live traffic cannot re-open duplicate pushes for recent events.
BEGIN;

DO $$
DECLARE
  has_recent BOOLEAN;
BEGIN
  IF to_regclass('public.consent_event_deliveries') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM consent_event_deliveries
                      WHERE claimed_at > NOW() - INTERVAL ''1 day'' LIMIT 1)'
      INTO has_recent;
    IF has_recent THEN
      RAISE EXCEPTION
        'migration_260_rollback_refused_recent_claims:consent_event_deliveries';
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION consent_audit_notify()
RETURNS TRIGGER AS $$
DECLARE
  payload TEXT;
BEGIN
  payload := json_build_object(
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

CREATE OR REPLACE FUNCTION feed_events_from_consent_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action IN ('REQUESTED', 'CONSENT_GRANTED', 'REVOKED') THEN
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

DROP INDEX IF EXISTS uq_feed_events_consent_request_bundle;
DROP TABLE IF EXISTS consent_event_deliveries;

COMMIT;
