-- Expand-only financial mode binding. Historical unbound orders require
-- provider reconciliation; never infer their mode from the deploying runtime.
BEGIN;
ALTER TABLE pkm_answer_payment_orders ADD COLUMN IF NOT EXISTS stripe_mode TEXT
    CHECK (stripe_mode IN ('test','live'));
ALTER TABLE pkm_answer_payment_obligations ADD COLUMN IF NOT EXISTS stripe_mode TEXT
    CHECK (stripe_mode IN ('test','live'));
ALTER TABLE pkm_answer_owner_payouts ADD COLUMN IF NOT EXISTS first_dispatch_at TIMESTAMPTZ;
ALTER TABLE pkm_answer_owner_payouts DROP CONSTRAINT IF EXISTS pkm_answer_owner_payouts_safe_error_code_check;
ALTER TABLE pkm_answer_owner_payouts ADD CONSTRAINT pkm_answer_owner_payouts_safe_error_code_check
  CHECK (safe_error_code IS NULL OR safe_error_code IN ('provider_unavailable','provider_rejected',
    'account_not_ready','provider_mismatch','idempotency_window_elapsed'));
CREATE OR REPLACE FUNCTION mirror_pkm_answer_payment_obligation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pkm_answer_payment_obligations (
    request_id, payer_ref, amount_cents, currency, status, checkout_attempt_id,
    stripe_checkout_session_id, stripe_payment_intent_id, paid_at,
    reconciliation_required, stripe_mode, updated_at)
  VALUES (NEW.request_id,
    encode(digest(NEW.request_id::text || ':' || NEW.requester_user_id, 'sha256'), 'hex'),
    NEW.amount_cents, NEW.currency, NEW.status, NEW.checkout_attempt_id,
    NEW.stripe_checkout_session_id, NEW.stripe_payment_intent_id, NEW.paid_at,
    NEW.reconciliation_required, NEW.stripe_mode, clock_timestamp())
  ON CONFLICT (request_id) DO UPDATE SET
    amount_cents=EXCLUDED.amount_cents, status=EXCLUDED.status,
    checkout_attempt_id=EXCLUDED.checkout_attempt_id,
    stripe_checkout_session_id=EXCLUDED.stripe_checkout_session_id,
    stripe_payment_intent_id=EXCLUDED.stripe_payment_intent_id,
    paid_at=EXCLUDED.paid_at, reconciliation_required=EXCLUDED.reconciliation_required,
    stripe_mode=EXCLUDED.stripe_mode, updated_at=clock_timestamp();
  RETURN NEW;
END $$;
-- Committed metadata doorbell reuses the existing multi-instance SSE channel.
-- No question, scopes, answer, amount or provider identifier enters NOTIFY.
CREATE OR REPLACE FUNCTION notify_pkm_answer_changed()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r record; participant text;
BEGIN
  IF TG_TABLE_NAME='pkm_answer_requests' THEN
    r:=NEW;
    IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    UPDATE feed_events SET metadata=metadata || jsonb_build_object('status',NEW.status)
      WHERE source_domain='consent' AND source_row_id='answer_request:'||NEW.request_id::text;
  ELSE
    IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    SELECT * INTO r FROM pkm_answer_requests WHERE request_id=NEW.request_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
  END IF;
  FOREACH participant IN ARRAY ARRAY[r.owner_user_id,r.requester_user_id] LOOP
    PERFORM pg_notify('one_user_state_changed',json_build_object(
      'type','answer_request_changed','user_id',participant,'request_id',r.request_id::text,
      'event_id',TG_TABLE_NAME||':'||NEW.request_id::text||':'||NEW.status||':'||NEW.updated_at::text)::text);
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pkm_answer_request_changed ON pkm_answer_requests;
CREATE TRIGGER pkm_answer_request_changed AFTER INSERT OR UPDATE ON pkm_answer_requests
  FOR EACH ROW EXECUTE FUNCTION notify_pkm_answer_changed();
DROP TRIGGER IF EXISTS pkm_answer_payment_changed ON pkm_answer_payment_orders;
CREATE TRIGGER pkm_answer_payment_changed AFTER INSERT OR UPDATE ON pkm_answer_payment_orders
  FOR EACH ROW EXECUTE FUNCTION notify_pkm_answer_changed();
-- Consent is bound to the exact approved terms; historical approvals stay unset.
ALTER TABLE pkm_answer_requests ADD COLUMN IF NOT EXISTS composer_consent_at timestamptz;
ALTER TABLE pkm_answer_requests ADD COLUMN IF NOT EXISTS composer_consent_version text;
ALTER TABLE pkm_answer_requests ADD COLUMN IF NOT EXISTS composer_consent_digest text;
COMMIT;
