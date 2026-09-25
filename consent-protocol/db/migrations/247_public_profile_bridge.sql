-- Additive bridge contracts; private selections remain ciphertext in the draft.
-- Frozen owner selection; opaque references only. Receipts are owned by PKM.
ALTER TABLE one_profile_discovery_jobs ADD COLUMN IF NOT EXISTS claim_batch JSONB;
ALTER TABLE one_profile_discovery_jobs ADD COLUMN IF NOT EXISTS claim_batch_key UUID;

ALTER TABLE one_public_profile_entities ADD COLUMN IF NOT EXISTS prepared_payload JSONB;

ALTER TABLE one_profile_discovery_jobs ADD COLUMN IF NOT EXISTS assessment_request JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS one_profile_feed_activity_unique
 ON feed_events(user_id,source_row_id) WHERE source_domain='profile_discovery';
