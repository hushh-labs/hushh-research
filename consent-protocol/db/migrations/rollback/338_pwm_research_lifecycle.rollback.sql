DELETE FROM feed_events WHERE source_domain='pwm';
DO $$ BEGIN
 IF to_regclass('pwm_completion_events') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS pwm_completion_feed ON pwm_completion_events;
 END IF;
END $$;
DROP FUNCTION IF EXISTS pwm_completion_feed_projection();
DROP TABLE IF EXISTS pwm_completion_events;
DROP TABLE IF EXISTS pwm_research_preferences;
ALTER TABLE pwm_claim_invitations DROP COLUMN IF EXISTS preview_envelope;
ALTER TABLE pwm_claim_invitations DROP COLUMN IF EXISTS preview_version;
ALTER TABLE pwm_claim_invitations DROP COLUMN IF EXISTS recipient_draft_id;
ALTER TABLE feed_events DROP CONSTRAINT IF EXISTS feed_events_source_domain_check;
ALTER TABLE feed_events ADD CONSTRAINT feed_events_source_domain_check CHECK (
 source_domain IN ('consent','location','kai','kyc','connected_systems','connections')
);
