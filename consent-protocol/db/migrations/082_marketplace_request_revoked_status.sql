BEGIN;

-- Allow the 'revoked' status on marketplace access requests.
--
-- Owner-scoped revoke (withdraw a previously approved grant) flips the request
-- status to 'revoked' and purges any delivered ciphertext. The original table
-- (migration 076) constrained status to ('pending','approved','denied',
-- 'expired'), so the revoke UPDATE was rejected by the CHECK constraint at the
-- database layer even though the service and API already understood 'revoked'.
-- This widens the constraint to include it.

ALTER TABLE marketplace_access_requests
  DROP CONSTRAINT IF EXISTS marketplace_access_requests_status_check;

ALTER TABLE marketplace_access_requests
  ADD CONSTRAINT marketplace_access_requests_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'revoked'));

COMMIT;
