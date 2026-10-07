BEGIN;
-- Removing the generation must retire outstanding immediate authority before
-- a later forward migration can reuse its default generation. History stays.
UPDATE gmail_owner_send_actions
SET state = 'cancelled', updated_at = NOW()
WHERE state = 'prepared' AND send_at IS NULL;
DROP TRIGGER IF EXISTS gmail_send_grant_generation ON kai_gmail_connections;
DROP FUNCTION IF EXISTS bump_gmail_send_grant_generation();
ALTER TABLE kai_gmail_connections DROP COLUMN IF EXISTS send_grant_generation;
COMMIT;
