-- Fail closed rather than rewrite or delete an owner's standing approval.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM finance_share_requests WHERE expires_at IS NULL AND policy->>'mode' <> 'ongoing') THEN
    RAISE EXCEPTION 'Reconcile advisor snapshot Always approvals before rolling back migration 446';
  END IF;
END $$;
ALTER TABLE finance_share_requests DROP CONSTRAINT IF EXISTS finance_share_requests_expiry_policy_check;
ALTER TABLE finance_share_requests DROP CONSTRAINT IF EXISTS finance_share_requests_check1;
ALTER TABLE finance_share_requests ADD CONSTRAINT finance_share_requests_check1
  CHECK (expires_at IS NOT NULL OR policy->>'mode' = 'ongoing');
COMMIT;
