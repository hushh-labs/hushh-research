-- Curated advisor sharing keeps connection controls and permits explicit Always access.
BEGIN;
-- Migration 435's multi-column expiry check receives this PostgreSQL name.
-- Keep the independent policy mode and fingerprint checks intact.
ALTER TABLE finance_share_requests DROP CONSTRAINT IF EXISTS finance_share_requests_check;
ALTER TABLE finance_share_requests DROP CONSTRAINT IF EXISTS finance_share_requests_check1;
ALTER TABLE finance_share_requests DROP CONSTRAINT IF EXISTS finance_share_requests_expiry_policy_check;
ALTER TABLE finance_share_requests ADD CONSTRAINT finance_share_requests_expiry_policy_check CHECK (COALESCE(
  expires_at IS NOT NULL OR policy->>'mode' = 'ongoing'
  OR (policy->>'version' = '3' AND policy->>'purpose' = 'verified_ria_share')
  OR (policy->>'version' = '2' AND policy->>'purpose' = 'verified_ria_review'),
  FALSE
));
COMMIT;
