BEGIN;
CREATE TEMPORARY TABLE rollback_sms_pending_calls (id UUID PRIMARY KEY) ON COMMIT DROP;
WITH cancelled AS (
    UPDATE direct_calls SET state='cancelled', revision=revision+1,
        expires_at=LEAST(expires_at,clock_timestamp()), offers='[]', caller_proof='{}'
    WHERE sms_incident_id IS NOT NULL AND state IN ('preparing','ringing')
    RETURNING id
)
INSERT INTO rollback_sms_pending_calls SELECT id FROM cancelled;
DELETE FROM direct_call_voip_outbox WHERE call_id IN (SELECT id FROM rollback_sms_pending_calls);
DELETE FROM direct_call_signals WHERE call_id IN (SELECT id FROM rollback_sms_pending_calls);
DELETE FROM direct_call_slots WHERE call_id IN (SELECT id FROM rollback_sms_pending_calls);
ALTER TABLE direct_calls DROP COLUMN IF EXISTS sms_incident_id;
DELETE FROM direct_call_voip_tokens WHERE fcm_installation_id IS NOT NULL;
ALTER TABLE direct_call_voip_tokens
    DROP CONSTRAINT IF EXISTS direct_call_voip_provider_binding,
    DROP COLUMN IF EXISTS fcm_installation_id,
    DROP COLUMN IF EXISTS fcm_token_hash,
    ALTER COLUMN token SET NOT NULL,
    ALTER COLUMN environment SET NOT NULL,
    ALTER COLUMN topic SET NOT NULL;
COMMIT;
