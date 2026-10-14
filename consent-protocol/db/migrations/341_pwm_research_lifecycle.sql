-- Owner research consent and content-free completion delivery. Findings stay encrypted.
CREATE TABLE IF NOT EXISTS pwm_research_preferences (
    user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    consent_version TEXT NOT NULL DEFAULT 'pwm-native-v1',
    generation UUID NOT NULL,
    auto_started_at TIMESTAMPTZ,
    active_draft_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pwm_completion_events (
    user_id TEXT NOT NULL REFERENCES pwm_research_preferences(user_id) ON DELETE CASCADE,
    draft_id UUID NOT NULL,
    generation UUID NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ready','partial','attention')),
    email_state TEXT NOT NULL DEFAULT 'pending' CHECK (email_state IN ('pending','leased','accepted','uncertain','suppressed','failed')),
    email_attempts INTEGER NOT NULL DEFAULT 0 CHECK (email_attempts BETWEEN 0 AND 5),
    lease_id UUID,
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, draft_id)
);
CREATE INDEX IF NOT EXISTS pwm_completion_email_due ON pwm_completion_events(next_attempt_at)
    WHERE email_state IN ('pending','leased');
ALTER TABLE feed_events DROP CONSTRAINT IF EXISTS feed_events_source_domain_check;
ALTER TABLE feed_events ADD CONSTRAINT feed_events_source_domain_check CHECK (
    source_domain IN ('consent','location','kai','kyc','connected_systems','connections','pwm')
);
CREATE OR REPLACE FUNCTION pwm_completion_feed_projection() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO feed_events(user_id, source_domain, event_type, source_row_id, metadata)
    VALUES (NEW.user_id, 'pwm', 'pwm_research', NEW.draft_id::text,
            jsonb_build_object('draft_id', NEW.draft_id::text, 'pwm_outcome', NEW.outcome))
    ON CONFLICT (user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL
    DO UPDATE SET metadata=EXCLUDED.metadata; -- preserve read_at, dismissed_at and dismissal_token
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='pwm_completion_feed' AND tgrelid='pwm_completion_events'::regclass) THEN
        CREATE TRIGGER pwm_completion_feed AFTER INSERT OR UPDATE OF outcome ON pwm_completion_events
            FOR EACH ROW EXECUTE FUNCTION pwm_completion_feed_projection();
    END IF;
    IF to_regprocedure('install_account_deletion_write_guards()') IS NOT NULL THEN
        PERFORM install_account_deletion_write_guards();
    END IF;
END $$;
COMMENT ON TABLE pwm_research_preferences IS 'Explicit owner consent and generation fence only; no findings, contact, query, or decryption key.';
COMMENT ON TABLE pwm_completion_events IS 'Metadata-only outbox. Email uncertainty is not retried blindly. Cleared on reset or deletion.';

ALTER TABLE pwm_claim_invitations ADD COLUMN IF NOT EXISTS preview_envelope BYTEA;
ALTER TABLE pwm_claim_invitations ADD COLUMN IF NOT EXISTS preview_version INTEGER;
ALTER TABLE pwm_claim_invitations ADD COLUMN IF NOT EXISTS recipient_draft_id UUID;
COMMENT ON COLUMN pwm_claim_invitations.preview_envelope IS 'Public professional preview encrypted with a token-derived key; never a full personal model.';

COMMENT ON TABLE pwm_claim_invitations IS 'Contact-bound invitation with optional token-encrypted public professional preview. Recipient controls claim, review and research.';
