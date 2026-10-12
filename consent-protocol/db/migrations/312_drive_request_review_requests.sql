-- #24: after a partial delivery the requester may ask the owner to review the
-- files that were not shared, at most three times per request. The owner hears
-- it through one new closed event, document_share_review_requested (Feed and
-- push). Nothing here holds a refund or changes payout timing.
BEGIN;

DO $$
DECLARE
  installed TEXT[];
  wanted TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_share_requests'::regclass
      AND attname='review_requested_at' AND NOT attisdropped) THEN
    ALTER TABLE drive_share_requests ADD COLUMN review_requested_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_share_requests'::regclass
      AND attname='review_request_count' AND NOT attisdropped) THEN
    ALTER TABLE drive_share_requests
      ADD COLUMN review_request_count SMALLINT NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_requests'::regclass
      AND conname='drive_share_requests_review_request_count_check') THEN
    ALTER TABLE drive_share_requests
      ADD CONSTRAINT drive_share_requests_review_request_count_check
      CHECK (review_request_count BETWEEN 0 AND 3) NOT VALID;
  END IF;

  -- Widen only. Read the installed literals the way 262 and 288 do and add the
  -- new type to that set, so replay never drops a type a later migration added.
  SELECT ARRAY(SELECT DISTINCT hit[1] FROM regexp_matches(
    pg_get_constraintdef(c.oid), '''(document_share_[^'']+)''', 'g') AS hit
    ORDER BY hit[1]) INTO installed
  FROM pg_constraint c
  WHERE c.conrelid='drive_share_events'::regclass
    AND c.conname='drive_share_events_event_type_check';
  IF NOT COALESCE(installed @> ARRAY['document_share_review_requested']::TEXT[], FALSE) THEN
    wanted := ARRAY(SELECT DISTINCT item FROM unnest(
      COALESCE(installed, ARRAY[]::TEXT[]) || ARRAY[
        'document_share_request','document_share_request_sent',
        'document_share_review_ready','document_share_decided',
        'document_share_outcome','document_share_revoked',
        'document_share_revocation_outcome','document_share_payment_ready',
        'document_share_payment_confirmed','document_share_payment_refunded',
        'document_share_review_requested']::TEXT[]) AS item ORDER BY item);
    ALTER TABLE drive_share_events DROP CONSTRAINT IF EXISTS drive_share_events_event_type_check;
    -- Existing rows already satisfy this wider check; NOT VALID skips the scan.
    EXECUTE 'ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_events_event_type_check'
      || ' CHECK (event_type IN ('
      || (SELECT string_agg(quote_literal(item), ',' ORDER BY item) FROM unnest(wanted) AS item)
      || ')) NOT VALID';
  END IF;
END $$;

-- 246's Feed projection keeps its own closed allowlist; 262 and 288 extend the
-- installed body in place. Add the owner's review request the same way.
DO $$
DECLARE source_sql TEXT;
BEGIN
  IF to_regprocedure('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)') IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_functiondef('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)'::regprocedure)
    INTO source_sql;
  IF strpos(source_sql, '''document_share_review_requested''') = 0 THEN
    IF strpos(source_sql, '''document_share_request'',') = 0 THEN
      RAISE EXCEPTION 'Drive Feed request event allowlist was not found';
    END IF;
    EXECUTE replace(source_sql, '''document_share_request'',',
      '''document_share_request'',' || E'\n    ''document_share_review_requested'',');
  END IF;
END $$;

COMMENT ON COLUMN drive_share_requests.review_requested_at IS
  'Latest requester ask to review unshared files; NULL when never asked.';
COMMENT ON COLUMN drive_share_requests.review_request_count IS
  'Requester review asks for this request, at most three.';

COMMIT;
