BEGIN;

-- Product decision: legacy RIA pick uploads are intentionally retired rather
-- than copied into the encrypted PKM package. This migration records only
-- metadata about the reset, revokes every pre-explicit Picks projection, and
-- removes the obsolete plaintext-era storage in the same transaction. New
-- Picks begin only in the owner-controlled encrypted `ria.advisor_package`
-- domain and can reach investors only through an explicit bilateral proposal.
CREATE TABLE IF NOT EXISTS ria_pick_legacy_retirements (
  legacy_upload_id UUID PRIMARY KEY,
  ria_profile_id UUID NOT NULL REFERENCES ria_profiles(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL,
  top_pick_count INTEGER NOT NULL CHECK (top_pick_count >= 0),
  retired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL DEFAULT 'product_authorized_clean_start'
);

CREATE INDEX IF NOT EXISTS idx_ria_pick_legacy_retirements_owner
  ON ria_pick_legacy_retirements (owner_user_id, retired_at DESC);

INSERT INTO ria_pick_legacy_retirements (
  legacy_upload_id,
  ria_profile_id,
  owner_user_id,
  top_pick_count,
  reason
)
SELECT
  upload.id,
  upload.ria_profile_id,
  upload.uploaded_by_user_id,
  COUNT(row.id)::INTEGER,
  'product_authorized_clean_start'
FROM ria_pick_uploads AS upload
LEFT JOIN ria_pick_upload_rows AS row ON row.upload_id = upload.id
GROUP BY upload.id, upload.ria_profile_id, upload.uploaded_by_user_id
ON CONFLICT (legacy_upload_id) DO NOTHING;

-- No artifact created before proposal lineage can survive the reset. Existing
-- audit rows remain immutable, but their mutable grants/artifacts cannot
-- authorize Market, preview, Debate, or a later refresh.
WITH retired_grants AS (
  UPDATE relationship_share_grants AS grant_row
  SET
    status = 'revoked',
    revoked_at = COALESCE(grant_row.revoked_at, NOW()),
    metadata = COALESCE(grant_row.metadata, '{}'::jsonb) || jsonb_build_object(
      'retired_reason', 'legacy_picks_clean_start',
      'share_origin', 'retired_legacy'
    ),
    updated_at = NOW()
  WHERE grant_row.grant_key = 'ria_active_picks_feed_v1'
    AND grant_row.status = 'active'
    AND grant_row.connection_scope_proposal_id IS NULL
  RETURNING grant_row.id, grant_row.relationship_id, grant_row.grant_key,
            grant_row.provider_user_id, grant_row.receiver_user_id, grant_row.metadata
), retired_artifacts AS (
  UPDATE ria_pick_share_artifacts AS artifact
  SET status = 'revoked', updated_at = NOW()
  FROM retired_grants
  WHERE artifact.relationship_id = retired_grants.relationship_id
    AND artifact.grant_key = retired_grants.grant_key
    AND artifact.status = 'active'
)
INSERT INTO relationship_share_events (
  share_grant_id,
  relationship_id,
  grant_key,
  event_type,
  provider_user_id,
  receiver_user_id,
  metadata,
  created_at
)
SELECT
  id,
  relationship_id,
  grant_key,
  'REVOKED',
  provider_user_id,
  receiver_user_id,
  metadata || jsonb_build_object('reason', 'legacy_picks_clean_start'),
  NOW()
FROM retired_grants;

DROP TABLE IF EXISTS ria_pick_upload_rows;
DROP TABLE IF EXISTS ria_pick_uploads;

COMMENT ON TABLE ria_pick_legacy_retirements IS
  'Metadata-only record of the product-authorized retirement of obsolete RIA Picks storage. It contains no Pick values, package metadata, PKM material, or export authority.';

COMMIT;
