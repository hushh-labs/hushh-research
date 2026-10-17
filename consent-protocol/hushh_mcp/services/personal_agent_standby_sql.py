"""Statements behind ``personal_agent_standby_store`` (dev-only migration 950).

Plain literals with bound parameters only, so every statement can be read whole and
none is assembled from strings. Each is ONE statement, therefore one transaction.
Shared clauses are repeated on purpose rather than concatenated: a settled registry
row is never under erasure and never mid-provision; person-level metadata keys
(``puppy*`` and ``detachedPlacements``) stay with the person on a switch (E9).
"""

READ_SQL = """
SELECT s.*, r.placement_epoch
FROM personal_agent_standby_placements AS s
JOIN personal_agent_registry AS r ON r.user_id = s.user_id
WHERE s.user_id = :user_id
"""

ADD_SQL = """
WITH primary_row AS (
  SELECT r.user_id, r.hushh_id FROM personal_agent_registry AS r
  WHERE r.user_id = :user_id
    AND r.status = 'provisioned'
    AND r.placement_epoch = CAST(:epoch AS bigint)
    AND r.pod_signing_key_id IS NOT NULL
    AND r.pod_signing_key_id <> CAST(:pod_signing_key_id AS text)
    AND r.pod_key_id IS DISTINCT FROM CAST(:pod_key_id AS text)
    AND r.external_agent_id IS DISTINCT FROM CAST(:external_agent_id AS text)
    AND NOT EXISTS (
      SELECT 1 FROM personal_agent_registry AS x
      WHERE x.user_id <> r.user_id
        AND ((CAST(:user_cloud_project AS text) IS NOT NULL
              AND x.user_cloud_project = CAST(:user_cloud_project AS text))
          OR (CAST(:user_cloud_resource_group AS text) IS NOT NULL
              AND x.user_cloud_tenant_id = CAST(:user_cloud_tenant_id AS text)
              AND x.user_cloud_subscription_id = CAST(:user_cloud_subscription_id AS text)
              AND x.user_cloud_resource_group = CAST(:user_cloud_resource_group AS text))))

  AND NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'erasure')
  AND (NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'provisionAttempt')
       OR r.backend_metadata->'provisionAttempt'->>'phase' = 'provisioned')

  FOR UPDATE
), latch AS (
  UPDATE personal_agent_registry AS r SET identity_mode = 'signed'
  FROM primary_row AS p
  WHERE r.user_id = p.user_id AND r.identity_mode IS DISTINCT FROM 'signed'
  RETURNING r.user_id
)
INSERT INTO personal_agent_standby_placements (
  user_id, hushh_id, deployment_target, backend, external_agent_id, region,
  model_credential_mode, user_cloud_project, user_cloud_region, user_cloud_bootstrap_sa,
  user_cloud_authorized_at, user_cloud_tenant_id, user_cloud_subscription_id,
  user_cloud_resource_group, url, pod_pubkey, pod_key_id, pod_key_wrapping_alg,
  pod_signing_pubkey, pod_signing_key_id, runtime_version, prompt_version, backend_metadata
)
SELECT p.user_id, p.hushh_id, :deployment_target, :backend, :external_agent_id, :region,
  :model_credential_mode, :user_cloud_project, :user_cloud_region, :user_cloud_bootstrap_sa,
  CAST(:user_cloud_authorized_at AS timestamptz), :user_cloud_tenant_id,
  :user_cloud_subscription_id, :user_cloud_resource_group, :url, :pod_pubkey, :pod_key_id,
  :pod_key_wrapping_alg, :pod_signing_pubkey, :pod_signing_key_id, :runtime_version,
  :prompt_version, CAST(:backend_metadata AS jsonb)
FROM primary_row AS p
ON CONFLICT (user_id) DO NOTHING
RETURNING *
"""

REMOVE_SQL = """
WITH gone AS (
  DELETE FROM personal_agent_standby_placements AS s
  USING personal_agent_registry AS r
  WHERE s.user_id = :user_id AND r.user_id = s.user_id
    AND s.pod_key_id = :pod_key_id
    AND r.placement_epoch = CAST(:epoch AS bigint)

  AND NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'erasure')
  AND (NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'provisionAttempt')
       OR r.backend_metadata->'provisionAttempt'->>'phase' = 'provisioned')

  RETURNING s.*
)
UPDATE personal_agent_registry AS r
SET backend_metadata = coalesce(r.backend_metadata, '{}'::jsonb) || jsonb_build_object(
      'detachedPlacements',
      coalesce(r.backend_metadata -> 'detachedPlacements', '[]'::jsonb) || jsonb_build_array(
        (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
         FROM jsonb_each(to_jsonb(gone)) AS e
         WHERE e.key = ANY(CASE WHEN gone.backend_metadata ? 'notificationCheckpoint'
                               THEN :custody_coordinates ELSE :coordinates END))
        || jsonb_build_object(
          'role', 'standby',
          'detachedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'reason', CAST(:reason AS text)))),
    updated_at = now()
FROM gone
WHERE r.user_id = gone.user_id
RETURNING r.user_id, jsonb_array_length(r.backend_metadata -> 'detachedPlacements') AS detached_count
"""

CLAIM_SQL = """
UPDATE personal_agent_standby_placements AS s
SET sync_lease_id = :lease_id, sync_lease_at = now(), last_sync_attempt_at = now(),
    updated_at = now()
FROM personal_agent_registry AS r
WHERE s.user_id = :user_id AND r.user_id = s.user_id
  AND s.pod_key_id = :pod_key_id
  AND r.placement_epoch = CAST(:epoch AS bigint)
  AND r.status IN ('provisioned', 'migrating')
  AND (s.sync_lease_id IS NULL OR s.sync_lease_at <= now() - make_interval(secs => :lease_ttl))
  AND (s.last_sync_attempt_at IS NULL
       OR s.last_sync_attempt_at <= now() - make_interval(secs => :cooldown))

  AND NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'erasure')
  AND (NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'provisionAttempt')
       OR r.backend_metadata->'provisionAttempt'->>'phase' = 'provisioned')

RETURNING s.*, r.placement_epoch
"""

DUE_SQL = """
SELECT s.*, r.placement_epoch
FROM personal_agent_standby_placements AS s
JOIN personal_agent_registry AS r ON r.user_id = s.user_id
WHERE (s.last_sync_at IS NULL OR s.last_sync_at < CAST(:synced_before AS timestamptz))
  AND r.status = 'provisioned'
  AND (s.sync_lease_id IS NULL OR s.sync_lease_at <= now() - make_interval(secs => :lease_ttl))

  AND NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'erasure')
  AND (NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'provisionAttempt')
       OR r.backend_metadata->'provisionAttempt'->>'phase' = 'provisioned')

ORDER BY s.last_sync_attempt_at ASC NULLS FIRST, s.user_id
LIMIT :limit
"""

RECORD_SQL = """
UPDATE personal_agent_standby_placements AS s
SET sync_lease_id = NULL, sync_lease_at = NULL,
    last_sync_status = CAST(:status AS text),
    synced_seq = CASE WHEN CAST(:status AS text) = 'synced'
                      THEN CAST(:synced_seq AS bigint) ELSE s.synced_seq END,
    synced_head_sha = CASE WHEN CAST(:status AS text) = 'synced'
                           THEN CAST(:synced_head_sha AS text) ELSE s.synced_head_sha END,
    last_sync_at = CASE WHEN CAST(:status AS text) = 'synced' THEN now() ELSE s.last_sync_at END,
    updated_at = now()
FROM personal_agent_registry AS r
WHERE s.user_id = :user_id AND r.user_id = s.user_id
  AND s.sync_lease_id = :lease_id
  AND s.pod_key_id = :pod_key_id
  AND r.placement_epoch = CAST(:epoch AS bigint)
  AND (CAST(:status AS text) <> 'synced'
       OR CAST(:synced_seq AS bigint) > s.synced_seq
       OR (CAST(:synced_seq AS bigint) = s.synced_seq
           AND CAST(:synced_head_sha AS text) IS NOT DISTINCT FROM s.synced_head_sha))
RETURNING s.*, r.placement_epoch
"""

SWAP_SQL = """
WITH old_r AS (
  SELECT r.* FROM personal_agent_registry AS r
  WHERE r.user_id = :user_id
    AND r.placement_epoch = CAST(:epoch AS bigint)
    AND r.status IN ('provisioned', 'needs_reinit')
    AND r.backend_metadata->>'upgradeLease' IS NULL
    AND r.deployment_target = ANY(:known_targets)
    AND r.external_agent_id IS NOT NULL
    AND r.pod_pubkey IS NOT NULL AND r.pod_key_id IS NOT NULL
    AND r.pod_signing_key_id IS NOT NULL
    AND left(r.backend_metadata->>'url', 8) = 'https://'

  AND NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'erasure')
  AND (NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'provisionAttempt')
       OR r.backend_metadata->'provisionAttempt'->>'phase' = 'provisioned')

  FOR UPDATE
), old_s AS (
  SELECT s.* FROM personal_agent_standby_placements AS s
  JOIN old_r ON old_r.user_id = s.user_id
  WHERE s.pod_key_id = :pod_key_id
    AND s.last_sync_at IS NOT NULL
  FOR UPDATE OF s
), promoted AS (
  UPDATE personal_agent_registry AS r SET
    deployment_target = old_s.deployment_target, backend = old_s.backend,
    external_agent_id = old_s.external_agent_id, region = old_s.region,
    model_credential_mode = old_s.model_credential_mode,
    user_cloud_project = old_s.user_cloud_project, user_cloud_region = old_s.user_cloud_region,
    user_cloud_bootstrap_sa = old_s.user_cloud_bootstrap_sa,
    user_cloud_authorized_at = old_s.user_cloud_authorized_at,
    user_cloud_tenant_id = old_s.user_cloud_tenant_id,
    user_cloud_subscription_id = old_s.user_cloud_subscription_id,
    user_cloud_resource_group = old_s.user_cloud_resource_group,
    pod_pubkey = old_s.pod_pubkey, pod_key_id = old_s.pod_key_id,
    pod_key_wrapping_alg = old_s.pod_key_wrapping_alg,
    pod_signing_pubkey = old_s.pod_signing_pubkey, pod_signing_key_id = old_s.pod_signing_key_id,
    runtime_version = old_s.runtime_version, prompt_version = old_s.prompt_version,
    backend_metadata = old_s.backend_metadata || jsonb_build_object('url', old_s.url) || (
      SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      FROM jsonb_each(coalesce(old_r.backend_metadata, '{}'::jsonb)) AS e WHERE (e.key LIKE 'puppy%' OR e.key = 'detachedPlacements')),
    status = 'provisioned', provisioned_at = old_s.provisioned_at,
    last_heartbeat_at = NULL, health_state = 'unknown', last_probe_at = NULL,
    liveness_failures = 0, last_healed_at = NULL,
    placement_epoch = old_r.placement_epoch + 1, identity_mode = 'signed', updated_at = now()
  FROM old_r, old_s
  WHERE r.user_id = old_r.user_id AND old_s.user_id = old_r.user_id
  RETURNING r.user_id, r.placement_epoch
), demoted AS (
  UPDATE personal_agent_standby_placements AS s SET
    deployment_target = old_r.deployment_target, backend = old_r.backend,
    external_agent_id = old_r.external_agent_id, region = old_r.region,
    model_credential_mode = old_r.model_credential_mode,
    user_cloud_project = old_r.user_cloud_project, user_cloud_region = old_r.user_cloud_region,
    user_cloud_bootstrap_sa = old_r.user_cloud_bootstrap_sa,
    user_cloud_authorized_at = old_r.user_cloud_authorized_at,
    user_cloud_tenant_id = old_r.user_cloud_tenant_id,
    user_cloud_subscription_id = old_r.user_cloud_subscription_id,
    user_cloud_resource_group = old_r.user_cloud_resource_group,
    url = old_r.backend_metadata->>'url',
    pod_pubkey = old_r.pod_pubkey, pod_key_id = old_r.pod_key_id,
    pod_key_wrapping_alg = old_r.pod_key_wrapping_alg,
    pod_signing_pubkey = old_r.pod_signing_pubkey, pod_signing_key_id = old_r.pod_signing_key_id,
    runtime_version = old_r.runtime_version, prompt_version = old_r.prompt_version,
    backend_metadata = (
      SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      FROM jsonb_each(coalesce(old_r.backend_metadata, '{}'::jsonb)) AS e
      WHERE e.key <> 'url' AND NOT (e.key LIKE 'puppy%' OR e.key = 'detachedPlacements')),
    provisioned_at = coalesce(old_r.provisioned_at, now()),
    last_sync_status = 'pending', sync_lease_id = NULL, sync_lease_at = NULL, updated_at = now()
  FROM old_r, old_s
  WHERE s.user_id = old_s.user_id AND old_s.user_id = old_r.user_id
  RETURNING s.user_id
)
SELECT promoted.user_id, promoted.placement_epoch
FROM promoted JOIN demoted ON demoted.user_id = promoted.user_id
"""
