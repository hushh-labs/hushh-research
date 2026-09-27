BEGIN;

-- consent_audit.request_id was VARCHAR(32) (legacy init schema), but
-- advisor_investor_relationships.last_request_id is TEXT. The RIA sub-agent
-- profile delete auto-disconnects active clients by writing consent_audit
-- REVOKED rows using last_request_id; a value longer than 32 chars would raise
-- StringDataRightTruncation and abort the ENTIRE delete transaction (HTTP 500),
-- so a RIA with active clients could not delete. Widen to TEXT to match the
-- source column. The partial index on request_id remains valid for TEXT.
--
-- Replay guard: re-running this on every deploy took ACCESS EXCLUSIVE on
-- consent_audit even when the column was already TEXT. Skip it only when the
-- catalog shows TEXT; otherwise run the original statement unchanged.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('consent_audit')
      AND attname = 'request_id'
      AND attnum > 0
      AND NOT attisdropped
      AND atttypid = 'text'::regtype
      AND atttypmod = -1
      AND attcollation = (SELECT typcollation FROM pg_type WHERE oid = 'text'::regtype)
  ) THEN
    ALTER TABLE consent_audit
      ALTER COLUMN request_id TYPE TEXT;
  END IF;
END
$$;

COMMIT;
