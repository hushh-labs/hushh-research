BEGIN;

-- Direct One Location asks are questions, not standing consent. Keeping one
-- actionable forever lets an owner approve a request whose context may be days
-- old, while also preventing the requester from sending a fresh notification.
-- The deadline is durable and server-owned; clients only present it.
--
-- Referral and matched public-link requests intentionally keep NULL here.
-- Their parent workflow owns a different lifetime and retry contract, and a
-- public visitor cannot simply resubmit the same phone/invite pair.
ALTER TABLE one_location_access_requests
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE one_location_access_requests
  DROP CONSTRAINT IF EXISTS one_location_access_requests_status_check;

ALTER TABLE one_location_access_requests
  ADD CONSTRAINT one_location_access_requests_status_check CHECK (
    status IN ('pending', 'approved', 'denied', 'cancelled', 'expired')
  ) NOT VALID;

-- Existing direct asks receive the same one-day window from their original
-- send time. Linked workflows remain NULL rather than being silently severed
-- from their independently-pending wrapper rows.
UPDATE one_location_access_requests AS request
SET expires_at = request.requested_at + INTERVAL '24 hours'
WHERE request.expires_at IS NULL
  AND request.referred_by_user_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM one_location_referrals AS referral
    WHERE referral.request_id = request.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM one_location_public_invite_submissions AS submission
    WHERE submission.request_id = request.id
  );

-- Make rollout truth immediate. The maintenance job will settle future rows,
-- while read/action paths also enforce the timestamp in case that job lags.
UPDATE one_location_access_requests
SET status = 'expired',
    resolved_at = COALESCE(resolved_at, expires_at)
WHERE status = 'pending'
  AND expires_at IS NOT NULL
  AND expires_at <= NOW();

ALTER TABLE one_location_access_requests
  DROP CONSTRAINT IF EXISTS chk_one_location_access_request_expiry_after_send;

ALTER TABLE one_location_access_requests
  ADD CONSTRAINT chk_one_location_access_request_expiry_after_send CHECK (
    expires_at IS NULL OR expires_at > requested_at
  ) NOT VALID;

ALTER TABLE one_location_access_requests
  VALIDATE CONSTRAINT one_location_access_requests_status_check;

ALTER TABLE one_location_access_requests
  VALIDATE CONSTRAINT chk_one_location_access_request_expiry_after_send;

CREATE INDEX IF NOT EXISTS idx_one_location_access_requests_pending_expiry
  ON one_location_access_requests (expires_at, owner_user_id, requester_user_id)
  WHERE status = 'pending' AND expires_at IS NOT NULL;

COMMENT ON COLUMN one_location_access_requests.expires_at IS
  'Server-owned deadline for a direct/extension location ask. NULL only when a linked referral or public-link workflow owns the lifetime.';

COMMIT;
