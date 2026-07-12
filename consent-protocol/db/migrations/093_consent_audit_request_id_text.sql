BEGIN;

-- consent_audit.request_id was VARCHAR(32) (legacy init schema), but
-- advisor_investor_relationships.last_request_id is TEXT. The RIA sub-agent
-- profile delete auto-disconnects active clients by writing consent_audit
-- REVOKED rows using last_request_id; a value longer than 32 chars would raise
-- StringDataRightTruncation and abort the ENTIRE delete transaction (HTTP 500),
-- so a RIA with active clients could not delete. Widen to TEXT to match the
-- source column. The partial index on request_id remains valid for TEXT.
ALTER TABLE consent_audit
  ALTER COLUMN request_id TYPE TEXT;

COMMIT;
