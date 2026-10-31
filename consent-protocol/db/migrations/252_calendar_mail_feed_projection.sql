BEGIN;

-- Calendar and Mail are connected systems. Project only closed, content-free
-- outcomes into the same durable Feed ledger used by Drive. Source identifiers
-- are server-side dedupe keys, never part of the Feed API response.
CREATE OR REPLACE FUNCTION project_calendar_mail_feed(
  p_user_id TEXT,
  p_event_type TEXT,
  p_source_row_id TEXT,
  p_created_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql VOLATILE
AS $$
BEGIN
  IF p_user_id IS NULL OR p_source_row_id IS NULL OR p_event_type IS NULL OR p_event_type NOT IN (
    'calendar_connected', 'calendar_reconnect_required', 'calendar_disconnected',
    'calendar_event_created', 'calendar_event_rescheduled', 'calendar_event_canceled',
    'mail_connected', 'mail_reconnect_required', 'mail_disconnected',
    'mail_information_request_detected', 'mail_receipts_imported',
    'mail_sync_completed', 'mail_sync_failed',
    'mail_message_sent', 'mail_message_failed', 'mail_delivery_unconfirmed'
  ) THEN
    RETURN;
  END IF;

  -- Feed is a projection, never the authority for a Calendar or Gmail action.
  BEGIN
    INSERT INTO feed_events (
      user_id, source_domain, event_type, metadata, source_row_id, created_at
    ) VALUES (
      p_user_id, 'connected_systems', p_event_type, '{}'::jsonb,
      p_source_row_id, COALESCE(p_created_at, NOW())
    ) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'calendar_mail_feed_projection_failed sqlstate=%', SQLSTATE;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION feed_from_calendar_grant()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.service <> 'calendar' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM project_calendar_mail_feed(
    NEW.user_id,
    CASE NEW.status
      WHEN 'connected' THEN 'calendar_connected'
      WHEN 'needs_reauth' THEN 'calendar_reconnect_required'
      WHEN 'disconnected' THEN 'calendar_disconnected'
    END,
    'calendar-grant:' || NEW.status || ':' || NEW.updated_at::TEXT,
    NEW.updated_at
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION feed_from_calendar_proposal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'executed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM project_calendar_mail_feed(
      NEW.user_id,
      CASE NEW.action
        WHEN 'create' THEN 'calendar_event_created'
        WHEN 'reschedule' THEN 'calendar_event_rescheduled'
        WHEN 'cancel' THEN 'calendar_event_canceled'
      END,
      NEW.proposal_id,
      NEW.executed_at
    );
  END IF;
  RETURN NEW;
END;
$$;

-- During a rolling backend deploy, the previous Calendar revision still
-- completes successful actions by deleting an executing proposal. The normal
-- expiry sweep only deletes executing plans after expiry. A service disconnect
-- also deletes executing plans, but first marks its grant disconnected in the
-- same transaction; require a still-connected grant to avoid false success.
-- New revisions update to 'executed' first, so their delete does not match.
CREATE OR REPLACE FUNCTION feed_from_calendar_legacy_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'executing' AND OLD.expires_at > NOW()
     AND EXISTS (SELECT 1 FROM actor_profiles WHERE user_id = OLD.user_id)
     AND EXISTS (
       SELECT 1 FROM google_service_grants
       WHERE user_id = OLD.user_id AND provider = 'google'
         AND service = 'calendar' AND status = 'connected'
     ) THEN
    PERFORM project_calendar_mail_feed(
      OLD.user_id,
      CASE OLD.action
        WHEN 'create' THEN 'calendar_event_created'
        WHEN 'reschedule' THEN 'calendar_event_rescheduled'
        WHEN 'cancel' THEN 'calendar_event_canceled'
      END,
      OLD.proposal_id, NOW()
    );
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION feed_from_mail_connection()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.status IN ('connected', 'error', 'disconnected') THEN
    PERFORM project_calendar_mail_feed(
      NEW.user_id,
      CASE NEW.status
        WHEN 'connected' THEN 'mail_connected'
        WHEN 'error' THEN 'mail_reconnect_required'
        WHEN 'disconnected' THEN 'mail_disconnected'
      END,
      'mail-connection:' || NEW.status || ':' || NEW.updated_at::TEXT,
      NEW.updated_at
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION feed_from_mail_information_request()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'detected' THEN
    PERFORM project_calendar_mail_feed(
      NEW.user_id, 'mail_information_request_detected',
      NEW.workflow_id::TEXT, NEW.created_at
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION feed_from_mail_sync()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  feed_type TEXT;
  dedupe_key TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.status IN ('completed', 'failed') THEN
    IF NEW.status = 'completed' AND NEW.synced_count > 0 THEN
      feed_type := 'mail_receipts_imported';
    ELSIF NEW.status = 'completed' AND NEW.sync_mode = 'manual' THEN
      feed_type := 'mail_sync_completed';
    ELSIF NEW.status = 'failed' THEN
      feed_type := 'mail_sync_failed';
    END IF;

    IF feed_type IS NOT NULL THEN
      -- Every run that actually imports new receipts must create its own
      -- Feed event. Otherwise a later same-day import is silently lost after
      -- the first run is read. Repeated background failures remain daily.
      dedupe_key := CASE WHEN feed_type <> 'mail_sync_failed' THEN NEW.run_id
        WHEN NEW.sync_mode = 'manual' THEN NEW.run_id
        ELSE 'mail-sync:' || TO_CHAR(
          COALESCE(NEW.completed_at, NEW.updated_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD'
        ) END;
      PERFORM project_calendar_mail_feed(
        NEW.user_id, feed_type, dedupe_key,
        COALESCE(NEW.completed_at, NEW.updated_at)
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION feed_from_mail_send()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.state IN ('sent', 'failed', 'outcome_unknown') THEN
    PERFORM project_calendar_mail_feed(
      NEW.user_id,
      CASE NEW.state
        WHEN 'sent' THEN 'mail_message_sent'
        WHEN 'failed' THEN 'mail_message_failed'
        WHEN 'outcome_unknown' THEN 'mail_delivery_unconfirmed'
      END,
      NEW.action_id,
      COALESCE(NEW.sent_at, NEW.updated_at)
    );
  END IF;
  RETURN NEW;
END;
$$;

-- The release migrator replays files. Preserve triggers and replace function
-- bodies in place to avoid taking a DROP TRIGGER lock on active source tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'calendar_grant_feed_projection'
    AND tgrelid = 'google_service_grants'::regclass) THEN
    CREATE TRIGGER calendar_grant_feed_projection
      AFTER INSERT OR UPDATE ON google_service_grants
      FOR EACH ROW EXECUTE FUNCTION feed_from_calendar_grant();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'calendar_proposal_feed_projection'
    AND tgrelid = 'google_calendar_action_proposals'::regclass) THEN
    CREATE TRIGGER calendar_proposal_feed_projection
      AFTER UPDATE ON google_calendar_action_proposals
      FOR EACH ROW EXECUTE FUNCTION feed_from_calendar_proposal();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'calendar_legacy_delete_feed_projection'
    AND tgrelid = 'google_calendar_action_proposals'::regclass) THEN
    CREATE TRIGGER calendar_legacy_delete_feed_projection
      AFTER DELETE ON google_calendar_action_proposals
      FOR EACH ROW EXECUTE FUNCTION feed_from_calendar_legacy_delete();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mail_connection_feed_projection'
    AND tgrelid = 'kai_gmail_connections'::regclass) THEN
    CREATE TRIGGER mail_connection_feed_projection
      AFTER INSERT OR UPDATE ON kai_gmail_connections
      FOR EACH ROW EXECUTE FUNCTION feed_from_mail_connection();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mail_information_request_feed_projection'
    AND tgrelid = 'gmail_personal_information_requests'::regclass) THEN
    CREATE TRIGGER mail_information_request_feed_projection
      AFTER INSERT ON gmail_personal_information_requests
      FOR EACH ROW EXECUTE FUNCTION feed_from_mail_information_request();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mail_sync_feed_projection'
    AND tgrelid = 'kai_gmail_sync_runs'::regclass) THEN
    CREATE TRIGGER mail_sync_feed_projection
      AFTER INSERT OR UPDATE ON kai_gmail_sync_runs
      FOR EACH ROW EXECUTE FUNCTION feed_from_mail_sync();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mail_send_feed_projection'
    AND tgrelid = 'gmail_owner_send_actions'::regclass) THEN
    CREATE TRIGGER mail_send_feed_projection
      AFTER INSERT OR UPDATE ON gmail_owner_send_actions
      FOR EACH ROW EXECUTE FUNCTION feed_from_mail_send();
  END IF;
END;
$$;

-- Deliberately no historical scan while CREATE TRIGGER locks are held.
-- Future transitions (including old Calendar workers during a rolling deploy)
-- are captured immediately; previous history remains in its source tables.

COMMIT;
