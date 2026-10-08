-- Separate the owner's spaceID handle from the opaque cost-attribution id.
--
-- PARKED (dev-only), 900 band, extends 900_personal_agent_registry.
--
-- WHY THIS IS A NEW FILE, NOT AN EDIT TO 900
-- 900 has already been applied to hushh-pda-dev, and the dev-extra lane refuses a
-- file whose checksum changed (db/migrate.py -> MigrationAuthorityError). An
-- applied migration is immutable whatever band it sits in. This is the same
-- lesson 913 was written for; it is a new file for the same reason.
--
-- WHAT CHANGED, AND WHY
-- 900 shipped a single `space_id` column and the code treated it as an opaque
-- billing-label token. That conflated two genuinely different things, and it
-- inverted the spaceID doctrine (docs/future/personal-agent/ARCHITECTURE.md: a
-- spaceID is the owner's node/instance, and ROADMAP M10 has the owner RESERVE
-- one -- a user-facing act). The founder's instruction settled it: `space_id` is
-- the owner's own chosen handle for their space; the engineering uses a separate
-- identifier where an opaque value is required.
--
--   space_id          the owner's handle. User-facing, user-set, mutable. NEVER a
--                     cloud label. NULL until the owner names their space.
--   billing_space_id  the opaque cost-attribution id (HMAC-derived, minted at
--                     provision). Rendered as the hussh-billing-space Cloud Run
--                     label and joined against the billing export. Discloses
--                     nothing on its own, because a label is readable by anyone
--                     with project billing access.
--
-- Both columns are all-NULL on dev today (no provisioned pod ever carried a
-- populated space_id), so redefining space_id's MEANING needs no data migration.
--
-- Idempotent + replay-safe: ADD COLUMN IF NOT EXISTS, and COMMENT ON is a no-op
-- to re-run. The dev lane runs REPLAY, so every statement must survive twice.

BEGIN;

ALTER TABLE personal_agent_registry
  ADD COLUMN IF NOT EXISTS billing_space_id TEXT;

COMMENT ON COLUMN personal_agent_registry.space_id IS
  'The owner''s chosen handle for their space (the spaceID they reserve/name). User-facing, user-set through the space-name path, and mutable. NEVER used as a cloud label and never derived. NULL until the owner names their space.';

COMMENT ON COLUMN personal_agent_registry.billing_space_id IS
  'Opaque per-agent cost-attribution id (HMAC-derived, minted once at provision). Rendered as the hussh-billing-space Cloud Run label and joined against the Cloud Billing export server-side. Deliberately NOT the space_id handle: a billing-readable label must disclose nothing, and a user handle does.';

CREATE INDEX IF NOT EXISTS idx_personal_agent_registry_billing_space_id
  ON personal_agent_registry(billing_space_id);

COMMIT;
