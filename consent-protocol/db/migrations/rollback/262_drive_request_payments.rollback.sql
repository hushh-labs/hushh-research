BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_share_requests WHERE payment_required) THEN
    RAISE EXCEPTION 'Cannot remove payment gate while payment-required requests exist';
  END IF;
  IF EXISTS (SELECT 1 FROM drive_request_payment_obligations) THEN
    RAISE EXCEPTION 'Cannot remove retained payment obligations';
  END IF;
END $$;
DO $$
DECLARE source_sql TEXT;
BEGIN
  IF to_regprocedure('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)') IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_functiondef('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)'::regprocedure)
    INTO source_sql;
  source_sql := replace(source_sql, E'    ''document_share_payment_ready'',\n', '');
  source_sql := replace(source_sql, E'    ''document_share_payment_confirmed'',\n', '');
  source_sql := replace(source_sql, E'    ''document_share_payment_refunded'',\n', '');
  EXECUTE source_sql;
END $$;
DROP TABLE IF EXISTS drive_request_payment_webhook_events;
DROP TABLE IF EXISTS drive_request_payment_refunds;
DROP TABLE IF EXISTS drive_request_payment_orders;
DROP TRIGGER IF EXISTS drive_request_payment_erasure ON drive_share_requests;
DROP FUNCTION IF EXISTS erase_drive_request_payment_identity();
DROP FUNCTION IF EXISTS mirror_drive_request_payment_obligation();
DROP TABLE IF EXISTS drive_request_payment_obligations;
ALTER TABLE drive_share_events DROP CONSTRAINT IF EXISTS drive_share_events_event_type_check;
ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_events_event_type_check CHECK (event_type IN (
  'document_share_request','document_share_review_ready','document_share_decided',
  'document_share_outcome','document_share_revoked','document_share_revocation_outcome'
));
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS payment_required;
COMMIT;
