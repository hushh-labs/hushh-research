-- Disable issuance/workers first. Retain enrollment rows to preserve identity.
BEGIN;
UPDATE email_auth_challenges
SET cancelled_at = COALESCE(cancelled_at, clock_timestamp()),
    delivery_state = 'cancelled', payload = NULL,
    destination_ciphertext = NULL, enrollment_ticket_hash = NULL;
-- Additive tables intentionally remain for safe forward recovery.
COMMIT;
