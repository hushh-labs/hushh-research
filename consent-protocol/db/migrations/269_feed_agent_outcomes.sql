BEGIN;

-- Extend the current indexed identity resolver in place. Keep source/audience
-- checks, current-photo reads and retained mappings owned by migrations202-204.
DO $$
DECLARE
  source_sql TEXT;
  old_fragment TEXT := '(''connection_accepted'', ''connection_rejected'')';
  new_fragment TEXT := '(''connection_accepted'', ''connection_rejected'', ''connection_withdrawn'')';
BEGIN
  SELECT pg_get_functiondef('public.resolve_feed_counterpart_user_id(text,text,text,text)'::regprocedure)
    INTO source_sql;
  IF (LENGTH(source_sql)-LENGTH(REPLACE(source_sql,new_fragment,'')))/LENGTH(new_fragment)=2 THEN
    RETURN;
  END IF;
  IF (LENGTH(source_sql)-LENGTH(REPLACE(source_sql,old_fragment,'')))/LENGTH(old_fragment)<>2 THEN
    RAISE EXCEPTION 'feed_withdrawn_counterpart_resolver_mismatch';
  END IF;
  EXECUTE REPLACE(source_sql,old_fragment,new_fragment);
END;
$$;

-- Presentation only: closed outcomes, stable replay keys, no provider content.
-- Keep the existing 252/260/262 publishers intact, including bundle and payment
-- aggregation. No historical scan, new authority, or provider action is added.
CREATE OR REPLACE FUNCTION project_agent_outcome_feed(
  p_user TEXT, p_domain TEXT, p_type TEXT, p_key TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb, p_label TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_user IS NULL OR p_key IS NULL OR p_type IS NULL OR p_domain IS NULL OR NOT (
    (p_domain = 'connected_systems' AND p_type IN (
      'calendar_action_failed', 'mail_mailbox_archive', 'mail_mailbox_trash',
      'mail_mailbox_add_label', 'mail_mailbox_remove_label', 'mail_mailbox_mark_read',
      'mail_mailbox_mark_unread', 'mail_mailbox_failed',
      'connected_systems_mutation_succeeded', 'connected_systems_mutation_partial',
      'connected_systems_disconnected', 'connector_connected',
      'connector_reconnect_required', 'connector_disconnected',
      'drive_search_completed', 'drive_search_limited', 'drive_search_failed', 'drive_search_stopped',
      'drive_share_succeeded', 'drive_share_failed', 'drive_share_unconfirmed',
      'drive_trash_succeeded', 'drive_trash_failed', 'drive_trash_unconfirmed',
      'drive_bulk_received', 'drive_bulk_completed', 'drive_bulk_partial',
      'drive_bulk_failed', 'drive_bulk_stopped', 'drive_question_withdrawn', 'drive_question_retry_required'))
    OR (p_domain = 'consent' AND p_type IN ('consent_denied', 'consent_cancelled', 'consent_timed_out'))
    OR (p_domain = 'location' AND p_type IN ('circle_invite_declined', 'circle_invite_cancelled',
      'circle_member_left', 'circle_membership_ended', 'circle_deleted'))
  ) THEN RETURN; END IF;
  BEGIN
    INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id,metadata,actor_label)
    VALUES(p_user,p_domain,p_type,p_key,p_metadata,LEFT(p_label,160))
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'agent_outcome_feed_projection_failed sqlstate=%', SQLSTATE;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION feed_from_agent_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_type TEXT;
  v_key TEXT;
  v_label TEXT;
  v_circle one_location_circles%ROWTYPE;
  v_user TEXT;
  v_peer TEXT;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'google_calendar_action_proposals' THEN
      IF NEW.status = 'failed' AND OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM project_agent_outcome_feed(NEW.user_id,'connected_systems',
          'calendar_action_failed',NEW.proposal_id);
      END IF;
    WHEN 'gmail_mailbox_action_proposals' THEN
      IF NEW.status IN ('executed','failed') AND OLD.status IS DISTINCT FROM NEW.status THEN
        v_type := CASE WHEN NEW.status='failed' THEN 'mail_mailbox_failed'
          ELSE 'mail_mailbox_' || NEW.action END;
        PERFORM project_agent_outcome_feed(NEW.user_id,'connected_systems',v_type,NEW.proposal_id);
      END IF;
    WHEN 'connected_system_audit_events' THEN
      IF NEW.status IN ('succeeded','partial') AND NEW.action IN ('create','update','delete') THEN
        v_type := 'connected_systems_mutation_' || NEW.status;
      ELSIF NEW.status='succeeded' AND NEW.action='disconnect' THEN
        v_type := 'connected_systems_disconnected';
      END IF;
      IF v_type IS NOT NULL THEN
        PERFORM project_agent_outcome_feed(NEW.user_id,'connected_systems',v_type,
          COALESCE(NULLIF(NEW.intent_id,''),NEW.event_id));
      END IF;
    WHEN 'user_external_connector_connections' THEN
      IF TG_OP='INSERT' THEN
        IF NEW.status <> 'connected' THEN RETURN NEW; END IF;
      ELSIF NEW.status IS NOT DISTINCT FROM OLD.status
        AND (NEW.status <> 'connected' OR NEW.connection_generation=OLD.connection_generation) THEN
        RETURN NEW;
      END IF;
      SELECT LEFT(display_name,160) INTO v_label FROM external_mcp_connectors
        WHERE connector_id=NEW.connector_id AND (user_id IS NULL OR user_id=NEW.user_id);
      v_type := CASE NEW.status WHEN 'connected' THEN 'connector_connected'
        WHEN 'needs_reauth' THEN 'connector_reconnect_required'
        WHEN 'revoked' THEN 'connector_disconnected' END;
      IF v_type IS NOT NULL THEN
        PERFORM project_agent_outcome_feed(NEW.user_id,'connected_systems',v_type,
          NEW.connector_id || ':' || NEW.connection_generation::TEXT || ':' || NEW.status,
          '{}'::jsonb,v_label);
      END IF;
    WHEN 'drive_owner_search_jobs' THEN
      IF NEW.status IN ('completed','limited','failed','stopped')
        AND OLD.status IS DISTINCT FROM NEW.status
        AND (NEW.status <> 'completed' OR NOT EXISTS (SELECT 1 FROM drive_share_requests
          WHERE request_id=NEW.client_request_id AND user_id=NEW.user_id)) THEN
        PERFORM project_agent_outcome_feed(NEW.user_id,'connected_systems',
          'drive_search_' || NEW.status,NEW.job_id::TEXT);
      END IF;
    WHEN 'one_action_directive_ledger' THEN
      IF NEW.state='settled' AND OLD.state IS DISTINCT FROM NEW.state
        AND NEW.context_revision='drive-review:v1'
        AND NEW.action_id IN ('connector.drive.share_file','connector.drive.trash_file') THEN
        v_type := CASE NEW.action_id WHEN 'connector.drive.share_file' THEN 'drive_share_'
          ELSE 'drive_trash_' END || CASE
          WHEN NEW.settlement_reason_code='outcome_unknown' THEN 'unconfirmed'
          WHEN NEW.settlement_status='succeeded' THEN 'succeeded'
          WHEN NEW.settlement_status='failed' THEN 'failed' END;
        PERFORM project_agent_outcome_feed(NEW.user_id,'connected_systems',v_type,NEW.directive_id);
      END IF;
    WHEN 'drive_bulk_share_notifications' THEN
      IF EXISTS (SELECT 1 FROM drive_bulk_shares WHERE share_id=NEW.share_id AND origin_request_id IS NULL) THEN
        PERFORM project_agent_outcome_feed(NEW.recipient_user_id,'connected_systems',
          'drive_bulk_received',NEW.share_id::TEXT);
      END IF;
    WHEN 'drive_live_query_requests' THEN
      IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
        v_type := 'drive_question_withdrawn';
      ELSIF NEW.status='pending' AND OLD.status='running' AND NEW.last_error_code IS NOT NULL THEN
        v_type := 'drive_question_retry_required';
      END IF;
      IF v_type IS NOT NULL THEN
        PERFORM project_agent_outcome_feed(NEW.user_id,'connected_systems',v_type,
          NEW.request_id::TEXT || ':' || NEW.revision::TEXT,
          jsonb_build_object('request_id',NEW.request_id));
      END IF;
    WHEN 'consent_audit' THEN
      v_type := CASE NEW.action WHEN 'CONSENT_DENIED' THEN 'consent_denied'
        WHEN 'CANCELLED' THEN 'consent_cancelled' WHEN 'TIMEOUT' THEN 'consent_timed_out' END;
      IF v_type IS NOT NULL THEN
        v_key := COALESCE(NULLIF(NEW.metadata->>'bundle_id',''),NEW.request_id::TEXT,NEW.id::TEXT);
        PERFORM project_agent_outcome_feed(NEW.user_id,'consent',v_type,v_key);
      END IF;
    WHEN 'one_location_circle_member_invites' THEN
      SELECT * INTO v_circle FROM one_location_circles WHERE id=NEW.circle_id AND status='active';
      IF NOT FOUND OR OLD.status <> 'pending' THEN RETURN NEW; END IF;
      IF NEW.status='declined' THEN
        v_type := 'circle_invite_declined'; v_user := NEW.inviter_user_id; v_peer := NEW.invitee_user_id;
      ELSIF NEW.status='cancelled' THEN
        v_type := 'circle_invite_cancelled'; v_user := NEW.invitee_user_id;
      END IF;
      IF v_type IS NOT NULL THEN
        v_key := NEW.id::TEXT;
      END IF;
    WHEN 'one_location_circle_memberships' THEN
      SELECT * INTO v_circle FROM one_location_circles WHERE id=NEW.circle_id AND status='active';
      IF NOT FOUND OR NEW.role='owner' OR OLD.status <> 'active' THEN RETURN NEW; END IF;
      IF NEW.status='left' THEN
        v_type := 'circle_member_left'; v_user := v_circle.owner_user_id; v_peer := NEW.user_id;
      ELSIF NEW.status='removed' THEN
        v_type := 'circle_membership_ended'; v_user := NEW.user_id;
      END IF;
      IF v_type IS NOT NULL THEN
        v_key := NEW.circle_id::TEXT || ':' || NEW.user_id || ':' || NEW.joined_at::TEXT;
      END IF;
    WHEN 'one_location_circles' THEN
      IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM NEW.status THEN
        FOR v_user IN SELECT user_id FROM one_location_circle_memberships
          WHERE circle_id=NEW.id AND status='active' UNION SELECT NEW.owner_user_id LOOP
          PERFORM project_agent_outcome_feed(v_user,'location','circle_deleted',NEW.id::TEXT,
            jsonb_build_object('circle_name',LEFT(NEW.name,80)));
        END LOOP;
      END IF;
  END CASE;
  IF TG_TABLE_NAME IN ('one_location_circle_member_invites','one_location_circle_memberships')
    AND v_type IS NOT NULL THEN
    -- Name-only public identity, scoped to the peer on the source transition.
    -- Identity cache seeds can be raw UIDs; never present them as person names.
    SELECT CASE WHEN NULLIF(BTRIM(display_name),'') IS NOT NULL
      AND BTRIM(display_name) <> v_peer AND STRPOS(display_name,'@')=0
      AND BTRIM(display_name) !~* '^ria:'
      AND BTRIM(display_name) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND NOT (BTRIM(display_name) !~ '[[:space:]]' AND LENGTH(BTRIM(display_name)) >= 20)
      THEN LEFT(BTRIM(display_name),160) END INTO v_label
      FROM actor_identity_cache WHERE user_id=v_peer;
    PERFORM project_agent_outcome_feed(v_user,'location',v_type,v_key,
      jsonb_strip_nulls(jsonb_build_object('circle_id',v_circle.id,
        'circle_name',LEFT(v_circle.name,80),'counterpart_label',v_label)));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'agent_outcome_source_projection_failed sqlstate=%', SQLSTATE;
  RETURN NEW;
END;
$$;

-- Stop is intent until all in-flight effects settle. Source-effect transitions
-- also wake this projection, since a stopped job does not change status again.
CREATE OR REPLACE FUNCTION feed_from_bulk_share_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_share drive_bulk_shares%ROWTYPE;
BEGIN
  SELECT * INTO v_share FROM drive_bulk_shares WHERE share_id=NEW.share_id;
  IF v_share.origin_request_id IS NOT NULL OR v_share.status NOT IN ('completed','partial','failed','stopped')
    OR EXISTS (SELECT 1 FROM drive_bulk_share_effects WHERE share_id=NEW.share_id
      AND state IN ('queued','dispatching','unknown')) THEN RETURN NEW; END IF;
  PERFORM project_agent_outcome_feed(v_share.user_id,'connected_systems','drive_bulk_' || v_share.status,
    v_share.share_id::TEXT || ':' || CASE WHEN v_share.status='stopped'
      THEN COALESCE(v_share.stopped_at::TEXT,'stopped') ELSE v_share.revision::TEXT END);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'bulk_outcome_source_projection_failed sqlstate=%', SQLSTATE;
  RETURN NEW;
END;
$$;

DO $$
DECLARE v_table TEXT; v_operation TEXT; v_trigger TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'google_calendar_action_proposals','gmail_mailbox_action_proposals',
    'connected_system_audit_events','user_external_connector_connections',
    'drive_owner_search_jobs','one_action_directive_ledger','drive_bulk_share_notifications',
    'drive_live_query_requests','consent_audit','one_location_circle_member_invites',
    'one_location_circle_memberships','one_location_circles'
  ] LOOP
    v_operation := CASE WHEN v_table IN ('connected_system_audit_events','drive_bulk_share_notifications','consent_audit')
      THEN 'INSERT' WHEN v_table='user_external_connector_connections' THEN 'INSERT OR UPDATE' ELSE 'UPDATE' END;
    v_trigger := v_table || '_outcome_feed';
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=v_trigger AND tgrelid=to_regclass(v_table)) THEN
      EXECUTE format('CREATE TRIGGER %I AFTER %s ON %I FOR EACH ROW EXECUTE FUNCTION feed_from_agent_outcome()',
        v_trigger,v_operation,v_table);
    END IF;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['drive_bulk_shares','drive_bulk_share_effects'] LOOP
    v_trigger := v_table || '_outcome_feed';
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=v_trigger AND tgrelid=to_regclass(v_table)) THEN
      EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION feed_from_bulk_share_outcome()',
        v_trigger,v_table);
    END IF;
  END LOOP;
END;
$$;
COMMIT;
