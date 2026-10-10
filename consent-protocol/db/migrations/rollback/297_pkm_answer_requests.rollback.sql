-- Rollback 297_pkm_answer_requests.
--
-- Drops the paid-answer lane entirely. Touches nothing in the Drive document
-- lane (migration 262) or the packet lane (278/280), which are separate tables.
--
-- Destructive by design for an unreleased feature: any in-flight answer order
-- goes with it. Reconcile and refund open orders at Stripe BEFORE running
-- this, because the obligation mirror that would let a late event settle is
-- dropped here too.
--
-- Replay-safe: every statement is guarded.

BEGIN;

DROP TRIGGER IF EXISTS mirror_pkm_answer_payment_obligation_trg ON pkm_answer_payment_orders;
DROP FUNCTION IF EXISTS mirror_pkm_answer_payment_obligation();

-- Child-first: webhook events reference obligations; scopes, orders and
-- deliveries reference requests.
DROP TABLE IF EXISTS pkm_answer_payment_webhook_events;
DROP TABLE IF EXISTS pkm_answer_payment_obligations;
DROP TABLE IF EXISTS pkm_answer_deliveries;
DROP TABLE IF EXISTS pkm_answer_payment_orders;
DROP TABLE IF EXISTS pkm_answer_request_scopes;
DROP TABLE IF EXISTS pkm_answer_requests;

COMMIT;
