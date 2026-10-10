-- Scope-policy v2: separate One invocation from information authority, bind
-- developer apps to reserved capabilities, and revoke retired grants without
-- rewriting immutable audit history.

BEGIN;

ALTER TABLE developer_apps
  ADD COLUMN IF NOT EXISTS allowed_capabilities JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE INDEX IF NOT EXISTS idx_developer_apps_allowed_capabilities
  ON developer_apps USING GIN (allowed_capabilities);

-- Preserve the existing Hushh Technologies token. Authentication is by its
-- stored hash; changing this app-policy row does not rotate or reveal the raw
-- credential.
UPDATE developer_apps
SET allowed_capabilities = CASE
      WHEN allowed_capabilities ? 'cap.one.invoke' THEN allowed_capabilities
      ELSE allowed_capabilities || '["cap.one.invoke"]'::JSONB
    END,
    updated_at = GREATEST(
      updated_at,
      (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
    )
WHERE LOWER(TRIM(display_name)) IN ('hushh technology', 'hushh technologies');

-- Append REVOKED events for every latest live grant with a retired scope. The
-- original grant row/string remains immutable for audit and can no longer win
-- latest-event resolution after this migration.
WITH latest_token_events AS (
  SELECT DISTINCT ON (token_id)
    token_id,
    user_id,
    agent_id,
    scope,
    action,
    expires_at,
    metadata,
    token_type,
    request_id,
    scope_description
  FROM consent_audit
  WHERE token_id IS NOT NULL
    AND TRIM(token_id) <> ''
  ORDER BY token_id, issued_at DESC, id DESC
), retired_live_grants AS (
  SELECT *
  FROM latest_token_events
  WHERE action = 'CONSENT_GRANTED'
    AND scope = ANY (ARRAY[
      'agent.one.orchestrate',
      'portfolio.analyze',
      'portfolio.read',
      'chat.history.read',
      'chat.history.write',
      'embedding.profile.read',
      'embedding.profile.compute',
      'pkm.metadata',
      'agent.kai.debate',
      'agent.kai.infer',
      'agent.kai.chat',
      'agent.kai.execute',
      'agent.nav.revoke',
      'agent.kyc.draft',
      'agent.kyc.writeback',
      'cap.pkm.marketplace.publish',
      'external.sec.filings',
      'external.news.api',
      'external.market.data',
      'external.renaissance.data'
    ]::TEXT[])
)
INSERT INTO consent_audit (
  token_id,
  user_id,
  agent_id,
  scope,
  action,
  issued_at,
  expires_at,
  revoked_at,
  metadata,
  token_type,
  request_id,
  scope_description
)
SELECT
  token_id,
  user_id,
  agent_id,
  scope,
  'REVOKED',
  (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
  expires_at,
  (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
  COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
    'reason', 'scope_retired',
    'scope_policy_version', 2
  ),
  token_type,
  request_id,
  scope_description
FROM retired_live_grants;

-- Encrypted artifacts for retired grants are no longer retrievable. Refresh
-- jobs cascade through the existing foreign key.
DELETE FROM consent_exports
WHERE scope = ANY (ARRAY[
  'agent.one.orchestrate',
  'portfolio.analyze',
  'portfolio.read',
  'chat.history.read',
  'chat.history.write',
  'embedding.profile.read',
  'embedding.profile.compute',
  'pkm.metadata',
  'agent.kai.debate',
  'agent.kai.infer',
  'agent.kai.chat',
  'agent.kai.execute',
  'agent.nav.revoke',
  'agent.kyc.draft',
  'agent.kyc.writeback',
  'cap.pkm.marketplace.publish',
  'external.sec.filings',
  'external.news.api',
  'external.market.data',
  'external.renaissance.data'
]::TEXT[]);

COMMIT;
