-- Rollback 301_pkm_answer_refunds_payouts.
--
-- Drops the paid-answer lane's durable refund and payout tables. Touches
-- nothing in the Drive lane (262/292) or the packet lane (278/280).
--
-- Destructive for an unreleased feature: any queued refund or undispatched
-- earning goes with it. Reconcile open refunds and transfers at Stripe BEFORE
-- running this, because the rows that would let the drain retry them are
-- dropped here.
--
-- Replay-safe: every statement is guarded.

BEGIN;

DROP TABLE IF EXISTS pkm_answer_owner_payouts;
DROP TABLE IF EXISTS pkm_answer_payment_refunds;

COMMIT;
