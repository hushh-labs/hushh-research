BEGIN;

-- A connection is a mutual relationship, never standing access.  Scope choices
-- are normalized so the request envelope cannot become an authorization store.
CREATE TABLE IF NOT EXISTS connection_scope_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_request_id UUID NOT NULL REFERENCES connection_requests(id),
  scope_handle TEXT NOT NULL,
  capability_key TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('requested', 'offered')),
  owner_user_id TEXT NOT NULL,
  receiver_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'declined', 'revoked', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  resolved_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT connection_scope_proposals_no_self CHECK (owner_user_id <> receiver_user_id),
  CONSTRAINT uq_connection_scope_proposal UNIQUE (connection_request_id, direction, capability_key)
);

CREATE INDEX IF NOT EXISTS idx_connection_scope_proposals_receiver
  ON connection_scope_proposals(receiver_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_scope_proposals_owner
  ON connection_scope_proposals(owner_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_scope_proposals_active_expiry
  ON connection_scope_proposals(expires_at)
  WHERE status = 'active';

-- Proposal history is immutable policy evidence.  It is separate from the
-- request metadata and from the RIA-only share-event history so generic
-- peer-capabilities remain auditable without carrying any protected values.
CREATE TABLE IF NOT EXISTS connection_scope_proposal_events (
  id BIGSERIAL PRIMARY KEY,
  connection_scope_proposal_id UUID NOT NULL
    REFERENCES connection_scope_proposals(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'PROPOSED', 'ACTIVATED', 'DECLINED', 'REVOKED', 'EXPIRED'
  )),
  actor_user_id TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The migration is idempotent for a partially provisioned development
-- environment. Existing proposals are bounded from their original creation;
-- no capability can silently become perpetual during the schema upgrade.
ALTER TABLE connection_scope_proposals
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE connection_scope_proposals
SET expires_at = created_at + INTERVAL '90 days'
WHERE expires_at IS NULL;
ALTER TABLE connection_scope_proposals
  ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE connection_scope_proposals
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '90 days');
CREATE INDEX IF NOT EXISTS idx_connection_scope_proposal_events_proposal_created
  ON connection_scope_proposal_events(connection_scope_proposal_id, created_at DESC);

-- Relationship share grants remain the one active RIA capability plane.  These
-- links explain exactly which bilateral proposal authorized a grant.
ALTER TABLE relationship_share_grants
  ADD COLUMN IF NOT EXISTS connection_request_id UUID REFERENCES connection_requests(id) ON DELETE SET NULL;
ALTER TABLE relationship_share_grants
  ADD COLUMN IF NOT EXISTS connection_scope_proposal_id UUID REFERENCES connection_scope_proposals(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_relationship_share_grants_scope_proposal
  ON relationship_share_grants(connection_scope_proposal_id)
  WHERE connection_scope_proposal_id IS NOT NULL;

-- Preserve the exact proposal lineage in immutable share history as well.
-- These are intentionally UUID values rather than cascading foreign keys: a
-- historical event must stay intelligible even if a future retention policy
-- deletes its mutable request envelope.
ALTER TABLE relationship_share_events
  ADD COLUMN IF NOT EXISTS connection_request_id UUID;
ALTER TABLE relationship_share_events
  ADD COLUMN IF NOT EXISTS connection_scope_proposal_id UUID;
CREATE INDEX IF NOT EXISTS idx_relationship_share_events_scope_proposal
  ON relationship_share_events(connection_scope_proposal_id, created_at DESC)
  WHERE connection_scope_proposal_id IS NOT NULL;

-- The old policy granted Picks from a broad RIA relationship.  Retire those
-- rows atomically: their history remains, but they cannot authorize content.
WITH retired AS (
  UPDATE relationship_share_grants grant_row
  SET
    status = 'revoked',
    revoked_at = COALESCE(grant_row.revoked_at, NOW()),
    metadata = COALESCE(grant_row.metadata, '{}'::jsonb) || jsonb_build_object(
      'retired_reason', 'implicit_policy_retired',
      'share_origin', 'retired_implicit'
    ),
    updated_at = NOW()
  WHERE grant_row.grant_key = 'ria_active_picks_feed_v1'
    AND grant_row.status = 'active'
    AND COALESCE(grant_row.metadata ->> 'share_origin', '') = 'relationship_implicit'
  RETURNING grant_row.id, grant_row.relationship_id, grant_row.grant_key,
            grant_row.provider_user_id, grant_row.receiver_user_id, grant_row.metadata
), artifacts AS (
  UPDATE ria_pick_share_artifacts artifact
  SET status = 'revoked', updated_at = NOW()
  FROM retired
  WHERE artifact.relationship_id = retired.relationship_id
    AND artifact.grant_key = retired.grant_key
    AND artifact.status = 'active'
), retired_relationships AS (
  UPDATE advisor_investor_relationships relationship
  SET status = 'revoked', revoked_at = COALESCE(relationship.revoked_at, NOW()), updated_at = NOW()
  WHERE relationship.id IN (SELECT relationship_id FROM retired)
    AND NOT EXISTS (
      SELECT 1
      FROM relationship_share_grants active_grant
      JOIN connection_scope_proposals active_proposal
        ON active_proposal.id = active_grant.connection_scope_proposal_id
       AND active_proposal.status = 'active'
      WHERE active_grant.relationship_id = relationship.id
        AND active_grant.status = 'active'
        AND active_grant.connection_scope_proposal_id IS NOT NULL
    )
  RETURNING relationship.id
)
INSERT INTO relationship_share_events (
  share_grant_id, relationship_id, grant_key, event_type,
  provider_user_id, receiver_user_id, metadata, created_at
)
SELECT
  id, relationship_id, grant_key, 'REVOKED', provider_user_id, receiver_user_id,
  metadata || jsonb_build_object('reason', 'implicit_policy_retired'), NOW()
FROM retired;

COMMENT ON TABLE connection_scope_proposals IS
  'Bilateral scope choices inside a One-to-One connection request. Rows are metadata-only, expire after 90 days, and are not information exports.';
COMMENT ON TABLE connection_scope_proposal_events IS
  'Immutable lifecycle history for metadata-only One-to-One scope proposals; request/proposal deletion is intentionally restricted.';

COMMIT;
