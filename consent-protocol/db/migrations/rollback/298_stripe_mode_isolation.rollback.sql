-- Non-destructive rollback: retain financial mode bindings and account history.
-- Roll back application traffic/Stripe mode together; never drop these columns
-- or copy live Connect accounts into the old sandbox mapping automatically.
BEGIN;
COMMENT ON TABLE stripe_owner_payout_accounts IS
  'Mode-isolated Stripe Connect mappings retained for safe financial reconciliation.';
COMMIT;
