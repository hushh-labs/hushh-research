CREATE TABLE IF NOT EXISTS relationship_share_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES advisor_investor_relationships(id) ON DELETE CASCADE,
  grant_key TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  receiver_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT relationship_share_grants_status_check
    CHECK (status IN ('active', 'revoked', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_relationship_share_grants_relationship_key
  ON relationship_share_grants(relationship_id, grant_key);

CREATE INDEX IF NOT EXISTS idx_relationship_share_grants_receiver_status
  ON relationship_share_grants(receiver_user_id, status);

CREATE INDEX IF NOT EXISTS idx_relationship_share_grants_provider_status
  ON relationship_share_grants(provider_user_id, status);

CREATE TABLE IF NOT EXISTS relationship_share_events (
  id BIGSERIAL PRIMARY KEY,
  share_grant_id UUID REFERENCES relationship_share_grants(id) ON DELETE CASCADE,
  relationship_id UUID NOT NULL REFERENCES advisor_investor_relationships(id) ON DELETE CASCADE,
  grant_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  receiver_user_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT relationship_share_events_type_check
    CHECK (event_type IN ('GRANTED', 'REVOKED', 'EXPIRED'))
);

CREATE INDEX IF NOT EXISTS idx_relationship_share_events_relationship_created
  ON relationship_share_events(relationship_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_share_events_grant_created
  ON relationship_share_events(share_grant_id, created_at DESC);

WITH approved_relationships AS (
  SELECT
    rel.id AS relationship_id,
    rp.user_id AS provider_user_id,
    rel.investor_user_id AS receiver_user_id,
    COALESCE(rel.consent_granted_at, rel.updated_at, rel.created_at, NOW()) AS granted_at
  FROM advisor_investor_relationships rel
  JOIN ria_profiles rp ON rp.id = rel.ria_profile_id
  WHERE rel.status = 'approved'
),
upserted_grants AS (
  INSERT INTO relationship_share_grants (
    relationship_id,
    grant_key,
    provider_user_id,
    receiver_user_id,
    status,
    granted_at,
    revoked_at,
    metadata,
    created_at,
    updated_at
  )
  SELECT
    relationship_id,
    'ria_active_picks_feed_v1',
    provider_user_id,
    receiver_user_id,
    'active',
    granted_at,
    NULL,
    jsonb_build_object(
      'share_origin', 'relationship_implicit',
      'source', 'migration_backfill'
    ),
    NOW(),
    NOW()
  FROM approved_relationships
  ON CONFLICT (relationship_id, grant_key) DO UPDATE
  SET
    provider_user_id = EXCLUDED.provider_user_id,
    receiver_user_id = EXCLUDED.receiver_user_id,
    status = 'active',
    revoked_at = NULL,
    granted_at = COALESCE(relationship_share_grants.granted_at, EXCLUDED.granted_at),
    metadata = COALESCE(relationship_share_grants.metadata, '{}'::JSONB)
      || jsonb_build_object(
        'share_origin', 'relationship_implicit',
        'source', 'migration_backfill'
      ),
    updated_at = NOW()
  RETURNING id, relationship_id, grant_key, provider_user_id, receiver_user_id, granted_at, metadata
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
  grant_row.id,
  grant_row.relationship_id,
  grant_row.grant_key,
  'GRANTED',
  grant_row.provider_user_id,
  grant_row.receiver_user_id,
  COALESCE(grant_row.metadata, '{}'::JSONB)
    || jsonb_build_object('source', 'migration_backfill'),
  grant_row.granted_at
FROM upserted_grants grant_row
WHERE NOT EXISTS (
  SELECT 1
  FROM relationship_share_events event_row
  WHERE event_row.share_grant_id = grant_row.id
    AND event_row.event_type = 'GRANTED'
);
