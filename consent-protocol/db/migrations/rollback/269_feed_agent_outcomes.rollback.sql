BEGIN;
DO $$
DECLARE
  source_sql TEXT;
  old_fragment TEXT := '(''connection_accepted'', ''connection_rejected'')';
  new_fragment TEXT := '(''connection_accepted'', ''connection_rejected'', ''connection_withdrawn'')';
BEGIN
  SELECT pg_get_functiondef('public.resolve_feed_counterpart_user_id(text,text,text,text)'::regprocedure)
    INTO source_sql;
  IF (LENGTH(source_sql)-LENGTH(REPLACE(source_sql,old_fragment,'')))/LENGTH(old_fragment)=2 THEN
    RETURN;
  END IF;
  IF (LENGTH(source_sql)-LENGTH(REPLACE(source_sql,new_fragment,'')))/LENGTH(new_fragment)<>2 THEN
    RAISE EXCEPTION 'feed_withdrawn_counterpart_rollback_mismatch';
  END IF;
  EXECUTE REPLACE(source_sql,new_fragment,old_fragment);
END;
$$;
DO $$
DECLARE v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'google_calendar_action_proposals','gmail_mailbox_action_proposals',
    'connected_system_audit_events','user_external_connector_connections',
    'drive_owner_search_jobs','one_action_directive_ledger','drive_bulk_share_notifications',
    'drive_live_query_requests','consent_audit','one_location_circle_member_invites',
    'one_location_circle_memberships','one_location_circles','drive_bulk_shares','drive_bulk_share_effects'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',v_table || '_outcome_feed',v_table);
  END LOOP;
END;
$$;
DROP FUNCTION IF EXISTS feed_from_bulk_share_outcome();
DROP FUNCTION IF EXISTS feed_from_agent_outcome();
DROP FUNCTION IF EXISTS project_agent_outcome_feed(TEXT,TEXT,TEXT,TEXT,JSONB,TEXT);
-- Keep already-delivered history and all source state; existing projections
-- (including payments and bundled consent) are unaffected.
COMMIT;
