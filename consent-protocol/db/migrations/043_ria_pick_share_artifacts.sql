CREATE TABLE IF NOT EXISTS ria_pick_share_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES advisor_investor_relationships(id) ON DELETE CASCADE,
  ria_profile_id UUID NOT NULL REFERENCES ria_profiles(id) ON DELETE CASCADE,
  provider_user_id TEXT NOT NULL,
  receiver_user_id TEXT NOT NULL,
  grant_key TEXT NOT NULL DEFAULT 'ria_active_picks_feed_v1',
  status TEXT NOT NULL DEFAULT 'active',
  source_domain TEXT NOT NULL DEFAULT 'ria',
  source_path TEXT NOT NULL DEFAULT 'advisor_package',
  source_data_version INTEGER,
  source_manifest_revision INTEGER,
  artifact_projection JSONB NOT NULL DEFAULT '{}'::JSONB,
  artifact_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ria_pick_share_artifacts_status_check
    CHECK (status IN ('active', 'revoked', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ria_pick_share_artifacts_relationship_key
  ON ria_pick_share_artifacts(relationship_id, grant_key);

CREATE INDEX IF NOT EXISTS idx_ria_pick_share_artifacts_receiver_status
  ON ria_pick_share_artifacts(receiver_user_id, status);

CREATE INDEX IF NOT EXISTS idx_ria_pick_share_artifacts_ria_profile
  ON ria_pick_share_artifacts(ria_profile_id, updated_at DESC);

WITH active_packages AS (
  SELECT
    rel.id AS relationship_id,
    rel.ria_profile_id,
    rp.user_id AS provider_user_id,
    rel.investor_user_id AS receiver_user_id,
    u.package_metadata,
    jsonb_agg(
      jsonb_build_object(
        'ticker', r.ticker,
        'company_name', r.company_name,
        'sector', r.sector,
        'tier', r.tier,
        'tier_rank', r.tier_rank,
        'conviction_weight', r.conviction_weight,
        'recommendation_bias', r.recommendation_bias,
        'investment_thesis', r.investment_thesis,
        'fcf_billions', r.fcf_billions
      )
      ORDER BY r.sort_order
    ) FILTER (WHERE r.upload_id IS NOT NULL) AS top_picks
  FROM advisor_investor_relationships rel
  JOIN ria_profiles rp ON rp.id = rel.ria_profile_id
  JOIN relationship_share_grants share
    ON share.relationship_id = rel.id
   AND share.grant_key = 'ria_active_picks_feed_v1'
   AND share.status = 'active'
  JOIN LATERAL (
    SELECT id, package_metadata
    FROM ria_pick_uploads
    WHERE ria_profile_id = rel.ria_profile_id
      AND status = 'active'
    ORDER BY activated_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  ) u ON TRUE
  LEFT JOIN ria_pick_upload_rows r
    ON r.upload_id = u.id
  WHERE rel.status = 'approved'
  GROUP BY rel.id, rel.ria_profile_id, rp.user_id, rel.investor_user_id, u.package_metadata
)
INSERT INTO ria_pick_share_artifacts (
  relationship_id,
  ria_profile_id,
  provider_user_id,
  receiver_user_id,
  grant_key,
  status,
  source_domain,
  source_path,
  artifact_projection,
  artifact_metadata,
  created_at,
  updated_at
)
SELECT
  relationship_id,
  ria_profile_id,
  provider_user_id,
  receiver_user_id,
  'ria_active_picks_feed_v1',
  'active',
  'ria',
  'advisor_package',
  jsonb_build_object(
    'top_picks', COALESCE(top_picks, '[]'::jsonb),
    'avoid_rows', COALESCE(package_metadata->'avoid_rows', '[]'::jsonb),
    'screening_sections', COALESCE(package_metadata->'screening_sections', '[]'::jsonb),
    'package_note', NULLIF(TRIM(COALESCE(package_metadata->>'package_note', '')), '')
  ),
  jsonb_build_object(
    'label', 'Active advisor package',
    'package_note', NULLIF(TRIM(COALESCE(package_metadata->>'package_note', '')), ''),
    'source', 'migration_backfill'
  ),
  NOW(),
  NOW()
FROM active_packages
ON CONFLICT (relationship_id, grant_key) DO NOTHING;
