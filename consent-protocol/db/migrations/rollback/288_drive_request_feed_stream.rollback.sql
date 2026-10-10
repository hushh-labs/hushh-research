BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_share_events WHERE event_type='document_share_request_sent') THEN
    RAISE EXCEPTION 'Cannot remove request-sent event support while retained events exist';
  END IF;
END $$;
DROP TRIGGER IF EXISTS drive_share_event_feed_wake ON drive_share_events;
DROP FUNCTION IF EXISTS public.notify_document_request_feed_changed();
DROP TRIGGER IF EXISTS drive_share_request_access_stop_feed_wake ON drive_share_requests;
DROP FUNCTION IF EXISTS public.notify_document_request_access_stop();
DO $$
DECLARE source_sql TEXT;
BEGIN
  IF to_regprocedure('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)') IS NOT NULL THEN
    SELECT pg_get_functiondef('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)'::regprocedure)
      INTO source_sql;
    EXECUTE replace(source_sql, E'    ''document_share_request_sent'',\n', '');
  END IF;
END $$;
ALTER TABLE drive_share_events DROP CONSTRAINT IF EXISTS drive_share_events_event_type_check;
ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_events_event_type_check
  CHECK (event_type IN (
    'document_share_request','document_share_review_ready','document_share_decided',
    'document_share_outcome','document_share_revoked','document_share_revocation_outcome',
    'document_share_payment_ready','document_share_payment_confirmed',
    'document_share_payment_refunded'
  ));
COMMIT;
