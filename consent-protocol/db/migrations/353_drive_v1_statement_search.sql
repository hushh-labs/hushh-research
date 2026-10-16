-- Route only server-planned statement searches to the isolated V1 drain.
BEGIN;
ALTER TABLE drive_owner_search_jobs
  ADD COLUMN IF NOT EXISTS v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS drive_owner_search_v1_due
  ON drive_owner_search_jobs(next_at,inspected_at)
  WHERE v1_statement_search AND status IN ('queued','running');
COMMENT ON COLUMN drive_owner_search_jobs.v1_statement_search IS
  'Server-derived brokerage or Schwab statement search eligible for the V1-only drain; never buyer-supplied.';

-- Search jobs expire with the request, but an opaque payment obligation and
-- owner payout survive account erasure for late refunds and reconciliation.
-- These flags contain no user identity or document data.
ALTER TABLE drive_request_payment_obligations
  ADD COLUMN IF NOT EXISTS v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE drive_request_owner_payouts
  ADD COLUMN IF NOT EXISTS v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS drive_request_payment_obligations_v1_due
  ON drive_request_payment_obligations(updated_at,request_id)
  WHERE v1_statement_search;
CREATE INDEX IF NOT EXISTS drive_request_owner_payouts_v1_due
  ON drive_request_owner_payouts(next_check_at,request_id)
  WHERE v1_statement_search;

-- Approval and order enrollment can happen in one transaction. Derive the
-- durable marker from that exact approved owner batch, never from request
-- text, an API argument, or a buyer-controlled field. Keep it sticky across
-- subsequent order updates and request erasure.
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

-- Existing in-flight approved V1 orders may predate this migration. Their
-- current live authority is checked again before recording provenance.
UPDATE drive_request_payment_obligations o SET v1_statement_search=TRUE
FROM drive_request_payment_orders ord
WHERE o.request_id=ord.request_id AND o.v1_statement_search=FALSE
  AND EXISTS (
    SELECT 1 FROM drive_bulk_shares b
    JOIN drive_owner_search_jobs j
      ON j.job_id=b.search_job_id AND j.user_id=b.user_id
    JOIN drive_share_requests r
      ON r.request_id=b.origin_request_id AND r.user_id=b.user_id
    JOIN drive_bulk_share_recipients recipient
      ON recipient.share_id=b.share_id AND recipient.user_id=b.user_id
    WHERE b.origin_request_id=ord.request_id AND b.user_id=ord.user_id
      AND r.recipient_user_id=ord.requester_user_id
      AND b.origin_request_revision=r.revision
      AND recipient.recipient_user_id=r.recipient_user_id
      AND j.v1_statement_search=TRUE AND b.progressive_batch=TRUE
      AND b.approval_source='owner' AND b.approved_at IS NOT NULL
      AND b.file_count>0 AND b.recipient_count=1
      AND b.status IN ('queued','running','completed','partial')
      AND r.status IN ('pending','approved','partial')
  );
UPDATE drive_request_owner_payouts p SET v1_statement_search=TRUE
FROM drive_request_payment_obligations o
WHERE p.request_id=o.request_id AND o.v1_statement_search=TRUE
  AND p.v1_statement_search=FALSE;
COMMIT;
