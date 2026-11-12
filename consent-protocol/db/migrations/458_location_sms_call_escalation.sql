BEGIN;
ALTER TABLE direct_calls ADD COLUMN IF NOT EXISTS sms_incident_id UUID;
ALTER TABLE direct_call_voip_tokens
    ADD COLUMN IF NOT EXISTS fcm_installation_id BIGINT REFERENCES user_push_installations(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS fcm_token_hash TEXT,
    ALTER COLUMN token DROP NOT NULL,
    ALTER COLUMN environment DROP NOT NULL,
    ALTER COLUMN topic DROP NOT NULL;
ALTER TABLE direct_call_voip_tokens DROP CONSTRAINT IF EXISTS direct_call_voip_provider_binding;
ALTER TABLE direct_call_voip_tokens ADD CONSTRAINT direct_call_voip_provider_binding CHECK (
    (fcm_installation_id IS NULL AND fcm_token_hash IS NULL AND token IS NOT NULL AND environment IS NOT NULL AND topic IS NOT NULL)
    OR
    (fcm_installation_id IS NOT NULL AND fcm_token_hash IS NOT NULL AND fcm_token_hash ~ '^[a-f0-9]{64}$'
        AND token IS NULL AND environment IS NULL AND topic IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS direct_call_fcm_installation_idx ON direct_call_voip_tokens(fcm_installation_id)
    WHERE fcm_installation_id IS NOT NULL;
COMMIT;
