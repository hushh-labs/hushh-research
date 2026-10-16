BEGIN;
-- Restore the preceding lane-provenance functions before dropping their input.
CREATE OR REPLACE FUNCTION mirror_drive_request_payment_obligation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v1_approved BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM drive_bulk_shares b
    JOIN drive_owner_search_jobs j
      ON j.job_id=b.search_job_id AND j.user_id=b.user_id
    JOIN drive_share_requests r
      ON r.request_id=b.origin_request_id AND r.user_id=b.user_id
    JOIN drive_bulk_share_recipients recipient
      ON recipient.share_id=b.share_id AND recipient.user_id=b.user_id
    WHERE b.origin_request_id=NEW.request_id AND b.user_id=NEW.user_id
      AND r.recipient_user_id=NEW.requester_user_id
      AND b.origin_request_revision=r.revision
      AND recipient.recipient_user_id=r.recipient_user_id
      AND j.v1_statement_search=TRUE AND b.progressive_batch=TRUE
      AND b.approval_source='owner' AND b.approved_at IS NOT NULL
      AND b.file_count>0 AND b.recipient_count=1
      AND b.status IN ('queued','running','completed','partial')
      AND r.status IN ('pending','approved','partial')
  ) INTO v1_approved;
  INSERT INTO drive_request_payment_obligations
    (request_id,payer_ref,amount_cents,currency,status,checkout_attempt_id,
     stripe_checkout_session_id,stripe_payment_intent_id,paid_at,
     reconciliation_required,v1_statement_search)
  VALUES (NEW.request_id,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      NEW.request_id::text || ':' || NEW.requester_user_id,'UTF8')),'hex'),
    NEW.amount_cents,NEW.currency,NEW.status,NEW.checkout_attempt_id,
    NEW.stripe_checkout_session_id,NEW.stripe_payment_intent_id,NEW.paid_at,
    NEW.reconciliation_required,v1_approved)
  ON CONFLICT (request_id) DO UPDATE SET
    status=EXCLUDED.status,checkout_attempt_id=EXCLUDED.checkout_attempt_id,
    stripe_checkout_session_id=EXCLUDED.stripe_checkout_session_id,
    stripe_payment_intent_id=EXCLUDED.stripe_payment_intent_id,
    paid_at=EXCLUDED.paid_at,
    reconciliation_required=drive_request_payment_obligations.reconciliation_required
      OR EXCLUDED.reconciliation_required,
    v1_statement_search=drive_request_payment_obligations.v1_statement_search
      OR EXCLUDED.v1_statement_search,
    updated_at=clock_timestamp();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mark_drive_bulk_share_v1_removal_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.v1_statement_search THEN
    NEW.v1_statement_search := TRUE;
  ELSIF NEW.origin_request_id IS NULL OR NEW.progressive_batch IS NOT TRUE
      OR NEW.approval_source IS DISTINCT FROM 'owner'
      OR NEW.approved_at IS NULL OR NEW.file_count < 1
      OR NEW.recipient_count <> 1 THEN
    NEW.v1_statement_search := FALSE;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM drive_owner_search_jobs j
      JOIN drive_share_requests request
        ON request.request_id=NEW.origin_request_id AND request.user_id=NEW.user_id
      JOIN drive_bulk_share_recipients recipient
        ON recipient.share_id=NEW.share_id AND recipient.user_id=NEW.user_id
      WHERE j.job_id=NEW.search_job_id AND j.user_id=NEW.user_id
        AND j.v1_statement_search=TRUE
        AND request.revision=NEW.origin_request_revision
        AND request.recipient_user_id=recipient.recipient_user_id
    ) INTO NEW.v1_statement_search;
  END IF;
  RETURN NEW;
END $$;
DROP INDEX IF EXISTS drive_share_requests_v1_preparation_due;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS v1_live_request;
COMMIT;
